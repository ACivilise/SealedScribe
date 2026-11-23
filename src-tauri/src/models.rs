use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingSession {
    pub id: String,
    pub title: String,
    pub language: String,
    pub duration: u32,
    pub recorded_at: DateTime<Utc>,
    pub status: MeetingStatus,
    pub audio_path: Option<String>,
    pub speakers: Vec<Speaker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MeetingStatus {
    Stopped,
    Recording,
    Processing,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Speaker {
    pub label: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionSegment {
    pub text: String,
    pub speaker: u32,
    pub start_time: f64,
    pub end_time: f64,
    pub confidence: f32,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTranscription {
    pub session_id: String,
    pub segments: Vec<TranscriptionSegment>,
    pub summary: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioLevelEvent {
    pub level: f32,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPreferences {
    pub default_language: String,
    pub auto_summary: bool,
    pub save_locally: bool,
    pub theme: String,
    #[serde(default = "default_recordings_directory")]
    pub recordings_directory: String,
    /// Moteur de transcription : "azure" (défaut), "local" (whisper.cpp) ou "mistral" (Voxtral).
    #[serde(default = "default_transcription_engine")]
    pub transcription_engine: String,
    /// Modèle utilisé par le moteur local (voir `services::local_whisper`).
    #[serde(default = "default_local_model")]
    pub local_model: String,
    /// Moteur de résumé : "azure" (défaut), "mistral", "ollama" ou "openai" (serveur local
    /// compatible OpenAI : LM Studio, llama-server…). Voir `services::summary`.
    #[serde(default = "default_summary_engine")]
    pub summary_engine: String,
    /// Adresse du serveur local de résumé ; vide : adresse par défaut du moteur.
    #[serde(default)]
    pub local_llm_url: String,
    /// Modèle déjà installé dans le serveur local (ex. `qwen3:4b`).
    #[serde(default)]
    pub local_llm_model: String,
    /// Modèle Voxtral de la transcription Mistral ; vide : `voxtral-mini-latest`.
    #[serde(default)]
    pub mistral_transcription_model: String,
    /// Modèle de chat Mistral pour le résumé ; vide : `mistral-medium-latest`.
    #[serde(default)]
    pub mistral_summary_model: String,
    /// Connexion Microsoft (Entra ID) exigée au démarrage. Simple contrôle d'accès à l'interface :
    /// les services Azure utilisent les clés du Gestionnaire d'identification, pas ce jeton.
    #[serde(default)]
    pub auth_enabled: bool,
    /// ID d'application (client) de l'inscription Entra ID, utilisé si `auth_enabled`.
    #[serde(default)]
    pub azure_ad_client_id: String,
    /// ID de l'annuaire (locataire) : GUID, domaine ou `common` / `organizations`.
    #[serde(default)]
    pub azure_ad_tenant_id: String,
}

pub fn default_transcription_engine() -> String {
    "azure".to_string()
}

pub fn default_local_model() -> String {
    crate::services::local_whisper::DEFAULT_MODEL_ID.to_string()
}

pub fn default_summary_engine() -> String {
    crate::services::summary::ENGINE_AZURE.to_string()
}

pub fn default_recordings_directory() -> String {
    // Dossier du Magnétophone Windows : Documents\Enregistrements audio.
    // `document_dir` résout le Known Folder Documents (suit la redirection OneDrive).
    if let Some(documents) = dirs::document_dir() {
        let english = documents.join("Sound Recordings");
        if english.exists() && !documents.join("Enregistrements audio").exists() {
            return english.to_string_lossy().to_string();
        }
        return documents
            .join("Enregistrements audio")
            .to_string_lossy()
            .to_string();
    }
    "./Recordings".to_string()
}

// Azure Speech Service API Response Models

/// Azure Speech Service recognition result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AzureSpeechRecognitionResult {
    pub recognition_status: String,
    pub display_text: Option<String>,
    pub offset: Option<u64>,
    pub duration: Option<u64>,
    #[serde(rename = "NBest")]
    pub n_best: Option<Vec<NBestResult>>,
}

/// N-best result from Azure Speech Service
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct NBestResult {
    pub confidence: f32,
    #[serde(default)]
    pub lexical: String,
    #[serde(default)]
    pub itn: String,
    #[serde(default)]
    pub masked_itn: String,
    pub display: String,
    pub words: Option<Vec<WordResult>>,
}

/// Word-level result from Azure Speech Service
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct WordResult {
    pub word: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub duration: u64,
    #[serde(default)]
    pub confidence: f32,
}

/// Transcription configuration for API calls
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionConfig {
    pub speech_key: String,
    pub speech_region: String,
    pub language: String,
}

// ============================================================================
// Speaker Diarization Models
// ============================================================================

/// Configuration for speaker diarization
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationConfig {
    pub speech_key: String,
    pub speech_region: String,
    pub language: String,
    /// Minimum number of speakers (optional, default 1)
    #[serde(default = "default_min_speakers")]
    pub min_speakers: u32,
    /// Maximum number of speakers (optional, default 10)
    #[serde(default = "default_max_speakers")]
    pub max_speakers: u32,
}

fn default_min_speakers() -> u32 {
    1
}

fn default_max_speakers() -> u32 {
    10
}

/// A speaker identified in the transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifiedSpeaker {
    /// Unique speaker ID from diarization (e.g., "Speaker1", "Speaker2")
    pub speaker_id: String,
    /// Display name (initially same as speaker_id, can be mapped by user)
    pub display_name: String,
    /// Total speaking time in seconds
    pub total_speaking_time: f64,
    /// Number of segments spoken by this speaker
    pub segment_count: u32,
}

/// Speaker mapping for user-friendly names
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMapping {
    /// Speaker ID from diarization
    pub speaker_id: String,
    /// User-assigned name for this speaker
    pub assigned_name: String,
}

/// Result of speaker diarization with enhanced transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationResult {
    /// Transcription segments with speaker information
    pub segments: Vec<DiarizedSegment>,
    /// List of identified speakers
    pub speakers: Vec<IdentifiedSpeaker>,
    /// Full transcription text
    pub full_text: String,
    /// Language of the transcription
    pub language: String,
    /// Total duration in seconds
    pub duration_seconds: f64,
}

/// A transcription segment with speaker attribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizedSegment {
    /// The transcribed text
    pub text: String,
    /// Speaker ID (e.g., "Speaker1", "Speaker2")
    pub speaker_id: String,
    /// Speaker display name (may be user-mapped)
    pub speaker_name: String,
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Confidence score (0.0 to 1.0)
    pub confidence: f32,
    /// Language code
    pub language: String,
}

// Azure Batch Transcription API Models for Speaker Diarization

/// Request body for creating a batch transcription job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionRequest {
    pub content_urls: Option<Vec<String>>,
    pub content_container_url: Option<String>,
    pub locale: String,
    pub display_name: String,
    pub properties: BatchTranscriptionProperties,
}

/// Properties for batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionProperties {
    /// Enable speaker diarization
    #[serde(default)]
    pub diarization_enabled: bool,
    /// Speaker count hint
    pub diarization: Option<DiarizationProperties>,
    /// Enable word-level timestamps
    #[serde(default = "default_true")]
    pub word_level_timestamps_enabled: bool,
    /// Profanity filter mode
    #[serde(default = "default_profanity_mode")]
    pub profanity_filter_mode: String,
    /// Punctuation mode
    #[serde(default = "default_punctuation_mode")]
    pub punctuation_mode: String,
}

fn default_true() -> bool {
    true
}

fn default_profanity_mode() -> String {
    "Masked".to_string()
}

fn default_punctuation_mode() -> String {
    "DictatedAndAutomatic".to_string()
}

/// Diarization-specific properties
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationProperties {
    pub speakers: DiarizationSpeakerProperties,
}

/// Speaker count configuration for diarization
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationSpeakerProperties {
    pub min_count: u32,
    pub max_count: u32,
}

/// Response from creating a batch transcription job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionResponse {
    #[serde(rename = "self")]
    pub self_link: String,
    pub status: String,
    pub created_date_time: Option<String>,
    pub last_action_date_time: Option<String>,
    pub display_name: String,
    pub locale: String,
}

/// Status of a batch transcription job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionStatus {
    #[serde(rename = "self")]
    pub self_link: String,
    pub status: String,
    pub created_date_time: Option<String>,
    pub last_action_date_time: Option<String>,
    pub properties: Option<BatchTranscriptionStatusProperties>,
}

/// Properties in status response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionStatusProperties {
    pub duration: Option<String>,
    pub error: Option<BatchTranscriptionError>,
}

/// Error details from batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionError {
    pub code: String,
    pub message: String,
}

/// Files produced by batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionFiles {
    pub values: Vec<BatchTranscriptionFile>,
}

/// Individual file from batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionFile {
    #[serde(rename = "self")]
    pub self_link: String,
    pub name: String,
    pub kind: String,
    pub links: BatchTranscriptionFileLinks,
}

/// Links to file content
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionFileLinks {
    pub content_url: String,
}

/// Transcription result with diarization from batch API
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTranscriptionResult {
    pub source: Option<String>,
    pub combined_recognized_phrases: Option<Vec<CombinedRecognizedPhrase>>,
    pub recognized_phrases: Option<Vec<RecognizedPhrase>>,
}

/// Combined phrases from batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedRecognizedPhrase {
    pub channel: Option<u32>,
    pub speaker: Option<u32>,
    pub lexical: String,
    pub itn: String,
    pub masked_itn: String,
    pub display: String,
}

/// Individual phrase with diarization info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizedPhrase {
    pub recognition_status: String,
    pub channel: Option<u32>,
    pub speaker: Option<u32>,
    pub offset: String,
    pub duration: String,
    pub offset_in_ticks: u64,
    pub duration_in_ticks: u64,
    pub n_best: Vec<NBestPhrase>,
}

/// N-best result from batch transcription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NBestPhrase {
    pub confidence: f32,
    pub lexical: String,
    pub itn: String,
    pub masked_itn: String,
    pub display: String,
    pub words: Option<Vec<WordWithSpeaker>>,
}

/// Word with speaker attribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordWithSpeaker {
    pub word: String,
    pub offset: String,
    pub duration: String,
    pub offset_in_ticks: u64,
    pub duration_in_ticks: u64,
    pub confidence: f32,
}

/// Result of a transcription operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub segments: Vec<TranscriptionSegment>,
    pub full_text: String,
    pub language: String,
    pub duration_seconds: f64,
}

// AI Summary Models

/// Configuration for AI summary generation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryConfig {
    pub endpoint: String,
    pub api_key: String,
    /// Nom du déploiement envoyé dans `model`. Absent : endpoint dédié à un seul modèle (serverless).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_top_p")]
    pub top_p: f32,
}

fn default_max_tokens() -> u32 {
    2048
}

fn default_temperature() -> f32 {
    0.3
}

fn default_top_p() -> f32 {
    0.1
}

/// Result of a summary generation operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub summary: String,
    pub style: String,
    pub tokens_used: Option<u32>,
    pub model: String,
    /// Génération arrêtée par l'utilisateur : `summary` ne contient que le début.
    #[serde(default)]
    pub cancelled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preferences_without_optional_fields_get_defaults() {
        // Ancien fichier preferences.json, écrit avant l'ajout des champs optionnels.
        let old = r#"{"default_language":"fr-FR","auto_summary":false,"save_locally":true,"theme":"dark"}"#;
        let prefs: UserPreferences = serde_json::from_str(old).unwrap();
        assert_eq!(prefs.default_language, "fr-FR");
        assert!(!prefs.auto_summary);
        assert_eq!(prefs.transcription_engine, "azure");
        assert_eq!(prefs.local_model, crate::services::local_whisper::DEFAULT_MODEL_ID);
        assert!(!prefs.recordings_directory.is_empty());
        // Résumé : Azure tant qu'un serveur local n'est pas choisi.
        assert_eq!(prefs.summary_engine, "azure");
        assert!(prefs.local_llm_url.is_empty());
        assert!(prefs.local_llm_model.is_empty());
        assert!(prefs.mistral_transcription_model.is_empty());
        assert!(prefs.mistral_summary_model.is_empty());
        // Connexion Microsoft désactivée tant qu'elle n'est pas configurée dans les Paramètres.
        assert!(!prefs.auth_enabled);
        assert!(prefs.azure_ad_client_id.is_empty());
        assert!(prefs.azure_ad_tenant_id.is_empty());
    }

    #[test]
    fn preferences_keep_snake_case_fields_for_the_front() {
        let prefs: UserPreferences = serde_json::from_value(json!({
            "default_language": "en-US", "auto_summary": true, "save_locally": true, "theme": "system",
            "recordings_directory": "D:\\rec", "transcription_engine": "local", "local_model": "tiny",
            "summary_engine": "ollama", "local_llm_url": "", "local_llm_model": "qwen3:4b",
            "auth_enabled": true, "azure_ad_client_id": "client", "azure_ad_tenant_id": "tenant"
        }))
        .unwrap();
        let out = serde_json::to_value(&prefs).unwrap();
        assert_eq!(out["recordings_directory"], "D:\\rec");
        assert_eq!(out["transcription_engine"], "local");
        assert_eq!(out["summary_engine"], "ollama");
        assert_eq!(out["local_llm_model"], "qwen3:4b");
        assert!(out.get("recordingsDirectory").is_none());
        assert_eq!(out["auth_enabled"], true);
        assert_eq!(out["azure_ad_client_id"], "client");
        assert_eq!(out["azure_ad_tenant_id"], "tenant");
    }

    #[test]
    fn meeting_status_serializes_lowercase() {
        assert_eq!(serde_json::to_value(MeetingStatus::Processing).unwrap(), "processing");
        assert_eq!(serde_json::from_str::<MeetingStatus>("\"completed\"").unwrap(), MeetingStatus::Completed);
        assert!(serde_json::from_str::<MeetingStatus>("\"Completed\"").is_err());
    }

    #[test]
    fn transcription_result_roundtrips_with_snake_case_fields() {
        let result = TranscriptionResult {
            segments: vec![TranscriptionSegment {
                text: "Bonjour".into(),
                speaker: 1,
                start_time: 1.5,
                end_time: 2.5,
                confidence: 0.5,
                language: "fr-FR".into(),
            }],
            full_text: "Bonjour".into(),
            language: "fr-FR".into(),
            duration_seconds: 2.5,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["full_text"], "Bonjour");
        assert_eq!(json["segments"][0]["start_time"], 1.5);
        let back: TranscriptionResult = serde_json::from_value(json).unwrap();
        assert_eq!(back.segments[0].end_time, 2.5);
        assert_eq!(back.duration_seconds, 2.5);
    }

    #[test]
    fn diarization_models_use_camel_case() {
        let json = serde_json::to_value(DiarizedSegment {
            text: "Salut".into(),
            speaker_id: "Speaker1".into(),
            speaker_name: "Alice".into(),
            start_time: 0.0,
            end_time: 1.0,
            confidence: 0.9,
            language: "fr-FR".into(),
        })
        .unwrap();
        for key in ["speakerId", "speakerName", "startTime", "endTime"] {
            assert!(json.get(key).is_some(), "champ {key} attendu par le front");
        }

        let result: DiarizationResult = serde_json::from_value(json!({
            "segments": [], "speakers": [{
                "speakerId": "Speaker1", "displayName": "Speaker1", "totalSpeakingTime": 12.5, "segmentCount": 3
            }],
            "fullText": "", "language": "fr-FR", "durationSeconds": 12.5
        }))
        .unwrap();
        assert_eq!(result.speakers[0].segment_count, 3);
        assert_eq!(result.speakers[0].total_speaking_time, 12.5);
    }

    #[test]
    fn diarization_config_defaults_speaker_bounds() {
        let config: DiarizationConfig =
            serde_json::from_value(json!({"speechKey": "k", "speechRegion": "westeurope", "language": "fr-FR"}))
                .unwrap();
        assert_eq!((config.min_speakers, config.max_speakers), (1, 10));
    }

    #[test]
    fn azure_realtime_result_parses_pascal_case_with_nbest_rename() {
        let body = r#"{
            "RecognitionStatus": "Success", "DisplayText": "Bonjour.", "Offset": 100, "Duration": 200,
            "NBest": [{"Confidence": 0.9, "Display": "Bonjour.", "Words": [
                {"Word": "Bonjour", "Offset": 100, "Duration": 50}
            ]}]
        }"#;
        let result: AzureSpeechRecognitionResult = serde_json::from_str(body).unwrap();
        assert_eq!(result.recognition_status, "Success");
        let best = &result.n_best.unwrap()[0];
        // Champs absents : valeurs par défaut.
        assert_eq!(best.lexical, "");
        assert_eq!(best.words.as_ref().unwrap()[0].confidence, 0.0);
    }

    #[test]
    fn batch_response_maps_the_self_link() {
        let response: BatchTranscriptionResponse = serde_json::from_value(json!({
            "self": "https://example.invalid/transcriptions/1", "status": "NotStarted",
            "displayName": "test", "locale": "fr-FR"
        }))
        .unwrap();
        assert_eq!(response.self_link, "https://example.invalid/transcriptions/1");
        assert!(response.created_date_time.is_none());
        assert_eq!(serde_json::to_value(&response).unwrap()["self"], "https://example.invalid/transcriptions/1");
    }

    #[test]
    fn batch_properties_defaults_apply_when_missing() {
        let props: BatchTranscriptionProperties = serde_json::from_value(json!({"diarization": null})).unwrap();
        assert!(!props.diarization_enabled);
        assert!(props.word_level_timestamps_enabled);
        assert_eq!(props.profanity_filter_mode, "Masked");
        assert_eq!(props.punctuation_mode, "DictatedAndAutomatic");
    }

    #[test]
    fn batch_request_serializes_for_the_azure_api() {
        let request = BatchTranscriptionRequest {
            content_urls: Some(vec!["https://example.invalid/a.wav".into()]),
            content_container_url: None,
            locale: "fr-FR".into(),
            display_name: "SealedScribe".into(),
            properties: BatchTranscriptionProperties {
                diarization_enabled: true,
                diarization: Some(DiarizationProperties {
                    speakers: DiarizationSpeakerProperties { min_count: 1, max_count: 4 },
                }),
                word_level_timestamps_enabled: true,
                profanity_filter_mode: "Masked".into(),
                punctuation_mode: "DictatedAndAutomatic".into(),
            },
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["contentUrls"][0], "https://example.invalid/a.wav");
        assert_eq!(json["properties"]["diarizationEnabled"], true);
        assert_eq!(json["properties"]["diarization"]["speakers"]["maxCount"], 4);
    }

    #[test]
    fn summary_config_defaults_and_optional_model() {
        let config: SummaryConfig =
            serde_json::from_value(json!({"endpoint": "https://example.invalid", "apiKey": "k"})).unwrap();
        assert!(config.model.is_none());
        assert_eq!(config.max_tokens, 2048);
        assert_eq!(config.temperature, 0.3);
        assert_eq!(config.top_p, 0.1);
    }

    #[test]
    fn summary_result_cancelled_defaults_to_false() {
        let result: SummaryResult = serde_json::from_value(
            json!({"summary": "ok", "style": "short", "tokensUsed": null, "model": "gpt"}),
        )
        .unwrap();
        assert!(!result.cancelled);
        assert!(result.tokens_used.is_none());
    }

    #[test]
    fn default_recordings_directory_is_never_empty() {
        assert!(!default_recordings_directory().is_empty());
    }
}
