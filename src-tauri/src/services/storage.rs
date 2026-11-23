use crate::error::AppResult;
use crate::models::UserPreferences;
use std::path::PathBuf;
use serde_json;


pub struct StorageService {
    config_dir: PathBuf,
}

impl StorageService {
    pub fn new() -> AppResult<Self> {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("meetscribe");

        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir)?;
        }

        Ok(Self { config_dir })
    }

    /// Get recordings directory from preferences, creating it if needed
    pub fn get_recordings_dir(&self) -> AppResult<PathBuf> {
        let prefs = self.load_preferences()?;
        let recordings_dir = PathBuf::from(&prefs.recordings_directory);

        if !recordings_dir.exists() {
            std::fs::create_dir_all(&recordings_dir)?;
        }

        Ok(recordings_dir)
    }

    /// Get recordings directory path as string
    pub fn get_recordings_dir_string(&self) -> AppResult<String> {
        let prefs = self.load_preferences()?;
        let recordings_dir = PathBuf::from(&prefs.recordings_directory);

        if !recordings_dir.exists() {
            std::fs::create_dir_all(&recordings_dir)?;
        }

        Ok(prefs.recordings_directory)
    }

    pub fn load_preferences(&self) -> AppResult<UserPreferences> {
        let prefs_path = self.config_dir.join("preferences.json");

        if prefs_path.exists() {
            let content = std::fs::read_to_string(&prefs_path)?;
            let prefs: UserPreferences = serde_json::from_str(&content)?;
            Ok(prefs)
        } else {
            Ok(UserPreferences {
                default_language: "en-US".to_string(),
                auto_summary: true,
                save_locally: true,
                theme: "system".to_string(),
                recordings_directory: crate::models::default_recordings_directory(),
                transcription_engine: crate::models::new_install_transcription_engine(),
                local_model: crate::models::default_local_model(),
                summary_engine: crate::models::default_summary_engine(),
                local_llm_url: String::new(),
                local_llm_model: String::new(),
                mistral_transcription_model: String::new(),
                mistral_summary_model: String::new(),
                auth_enabled: false,
                azure_ad_client_id: String::new(),
                azure_ad_tenant_id: String::new(),
            })
        }
    }

    pub fn save_preferences(&self, prefs: &UserPreferences) -> AppResult<()> {
        let prefs_path = self.config_dir.join("preferences.json");
        let content = serde_json::to_string_pretty(prefs)?;
        std::fs::write(prefs_path, content)?;
        Ok(())
    }
}

impl Default for StorageService {
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| {
            Self {
                config_dir: PathBuf::from("."),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Service pointant sur un dossier temporaire unique (jamais le vrai dossier de config).
    struct Fixture {
        dir: PathBuf,
        service: StorageService,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("meetscribe-test-storage-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let service = StorageService { config_dir: dir.clone() };
            Self { dir, service }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn prefs(recordings_dir: &str) -> UserPreferences {
        UserPreferences {
            default_language: "fr-FR".to_string(),
            auto_summary: false,
            save_locally: true,
            theme: "dark".to_string(),
            recordings_directory: recordings_dir.to_string(),
            transcription_engine: "local".to_string(),
            local_model: "tiny".to_string(),
            summary_engine: "ollama".to_string(),
            local_llm_url: String::new(),
            local_llm_model: "qwen3:4b".to_string(),
            mistral_transcription_model: String::new(),
            mistral_summary_model: "mistral-large-latest".to_string(),
            auth_enabled: false,
            azure_ad_client_id: String::new(),
            azure_ad_tenant_id: String::new(),
        }
    }

    #[test]
    fn missing_preferences_file_gives_defaults() {
        let fx = Fixture::new();
        let loaded = fx.service.load_preferences().unwrap();
        assert_eq!(loaded.default_language, "en-US");
        assert!(loaded.auto_summary);
        // Nouvelle installation : moteur local, sans clé à saisir.
        assert_eq!(loaded.transcription_engine, "local");
        assert!(!loaded.recordings_directory.is_empty());
    }

    #[test]
    fn saved_preferences_are_loaded_back() {
        let fx = Fixture::new();
        fx.service.save_preferences(&prefs("D:\\rec")).unwrap();
        let loaded = fx.service.load_preferences().unwrap();
        assert_eq!(loaded.default_language, "fr-FR");
        assert!(!loaded.auto_summary);
        assert_eq!(loaded.recordings_directory, "D:\\rec");
        assert_eq!(loaded.local_model, "tiny");
    }

    #[test]
    fn corrupt_preferences_file_is_an_error() {
        let fx = Fixture::new();
        std::fs::write(fx.dir.join("preferences.json"), "{pas du json").unwrap();
        assert!(matches!(
            fx.service.load_preferences(),
            Err(crate::error::AppError::SerializationError(_))
        ));
    }

    #[test]
    fn recordings_dir_is_created_from_preferences() {
        let fx = Fixture::new();
        let target = fx.dir.join("enregistrements").join("2026");
        fx.service.save_preferences(&prefs(&target.to_string_lossy())).unwrap();
        assert!(!target.exists());

        assert_eq!(fx.service.get_recordings_dir().unwrap(), target);
        assert!(target.is_dir());
        assert_eq!(fx.service.get_recordings_dir_string().unwrap(), target.to_string_lossy());
    }
}
