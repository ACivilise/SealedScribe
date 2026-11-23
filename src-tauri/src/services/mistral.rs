//! Mistral AI en direct (`api.mistral.ai`) : transcription par Voxtral. Le résumé par les
//! modèles de chat de Mistral est dans `summary` ; une seule clé API sert aux deux (voir `secrets`).
//!
//! - L'audio part en morceaux d'environ 10 minutes (WAV mono 16 kHz, ~19 Mo), coupés sur un
//!   silence : progression, point de reprise et arrêt après la partie en cours, comme le moteur
//!   local. L'API accepte jusqu'à 3 heures par requête, mais pas un fichier de 350 Mo.
//! - Les termes des lexiques partent en `context_bias` (vocabulaire à privilégier).
//! - Pas de séparation des intervenants par Mistral : ses numéros de locuteur ne seraient pas
//!   cohérents d'un morceau à l'autre. La séparation locale (sherpa-onnx) s'applique ensuite,
//!   comme pour les autres moteurs.

use crate::error::{AppError, AppResult};
use crate::models::{TranscriptionResult, TranscriptionSegment};
use crate::services::audio_prep::{self, TARGET_RATE};
use crate::services::checkpoint::{Checkpoint, ChunkResult};
use crate::services::transcription::{TranscriptionProgressEvent, CANCELLED_MESSAGE, STOPPED_MESSAGE};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// Valeur de `UserPreferences::transcription_engine` et `summary_engine` pour Mistral AI.
pub const ENGINE_MISTRAL: &str = "mistral";
pub const API_BASE: &str = "https://api.mistral.ai/v1";
/// Modèles utilisés quand le champ « Modèle » est vide.
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "voxtral-mini-latest";
pub const DEFAULT_CHAT_MODEL: &str = "mistral-medium-latest";

/// Durée cible d'un morceau envoyé à Voxtral.
const CHUNK_TARGET_SECS: u32 = 600;
/// Limite de l'API pour `context_bias`.
const MAX_CONTEXT_BIAS: usize = 100;
/// Tentatives par morceau (débit limité, erreur serveur ou réseau).
const MAX_ATTEMPTS: u32 = 3;
/// Envoi d'un morceau de ~19 Mo puis transcription.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Modèle saisi, ou celui par défaut si le champ est vide.
pub fn model_or_default(model: &str, default: &str) -> String {
    let model = model.trim();
    if model.is_empty() { default } else { model }.to_string()
}

pub fn missing_key_error() -> AppError {
    AppError::Custom("Clé Mistral AI absente : saisissez-la dans Paramètres.".to_string())
}

/// Erreur lisible pour une réponse HTTP en échec de Mistral.
pub fn api_error(status: StatusCode, body: &str) -> AppError {
    let detail = crate::services::summary::server_error_detail(body);
    AppError::Custom(match status {
        StatusCode::UNAUTHORIZED => {
            "Clé Mistral AI refusée (401) : vérifiez-la dans Paramètres.".to_string()
        }
        StatusCode::TOO_MANY_REQUESTS => {
            format!("Limite d'utilisation de Mistral AI atteinte (429) : réessayez dans un moment. {detail}")
        }
        _ => format!("Réponse {} de Mistral AI : {detail}", status.as_u16()),
    })
}

/// "fr-FR" → "fr" : Voxtral attend le code de langue seul.
fn voxtral_language(language: &str) -> String {
    language.split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase()
}

/// Termes des lexiques à partir de l'indice whisper du front (`"terme1, terme2."`).
fn context_bias(prompt: Option<&str>) -> Vec<String> {
    prompt
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .split(',')
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty())
        .take(MAX_CONTEXT_BIAS)
        .collect()
}

#[derive(Debug, Deserialize)]
struct VoxtralResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    segments: Vec<VoxtralSegment>,
}

#[derive(Debug, Deserialize)]
struct VoxtralSegment {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
}

/// Segments d'un morceau, horodatés depuis le début du morceau. Sans segments (texte seul),
/// un segment couvre tout le morceau.
fn chunk_segments(response: VoxtralResponse, chunk_secs: f64, language: &str) -> Vec<TranscriptionSegment> {
    let segment = |text: &str, start: f64, end: f64| TranscriptionSegment {
        text: text.trim().to_string(),
        speaker: 0,
        start_time: start,
        end_time: end,
        confidence: 1.0,
        language: language.to_string(),
    };
    if response.segments.is_empty() {
        return Some(response.text.trim())
            .filter(|t| !t.is_empty())
            .map(|text| vec![segment(text, 0.0, chunk_secs)])
            .unwrap_or_default();
    }
    response
        .segments
        .iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| segment(&s.text, s.start, s.end))
        .collect()
}

/// Paramètres facultatifs d'une requête, retirés pour la suite si l'API les refuse.
#[derive(Debug, Clone, PartialEq)]
struct RequestOptions {
    language: Option<String>,
    context_bias: Vec<String>,
}

impl RequestOptions {
    /// Requête refusée (400 / 422) à cause d'un paramètre facultatif : on le retire et on
    /// renvoie `true` pour réessayer. La documentation dit `language` incompatible avec les
    /// horodatages ; l'API de référence l'accepte : on essaie, puis on s'en passe.
    fn drop_refused(&mut self, status: StatusCode, body: &str) -> bool {
        if status != StatusCode::BAD_REQUEST && status != StatusCode::UNPROCESSABLE_ENTITY {
            return false;
        }
        if body.contains("language") && self.language.take().is_some() {
            log::warn!("[Mistral] « language » refusé, nouvel essai sans : {body}");
            return true;
        }
        if body.contains("context_bias") && !self.context_bias.is_empty() {
            self.context_bias.clear();
            log::warn!("[Mistral] « context_bias » refusé, nouvel essai sans : {body}");
            return true;
        }
        false
    }
}

fn cancelled() -> AppError {
    AppError::TranscriptionError(CANCELLED_MESSAGE.to_string())
}

fn stopped() -> AppError {
    AppError::TranscriptionError(STOPPED_MESSAGE.to_string())
}

async fn wait_for_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Transcription par l'API Voxtral de Mistral AI.
pub struct MistralTranscriptionService {
    client: Client,
    base_url: String,
    key: RwLock<Option<String>>,
}

impl MistralTranscriptionService {
    pub fn new() -> Self {
        Self::with_base_url(API_BASE)
    }

    fn with_base_url(base_url: &str) -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
            base_url: base_url.trim_end_matches('/').to_string(),
            key: RwLock::new(None),
        }
    }

    pub async fn set_key(&self, key: Option<String>) {
        *self.key.write().await = key;
    }

    pub async fn transcribe<F>(
        &self,
        audio_path: String,
        language: String,
        model: String,
        prompt: Option<String>,
        cancel: Arc<AtomicBool>,
        stop_after_part: Arc<AtomicBool>,
        checkpoint: &Checkpoint,
        mut on_progress: F,
    ) -> AppResult<TranscriptionResult>
    where
        F: FnMut(TranscriptionProgressEvent) + Send,
    {
        let key = self.key.read().await.clone().ok_or_else(missing_key_error)?;

        on_progress(TranscriptionProgressEvent {
            phase: "preparing".to_string(),
            progress: 2,
            message: "Préparation de l'audio…".to_string(),
            ..Default::default()
        });
        let samples = tokio::task::spawn_blocking(move || audio_prep::decode_to_mono_16k(&audio_path))
            .await
            .map_err(|e| AppError::TranscriptionError(format!("Préparation audio interrompue : {e}")))??;
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }

        let total_secs = samples.len() as f64 / TARGET_RATE as f64;
        let chunks = audio_prep::split_on_silence(&samples, CHUNK_TARGET_SECS);
        let total_chunks = chunks.len();
        checkpoint.begin(total_chunks);
        let mut options = RequestOptions {
            language: Some(voxtral_language(&language)).filter(|l| !l.is_empty()),
            context_bias: context_bias(prompt.as_deref()),
        };
        let mut segments: Vec<TranscriptionSegment> = Vec::new();

        for (index, chunk) in chunks.iter().enumerate() {
            // Déjà transcrit lors d'une tentative précédente : repris tel quel.
            if let Some(saved) = checkpoint.get(index + 1) {
                segments.extend(with_offset(saved.segments, saved.offset_secs));
                continue;
            }
            if stop_after_part.load(Ordering::SeqCst) {
                return Err(stopped());
            }
            let processed = chunk.offset_secs;
            on_progress(TranscriptionProgressEvent {
                phase: "transcribing".to_string(),
                progress: (5.0 + 94.0 * (processed / total_secs.max(1.0)).clamp(0.0, 1.0)) as u8,
                current_chunk: Some(index + 1),
                total_chunks: Some(total_chunks),
                concurrency: Some(1),
                message: format!(
                    "Transcription Mistral… {} / {} min",
                    (processed / 60.0).floor(),
                    (total_secs / 60.0).ceil()
                ),
                processed_seconds: Some(processed),
                total_seconds: Some(total_secs),
                ..Default::default()
            });

            let wav = audio_prep::encode_wav_16k(chunk.samples)?;
            let chunk_secs = chunk.samples.len() as f64 / TARGET_RATE as f64;
            let response = self.send_chunk(&key, &model, wav, &mut options, &cancel).await?;
            let chunk_segments = chunk_segments(response, chunk_secs, &language);
            checkpoint.save(
                index + 1,
                ChunkResult {
                    offset_secs: chunk.offset_secs,
                    full_text: join_text(&chunk_segments),
                    segments: chunk_segments.clone(),
                },
            );
            segments.extend(with_offset(chunk_segments, chunk.offset_secs));
        }

        on_progress(TranscriptionProgressEvent {
            phase: "completed".to_string(),
            progress: 100,
            current_chunk: Some(total_chunks),
            total_chunks: Some(total_chunks),
            concurrency: Some(1),
            message: "Transcription terminée".to_string(),
            processed_seconds: Some(total_secs),
            total_seconds: Some(total_secs),
            ..Default::default()
        });

        Ok(TranscriptionResult {
            full_text: join_text(&segments),
            segments,
            language,
            duration_seconds: total_secs,
        })
    }

    /// Envoie un morceau ; réessaie après un refus de débit, une erreur serveur ou réseau, et
    /// sans le paramètre facultatif refusé. L'annulation abandonne la requête immédiatement.
    async fn send_chunk(
        &self,
        key: &str,
        model: &str,
        wav: Vec<u8>,
        options: &mut RequestOptions,
        cancel: &AtomicBool,
    ) -> AppResult<VoxtralResponse> {
        let mut attempt = 1;
        loop {
            let part = reqwest::multipart::Part::bytes(wav.clone())
                .file_name("chunk.wav")
                .mime_str("audio/wav")?;
            let mut form = reqwest::multipart::Form::new()
                .part("file", part)
                .text("model", model.to_string())
                .text("timestamp_granularities", "segment");
            if let Some(language) = &options.language {
                form = form.text("language", language.clone());
            }
            // Liste en champs répétés, comme le SDK Python de Mistral.
            for term in &options.context_bias {
                form = form.text("context_bias", term.clone());
            }

            let request = self
                .client
                .post(format!("{}/audio/transcriptions", self.base_url))
                .bearer_auth(key)
                .timeout(CHUNK_TIMEOUT)
                .multipart(form)
                .send();
            let outcome = tokio::select! {
                response = request => response,
                _ = wait_for_cancel(cancel) => return Err(cancelled()),
            };

            let retryable = match outcome {
                Ok(response) => {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    if status.is_success() {
                        return serde_json::from_str(&body).map_err(|e| {
                            let preview: String = body.chars().take(200).collect();
                            AppError::TranscriptionError(format!("Réponse de Mistral AI illisible ({e}) : {preview}"))
                        });
                    }
                    if options.drop_refused(status, &body) {
                        continue;
                    }
                    if status != StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() {
                        return Err(api_error(status, &body));
                    }
                    api_error(status, &body)
                }
                Err(error) => AppError::Custom(format!("Échange avec Mistral AI impossible : {error}")),
            };

            if attempt >= MAX_ATTEMPTS {
                return Err(retryable);
            }
            log::warn!("[Mistral] tentative {attempt}/{MAX_ATTEMPTS} échouée : {retryable}");
            let delay = Duration::from_secs(3 * attempt as u64);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = wait_for_cancel(cancel) => return Err(cancelled()),
            }
            attempt += 1;
        }
    }
}

impl Default for MistralTranscriptionService {
    fn default() -> Self {
        Self::new()
    }
}

fn with_offset(segments: Vec<TranscriptionSegment>, offset_secs: f64) -> impl Iterator<Item = TranscriptionSegment> {
    segments.into_iter().map(move |mut segment| {
        segment.start_time += offset_secs;
        segment.end_time += offset_secs;
        segment
    })
}

fn join_text(segments: &[TranscriptionSegment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn language_and_lexicon_terms_are_converted_for_voxtral() {
        assert_eq!(voxtral_language("fr-FR"), "fr");
        assert_eq!(voxtral_language("EN_us"), "en");
        assert_eq!(context_bias(Some("Zentra, ACME Corp, SealedScribe.")), ["Zentra", "ACME Corp", "SealedScribe"]);
        assert!(context_bias(Some("  ")).is_empty());
        assert!(context_bias(None).is_empty());
        let many = (0..150).map(|i| format!("t{i}")).collect::<Vec<_>>().join(", ");
        assert_eq!(context_bias(Some(&many)).len(), MAX_CONTEXT_BIAS);
    }

    #[test]
    fn an_empty_model_falls_back_to_the_default() {
        assert_eq!(model_or_default("  ", DEFAULT_TRANSCRIPTION_MODEL), "voxtral-mini-latest");
        assert_eq!(model_or_default(" voxtral-mini-transcribe-3 ", DEFAULT_TRANSCRIPTION_MODEL), "voxtral-mini-transcribe-3");
    }

    #[test]
    fn segments_keep_their_times_and_text_only_responses_cover_the_chunk() {
        let response: VoxtralResponse = serde_json::from_str(
            r#"{"model":"voxtral-mini-2602","text":"Bonjour. On commence.","language":"fr","segments":[
                {"type":"transcription_segment","text":" Bonjour.","start":0.4,"end":1.2},
                {"text":"  ","start":1.2,"end":1.5},
                {"text":" On commence.","start":1.5,"end":2.8,"speaker_id":"speaker_1"}],
                "usage":{"prompt_audio_seconds":3}}"#,
        )
        .unwrap();
        let segments = chunk_segments(response, 3.0, "fr-FR");
        assert_eq!(segments.len(), 2);
        assert_eq!((segments[0].text.as_str(), segments[0].start_time, segments[0].end_time), ("Bonjour.", 0.4, 1.2));
        assert_eq!(segments[1].language, "fr-FR");

        let text_only: VoxtralResponse = serde_json::from_str(r#"{"text":" Tout le texte. ","segments":[]}"#).unwrap();
        let segments = chunk_segments(text_only, 42.0, "fr-FR");
        assert_eq!((segments[0].text.as_str(), segments[0].end_time), ("Tout le texte.", 42.0));
    }

    #[test]
    fn a_refused_optional_parameter_is_dropped_once() {
        let mut options = RequestOptions { language: Some("fr".into()), context_bias: vec!["Zentra".into()] };
        let body = r#"{"detail":[{"loc":["body","language"],"msg":"not compatible with timestamp_granularities"}]}"#;
        assert!(options.drop_refused(StatusCode::UNPROCESSABLE_ENTITY, body));
        assert_eq!(options.language, None);
        assert!(!options.drop_refused(StatusCode::UNPROCESSABLE_ENTITY, body), "déjà retiré");
        assert!(options.drop_refused(StatusCode::BAD_REQUEST, "context_bias: too many items"));
        assert!(options.context_bias.is_empty());
        assert!(!options.drop_refused(StatusCode::UNAUTHORIZED, "language"));
    }

    #[test]
    fn api_errors_are_readable() {
        assert!(api_error(StatusCode::UNAUTHORIZED, "{}").to_string().contains("vérifiez-la dans Paramètres"));
        let error = api_error(StatusCode::BAD_REQUEST, r#"{"object":"error","message":"Invalid model: voxtral-x","type":"invalid_model"}"#);
        assert_eq!(error.to_string(), "Réponse 400 de Mistral AI : Invalid model: voxtral-x");
    }

    // ------------------------------------------------------------------------
    // Bout en bout contre un faux serveur Mistral
    // ------------------------------------------------------------------------

    /// Faux serveur : une réponse par connexion ; rend les requêtes reçues (en-têtes et corps).
    async fn fake_server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    received.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&received);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if received.len() >= end + 4 + length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                requests.push(String::from_utf8_lossy(&received).to_string());
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        (url, handle)
    }

    fn http_response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// WAV mono 16 kHz de `secs` secondes de silence, dans un fichier temporaire.
    fn silent_wav(secs: u32) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("meetscribe-mistral-{}-{secs}.wav", std::process::id()));
        let samples = vec![0.0f32; (TARGET_RATE * secs) as usize];
        std::fs::write(&path, audio_prep::encode_wav_16k(&samples).unwrap()).unwrap();
        path
    }

    #[tokio::test]
    async fn a_recording_is_sent_with_key_language_and_lexicon_terms() {
        let body = r#"{"model":"voxtral-mini-2602","text":"Point d'étape.","language":"fr","segments":[{"text":" Point d'étape.","start":0.5,"end":1.5}]}"#;
        let (url, server) = fake_server(vec![http_response("200 OK", body)]).await;
        let service = MistralTranscriptionService::with_base_url(&url);
        service.set_key(Some("cle-test".into())).await;
        let audio = silent_wav(2);

        let mut phases = Vec::new();
        let result = service
            .transcribe(
                audio.to_string_lossy().into_owned(),
                "fr-FR".into(),
                "voxtral-mini-latest".into(),
                Some("Zentra, SealedScribe.".into()),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
                &Checkpoint::disabled(),
                |event| phases.push(event.phase),
            )
            .await
            .unwrap();
        let _ = std::fs::remove_file(&audio);

        assert_eq!(result.full_text, "Point d'étape.");
        assert_eq!(result.segments[0].start_time, 0.5);
        assert_eq!(phases.first().map(String::as_str), Some("preparing"));
        assert_eq!(phases.last().map(String::as_str), Some("completed"));

        let request = &server.await.unwrap()[0];
        assert!(request.starts_with("POST /v1/audio/transcriptions "));
        assert!(request.contains("authorization: Bearer cle-test") || request.contains("Authorization: Bearer cle-test"));
        for field in ["model\"\r\n\r\nvoxtral-mini-latest", "timestamp_granularities\"\r\n\r\nsegment", "language\"\r\n\r\nfr", "context_bias\"\r\n\r\nZentra", "context_bias\"\r\n\r\nSealedScribe"] {
            assert!(request.contains(field), "champ attendu : {field}");
        }
    }

    #[tokio::test]
    async fn the_language_is_dropped_when_the_api_refuses_it() {
        let refused = http_response("422 Unprocessable Entity", r#"{"detail":[{"loc":["body","language"],"msg":"language is not compatible with timestamp_granularities"}]}"#);
        let ok = http_response("200 OK", r#"{"text":"OK","segments":[{"text":"OK","start":0,"end":1}]}"#);
        let (url, server) = fake_server(vec![refused, ok]).await;
        let service = MistralTranscriptionService::with_base_url(&url);
        service.set_key(Some("k".into())).await;
        let audio = silent_wav(1);
        let result = service
            .transcribe(audio.to_string_lossy().into_owned(), "fr-FR".into(), "voxtral-mini-latest".into(), None,
                Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), &Checkpoint::disabled(), |_| {})
            .await
            .unwrap();
        let _ = std::fs::remove_file(&audio);
        assert_eq!(result.full_text, "OK");
        let requests = server.await.unwrap();
        assert!(requests[0].contains("name=\"language\""));
        assert!(!requests[1].contains("name=\"language\""));
    }

    #[tokio::test]
    async fn a_missing_key_is_reported_before_any_upload() {
        let service = MistralTranscriptionService::with_base_url("http://127.0.0.1:9");
        let error = service
            .transcribe("x.wav".into(), "fr-FR".into(), "m".into(), None,
                Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), &Checkpoint::disabled(), |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Clé Mistral AI absente"));
    }
}
