use crate::error::{AppError, AppResult};
use crate::services::audio_devices::{self, RecordingDevices};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;
use hound::WavWriter;
use std::fs::File;
use std::io::BufWriter;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

#[cfg(windows)]
use super::wasapi_loopback::WasapiLoopbackService;

#[cfg(windows)]
use super::combined_audio::CombinedAudioService;

/// Audio recording mode
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RecordingMode {
    /// Record from microphone input (default CPAL behavior)
    Microphone,
    /// Record system audio via WASAPI loopback (Windows only)
    SystemLoopback,
    /// Record both microphone AND system audio mixed together (best for meetings)
    Combined,
}

impl Default for RecordingMode {
    fn default() -> Self {
        // Default to combined for meeting recording
        RecordingMode::Combined
    }
}

pub struct AudioRecordingService {
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
    stream: Arc<Mutex<Option<Stream>>>,
    recording_mode: Arc<StdMutex<RecordingMode>>,
    #[cfg(windows)]
    loopback_service: WasapiLoopbackService,
    #[cfg(windows)]
    combined_service: CombinedAudioService,
}

// Stream is not Send, so we need to wrap it
unsafe impl Send for AudioRecordingService {}
unsafe impl Sync for AudioRecordingService {}

impl AudioRecordingService {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            current_level: Arc::new(StdMutex::new(0.0)),
            stream: Arc::new(Mutex::new(None)),
            recording_mode: Arc::new(StdMutex::new(RecordingMode::default())),
            #[cfg(windows)]
            loopback_service: WasapiLoopbackService::new(),
            #[cfg(windows)]
            combined_service: CombinedAudioService::new(),
        }
    }

    /// Set the recording mode
    pub fn set_recording_mode(&self, mode: RecordingMode) -> AppResult<()> {
        let mut current_mode = self.recording_mode.lock()
            .map_err(|_| AppError::Custom("Failed to lock recording mode".to_string()))?;
        *current_mode = mode;
        Ok(())
    }

    /// Get the current recording mode
    pub fn get_recording_mode(&self) -> AppResult<RecordingMode> {
        let mode = self.recording_mode.lock()
            .map_err(|_| AppError::Custom("Failed to lock recording mode".to_string()))?;
        Ok(*mode)
    }

    pub async fn start_recording(&self, output_path: String, devices: RecordingDevices) -> AppResult<bool> {
        // Check if already recording
        if self.is_recording.load(Ordering::SeqCst) {
            return Err(AppError::Custom("Already recording".to_string()));
        }

        // Thread dédié : cpal y initialise COM (voir `audio_devices`).
        let checked = devices.clone();
        tokio::task::spawn_blocking(move || audio_devices::check_available(&checked))
            .await
            .map_err(|e| AppError::Custom(format!("Task join error: {}", e)))??;

        let mode = self.get_recording_mode()?;
        
        #[cfg(windows)]
        {
            if mode == RecordingMode::Combined {
                return self.start_combined_recording(output_path, devices).await;
            }
            if mode == RecordingMode::SystemLoopback {
                return self.start_loopback_recording(output_path, devices.output).await;
            }
        }

        // Fall back to microphone recording
        self.start_microphone_recording(output_path, devices.input).await
    }

    #[cfg(windows)]
    async fn start_combined_recording(&self, output_path: String, devices: RecordingDevices) -> AppResult<bool> {
        eprintln!("Starting combined recording (Mic + System Audio)...");
        
        // Mark as recording in our state
        self.is_recording.store(true, Ordering::SeqCst);
        
        match self.combined_service.start_recording(output_path, devices) {
            Ok(result) => Ok(result),
            Err(e) => {
                self.is_recording.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    #[cfg(windows)]
    async fn start_loopback_recording(&self, output_path: String, output_device: Option<String>) -> AppResult<bool> {
        eprintln!("Starting WASAPI loopback recording...");
        
        // Mark as recording in our state as well
        self.is_recording.store(true, Ordering::SeqCst);
        
        match self.loopback_service.start_recording(output_path, output_device) {
            Ok(result) => Ok(result),
            Err(e) => {
                self.is_recording.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    async fn start_microphone_recording(&self, output_path: String, input_device: Option<String>) -> AppResult<bool> {
        let is_recording = Arc::clone(&self.is_recording);
        let current_level = Arc::clone(&self.current_level);
        let stream_holder = Arc::clone(&self.stream);

        // Mark as recording
        is_recording.store(true, Ordering::SeqCst);

        // Run blocking CPAL operations in a separate thread
        let result = tokio::task::spawn_blocking(move || {
            // Ensure output directory exists
            let path = std::path::Path::new(&output_path);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| AppError::Custom(format!("Failed to create directory: {}", e)))?;
                }
            }

            let device = audio_devices::input_device(input_device.as_deref())?;

            // Get default config
            let config = device.default_input_config()
                .map_err(|e| AppError::Custom(format!("Failed to get device config: {}", e)))?;

            let sample_rate = config.sample_rate();
            let channels = config.channels() as u16;

            // Create WAV file writer
            let file = File::create(&output_path)
                .map_err(|e| AppError::Custom(format!("Failed to create file: {}", e)))?;
            let buffered = BufWriter::new(file);

            let spec = hound::WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };

            let writer = Arc::new(StdMutex::new(
                WavWriter::new(buffered, spec)
                    .map_err(|e| AppError::Custom(format!("Failed to create WAV writer: {}", e)))?
            ));

            let is_rec = Arc::clone(&is_recording);
            let level = Arc::clone(&current_level);
            let writer_clone = Arc::clone(&writer);

            // Create audio stream with appropriate sample type
            let stream: Stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    device.build_input_stream(
                        config.config(),
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            if !is_rec.load(Ordering::SeqCst) {
                                return;
                            }

                            // Calculate RMS level
                            let sum_squares: f32 = data.iter().map(|&s| s * s).sum();
                            let rms = (sum_squares / (data.len() as f32)).sqrt();

                            // Write samples to WAV file
                            if let Ok(mut writer_mut) = writer_clone.lock() {
                                for &sample in data.iter() {
                                    let scaled = (sample * i16::MAX as f32)
                                        .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                                    let _ = writer_mut.write_sample(scaled);
                                }
                            }

                            // Update level
                            if let Ok(mut lvl) = level.lock() {
                                *lvl = rms.clamp(0.0, 1.0);
                            }
                        },
                        move |err| {
                            eprintln!("Stream error: {}", err);
                        },
                        None,
                    )
                    .map_err(|e| AppError::Custom(format!("Failed to build stream: {}", e)))?
                }
                cpal::SampleFormat::I16 => {
                    device.build_input_stream(
                        config.config(),
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            if !is_rec.load(Ordering::SeqCst) {
                                return;
                            }

                            // Calculate RMS level
                            let sum_squares: f32 = data.iter()
                                .map(|&s| {
                                    let f = s as f32 / i16::MAX as f32;
                                    f * f
                                })
                                .sum();
                            let rms = (sum_squares / (data.len() as f32)).sqrt();

                            // Write samples
                            if let Ok(mut writer_mut) = writer_clone.lock() {
                                for &sample in data.iter() {
                                    let _ = writer_mut.write_sample(sample);
                                }
                            }

                            // Update level
                            if let Ok(mut lvl) = level.lock() {
                                *lvl = rms.clamp(0.0, 1.0);
                            }
                        },
                        move |err| {
                            eprintln!("Stream error: {}", err);
                        },
                        None,
                    )
                    .map_err(|e| AppError::Custom(format!("Failed to build stream: {}", e)))?
                }
                cpal::SampleFormat::U16 => {
                    device.build_input_stream(
                        config.config(),
                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                            if !is_rec.load(Ordering::SeqCst) {
                                return;
                            }

                            // Calculate RMS level
                            let sum_squares: f32 = data.iter()
                                .map(|&s| {
                                    let f = (s as i32 - 32768) as f32 / 32768.0;
                                    f * f
                                })
                                .sum();
                            let rms = (sum_squares / (data.len() as f32)).sqrt();

                            // Write samples (convert U16 to I16)
                            if let Ok(mut writer_mut) = writer_clone.lock() {
                                for &sample in data.iter() {
                                    let scaled = ((sample as i32) - 32768) as i16;
                                    let _ = writer_mut.write_sample(scaled);
                                }
                            }

                            // Update level
                            if let Ok(mut lvl) = level.lock() {
                                *lvl = rms.clamp(0.0, 1.0);
                            }
                        },
                        move |err| {
                            eprintln!("Stream error: {}", err);
                        },
                        None,
                    )
                    .map_err(|e| AppError::Custom(format!("Failed to build stream: {}", e)))?
                }
                _ => {
                    return Err(AppError::Custom("Unsupported audio sample format".to_string()));
                }
            };

            // Start the stream
            stream.play()
                .map_err(|e| AppError::Custom(format!("Failed to play stream: {}", e)))?;

            Ok::<Stream, AppError>(stream)
        }).await.map_err(|e| AppError::Custom(format!("Task join error: {}", e)))?;

        match result {
            Ok(stream) => {
                // Store stream
                let mut stream_lock = stream_holder.lock().await;
                *stream_lock = Some(stream);
                Ok(true)
            }
            Err(e) => {
                self.is_recording.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    pub async fn stop_recording(&self) -> AppResult<()> {
        let mode = self.get_recording_mode()?;
        
        self.is_recording.store(false, Ordering::SeqCst);

        #[cfg(windows)]
        {
            if mode == RecordingMode::Combined {
                return self.combined_service.stop_recording();
            }
            if mode == RecordingMode::SystemLoopback {
                return self.loopback_service.stop_recording();
            }
        }

        // Drop the stream (which also closes it)
        let mut stream_lock = self.stream.lock().await;
        *stream_lock = None;

        Ok(())
    }

    pub async fn get_audio_level(&self) -> AppResult<f32> {
        let mode = self.get_recording_mode()?;
        
        #[cfg(windows)]
        {
            if mode == RecordingMode::Combined {
                return self.combined_service.get_audio_level();
            }
            if mode == RecordingMode::SystemLoopback {
                return self.loopback_service.get_audio_level();
            }
        }
        
        let level = self.current_level.lock()
            .map_err(|_| AppError::Custom("Failed to lock level".to_string()))?;
        Ok(*level)
    }

    pub async fn test_audio_devices(&self) -> AppResult<bool> {
        let mode = self.get_recording_mode()?;
        
        #[cfg(windows)]
        {
            if mode == RecordingMode::Combined {
                return CombinedAudioService::test_devices();
            }
            if mode == RecordingMode::SystemLoopback {
                return WasapiLoopbackService::test_loopback_device();
            }
        }
        
        let host = cpal::default_host();
        
        match host.default_input_device() {
            Some(device) => {
                match device.default_input_config() {
                    Ok(config) => {
                        eprintln!("✓ Audio device found: {:?}", device.description().map(|d| d.name().to_string()));
                        eprintln!("  Sample Rate: {}", config.sample_rate());
                        eprintln!("  Channels: {}", config.channels());
                        eprintln!("  Sample Format: {:?}", config.sample_format());
                        Ok(true)
                    }
                    Err(e) => {
                        eprintln!("✗ Failed to get device config: {}", e);
                        Ok(false)
                    }
                }
            }
            None => {
                eprintln!("✗ No audio input device found");
                Ok(false)
            }
        }
    }
}

impl Default for AudioRecordingService {
    fn default() -> Self {
        Self::new()
    }
}
