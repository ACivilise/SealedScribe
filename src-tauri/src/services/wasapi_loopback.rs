//! WASAPI Loopback Capture for Windows
//!
//! This module provides system audio loopback capture using Windows Audio Session API (WASAPI).
//! It captures audio output from the system (what you hear through speakers/headphones)
//! rather than microphone input.

#![cfg(windows)]

use crate::error::{AppError, AppResult};
use crate::services::audio_devices;
use hound::{WavSpec, WavWriter};
use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;

use windows::{
    Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    },
    Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    },
    Win32::System::Threading::Sleep,
};

/// Audio format information for WAV file writing
#[derive(Debug, Clone)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 2,
            bits_per_sample: 16,
        }
    }
}

/// WASAPI Loopback recording service
pub struct WasapiLoopbackService {
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
    recording_thread: Arc<StdMutex<Option<thread::JoinHandle<()>>>>,
    current_format: Arc<StdMutex<AudioFormat>>,
}

// Stream is not Send, so we need to wrap it
unsafe impl Send for WasapiLoopbackService {}
unsafe impl Sync for WasapiLoopbackService {}

impl WasapiLoopbackService {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            current_level: Arc::new(StdMutex::new(0.0)),
            recording_thread: Arc::new(StdMutex::new(None)),
            current_format: Arc::new(StdMutex::new(AudioFormat::default())),
        }
    }

    /// Start loopback recording to a WAV file (`output_device` : sortie choisie, sinon celle par défaut)
    pub fn start_recording(&self, output_path: String, output_device: Option<String>) -> AppResult<bool> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err(AppError::AudioError("Already recording".to_string()));
        }

        // Ensure output directory exists
        let path = std::path::Path::new(&output_path);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::AudioError(format!("Failed to create directory: {}", e)))?;
            }
        }

        let is_recording = Arc::clone(&self.is_recording);
        let current_level = Arc::clone(&self.current_level);
        let current_format = Arc::clone(&self.current_format);

        is_recording.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            if let Err(e) = capture_loopback_audio(output_path, output_device, is_recording, current_level, current_format) {
                eprintln!("Loopback capture error: {}", e);
            }
        });

        // Store thread handle for later cleanup
        if let Ok(mut thread_lock) = self.recording_thread.lock() {
            *thread_lock = Some(handle);
        }

        Ok(true)
    }

    /// Stop the current loopback recording
    pub fn stop_recording(&self) -> AppResult<()> {
        self.is_recording.store(false, Ordering::SeqCst);

        // Wait for recording thread to finish
        if let Ok(mut thread_lock) = self.recording_thread.lock() {
            if let Some(handle) = thread_lock.take() {
                // Wait with timeout
                let _ = handle.join();
            }
        }

        // Reset audio level
        if let Ok(mut level) = self.current_level.lock() {
            *level = 0.0;
        }

        Ok(())
    }

    /// Get the current audio level (RMS, 0.0 to 1.0)
    pub fn get_audio_level(&self) -> AppResult<f32> {
        let level = self.current_level.lock()
            .map_err(|_| AppError::AudioError("Failed to lock level".to_string()))?;
        Ok(*level)
    }

    /// Get the current audio format
    pub fn get_audio_format(&self) -> AppResult<AudioFormat> {
        let format = self.current_format.lock()
            .map_err(|_| AppError::AudioError("Failed to lock format".to_string()))?;
        Ok(format.clone())
    }

    /// Test if loopback capture is available
    pub fn test_loopback_device() -> AppResult<bool> {
        unsafe {
            // Initialize COM
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr != windows::Win32::Foundation::CO_E_ALREADYINITIALIZED {
                return Err(AppError::AudioError(format!("COM initialization failed: {:?}", hr)));
            }

            let result = (|| -> AppResult<bool> {
                // Create device enumerator
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| AppError::AudioError(format!("Failed to create device enumerator: {}", e)))?;

                // Get default render (output) device
                let device: IMMDevice = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| AppError::AudioError(format!("Failed to get default audio endpoint: {}", e)))?;

                // Get device name for logging
                let device_id = device.GetId()
                    .map_err(|e| AppError::AudioError(format!("Failed to get device ID: {}", e)))?;

                let device_id_str = device_id.to_string().unwrap_or_else(|_| "Unknown".to_string());
                eprintln!("✓ Default output device: {}", device_id_str);

                // Try to activate audio client
                let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)
                    .map_err(|e| AppError::AudioError(format!("Failed to activate audio client: {}", e)))?;

                // Get mix format
                let mix_format = audio_client.GetMixFormat()
                    .map_err(|e| AppError::AudioError(format!("Failed to get mix format: {}", e)))?;

                let format = &*mix_format;
                // Copy packed struct fields to local variables to avoid unaligned access
                let sample_rate = format.nSamplesPerSec;
                let channels = format.nChannels;
                let bits = format.wBitsPerSample;
                eprintln!("  Sample Rate: {} Hz", sample_rate);
                eprintln!("  Channels: {}", channels);
                eprintln!("  Bits Per Sample: {}", bits);
                eprintln!("✓ Loopback capture available");

                // Free the format memory
                windows::Win32::System::Com::CoTaskMemFree(Some(mix_format as *const _ as *const _));

                Ok(true)
            })();

            CoUninitialize();
            result
        }
    }

}

impl Default for WasapiLoopbackService {
    fn default() -> Self {
        Self::new()
    }
}

/// Internal function to capture loopback audio
fn capture_loopback_audio(
    output_path: String,
    output_device: Option<String>,
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
    current_format: Arc<StdMutex<AudioFormat>>,
) -> AppResult<()> {
    unsafe {
        // Initialize COM for this thread
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != windows::Win32::Foundation::CO_E_ALREADYINITIALIZED {
            return Err(AppError::AudioError(format!("COM initialization failed: {:?}", hr)));
        }

        let result = capture_loopback_impl(output_path, output_device.as_deref(), is_recording, current_level, current_format);

        CoUninitialize();
        result
    }
}

/// Implementation of loopback capture
unsafe fn capture_loopback_impl(
    output_path: String,
    output_device: Option<&str>,
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
    current_format: Arc<StdMutex<AudioFormat>>,
) -> AppResult<()> {
    // Create device enumerator
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| AppError::AudioError(format!("Failed to create device enumerator: {}", e)))?;

    // Sortie choisie, ou celle par défaut
    let device = audio_devices::render_endpoint(&enumerator, output_device)?;

    // Activate audio client
    let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)
        .map_err(|e| AppError::AudioError(format!("Failed to activate audio client: {}", e)))?;

    // Get mix format
    let mix_format = audio_client.GetMixFormat()
        .map_err(|e| AppError::AudioError(format!("Failed to get mix format: {}", e)))?;

    let format_ptr = mix_format;
    let format = &*format_ptr;

    // Copy packed struct fields to local variables to avoid unaligned access
    let sample_rate = format.nSamplesPerSec;
    let channels = format.nChannels;
    let bits_per_sample = format.wBitsPerSample;
    let cb_size = format.cbSize;
    let format_tag = format.wFormatTag;

    // Store format info
    let audio_format = AudioFormat {
        sample_rate,
        channels,
        bits_per_sample: 16, // We'll convert to 16-bit for WAV
    };

    if let Ok(mut fmt) = current_format.lock() {
        *fmt = audio_format.clone();
    }

    eprintln!("Recording format: {}Hz, {} channels, {}-bit", 
        sample_rate, channels, bits_per_sample);

    // Calculate buffer duration (100ms in 100-nanosecond units)
    let buffer_duration: i64 = 1_000_000; // 100ms

    // Initialize audio client with loopback flag
    audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        buffer_duration,
        0,
        format_ptr,
        None,
    ).map_err(|e| AppError::AudioError(format!("Failed to initialize audio client: {}", e)))?;

    // Get capture client
    let capture_client: IAudioCaptureClient = audio_client.GetService()
        .map_err(|e| AppError::AudioError(format!("Failed to get capture client: {}", e)))?;

    // Create WAV writer
    let wav_spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let file = File::create(&output_path)
        .map_err(|e| AppError::AudioError(format!("Failed to create file: {}", e)))?;
    let buffered = BufWriter::new(file);

    let mut wav_writer = WavWriter::new(buffered, wav_spec)
        .map_err(|e| AppError::AudioError(format!("Failed to create WAV writer: {}", e)))?;

    // Start audio client
    audio_client.Start()
        .map_err(|e| AppError::AudioError(format!("Failed to start audio client: {}", e)))?;

    eprintln!("Loopback recording started: {}", output_path);

    // Capture loop - use the already copied local variables
    let source_bits = bits_per_sample;
    let source_channels = channels as usize;
    let is_float = is_float_format(format_tag, cb_size, format_ptr);

    while is_recording.load(Ordering::SeqCst) {
        // Get next packet size
        let packet_size = capture_client.GetNextPacketSize()
            .map_err(|e| AppError::AudioError(format!("Failed to get packet size: {}", e)))?;

        if packet_size == 0 {
            // No data available, sleep briefly
            Sleep(10);
            continue;
        }

        // Get buffer
        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut frames_available: u32 = 0;
        let mut flags: u32 = 0;

        capture_client.GetBuffer(
            &mut data_ptr,
            &mut frames_available,
            &mut flags,
            None,
            None,
        ).map_err(|e| AppError::AudioError(format!("Failed to get buffer: {}", e)))?;

        if frames_available > 0 && !data_ptr.is_null() {
            // Calculate RMS level
            let mut sum_squares: f32 = 0.0;
            let mut sample_count: usize = 0;

            // Convert and write samples based on source format
            if is_float && source_bits == 32 {
                // Source is 32-bit float
                let samples = std::slice::from_raw_parts(
                    data_ptr as *const f32,
                    (frames_available as usize) * source_channels,
                );

                for &sample in samples {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let scaled = (clamped * i16::MAX as f32) as i16;
                    let _ = wav_writer.write_sample(scaled);
                    
                    sum_squares += clamped * clamped;
                    sample_count += 1;
                }
            } else if source_bits == 16 {
                // Source is 16-bit integer
                let samples = std::slice::from_raw_parts(
                    data_ptr as *const i16,
                    (frames_available as usize) * source_channels,
                );

                for &sample in samples {
                    let _ = wav_writer.write_sample(sample);
                    
                    let normalized = sample as f32 / i16::MAX as f32;
                    sum_squares += normalized * normalized;
                    sample_count += 1;
                }
            } else if source_bits == 24 {
                // Source is 24-bit integer (packed in 3 bytes)
                let byte_count = (frames_available as usize) * source_channels * 3;
                let bytes = std::slice::from_raw_parts(data_ptr, byte_count);

                for chunk in bytes.chunks(3) {
                    if chunk.len() == 3 {
                        // Convert 24-bit to 32-bit signed, then scale to 16-bit
                        let value = ((chunk[0] as i32) | 
                                    ((chunk[1] as i32) << 8) | 
                                    ((chunk[2] as i32) << 16)) << 8 >> 8;
                        let scaled = (value >> 8) as i16;
                        let _ = wav_writer.write_sample(scaled);
                        
                        let normalized = value as f32 / (1 << 23) as f32;
                        sum_squares += normalized * normalized;
                        sample_count += 1;
                    }
                }
            } else if source_bits == 32 && !is_float {
                // Source is 32-bit integer
                let samples = std::slice::from_raw_parts(
                    data_ptr as *const i32,
                    (frames_available as usize) * source_channels,
                );

                for &sample in samples {
                    let scaled = (sample >> 16) as i16;
                    let _ = wav_writer.write_sample(scaled);
                    
                    let normalized = sample as f32 / i32::MAX as f32;
                    sum_squares += normalized * normalized;
                    sample_count += 1;
                }
            }

            // Update audio level
            if sample_count > 0 {
                let rms = (sum_squares / sample_count as f32).sqrt();
                if let Ok(mut lvl) = current_level.lock() {
                    *lvl = rms.clamp(0.0, 1.0);
                }
            }
        }

        // Release buffer
        capture_client.ReleaseBuffer(frames_available)
            .map_err(|e| AppError::AudioError(format!("Failed to release buffer: {}", e)))?;
    }

    // Stop audio client
    let _ = audio_client.Stop();

    // Finalize WAV file
    wav_writer.finalize()
        .map_err(|e| AppError::AudioError(format!("Failed to finalize WAV: {}", e)))?;

    // Free format memory
    windows::Win32::System::Com::CoTaskMemFree(Some(format_ptr as *const _ as *const _));

    eprintln!("Loopback recording stopped");
    Ok(())
}

/// Check if the audio format is floating point
/// Takes pre-extracted values to avoid packed struct access issues
unsafe fn is_float_format(format_tag: u16, cb_size: u16, format_ptr: *const WAVEFORMATEX) -> bool {
    // Check for WAVEFORMATEXTENSIBLE
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

    if format_tag == WAVE_FORMAT_IEEE_FLOAT {
        return true;
    }

    if format_tag == WAVE_FORMAT_EXTENSIBLE && cb_size >= 22 {
        let ext = format_ptr as *const WAVEFORMATEXTENSIBLE;
        let sub_format = (*ext).SubFormat;
        
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT GUID
        const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: windows::core::GUID = windows::core::GUID::from_u128(
            0x00000003_0000_0010_8000_00aa00389b71
        );
        
        return sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_audio_format_default() {
        let format = AudioFormat::default();
        assert_eq!(format.sample_rate, 48000);
        assert_eq!(format.channels, 2);
        assert_eq!(format.bits_per_sample, 16);
    }
}
