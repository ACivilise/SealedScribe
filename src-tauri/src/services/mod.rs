pub mod audio;
pub mod audio_devices;
pub mod transcription;
pub mod storage;
pub mod summary;
pub mod diarization;
pub mod export;
pub mod jobs;
pub mod secrets;
pub mod audio_prep;
pub mod dual_channel;
pub mod local_diarization;
pub mod speaker_clustering;
pub mod speaker_embedding;
pub mod hardware;
pub mod local_whisper;
pub mod mistral;
pub mod checkpoint;
pub mod power;
pub mod recording_watch;
pub mod shutdown;

#[cfg(windows)]
pub mod wasapi_loopback;

#[cfg(windows)]
pub mod combined_audio;

pub use audio::AudioRecordingService;
pub use transcription::TranscriptionService;
pub use storage::StorageService;
pub use summary::SummaryService;
pub use diarization::DiarizationService;
pub use export::ExportService;
pub use jobs::JobManager;
pub use local_whisper::LocalWhisperService;

#[cfg(windows)]
pub use wasapi_loopback::WasapiLoopbackService;

#[cfg(windows)]
pub use combined_audio::CombinedAudioService;
