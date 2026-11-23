//! Capture combinée sous Windows : micro ET son du PC (loopback) en même temps.
//!
//! Les deux sources ne sont pas mélangées : chacune est ramenée en mono et écrite sur son
//! propre canal du WAV, micro à gauche et son du PC à droite (voir `dual_channel`). La
//! transcription s'en sert pour attribuer chaque segment à « moi » ou aux « autres ».

#![cfg(windows)]

use crate::error::{AppError, AppResult};
use crate::services::audio_devices::{self, RecordingDevices};
use crate::services::dual_channel::DualChannelWavWriter;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;

use windows::{
    Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    },
    Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    },
    Win32::System::Threading::Sleep,
};

/// Fréquence d'écriture du WAV.
const SAMPLE_RATE: u32 = 48_000;
/// Avance gardée sur chaque source avant de l'écrire : absorbe l'irrégularité des paquets.
const LATENCY_SAMPLES: usize = SAMPLE_RATE as usize / 10; // 100 ms
/// Écart d'avance toléré avant de compenser la dérive d'horloge d'un périphérique.
const DRIFT_TOLERANCE: usize = SAMPLE_RATE as usize / 25; // 40 ms
/// Au-delà, les plus anciens échantillons sont abandonnés (boucle d'écriture bloquée).
const MAX_BUFFERED_SAMPLES: usize = SAMPLE_RATE as usize * 2; // 2 s
/// Plafond d'un tour d'écriture : après une suspension du processus, on n'écrit pas
/// des minutes de silence d'un coup.
const MAX_SAMPLES_PER_TICK: usize = SAMPLE_RATE as usize; // 1 s
/// Période de la boucle d'écriture.
const WRITE_INTERVAL: Duration = Duration::from_millis(20);

/// File d'attente d'une source (micro ou son du PC), mono 48 kHz.
///
/// Les paquets arrivent irrégulièrement ; la boucle d'écriture en tire à chaque tour le
/// nombre d'échantillons écoulés à l'horloge, pour les deux sources à la fois.
struct SourceBuffer {
    samples: VecDeque<f32>,
    /// La source a assez d'avance pour être lue (sinon : silence).
    primed: bool,
}

impl SourceBuffer {
    fn new() -> Self {
        Self { samples: VecDeque::with_capacity(MAX_BUFFERED_SAMPLES), primed: false }
    }

    fn push(&mut self, samples: &[f32]) {
        self.samples.extend(samples);
        let excess = self.samples.len().saturating_sub(MAX_BUFFERED_SAMPLES);
        self.samples.drain(..excess);
    }

    /// Ajoute exactement `n` échantillons à `out`.
    ///
    /// Silence tant que la source n'a pas `LATENCY_SAMPLES` d'avance : au démarrage, et quand
    /// le son du PC reprend (WASAPI n'envoie rien quand rien n'est joué). Les deux canaux
    /// gardent ainsi le même retard et restent alignés. Si l'avance dérive (horloge du
    /// périphérique un peu plus rapide ou plus lente que celle du PC), quelques échantillons
    /// sont sautés ou répétés à chaque tour, sans coupure audible.
    fn take_into(&mut self, n: usize, out: &mut Vec<f32>) {
        if !self.primed {
            if self.samples.len() < LATENCY_SAMPLES {
                out.extend(std::iter::repeat(0.0).take(n));
                return;
            }
            self.primed = true;
        }

        let step = (n / 64).max(1);
        let len = self.samples.len();
        let mut take = n;
        if len > LATENCY_SAMPLES + DRIFT_TOLERANCE {
            let skip = (len - LATENCY_SAMPLES).min(step);
            self.samples.drain(..skip);
        } else if len + DRIFT_TOLERANCE < LATENCY_SAMPLES && len >= n {
            take = n - step.min(n);
        }

        let available = take.min(self.samples.len());
        out.extend(self.samples.drain(..available));
        if available < take {
            // Source tarie (le son du PC s'est arrêté) : silence, puis réamorçage.
            out.extend(std::iter::repeat(0.0).take(n - available));
            self.primed = false;
        } else {
            let last = out.last().copied().unwrap_or(0.0);
            out.extend(std::iter::repeat(last).take(n - take));
        }
    }
}

/// Files d'attente des deux sources, partagées entre les threads de capture et d'écriture.
struct AudioMixer {
    microphone: SourceBuffer,
    system: SourceBuffer,
}

impl AudioMixer {
    fn new() -> Self {
        Self { microphone: SourceBuffer::new(), system: SourceBuffer::new() }
    }
}

/// Ramène un paquet entrelacé à un seul canal (moyenne des canaux), puis à 48 kHz
/// (plus proche voisin).
fn to_mono(data: &[f32], channels: usize, resample_ratio: f64) -> Vec<f32> {
    let channels = channels.max(1);
    let mono: Vec<f32> = if channels == 1 {
        data.to_vec()
    } else {
        data.chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    if mono.is_empty() || (resample_ratio - 1.0).abs() < 0.001 {
        return mono;
    }
    let output_len = (mono.len() as f64 * resample_ratio) as usize;
    (0..output_len)
        .map(|i| mono[((i as f64 / resample_ratio) as usize).min(mono.len() - 1)])
        .collect()
}

/// Combined audio recording service (Mic + System Audio)
pub struct CombinedAudioService {
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
    recording_thread: Arc<StdMutex<Option<thread::JoinHandle<()>>>>,
    mic_stream: Arc<StdMutex<Option<Stream>>>,
}

unsafe impl Send for CombinedAudioService {}
unsafe impl Sync for CombinedAudioService {}

impl CombinedAudioService {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            current_level: Arc::new(StdMutex::new(0.0)),
            recording_thread: Arc::new(StdMutex::new(None)),
            mic_stream: Arc::new(StdMutex::new(None)),
        }
    }

    /// Start combined recording (mic + system audio)
    pub fn start_recording(&self, output_path: String, devices: RecordingDevices) -> AppResult<bool> {
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

        is_recording.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            if let Err(e) = run_combined_capture(output_path, devices, is_recording, current_level) {
                eprintln!("Combined capture error: {}", e);
            }
        });

        if let Ok(mut thread_lock) = self.recording_thread.lock() {
            *thread_lock = Some(handle);
        }

        Ok(true)
    }

    /// Stop combined recording
    pub fn stop_recording(&self) -> AppResult<()> {
        self.is_recording.store(false, Ordering::SeqCst);

        // Wait for recording thread to finish
        if let Ok(mut thread_lock) = self.recording_thread.lock() {
            if let Some(handle) = thread_lock.take() {
                let _ = handle.join();
            }
        }

        // Reset audio level
        if let Ok(mut level) = self.current_level.lock() {
            *level = 0.0;
        }

        Ok(())
    }

    /// Get combined audio level
    pub fn get_audio_level(&self) -> AppResult<f32> {
        let level = self.current_level.lock()
            .map_err(|_| AppError::AudioError("Failed to lock level".to_string()))?;
        Ok(*level)
    }

    /// Test if combined capture is available
    pub fn test_devices() -> AppResult<bool> {
        // Test microphone
        let host = cpal::default_host();
        let mic_available = host.default_input_device().is_some();
        
        if !mic_available {
            eprintln!("✗ No microphone available");
            return Ok(false);
        }
        eprintln!("✓ Microphone available");

        // Test loopback (via WASAPI)
        unsafe {
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr != windows::Win32::Foundation::CO_E_ALREADYINITIALIZED {
                return Err(AppError::AudioError(format!("COM initialization failed: {:?}", hr)));
            }

            let result = (|| -> AppResult<bool> {
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| AppError::AudioError(format!("Failed to create device enumerator: {}", e)))?;

                let _device: IMMDevice = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| AppError::AudioError(format!("No audio output device: {}", e)))?;

                eprintln!("✓ System audio loopback available");
                Ok(true)
            })();

            CoUninitialize();
            result
        }
    }
}

impl Default for CombinedAudioService {
    fn default() -> Self {
        Self::new()
    }
}

/// Run combined audio capture
fn run_combined_capture(
    output_path: String,
    devices: RecordingDevices,
    is_recording: Arc<AtomicBool>,
    current_level: Arc<StdMutex<f32>>,
) -> AppResult<()> {
    eprintln!("Starting combined audio capture (Mic + System Audio)...");

    // Shared mixer for both audio sources
    let mixer = Arc::new(StdMutex::new(AudioMixer::new()));
    let target_sample_rate = SAMPLE_RATE;

    // Start microphone capture in a separate thread
    let mic_mixer = Arc::clone(&mixer);
    let mic_is_recording = Arc::clone(&is_recording);
    
    let RecordingDevices { input: input_device, output: output_device } = devices;
    let mic_thread = thread::spawn(move || {
        if let Err(e) = capture_microphone(mic_mixer, mic_is_recording, target_sample_rate, input_device) {
            eprintln!("Microphone capture error: {}", e);
        }
    });

    // Start loopback capture in a separate thread
    let loopback_mixer = Arc::clone(&mixer);
    let loopback_is_recording = Arc::clone(&is_recording);
    
    let loopback_thread = thread::spawn(move || {
        if let Err(e) = capture_loopback(loopback_mixer, loopback_is_recording, target_sample_rate, output_device) {
            eprintln!("Loopback capture error: {}", e);
        }
    });

    // Écriture : micro à gauche, son du PC à droite.
    let mut wav_writer = DualChannelWavWriter::create(std::path::Path::new(&output_path), SAMPLE_RATE)
        .map_err(|e| AppError::AudioError(format!("Failed to create file: {}", e)))?;

    eprintln!("Combined recording started: {}", output_path);

    // À chaque tour, on écrit autant d'échantillons que le temps écoulé à l'horloge du PC :
    // la durée du fichier suit le temps réel et les deux canaux restent alignés.
    let started = Instant::now();
    let mut clock_samples: u64 = 0;
    let mut microphone = Vec::with_capacity(MAX_SAMPLES_PER_TICK);
    let mut system = Vec::with_capacity(MAX_SAMPLES_PER_TICK);

    while is_recording.load(Ordering::SeqCst) {
        thread::sleep(WRITE_INTERVAL);

        let due = (started.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
        let n = (due.saturating_sub(clock_samples) as usize).min(MAX_SAMPLES_PER_TICK);
        clock_samples = due;
        if n == 0 {
            continue;
        }

        microphone.clear();
        system.clear();
        match mixer.lock() {
            Ok(mut mix) => {
                mix.microphone.take_into(n, &mut microphone);
                mix.system.take_into(n, &mut system);
            }
            Err(_) => continue,
        }

        let mut sum_squares = 0.0f32;
        for (&mic, &sys) in microphone.iter().zip(&system) {
            let _ = wav_writer.write_frame(mic, sys);
            // Niveau affiché (et détection de silence) : les deux sources ensemble.
            let mixed = (mic + sys).clamp(-1.0, 1.0);
            sum_squares += mixed * mixed;
        }
        if let Ok(mut level) = current_level.lock() {
            *level = (sum_squares / n as f32).sqrt().clamp(0.0, 1.0);
        }
    }

    // Wait for capture threads to finish
    let _ = mic_thread.join();
    let _ = loopback_thread.join();

    // Finalize WAV file
    wav_writer.finalize()
        .map_err(|e| AppError::AudioError(format!("Failed to finalize WAV: {}", e)))?;

    eprintln!("Combined recording stopped");
    Ok(())
}

/// Capture microphone audio
fn capture_microphone(
    mixer: Arc<StdMutex<AudioMixer>>,
    is_recording: Arc<AtomicBool>,
    target_sample_rate: u32,
    input_device: Option<String>,
) -> AppResult<()> {
    let device = audio_devices::input_device(input_device.as_deref())?;

    let config = device.default_input_config()
        .map_err(|e| AppError::AudioError(format!("Failed to get mic config: {}", e)))?;

    let source_sample_rate = config.sample_rate();
    let source_channels = config.channels() as usize;
    
    eprintln!("Microphone: {}Hz, {} channels", source_sample_rate, source_channels);

    // Calculate resampling ratio if needed
    let resample_ratio = target_sample_rate as f64 / source_sample_rate as f64;

    let mixer_clone = Arc::clone(&mixer);
    let is_rec = Arc::clone(&is_recording);

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            device.build_input_stream(
                config.config(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !is_rec.load(Ordering::SeqCst) {
                        return;
                    }
                    process_mic_samples(data, source_channels, resample_ratio, &mixer_clone);
                },
                |err| eprintln!("Mic stream error: {}", err),
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            device.build_input_stream(
                config.config(),
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !is_rec.load(Ordering::SeqCst) {
                        return;
                    }
                    // Convert to f32
                    let float_data: Vec<f32> = data.iter()
                        .map(|&s| s as f32 / i16::MAX as f32)
                        .collect();
                    process_mic_samples(&float_data, source_channels, resample_ratio, &mixer_clone);
                },
                |err| eprintln!("Mic stream error: {}", err),
                None,
            )
        }
        _ => {
            return Err(AppError::AudioError("Unsupported mic format".to_string()));
        }
    }.map_err(|e| AppError::AudioError(format!("Failed to build mic stream: {}", e)))?;

    stream.play()
        .map_err(|e| AppError::AudioError(format!("Failed to start mic stream: {}", e)))?;

    // Keep stream alive while recording
    while is_recording.load(Ordering::SeqCst) {
        thread::sleep(std::time::Duration::from_millis(100));
    }

    drop(stream);
    Ok(())
}

/// Ramène un paquet du micro en mono 48 kHz et l'ajoute à sa file d'attente.
fn process_mic_samples(
    data: &[f32],
    source_channels: usize,
    resample_ratio: f64,
    mixer: &Arc<StdMutex<AudioMixer>>,
) {
    let mono = to_mono(data, source_channels, resample_ratio);
    if let Ok(mut mix) = mixer.lock() {
        mix.microphone.push(&mono);
    }
}

/// Capture loopback (system) audio
fn capture_loopback(
    mixer: Arc<StdMutex<AudioMixer>>,
    is_recording: Arc<AtomicBool>,
    target_sample_rate: u32,
    output_device: Option<String>,
) -> AppResult<()> {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != windows::Win32::Foundation::CO_E_ALREADYINITIALIZED {
            return Err(AppError::AudioError(format!("COM initialization failed: {:?}", hr)));
        }

        let result = capture_loopback_impl(mixer, is_recording, target_sample_rate, output_device.as_deref());

        CoUninitialize();
        result
    }
}

/// Loopback capture implementation
unsafe fn capture_loopback_impl(
    mixer: Arc<StdMutex<AudioMixer>>,
    is_recording: Arc<AtomicBool>,
    target_sample_rate: u32,
    output_device: Option<&str>,
) -> AppResult<()> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| AppError::AudioError(format!("Failed to create device enumerator: {}", e)))?;

    let device = audio_devices::render_endpoint(&enumerator, output_device)?;

    let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)
        .map_err(|e| AppError::AudioError(format!("Failed to activate audio client: {}", e)))?;

    let mix_format = audio_client.GetMixFormat()
        .map_err(|e| AppError::AudioError(format!("Failed to get mix format: {}", e)))?;

    let format = &*mix_format;
    let source_sample_rate = format.nSamplesPerSec;
    let source_channels = format.nChannels as usize;
    let bits_per_sample = format.wBitsPerSample;
    let format_tag = format.wFormatTag;
    let cb_size = format.cbSize;

    eprintln!("System audio: {}Hz, {} channels, {}-bit", 
        source_sample_rate, source_channels, bits_per_sample);

    let resample_ratio = target_sample_rate as f64 / source_sample_rate as f64;

    let buffer_duration: i64 = 1_000_000; // 100ms

    audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        buffer_duration,
        0,
        mix_format,
        None,
    ).map_err(|e| AppError::AudioError(format!("Failed to initialize audio client: {}", e)))?;

    let capture_client: IAudioCaptureClient = audio_client.GetService()
        .map_err(|e| AppError::AudioError(format!("Failed to get capture client: {}", e)))?;

    audio_client.Start()
        .map_err(|e| AppError::AudioError(format!("Failed to start audio client: {}", e)))?;

    let is_float = is_float_format(format_tag, cb_size, mix_format);

    while is_recording.load(Ordering::SeqCst) {
        let packet_size = match capture_client.GetNextPacketSize() {
            Ok(size) => size,
            Err(_) => {
                Sleep(10);
                continue;
            }
        };

        if packet_size == 0 {
            Sleep(10);
            continue;
        }

        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut frames_available: u32 = 0;
        let mut flags: u32 = 0;

        if capture_client.GetBuffer(&mut data_ptr, &mut frames_available, &mut flags, None, None).is_err() {
            continue;
        }

        if frames_available > 0 && !data_ptr.is_null() {
            // Paquet marqué silencieux : son contenu n'est pas garanti, on écrit du silence.
            let float_samples = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                vec![0.0; frames_available as usize * source_channels]
            } else {
                convert_to_float(
                    data_ptr,
                    frames_available as usize,
                    source_channels,
                    bits_per_sample,
                    is_float,
                )
            };

            let mono = to_mono(&float_samples, source_channels, resample_ratio);
            if let Ok(mut mix) = mixer.lock() {
                mix.system.push(&mono);
            }
        }

        let _ = capture_client.ReleaseBuffer(frames_available);
    }

    let _ = audio_client.Stop();
    windows::Win32::System::Com::CoTaskMemFree(Some(mix_format as *const _ as *const _));

    Ok(())
}

/// Convert raw audio data to float samples
unsafe fn convert_to_float(
    data_ptr: *const u8,
    frames: usize,
    channels: usize,
    bits: u16,
    is_float: bool,
) -> Vec<f32> {
    let total_samples = frames * channels;

    if is_float && bits == 32 {
        let samples = std::slice::from_raw_parts(data_ptr as *const f32, total_samples);
        samples.iter().map(|&s| s.clamp(-1.0, 1.0)).collect()
    } else if bits == 16 {
        let samples = std::slice::from_raw_parts(data_ptr as *const i16, total_samples);
        samples.iter().map(|&s| s as f32 / i16::MAX as f32).collect()
    } else if bits == 24 {
        let bytes = std::slice::from_raw_parts(data_ptr, total_samples * 3);
        bytes.chunks(3)
            .map(|chunk| {
                if chunk.len() == 3 {
                    let value = ((chunk[0] as i32) | 
                                ((chunk[1] as i32) << 8) | 
                                ((chunk[2] as i32) << 16)) << 8 >> 8;
                    value as f32 / (1 << 23) as f32
                } else {
                    0.0
                }
            })
            .collect()
    } else if bits == 32 && !is_float {
        let samples = std::slice::from_raw_parts(data_ptr as *const i32, total_samples);
        samples.iter().map(|&s| s as f32 / i32::MAX as f32).collect()
    } else {
        vec![0.0; total_samples]
    }
}

/// Check if format is floating point
unsafe fn is_float_format(format_tag: u16, cb_size: u16, format_ptr: *const WAVEFORMATEX) -> bool {
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

    if format_tag == WAVE_FORMAT_IEEE_FLOAT {
        return true;
    }

    if format_tag == WAVE_FORMAT_EXTENSIBLE && cb_size >= 22 {
        let ext = format_ptr as *const WAVEFORMATEXTENSIBLE;
        let sub_format = (*ext).SubFormat;
        
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

    fn mixer() -> Arc<StdMutex<AudioMixer>> {
        Arc::new(StdMutex::new(AudioMixer::new()))
    }

    fn mic_samples(mixer: &Arc<StdMutex<AudioMixer>>) -> Vec<f32> {
        mixer.lock().unwrap().microphone.samples.iter().copied().collect()
    }

    /// Un tour d'écriture de `n` échantillons.
    fn take(buffer: &mut SourceBuffer, n: usize) -> Vec<f32> {
        let mut out = Vec::new();
        buffer.take_into(n, &mut out);
        assert_eq!(out.len(), n, "un tour rend toujours le nombre demandé");
        out
    }

    #[test]
    fn mono_input_is_kept_as_is() {
        assert_eq!(to_mono(&[0.1, 0.2, 0.3], 1, 1.0), [0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_and_multichannel_input_is_averaged() {
        assert_eq!(to_mono(&[0.2, 0.4, -1.0, 1.0], 2, 1.0), [0.3, 0.0]);
        assert_eq!(to_mono(&[1.0, 2.0, 3.0, 6.0, 0.0, 0.0, 0.0, 4.0], 4, 1.0), [3.0, 1.0]);
    }

    #[test]
    fn resampling_scales_the_number_of_samples() {
        assert_eq!(to_mono(&[1.0, 2.0], 1, 2.0), [1.0, 1.0, 2.0, 2.0]);
        assert_eq!(to_mono(&[1.0, 2.0, 3.0, 4.0], 1, 0.5), [1.0, 3.0]);
        // Rééchantillonnage après la mise en mono : les canaux ne se décalent jamais.
        assert_eq!(to_mono(&[1.0, -1.0, 2.0, -2.0], 2, 2.0), [0.0; 4]);
        assert!(to_mono(&[], 2, 2.0).is_empty());
    }

    #[test]
    fn microphone_packets_go_to_the_microphone_buffer_only() {
        let mixer = mixer();
        process_mic_samples(&[0.2, 0.4], 2, 1.0, &mixer);
        assert_eq!(mic_samples(&mixer), [0.3]);
        assert!(mixer.lock().unwrap().system.samples.is_empty());
    }

    #[test]
    fn buffer_is_capped_keeping_the_newest_samples() {
        let mut buffer = SourceBuffer::new();
        let data: Vec<f32> = (0..MAX_BUFFERED_SAMPLES + 10).map(|i| i as f32).collect();
        buffer.push(&data);
        assert_eq!(buffer.samples.len(), MAX_BUFFERED_SAMPLES);
        assert_eq!(buffer.samples[0], 10.0, "les plus anciens échantillons sont éliminés");
    }

    #[test]
    fn source_is_silent_until_it_has_enough_lead() {
        let mut buffer = SourceBuffer::new();
        buffer.push(&vec![0.5; LATENCY_SAMPLES - 1]);
        assert!(take(&mut buffer, 960).iter().all(|&s| s == 0.0));
        assert_eq!(buffer.samples.len(), LATENCY_SAMPLES - 1, "rien n'est consommé avant l'amorçage");

        buffer.push(&[0.5]);
        assert!(take(&mut buffer, 960).iter().all(|&s| s == 0.5));
    }

    #[test]
    fn primed_source_is_passed_through_in_order() {
        let mut buffer = SourceBuffer::new();
        let data: Vec<f32> = (0..LATENCY_SAMPLES + 960).map(|i| i as f32).collect();
        buffer.push(&data);
        assert_eq!(take(&mut buffer, 960), data[..960]);
        assert_eq!(take(&mut buffer, 960), data[960..1920]);
    }

    #[test]
    fn dried_up_source_pads_with_silence_then_primes_again() {
        let mut buffer = SourceBuffer::new();
        buffer.push(&vec![0.5; LATENCY_SAMPLES]);
        assert!(take(&mut buffer, LATENCY_SAMPLES).iter().all(|&s| s == 0.5));
        // Plus rien en attente : silence, et la source attend de nouveau son avance.
        assert!(take(&mut buffer, 960).iter().all(|&s| s == 0.0));
        assert!(!buffer.primed);
        buffer.push(&vec![0.7; 960]);
        assert!(take(&mut buffer, 960).iter().all(|&s| s == 0.0));
    }

    #[test]
    fn excess_lead_is_trimmed_a_little_at_each_turn() {
        let mut buffer = SourceBuffer::new();
        buffer.push(&vec![0.5; LATENCY_SAMPLES + DRIFT_TOLERANCE + 1000]);
        let before = buffer.samples.len();
        take(&mut buffer, 960);
        assert_eq!(before - buffer.samples.len(), 960 + 960 / 64);
    }

    #[test]
    fn missing_lead_is_rebuilt_by_repeating_the_last_sample() {
        let mut buffer = SourceBuffer::new();
        buffer.push(&vec![0.5; LATENCY_SAMPLES]);
        buffer.primed = true;
        buffer.samples.truncate(LATENCY_SAMPLES - DRIFT_TOLERANCE - 1);
        let before = buffer.samples.len();
        let out = take(&mut buffer, 960);
        assert_eq!(before - buffer.samples.len(), 960 - 960 / 64);
        assert!(out.iter().all(|&s| s == 0.5));
    }
}
