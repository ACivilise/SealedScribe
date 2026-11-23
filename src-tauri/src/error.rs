use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Audio error: {0}")]
    AudioError(String),

    #[error("Transcription error: {0}")]
    TranscriptionError(String),

    #[error("File I/O error: {0}")]
    FileError(#[from] std::io::Error),

    #[error("HTTP request error: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("API error: {0}")]
    Api(String),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Authentication error: {0}")]
    AuthError(String),

    #[error("{0}")]
    Custom(String),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_messages_carry_their_prefix_and_detail() {
        assert_eq!(AppError::AudioError("pas de micro".into()).to_string(), "Audio error: pas de micro");
        assert_eq!(
            AppError::TranscriptionError("échec".into()).to_string(),
            "Transcription error: échec"
        );
        assert_eq!(AppError::Validation("vide".into()).to_string(), "Validation error: vide");
        assert_eq!(AppError::AuthError("clé".into()).to_string(), "Authentication error: clé");
        assert_eq!(AppError::Unknown("?".into()).to_string(), "Unknown error: ?");
    }

    #[test]
    fn custom_error_is_displayed_verbatim() {
        // Les messages Custom sont affichés tels quels à l'utilisateur (voir `to_tauri_error`).
        assert_eq!(AppError::Custom("Transcription annulée".into()).to_string(), "Transcription annulée");
    }

    #[test]
    fn io_errors_convert_with_question_mark() {
        fn read_missing() -> AppResult<String> {
            Ok(std::fs::read_to_string(std::env::temp_dir().join("meetscribe-fichier-inexistant.txt"))?)
        }
        let error = read_missing().unwrap_err();
        assert!(matches!(error, AppError::FileError(_)));
        assert!(error.to_string().starts_with("File I/O error: "));
    }

    #[test]
    fn json_errors_convert_with_question_mark() {
        fn parse(body: &str) -> AppResult<serde_json::Value> {
            Ok(serde_json::from_str(body)?)
        }
        assert!(parse("{\"ok\": true}").is_ok());
        let error = parse("{pas du json").unwrap_err();
        assert!(matches!(error, AppError::SerializationError(_)));
        assert!(error.to_string().starts_with("Serialization error: "));
    }
}
