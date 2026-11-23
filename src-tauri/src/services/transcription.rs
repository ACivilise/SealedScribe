use crate::error::{AppError, AppResult};
use crate::models::{
    AzureSpeechRecognitionResult, TranscriptionConfig, TranscriptionResult, TranscriptionSegment,
};
use crate::services::checkpoint::{Checkpoint, ChunkResult};
use futures::stream::{FuturesUnordered, StreamExt};
use reqwest::{Client, StatusCode};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::default::{get_codecs, get_probe};
use tokio::sync::Mutex;

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgressEvent {
    pub phase: String,
    pub progress: u8,
    pub current_chunk: Option<usize>,
    pub total_chunks: Option<usize>,
    pub concurrency: Option<usize>,
    pub message: String,
    /// Moteur local : secondes d'audio déjà traitées et durée totale.
    pub processed_seconds: Option<f64>,
    pub total_seconds: Option<f64>,
    /// Moteur local, phase `loading-model` : secondes écoulées et durée attendue
    /// (dernier chargement mesuré, ou estimation d'après la taille du modèle).
    pub model_load_seconds: Option<f64>,
    pub model_load_expected_seconds: Option<f64>,
}

/// Ramène des échantillons PCM 16 bits entrelacés à un seul canal : somme des canaux pour
/// un enregistrement micro / son du PC (deux sources distinctes), moyenne sinon.
fn downmix_pcm16(data: &[u8], channels: u16, sum: bool) -> Vec<u8> {
    let channels = channels.max(1) as usize;
    let gain = if sum { 1.0 } else { 1.0 / channels as f32 };
    let mut out = Vec::with_capacity(data.len() / channels);
    for frame in data.chunks_exact(channels * 2) {
        let total: f32 = frame
            .chunks_exact(2)
            .map(|s| i16::from_le_bytes([s[0], s[1]]) as f32)
            .sum();
        let mixed = (total * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        out.extend_from_slice(&mixed.to_le_bytes());
    }
    out
}

/// Message d'erreur renvoyé quand un traitement est annulé par l'utilisateur.
pub const CANCELLED_MESSAGE: &str = "Transcription annulée";
/// Arrêt demandé après la partie en cours : le point de reprise est conservé.
pub const STOPPED_MESSAGE: &str = "Transcription arrêtée après la partie en cours";

fn check_cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(AppError::TranscriptionError(CANCELLED_MESSAGE.to_string()))
    } else {
        Ok(())
    }
}

/// Morceaux envoyés en même temps : `TRANSCRIPTION_CHUNK_CONCURRENCY`, 2 par défaut, entre 1 et 4.
fn configured_chunk_concurrency(configured: Option<&str>) -> usize {
    configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 4)
}

/// Plafond du délai demandé par Azure dans l'en-tête `Retry-After`.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Échec d'une requête de reconnaissance.
enum RecognizeError {
    /// 429 : Azure refuse la requête, trop de requêtes simultanées (le palier gratuit F0
    /// n'en accepte qu'une) ou trop rapprochées. `retry_after` : délai indiqué par Azure.
    Throttled { retry_after: Option<Duration>, error: AppError },
    Failed(AppError),
}

impl From<AppError> for RecognizeError {
    fn from(error: AppError) -> Self {
        Self::Failed(error)
    }
}

impl From<RecognizeError> for AppError {
    fn from(error: RecognizeError) -> Self {
        match error {
            RecognizeError::Throttled { error, .. } | RecognizeError::Failed(error) => error,
        }
    }
}

/// Service for transcribing audio files using Azure Speech Service REST API
pub struct TranscriptionService {
    client: Client,
    config: Arc<Mutex<Option<TranscriptionConfig>>>,
    /// Adresse de reconnaissance ; `None` : celle d'Azure pour la région configurée.
    endpoint: Option<String>,
    /// La clé a refusé des requêtes simultanées : les morceaux partent un par un
    /// jusqu'au prochain changement de clé.
    one_request_at_a_time: AtomicBool,
}

impl TranscriptionService {
    /// Create a new TranscriptionService
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(300)) // 5 minute timeout for long audio
                .build()
                .unwrap_or_else(|_| Client::new()),
            config: Arc::new(Mutex::new(None)),
            endpoint: None,
            one_request_at_a_time: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    fn with_endpoint(endpoint: &str) -> Self {
        Self { endpoint: Some(endpoint.to_string()), ..Self::new() }
    }

    /// Configure the transcription service with Azure credentials
    pub async fn configure(&self, config: TranscriptionConfig) -> AppResult<()> {
        let mut cfg = self.config.lock().await;
        *cfg = Some(config);
        // Nouvelle clé, peut-être d'un autre palier : on retente le parallèle.
        self.one_request_at_a_time.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Supprime les identifiants en mémoire
    pub async fn clear(&self) {
        *self.config.lock().await = None;
        self.one_request_at_a_time.store(false, Ordering::SeqCst);
    }

    /// Get the configuration
    async fn get_config(&self) -> AppResult<TranscriptionConfig> {
        let cfg = self.config.lock().await;
        cfg.clone().ok_or_else(|| {
            AppError::ConfigError("Azure Speech n'est pas configuré. Renseignez la clé dans Réglages.".to_string())
        })
    }

    /// Transcribe an audio file using Azure Speech Service REST API
    /// 
    /// # Arguments
    /// * `audio_path` - Path to the WAV audio file
    /// * `language` - Language code (e.g., "en-US", "fr-FR")
    /// 
    /// # Returns
    /// * `TranscriptionResult` containing segments and full text
    pub async fn transcribe_audio(
        &self,
        audio_path: String,
        language: String,
    ) -> AppResult<TranscriptionResult> {
        self.transcribe_audio_with_progress(
            audio_path,
            language,
            Arc::new(AtomicBool::new(false)),
            &Checkpoint::disabled(),
            |_| {},
        )
        .await
    }

    /// Transcribe with progress reporting. Setting `cancel` to `true` stops
    /// the processing before the next chunk is sent. Chaque morceau terminé est écrit
    /// dans `checkpoint` ; ceux qui y sont déjà ne sont pas renvoyés à Azure.
    pub async fn transcribe_audio_with_progress<F>(
        &self,
        audio_path: String,
        language: String,
        cancel: Arc<AtomicBool>,
        checkpoint: &Checkpoint,
        mut on_progress: F,
    ) -> AppResult<TranscriptionResult>
    where
        F: FnMut(TranscriptionProgressEvent) + Send,
    {
        on_progress(TranscriptionProgressEvent {
            phase: "preparing".to_string(),
            progress: 2,
            current_chunk: None,
            total_chunks: None,
            concurrency: None,
            message: "Preparing audio file...".to_string(),
            ..Default::default()
        });

        // Read and normalize audio input to WAV bytes for Azure Speech REST API
        let audio_bytes = self.load_audio_as_wav(&audio_path).await?;
        let sum_channels = crate::services::dual_channel::is_dual_channel(Path::new(&audio_path));

        // Les identifiants viennent uniquement du backend (keyring ou variables AZURE_*).
        let config = self.get_config().await?;

        // Check audio file size - Azure REST API has a 60-second limit for single requests
        // For longer audio, we need to use chunked processing or the batch API
        let audio_size = audio_bytes.len();
        
        // Durée lue dans l'en-tête WAV (un extrait mono 16 kHz fait 32 000 o/s, pas 176 400) ;
        // à défaut, hypothèse 44,1 kHz stéréo 16 bits.
        let estimated_duration = match self.parse_wav_header(&audio_bytes) {
            Ok((rate, channels, bits, offset)) if rate > 0 && channels > 0 && bits >= 8 => {
                (audio_size - offset) as f64 / (rate as f64 * channels as f64 * (bits as f64 / 8.0))
            }
            _ => audio_size as f64 / 176400.0,
        };
        
        if estimated_duration > 60.0 {
            // For long audio files, process in chunks
            self.transcribe_long_audio(&audio_bytes, &language, &config, sum_channels, &cancel, checkpoint, &mut on_progress)
                .await
        } else {
            // For short audio files, use single request
            check_cancelled(&cancel)?;
            let audio_bytes = match self.parse_wav_header(&audio_bytes) {
                Ok((rate, channels, bits, offset)) if bits == 16 && channels > 1 => {
                    self.mono_wav_chunk(&audio_bytes[offset..], rate, channels, bits, sum_channels)?
                }
                _ => audio_bytes,
            };
            on_progress(TranscriptionProgressEvent {
                phase: "transcribing".to_string(),
                progress: 25,
                current_chunk: Some(1),
                total_chunks: Some(1),
                concurrency: Some(1),
                message: "Transcribing chunk 1/1".to_string(),
                ..Default::default()
            });

            let result = self
                .transcribe_short_audio(&audio_bytes, &language, &config)
                .await
                .map_err(AppError::from)?;

            on_progress(TranscriptionProgressEvent {
                phase: "completed".to_string(),
                progress: 100,
                current_chunk: Some(1),
                total_chunks: Some(1),
                concurrency: Some(1),
                message: "Transcription complete".to_string(),
                ..Default::default()
            });

            Ok(result)
        }
    }

    /// Transcribe short audio files (< 60 seconds) using single REST API call
    async fn transcribe_short_audio(
        &self,
        audio_bytes: &[u8],
        language: &str,
        config: &TranscriptionConfig,
    ) -> Result<TranscriptionResult, RecognizeError> {
        let endpoint = self.endpoint.clone().unwrap_or_else(|| {
            format!(
                "https://{}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1",
                config.speech_region
            )
        });

        // Debug logging
        log::debug!("[Transcription] Endpoint: {}", endpoint);
        log::debug!("[Transcription] Region: {}", config.speech_region);
        log::debug!("[Transcription] Language: {}", language);
        log::debug!("[Transcription] Audio size: {} bytes", audio_bytes.len());

        let response = self
            .client
            .post(&endpoint)
            .header("Ocp-Apim-Subscription-Key", &config.speech_key)
            .header("Content-Type", "audio/wav; codecs=audio/pcm; samplerate=16000")
            .header("Accept", "application/json")
            .query(&[
                ("language", language),
                ("format", "detailed"),
                ("wordLevelTimestamps", "true"),
            ])
            .body(audio_bytes.to_vec())
            .send()
            .await
            .map_err(|e| AppError::HttpError(e))?;

        let status = response.status();
        log::debug!("[Transcription] Response status: {}", status);
        
        if !status.is_success() {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs);
            let error_text = response.text().await.unwrap_or_default();
            log::warn!("[Transcription] Error response: {}", error_text);
            let error = AppError::TranscriptionError(format!(
                "Azure Speech API returned status {}: {}",
                status, error_text
            ));
            return Err(if status == StatusCode::TOO_MANY_REQUESTS {
                RecognizeError::Throttled { retry_after, error }
            } else {
                RecognizeError::Failed(error)
            });
        }

        let result: AzureSpeechRecognitionResult = response
            .json()
            .await
            .map_err(|e| AppError::HttpError(e))?;

        Ok(self.parse_recognition_result(result, language)?)
    }

    /// Transcribe long audio files by processing in chunks
    async fn transcribe_long_audio(
        &self,
        audio_bytes: &[u8],
        language: &str,
        config: &TranscriptionConfig,
        sum_channels: bool,
        cancel: &AtomicBool,
        checkpoint: &Checkpoint,
        on_progress: &mut impl FnMut(TranscriptionProgressEvent),
    ) -> AppResult<TranscriptionResult> {
        // Parse WAV header to get audio parameters
        let (sample_rate, channels, bits_per_sample, data_offset) =
            self.parse_wav_header(audio_bytes)?;

        let bytes_per_sample = bits_per_sample as usize / 8;
        let bytes_per_second = sample_rate as usize * channels as usize * bytes_per_sample;
        
        // Process in 30-second chunks (to stay well under the 60-second limit)
        let chunk_duration_secs = 30;
        let chunk_size = bytes_per_second * chunk_duration_secs;
        
        let audio_data = &audio_bytes[data_offset..];
        let total_chunks = (audio_data.len() + chunk_size - 1) / chunk_size;
        let mut chunk_concurrency = if self.one_request_at_a_time.load(Ordering::SeqCst) {
            1
        } else {
            configured_chunk_concurrency(std::env::var("TRANSCRIPTION_CHUNK_CONCURRENCY").ok().as_deref())
        };
        let mut all_segments: Vec<TranscriptionSegment> = Vec::new();
        let mut full_text = String::new();
        let mut completed_chunks = 0usize;
        checkpoint.begin(total_chunks);

        on_progress(TranscriptionProgressEvent {
            phase: "chunking".to_string(),
            progress: 5,
            current_chunk: Some(0),
            total_chunks: Some(total_chunks),
            concurrency: Some(chunk_concurrency),
            message: format!(
                "Splitting audio into {} chunks (parallel x{})",
                total_chunks, chunk_concurrency
            ),
            ..Default::default()
        });

        let mut in_flight = FuturesUnordered::new();
        let mut next_chunk_start = 0usize;
        let mut next_chunk_index = 1usize;
        // Morceaux refusés parce que d'autres étaient en vol : renvoyés seuls, en priorité.
        // (numéro, début, fin) dans `audio_data`.
        let mut requeued: VecDeque<(usize, usize, usize)> = VecDeque::new();
        let mut completed_results: Vec<(usize, f64, TranscriptionResult)> = Vec::new();

        while next_chunk_start < audio_data.len() || !requeued.is_empty() || !in_flight.is_empty() {
            // Annulation : on sort immédiatement, les requêtes en vol sont abandonnées.
            check_cancelled(cancel)?;

            while in_flight.len() < chunk_concurrency {
                let (chunk_index, chunk_start, chunk_end) = if let Some(chunk) = requeued.pop_front() {
                    chunk
                } else if next_chunk_start < audio_data.len() {
                    let chunk_index = next_chunk_index;
                    let chunk_start = next_chunk_start;
                    let chunk_end = (chunk_start + chunk_size).min(audio_data.len());
                    next_chunk_start = chunk_end;
                    next_chunk_index += 1;

                    // Déjà transcrit lors d'une tentative précédente : repris tel quel.
                    if let Some(saved) = checkpoint.get(chunk_index) {
                        completed_chunks += 1;
                        completed_results.push((
                            chunk_index,
                            saved.offset_secs,
                            TranscriptionResult {
                                segments: saved.segments,
                                full_text: saved.full_text,
                                language: language.to_string(),
                                duration_seconds: 0.0,
                            },
                        ));
                        continue;
                    }
                    (chunk_index, chunk_start, chunk_end)
                } else {
                    break;
                };

                let chunk_wav = self.mono_wav_chunk(
                    &audio_data[chunk_start..chunk_end],
                    sample_rate,
                    channels,
                    bits_per_sample,
                    sum_channels,
                )?;
                // Une requête à la fois : rien d'autre n'est en vol quand celle-ci part.
                let alone = chunk_concurrency == 1;

                in_flight.push(async move {
                    let result = self
                        .transcribe_chunk_with_retry(&chunk_wav, language, config, cancel, chunk_index, alone)
                        .await;
                    (chunk_index, chunk_start, chunk_end, result)
                });
            }

            let Some((chunk_index, chunk_start, chunk_end, result)) = in_flight.next().await else {
                continue;
            };
            let chunk_offset_secs = chunk_start as f64 / bytes_per_second as f64;

            let chunk_result = match result {
                Ok(chunk_result) => chunk_result,
                // Requêtes simultanées refusées (le palier gratuit F0 n'en accepte qu'une) :
                // la suite part un morceau à la fois, celui-ci compris.
                Err(RecognizeError::Throttled { error, .. }) => {
                    if chunk_concurrency > 1 {
                        log::warn!(
                            "[Transcription] Azure refuse les requêtes simultanées, envoi des morceaux un par un : {}",
                            error
                        );
                        chunk_concurrency = 1;
                        self.one_request_at_a_time.store(true, Ordering::SeqCst);
                    }
                    requeued.push_back((chunk_index, chunk_start, chunk_end));
                    continue;
                }
                // Échec après plusieurs tentatives : on arrête, les morceaux terminés
                // restent dans le point de reprise et une relance repartira d'ici.
                Err(RecognizeError::Failed(error)) => return Err(error),
            };

            completed_chunks += 1;
            let progress = ((completed_chunks * 100) / total_chunks).min(99) as u8;

            on_progress(TranscriptionProgressEvent {
                phase: "transcribing".to_string(),
                progress,
                current_chunk: Some(completed_chunks),
                total_chunks: Some(total_chunks),
                concurrency: Some(chunk_concurrency),
                message: format!(
                    "Chunk {}/{} processed (last completed chunk #{})",
                    completed_chunks, total_chunks, chunk_index
                ),
                ..Default::default()
            });

            checkpoint.save(
                chunk_index,
                ChunkResult {
                    offset_secs: chunk_offset_secs,
                    segments: chunk_result.segments.clone(),
                    full_text: chunk_result.full_text.clone(),
                },
            );
            completed_results.push((chunk_index, chunk_offset_secs, chunk_result));
        }

        completed_results.sort_by_key(|(chunk_index, _, _)| *chunk_index);

        for (_, chunk_offset_secs, result) in completed_results {
            for mut segment in result.segments {
                segment.start_time += chunk_offset_secs;
                segment.end_time += chunk_offset_secs;
                all_segments.push(segment);
            }

            if !full_text.is_empty() && !result.full_text.is_empty() {
                full_text.push(' ');
            }
            full_text.push_str(&result.full_text);
        }

        let duration_seconds = audio_data.len() as f64 / bytes_per_second as f64;

        on_progress(TranscriptionProgressEvent {
            phase: "completed".to_string(),
            progress: 100,
            current_chunk: Some(total_chunks),
            total_chunks: Some(total_chunks),
            concurrency: Some(chunk_concurrency),
            message: "Transcription complete".to_string(),
            ..Default::default()
        });

        Ok(TranscriptionResult {
            segments: all_segments,
            full_text,
            language: language.to_string(),
            duration_seconds,
        })
    }

    /// Envoie un morceau, avec nouvelles tentatives espacées en cas d'échec
    /// (coupure réseau au réveil de veille, erreur passagère d'Azure, refus 429).
    /// Envoyé avec d'autres (`alone` faux), un refus 429 est rendu tout de suite
    /// (`RecognizeError::Throttled`) : l'appelant renverra le morceau seul.
    async fn transcribe_chunk_with_retry(
        &self,
        chunk_wav: &[u8],
        language: &str,
        config: &TranscriptionConfig,
        cancel: &AtomicBool,
        chunk_index: usize,
        alone: bool,
    ) -> Result<TranscriptionResult, RecognizeError> {
        const DELAYS_SECS: [u64; 3] = [2, 5, 15];
        let mut attempt = 0;
        loop {
            check_cancelled(cancel)?;
            let (error, retry_after) = match self.transcribe_short_audio(chunk_wav, language, config).await {
                Ok(result) => return Ok(result),
                Err(throttled @ RecognizeError::Throttled { .. }) if !alone => return Err(throttled),
                Err(RecognizeError::Throttled { error, retry_after }) => (error, retry_after),
                Err(RecognizeError::Failed(error)) => (error, None),
            };
            if attempt == DELAYS_SECS.len() {
                return Err(RecognizeError::Failed(AppError::TranscriptionError(format!(
                    "Le morceau {} n'a pas pu être transcrit après {} tentatives ({}). \
                     La partie déjà transcrite est conservée : relancez la transcription pour reprendre.",
                    chunk_index,
                    DELAYS_SECS.len() + 1,
                    error
                ))));
            }
            let delay = Duration::from_secs(DELAYS_SECS[attempt])
                .max(retry_after.unwrap_or_default().min(MAX_RETRY_AFTER));
            log::warn!(
                "Chunk {} failed (attempt {}), retrying in {}s: {}",
                chunk_index,
                attempt + 1,
                delay.as_secs(),
                error
            );
            tokio::time::sleep(delay).await;
            attempt += 1;
        }
    }

    /// Parse WAV header to extract audio parameters
    fn parse_wav_header(&self, data: &[u8]) -> AppResult<(u32, u16, u16, usize)> {
        if data.len() < 44 {
            return Err(AppError::TranscriptionError(
                "Invalid WAV file: too short".to_string(),
            ));
        }

        // Check RIFF header
        if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
            return Err(AppError::TranscriptionError(
                "Invalid WAV file: not a RIFF WAVE file".to_string(),
            ));
        }

        // Find fmt chunk
        let mut pos = 12;
        let mut sample_rate = 0u32;
        let mut channels = 0u16;
        let mut bits_per_sample = 0u16;
        let mut data_offset = 0usize;

        // `<=` : un en-tête de chunk peut finir exactement à la fin du fichier (WAV sans données).
        while pos + 8 <= data.len() {
            let chunk_id = &data[pos..pos + 4];
            let chunk_size = u32::from_le_bytes([
                data[pos + 4],
                data[pos + 5],
                data[pos + 6],
                data[pos + 7],
            ]) as usize;

            if chunk_id == b"fmt " {
                if pos + 8 + chunk_size > data.len() {
                    return Err(AppError::TranscriptionError(
                        "Invalid WAV file: fmt chunk too short".to_string(),
                    ));
                }
                channels = u16::from_le_bytes([data[pos + 10], data[pos + 11]]);
                sample_rate = u32::from_le_bytes([
                    data[pos + 12],
                    data[pos + 13],
                    data[pos + 14],
                    data[pos + 15],
                ]);
                bits_per_sample = u16::from_le_bytes([data[pos + 22], data[pos + 23]]);
            } else if chunk_id == b"data" {
                data_offset = pos + 8;
                break;
            }

            pos += 8 + chunk_size;
            // Ensure even alignment
            if chunk_size % 2 != 0 {
                pos += 1;
            }
        }

        if data_offset == 0 {
            return Err(AppError::TranscriptionError(
                "Invalid WAV file: no data chunk found".to_string(),
            ));
        }

        // Format absent ou incohérent : le découpage diviserait par une taille de morceau nulle.
        if sample_rate == 0 || channels == 0 || bits_per_sample < 8 {
            return Err(AppError::TranscriptionError(
                "Invalid WAV file: missing or invalid fmt chunk".to_string(),
            ));
        }

        Ok((sample_rate, channels, bits_per_sample, data_offset))
    }

    /// Read audio file and normalize to WAV bytes.
    ///
    /// Supported input formats: WAV, MP3, M4A.
    async fn load_audio_as_wav(&self, audio_path: &str) -> AppResult<Vec<u8>> {
        let audio_bytes = tokio::fs::read(audio_path)
            .await
            .map_err(AppError::FileError)?;

        // Keep WAV as-is (also supports wav content with no extension).
        if audio_bytes.len() >= 12 && &audio_bytes[0..4] == b"RIFF" && &audio_bytes[8..12] == b"WAVE" {
            return Ok(audio_bytes);
        }

        let extension = Path::new(audio_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_lowercase();

        match extension.as_str() {
            "wav" => Ok(audio_bytes),
            "mp3" | "m4a" => self.decode_compressed_audio_to_wav(audio_bytes, &extension),
            _ => Err(AppError::TranscriptionError(
                "Unsupported audio format. Please use WAV, MP3, or M4A.".to_string(),
            )),
        }
    }

    /// Decode compressed audio (MP3/M4A) to PCM WAV bytes.
    fn decode_compressed_audio_to_wav(
        &self,
        audio_bytes: Vec<u8>,
        extension: &str,
    ) -> AppResult<Vec<u8>> {
        let cursor = std::io::Cursor::new(audio_bytes);
        let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

        let mut hint = Hint::new();
        if !extension.is_empty() {
            hint.with_extension(extension);
        }

        let mut format = get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| {
                AppError::TranscriptionError(format!(
                    "Failed to parse audio container for transcription: {e}"
                ))
            })?;

        let track = format.default_track(TrackType::Audio).ok_or_else(|| {
            AppError::TranscriptionError("No default audio track found in file".to_string())
        })?;

        let track_id = track.id;
        let codec_params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or_else(|| {
                AppError::TranscriptionError("Default track has no audio codec parameters".to_string())
            })?;
        let mut decoder = get_codecs()
            .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
            .map_err(|e| {
                AppError::TranscriptionError(format!(
                    "Failed to initialize audio decoder for transcription: {e}"
                ))
            })?;

        let mut sample_rate = codec_params.sample_rate.unwrap_or(16000);
        let mut channels = codec_params
            .channels
            .as_ref()
            .map(|c| c.count() as u16)
            .unwrap_or(1);
        let mut pcm_data: Vec<u8> = Vec::new();
        let mut samples: Vec<i16> = Vec::new();

        loop {
            let packet = match format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => break,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break;
                }
                Err(SymphoniaError::ResetRequired) => {
                    return Err(AppError::TranscriptionError(
                        "Audio stream reset required during decoding".to_string(),
                    ));
                }
                Err(err) => {
                    return Err(AppError::TranscriptionError(format!(
                        "Failed reading audio packets: {err}"
                    )));
                }
            };

            if packet.track_id != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::ResetRequired) => {
                    return Err(AppError::TranscriptionError(
                        "Audio decoder reset required".to_string(),
                    ));
                }
                Err(err) => {
                    return Err(AppError::TranscriptionError(format!(
                        "Failed decoding audio stream: {err}"
                    )));
                }
            };

            sample_rate = decoded.spec().rate();
            channels = decoded.spec().channels().count() as u16;

            samples.resize(decoded.samples_interleaved(), 0);
            decoded.copy_to_slice_interleaved(&mut samples);

            for sample in &samples {
                pcm_data.extend_from_slice(&sample.to_le_bytes());
            }
        }

        if pcm_data.is_empty() {
            return Err(AppError::TranscriptionError(
                "No decodable audio samples found in file".to_string(),
            ));
        }

        self.create_wav_chunk(&pcm_data, sample_rate, channels, 16)
    }

    /// Morceau WAV envoyé à Azure. Le PCM 16 bits multicanal est ramené en mono : dans un
    /// enregistrement micro / son du PC, la gauche et la droite ne portent pas les mêmes voix.
    /// Autres formats : inchangés.
    fn mono_wav_chunk(
        &self,
        audio_data: &[u8],
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        sum_channels: bool,
    ) -> AppResult<Vec<u8>> {
        if bits_per_sample == 16 && channels > 1 {
            self.create_wav_chunk(&downmix_pcm16(audio_data, channels, sum_channels), sample_rate, 1, 16)
        } else {
            self.create_wav_chunk(audio_data, sample_rate, channels, bits_per_sample)
        }
    }

    /// Create a new WAV file from audio data chunk
    fn create_wav_chunk(
        &self,
        audio_data: &[u8],
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
    ) -> AppResult<Vec<u8>> {
        let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
        let block_align = channels * bits_per_sample / 8;
        let data_size = audio_data.len() as u32;
        let file_size = 36 + data_size;

        let mut wav = Vec::with_capacity(44 + audio_data.len());

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&file_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // audio format (PCM)
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav.extend_from_slice(audio_data);

        Ok(wav)
    }

    /// Parse Azure Speech recognition result into TranscriptionResult
    fn parse_recognition_result(
        &self,
        result: AzureSpeechRecognitionResult,
        language: &str,
    ) -> AppResult<TranscriptionResult> {
        let mut segments = Vec::new();
        let mut full_text = String::new();
        let mut duration_seconds = 0.0;

        match result.recognition_status.as_str() {
            "Success" => {
                if let Some(n_best) = result.n_best {
                    if let Some(best) = n_best.first() {
                        full_text = best.display.clone();

                        // If word-level timestamps are available, create segments
                        if let Some(words) = &best.words {
                            let mut current_segment_text = String::new();
                            let mut segment_start: Option<f64> = None;
                            let mut last_end: f64 = 0.0;

                            for word in words {
                                let word_start = word.offset as f64 / 10_000_000.0; // 100ns units to seconds
                                let word_end = (word.offset + word.duration) as f64 / 10_000_000.0;

                                // Start new segment if gap is too long (> 2 seconds) or this is the first word
                                if segment_start.is_none()
                                    || (word_start - last_end > 2.0 && !current_segment_text.is_empty())
                                {
                                    // Save previous segment if exists
                                    if let Some(start) = segment_start {
                                        if !current_segment_text.is_empty() {
                                            segments.push(TranscriptionSegment {
                                                text: current_segment_text.trim().to_string(),
                                                speaker: 0, // Default speaker, diarization not available in basic API
                                                start_time: start,
                                                end_time: last_end,
                                                confidence: best.confidence,
                                                language: language.to_string(),
                                            });
                                        }
                                    }
                                    current_segment_text = String::new();
                                    segment_start = Some(word_start);
                                }

                                if !current_segment_text.is_empty() {
                                    current_segment_text.push(' ');
                                }
                                current_segment_text.push_str(&word.word);
                                last_end = word_end;
                                duration_seconds = word_end;
                            }

                            // Save last segment
                            if let Some(start) = segment_start {
                                if !current_segment_text.is_empty() {
                                    segments.push(TranscriptionSegment {
                                        text: current_segment_text.trim().to_string(),
                                        speaker: 0,
                                        start_time: start,
                                        end_time: last_end,
                                        confidence: best.confidence,
                                        language: language.to_string(),
                                    });
                                }
                            }
                        } else {
                            // No word-level timestamps, create single segment
                            let start_time = result.offset.unwrap_or(0) as f64 / 10_000_000.0;
                            let duration = result.duration.unwrap_or(0) as f64 / 10_000_000.0;

                            segments.push(TranscriptionSegment {
                                text: best.display.clone(),
                                speaker: 0,
                                start_time,
                                end_time: start_time + duration,
                                confidence: best.confidence,
                                language: language.to_string(),
                            });

                            duration_seconds = start_time + duration;
                        }
                    }
                } else if let Some(display_text) = result.display_text {
                    full_text = display_text.clone();
                    let start_time = result.offset.unwrap_or(0) as f64 / 10_000_000.0;
                    let duration = result.duration.unwrap_or(0) as f64 / 10_000_000.0;

                    segments.push(TranscriptionSegment {
                        text: display_text,
                        speaker: 0,
                        start_time,
                        end_time: start_time + duration,
                        confidence: 1.0,
                        language: language.to_string(),
                    });

                    duration_seconds = start_time + duration;
                }
            }
            "NoMatch" => {
                return Err(AppError::TranscriptionError(
                    "No speech could be recognized in the audio".to_string(),
                ));
            }
            "InitialSilenceTimeout" => {
                return Err(AppError::TranscriptionError(
                    "No speech detected - audio contains only silence".to_string(),
                ));
            }
            "EndOfDictation" => {
                // This is normal, return empty result
            }
            status => {
                return Err(AppError::TranscriptionError(format!(
                    "Recognition failed with status: {}",
                    status
                )));
            }
        }

        Ok(TranscriptionResult {
            segments,
            full_text,
            language: language.to_string(),
            duration_seconds,
        })
    }
}

impl Default for TranscriptionService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{NBestResult, WordResult};

    const TICKS_PER_SECOND: u64 = 10_000_000;

    fn word(text: &str, start_secs: f64, duration_secs: f64) -> WordResult {
        WordResult {
            word: text.to_string(),
            offset: (start_secs * TICKS_PER_SECOND as f64) as u64,
            duration: (duration_secs * TICKS_PER_SECOND as f64) as u64,
            confidence: 0.9,
        }
    }

    fn recognition(status: &str, n_best: Option<Vec<NBestResult>>, display: Option<&str>) -> AzureSpeechRecognitionResult {
        AzureSpeechRecognitionResult {
            recognition_status: status.to_string(),
            display_text: display.map(str::to_string),
            offset: Some(2 * TICKS_PER_SECOND),
            duration: Some(3 * TICKS_PER_SECOND),
            n_best,
        }
    }

    fn best(display: &str, words: Option<Vec<WordResult>>) -> NBestResult {
        NBestResult {
            confidence: 0.8,
            lexical: String::new(),
            itn: String::new(),
            masked_itn: String::new(),
            display: display.to_string(),
            words,
        }
    }

    // ---------------------------------------------------------------- annulation

    #[test]
    fn check_cancelled_reports_the_cancel_message() {
        let flag = AtomicBool::new(false);
        assert!(check_cancelled(&flag).is_ok());
        flag.store(true, Ordering::SeqCst);
        let error = check_cancelled(&flag).unwrap_err();
        assert!(error.to_string().contains(CANCELLED_MESSAGE));
    }

    #[test]
    fn progress_event_serializes_in_camel_case() {
        let json = serde_json::to_value(TranscriptionProgressEvent {
            phase: "transcribing".into(),
            current_chunk: Some(2),
            processed_seconds: Some(30.0),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(json["currentChunk"], 2);
        assert_eq!(json["processedSeconds"], 30.0);
        assert!(json["totalChunks"].is_null());
    }

    // ---------------------------------------------------------------- concurrence

    #[test]
    fn chunk_concurrency_defaults_to_two_and_is_clamped() {
        assert_eq!(configured_chunk_concurrency(None), 2);
        assert_eq!(configured_chunk_concurrency(Some("3")), 3);
        assert_eq!(configured_chunk_concurrency(Some(" 3 ")), 3);
        assert_eq!(configured_chunk_concurrency(Some("0")), 1);
        assert_eq!(configured_chunk_concurrency(Some("99")), 4);
        assert_eq!(configured_chunk_concurrency(Some("beaucoup")), 2);
    }

    /// Lit une requête HTTP complète (en-têtes et corps).
    async fn read_request(socket: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut received = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = socket.read(&mut buf).await.unwrap();
            received.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&received);
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if received.len() >= end + 4 + length {
                    return;
                }
            }
            if n == 0 {
                return;
            }
        }
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Faux Azure Speech au palier gratuit F0 : une requête traitée à la fois, les autres
    /// reçoivent le 429 réel d'Azure. Rend l'adresse, le nombre de requêtes et de refus.
    async fn fake_f0_server() -> (String, Arc<std::sync::atomic::AtomicUsize>, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::AtomicUsize;
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/recognize", listener.local_addr().unwrap());
        let busy = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let refused = Arc::new(AtomicUsize::new(0));
        let (requests_seen, refused_seen) = (requests.clone(), refused.clone());
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (busy, requests, refused) = (busy.clone(), requests_seen.clone(), refused_seen.clone());
                tokio::spawn(async move {
                    read_request(&mut socket).await;
                    requests.fetch_add(1, Ordering::SeqCst);
                    let response = if busy.swap(true, Ordering::SeqCst) {
                        refused.fetch_add(1, Ordering::SeqCst);
                        http_response(
                            "429 Too Many Requests",
                            "The number of parallel requests exceeded the number of allowed concurrent transcriptions.",
                        )
                    } else {
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        busy.store(false, Ordering::SeqCst);
                        http_response(
                            "200 OK",
                            r#"{"RecognitionStatus":"Success","DisplayText":"Bonjour.","Offset":0,"Duration":10000000}"#,
                        )
                    };
                    socket.write_all(response.as_bytes()).await.unwrap();
                    let _ = socket.shutdown().await;
                });
            }
        });
        (url, requests, refused)
    }

    fn azure_config() -> TranscriptionConfig {
        TranscriptionConfig {
            speech_key: "cle-test".into(),
            speech_region: "westeurope".into(),
            language: "fr-FR".into(),
        }
    }

    #[tokio::test]
    async fn a_key_refusing_parallel_requests_gets_chunks_one_at_a_time() {
        let (url, requests, refused) = fake_f0_server().await;
        let service = TranscriptionService::with_endpoint(&url);
        service.configure(azure_config()).await.unwrap();

        // 61 s en 8 kHz mono : trois morceaux (30 s, 30 s, 1 s).
        let audio = std::env::temp_dir().join(format!("meetscribe-azure-f0-{}.wav", std::process::id()));
        let wav = service.create_wav_chunk(&vec![0u8; 16_000 * 61], 8_000, 1, 16).unwrap();
        std::fs::write(&audio, wav).unwrap();
        let transcribe = || {
            service.transcribe_audio(audio.to_string_lossy().into_owned(), "fr-FR".into())
        };

        let result = transcribe().await.unwrap();
        assert_eq!(result.full_text, "Bonjour. Bonjour. Bonjour.");
        let first_starts: Vec<f64> = result.segments.iter().map(|s| s.start_time).collect();
        assert_eq!(first_starts, [0.0, 30.0, 60.0]);
        let refusals = refused.load(Ordering::SeqCst);
        assert!(refusals >= 1, "les deux premiers morceaux partent ensemble, l'un est refusé");
        assert_eq!(requests.load(Ordering::SeqCst), 3 + refusals);
        assert!(service.one_request_at_a_time.load(Ordering::SeqCst));

        // Transcription suivante : un morceau à la fois d'emblée, plus aucun refus.
        transcribe().await.unwrap();
        assert_eq!(refused.load(Ordering::SeqCst), refusals);
        assert_eq!(requests.load(Ordering::SeqCst), 6 + refusals);

        // Nouvelle clé : on retente le parallèle.
        service.configure(azure_config()).await.unwrap();
        assert!(!service.one_request_at_a_time.load(Ordering::SeqCst));
        let _ = std::fs::remove_file(&audio);
    }

    // ---------------------------------------------------------------- WAV

    #[test]
    fn wav_chunk_header_roundtrips_through_parse() {
        let service = TranscriptionService::new();
        let pcm = vec![0u8; 3200];
        let wav = service.create_wav_chunk(&pcm, 16_000, 1, 16).unwrap();

        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 3200);
        // Débit : 16 000 Hz * 1 canal * 2 octets.
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32_000);

        let (rate, channels, bits, offset) = service.parse_wav_header(&wav).unwrap();
        assert_eq!((rate, channels, bits, offset), (16_000, 1, 16, 44));
    }

    #[test]
    fn wav_chunk_computes_byte_rate_and_block_align_for_stereo() {
        let service = TranscriptionService::new();
        let wav = service.create_wav_chunk(&[0u8; 8], 44_100, 2, 16).unwrap();
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 176_400);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 4);
    }

    #[test]
    fn downmix_averages_ordinary_stereo_and_sums_dual_channel_recordings() {
        let pcm: Vec<u8> = [1000i16, 3000, -32000, -32000].iter().flat_map(|s| s.to_le_bytes()).collect();
        let samples = |bytes: Vec<u8>| -> Vec<i16> {
            bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
        };
        assert_eq!(samples(downmix_pcm16(&pcm, 2, false)), [2000, -32000]);
        assert_eq!(samples(downmix_pcm16(&pcm, 2, true)), [4000, i16::MIN], "somme écrêtée");
    }

    #[test]
    fn stereo_pcm16_chunks_are_sent_to_azure_in_mono() {
        let service = TranscriptionService::new();
        let wav = service.mono_wav_chunk(&[0u8; 16], 48_000, 2, 16, false).unwrap();
        assert_eq!(service.parse_wav_header(&wav).unwrap(), (48_000, 1, 16, 44));
        assert_eq!(wav.len(), 44 + 8, "4 trames stéréo deviennent 4 échantillons mono");
        // Autre profondeur : envoyé tel quel.
        let wav24 = service.mono_wav_chunk(&[0u8; 12], 48_000, 2, 24, false).unwrap();
        assert_eq!(service.parse_wav_header(&wav24).unwrap().1, 2);
    }

    #[test]
    fn parse_wav_header_rejects_invalid_input() {
        let service = TranscriptionService::new();
        assert!(service.parse_wav_header(b"RIFF").is_err());

        let mut not_wave = service.create_wav_chunk(&[0u8; 16], 8_000, 1, 16).unwrap();
        not_wave[8..12].copy_from_slice(b"AVI ");
        assert!(service.parse_wav_header(&not_wave).is_err());

        let mut no_data = service.create_wav_chunk(&[0u8; 16], 8_000, 1, 16).unwrap();
        no_data[36..40].copy_from_slice(b"junk");
        let error = service.parse_wav_header(&no_data).unwrap_err();
        assert!(error.to_string().contains("no data chunk"));
    }

    #[test]
    fn parse_wav_header_accepts_a_wav_without_samples() {
        let service = TranscriptionService::new();
        let empty = service.create_wav_chunk(&[], 16_000, 1, 16).unwrap();
        assert_eq!(empty.len(), 44);
        let (rate, channels, bits, offset) = service.parse_wav_header(&empty).unwrap();
        assert_eq!((rate, channels, bits, offset), (16_000, 1, 16, 44));
    }

    #[test]
    fn parse_wav_header_rejects_a_zero_sample_rate() {
        let service = TranscriptionService::new();
        // Taux nul : sans ce contrôle, transcribe_long_audio divisait par zéro.
        let wav = service.create_wav_chunk(&[0u8; 16], 0, 1, 16).unwrap();
        let error = service.parse_wav_header(&wav).unwrap_err();
        assert!(error.to_string().contains("fmt"));
    }

    #[test]
    fn parse_wav_header_skips_extra_chunks_with_odd_size_padding() {
        let service = TranscriptionService::new();
        let base = service.create_wav_chunk(&[1u8; 8], 16_000, 1, 16).unwrap();
        // On insère un chunk LIST de taille impaire (3 octets + 1 octet de bourrage) avant « data ».
        let mut wav = base[..36].to_vec();
        wav.extend_from_slice(b"LIST");
        wav.extend_from_slice(&3u32.to_le_bytes());
        wav.extend_from_slice(&[7, 7, 7, 0]);
        wav.extend_from_slice(&base[36..]);

        let (rate, _, _, offset) = service.parse_wav_header(&wav).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(offset, 36 + 8 + 4 + 8);
        assert_eq!(&wav[offset..], &[1u8; 8]);
    }

    // ---------------------------------------------------------------- résultat Azure

    #[test]
    fn words_are_grouped_into_segments_split_on_long_gaps() {
        let service = TranscriptionService::new();
        let words = vec![
            word("Bonjour", 1.0, 0.5),
            word("à", 1.6, 0.2),
            word("tous", 1.9, 0.3),
            // Pause de 3 s : nouveau segment.
            word("On", 5.2, 0.2),
            word("commence", 5.5, 0.5),
        ];
        let result = service
            .parse_recognition_result(recognition("Success", Some(vec![best("Bonjour à tous. On commence.", Some(words))]), None), "fr-FR")
            .unwrap();

        assert_eq!(result.full_text, "Bonjour à tous. On commence.");
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[0].text, "Bonjour à tous");
        assert!((result.segments[0].start_time - 1.0).abs() < 1e-9);
        assert!((result.segments[0].end_time - 2.2).abs() < 1e-9);
        assert_eq!(result.segments[1].text, "On commence");
        assert!((result.segments[1].start_time - 5.2).abs() < 1e-9);
        assert!((result.duration_seconds - 6.0).abs() < 1e-9);
        assert_eq!(result.segments[1].language, "fr-FR");
        assert_eq!(result.segments[1].confidence, 0.8);
    }

    #[test]
    fn short_pauses_do_not_split_segments() {
        let service = TranscriptionService::new();
        let words = vec![word("un", 0.0, 0.5), word("deux", 2.4, 0.5)]; // écart de 1,9 s
        let result = service
            .parse_recognition_result(recognition("Success", Some(vec![best("un deux", Some(words))]), None), "fr-FR")
            .unwrap();
        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].text, "un deux");
    }

    #[test]
    fn without_words_a_single_segment_uses_the_result_offset() {
        let service = TranscriptionService::new();
        let result = service
            .parse_recognition_result(recognition("Success", Some(vec![best("Texte seul", None)]), None), "fr-FR")
            .unwrap();
        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.segments[0].start_time, 2.0);
        assert_eq!(result.segments[0].end_time, 5.0);
        assert_eq!(result.duration_seconds, 5.0);
    }

    #[test]
    fn without_nbest_the_display_text_is_used() {
        let service = TranscriptionService::new();
        let result = service
            .parse_recognition_result(recognition("Success", None, Some("Affichage")), "en-US")
            .unwrap();
        assert_eq!(result.full_text, "Affichage");
        assert_eq!(result.segments[0].confidence, 1.0);
        assert_eq!(result.language, "en-US");
    }

    #[test]
    fn recognition_failures_become_transcription_errors() {
        let service = TranscriptionService::new();
        let no_match = service.parse_recognition_result(recognition("NoMatch", None, None), "fr-FR").unwrap_err();
        assert!(no_match.to_string().contains("No speech could be recognized"));

        let silence = service
            .parse_recognition_result(recognition("InitialSilenceTimeout", None, None), "fr-FR")
            .unwrap_err();
        assert!(silence.to_string().contains("only silence"));

        let other = service.parse_recognition_result(recognition("Error", None, None), "fr-FR").unwrap_err();
        assert!(other.to_string().contains("status: Error"));
    }

    #[test]
    fn end_of_dictation_gives_an_empty_result() {
        let service = TranscriptionService::new();
        let result = service.parse_recognition_result(recognition("EndOfDictation", None, None), "fr-FR").unwrap();
        assert!(result.segments.is_empty());
        assert!(result.full_text.is_empty());
        assert_eq!(result.duration_seconds, 0.0);
    }
}
