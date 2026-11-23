//! Secrets des services en ligne : clés Azure (Speech et AI Inference) et clé Mistral AI
//! (transcription Voxtral et résumé, une seule clé pour les deux).
//!
//! Les valeurs sont stockées dans le Gestionnaire d'identifiants Windows (DPAPI, par utilisateur)
//! et ne sont jamais renvoyées au front : celui-ci ne reçoit que `CredentialsStatus`.
//! En développement, des variables d'environnement `AZURE_*` et `MISTRAL_API_KEY` (sans préfixe `VITE_`)
//! surchargent le keyring.

use crate::error::{AppError, AppResult};
use crate::models::{DiarizationConfig, SummaryConfig, TranscriptionConfig};
use crate::services::mistral::MistralTranscriptionService;
use crate::services::{DiarizationService, SummaryService, TranscriptionService};
use serde::Serialize;

// Ancien nom de l'app, gardé : les clés déjà enregistrées dans le Gestionnaire d'identification
// sont rangées sous ce nom.
const SERVICE: &str = "MeetScribe";
const DEFAULT_REGION: &str = "francecentral";

const ENTRY_SPEECH_KEY: &str = "azure_speech_key";
const ENTRY_SPEECH_REGION: &str = "azure_speech_region";
const ENTRY_AI_ENDPOINT: &str = "azure_ai_inference_endpoint";
const ENTRY_AI_KEY: &str = "azure_ai_inference_key";
const ENTRY_AI_MODEL: &str = "azure_ai_inference_model";
const ENTRY_MISTRAL_KEY: &str = "mistral_api_key";

/// Secrets chargés en mémoire côté Rust. Volontairement sans `Serialize` ni `Debug`.
#[derive(Clone)]
pub struct AzureSecrets {
    pub speech_key: Option<String>,
    pub speech_region: String,
    pub ai_endpoint: Option<String>,
    pub ai_key: Option<String>,
    /// Nom du déploiement (pas un secret, mais rangé avec l'endpoint).
    pub ai_model: Option<String>,
    /// Clé API Mistral AI (transcription et résumé).
    pub mistral_key: Option<String>,
}

/// Saisie utilisateur. `None` = inchangé, `Some("")` = supprimer, `Some(v)` = remplacer.
#[derive(Default)]
pub struct AzureSecretsInput {
    pub speech_key: Option<String>,
    pub speech_region: Option<String>,
    pub ai_endpoint: Option<String>,
    pub ai_key: Option<String>,
    pub ai_model: Option<String>,
    pub mistral_key: Option<String>,
}

/// Seul type renvoyé au front : jamais de valeur secrète.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsStatus {
    pub speech_configured: bool,
    pub ai_inference_configured: bool,
    /// Détail pour dire à l'utilisateur ce qui manque.
    pub ai_endpoint_configured: bool,
    pub ai_key_configured: bool,
    pub speech_region: String,
    /// Nom du déploiement : pas un secret, affiché dans Paramètres.
    pub ai_model: Option<String>,
    pub mistral_configured: bool,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Variable d'environnement d'abord, sinon keyring.
fn read(entry: &str, env_var: &str) -> Option<String> {
    if let Some(value) = non_empty(std::env::var(env_var).ok()) {
        return Some(value);
    }
    let stored = keyring::Entry::new(SERVICE, entry)
        .ok()
        .and_then(|e| e.get_password().ok());
    non_empty(stored)
}

pub fn load() -> AzureSecrets {
    AzureSecrets {
        speech_key: read(ENTRY_SPEECH_KEY, "AZURE_SPEECH_KEY"),
        speech_region: read(ENTRY_SPEECH_REGION, "AZURE_SPEECH_REGION")
            .unwrap_or_else(|| DEFAULT_REGION.to_string()),
        ai_endpoint: read(ENTRY_AI_ENDPOINT, "AZURE_AI_INFERENCE_ENDPOINT"),
        ai_key: read(ENTRY_AI_KEY, "AZURE_AI_INFERENCE_KEY"),
        ai_model: read(ENTRY_AI_MODEL, "AZURE_AI_INFERENCE_MODEL"),
        mistral_key: read(ENTRY_MISTRAL_KEY, "MISTRAL_API_KEY"),
    }
}

pub fn status(secrets: &AzureSecrets) -> CredentialsStatus {
    CredentialsStatus {
        speech_configured: secrets.speech_key.is_some(),
        ai_inference_configured: secrets.ai_key.is_some() && secrets.ai_endpoint.is_some(),
        ai_endpoint_configured: secrets.ai_endpoint.is_some(),
        ai_key_configured: secrets.ai_key.is_some(),
        speech_region: secrets.speech_region.clone(),
        ai_model: secrets.ai_model.clone(),
        mistral_configured: secrets.mistral_key.is_some(),
    }
}

/// La région est insérée dans l'hôte de l'URL Azure : on n'accepte que `[a-z0-9]{1,32}`.
pub fn validate_region(region: &str) -> AppResult<()> {
    let valid = !region.is_empty()
        && region.len() <= 32
        && region.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if valid {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Région Azure invalide (lettres minuscules et chiffres uniquement, ex. francecentral)".to_string(),
        ))
    }
}

/// L'endpoint reçoit la clé API et le transcript : HTTPS obligatoire.
pub fn validate_https_endpoint(endpoint: &str) -> AppResult<()> {
    let rest = endpoint.strip_prefix("https://").unwrap_or("");
    if rest.is_empty() || rest.starts_with('/') || endpoint.chars().any(char::is_whitespace) {
        return Err(AppError::Validation(
            "L'endpoint AI Inference doit commencer par https://".to_string(),
        ));
    }
    Ok(())
}

fn apply_entry(entry: &str, value: Option<String>) -> AppResult<()> {
    let Some(value) = value else { return Ok(()) };
    let value = value.trim();
    let keyring_entry = keyring::Entry::new(SERVICE, entry)
        .map_err(|e| AppError::ConfigError(format!("Keyring indisponible: {}", e)))?;
    if value.is_empty() {
        match keyring_entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::ConfigError(format!("Suppression impossible: {}", e))),
        }
    } else {
        keyring_entry
            .set_password(value)
            .map_err(|e| AppError::ConfigError(format!("Enregistrement impossible: {}", e)))
    }
}

pub fn save(input: &AzureSecretsInput) -> AppResult<()> {
    if let Some(region) = input.speech_region.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        validate_region(region)?;
    }
    if let Some(endpoint) = input.ai_endpoint.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        validate_https_endpoint(endpoint)?;
    }
    apply_entry(ENTRY_SPEECH_KEY, input.speech_key.clone())?;
    apply_entry(ENTRY_SPEECH_REGION, input.speech_region.clone())?;
    apply_entry(ENTRY_AI_ENDPOINT, input.ai_endpoint.clone())?;
    apply_entry(ENTRY_AI_KEY, input.ai_key.clone())?;
    apply_entry(ENTRY_AI_MODEL, input.ai_model.clone())?;
    apply_entry(ENTRY_MISTRAL_KEY, input.mistral_key.clone())?;
    Ok(())
}

/// Reconfigure (ou vide) les services à partir des secrets chargés.
pub async fn configure_services(
    secrets: &AzureSecrets,
    transcription: &TranscriptionService,
    diarization: &DiarizationService,
    summary: &SummaryService,
    mistral: &MistralTranscriptionService,
) -> AppResult<()> {
    summary.set_mistral_key(secrets.mistral_key.clone()).await;
    mistral.set_key(secrets.mistral_key.clone()).await;

    match &secrets.speech_key {
        Some(key) => {
            transcription
                .configure(TranscriptionConfig {
                    speech_key: key.clone(),
                    speech_region: secrets.speech_region.clone(),
                    language: "en-US".to_string(), // surchargé à chaque requête
                })
                .await?;
            diarization
                .configure(DiarizationConfig {
                    speech_key: key.clone(),
                    speech_region: secrets.speech_region.clone(),
                    language: "en-US".to_string(),
                    min_speakers: 1,
                    max_speakers: 10,
                })
                .await?;
        }
        None => {
            transcription.clear().await;
            diarization.clear().await;
        }
    }

    match (&secrets.ai_endpoint, &secrets.ai_key) {
        (Some(endpoint), Some(key)) => {
            summary
                .configure(SummaryConfig {
                    endpoint: endpoint.clone(),
                    api_key: key.clone(),
                    model: secrets.ai_model.clone(),
                    max_tokens: 2048,
                    temperature: 0.3,
                    top_p: 0.1,
                })
                .await?;
        }
        _ => summary.clear().await,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_validation() {
        assert!(validate_region("francecentral").is_ok());
        assert!(validate_region("westeurope").is_ok());
        assert!(validate_region("").is_err());
        assert!(validate_region("evil.com/").is_err());
        assert!(validate_region("a@b").is_err());
        assert!(validate_region("France").is_err());
    }

    #[test]
    fn endpoint_validation() {
        assert!(validate_https_endpoint("https://x.services.ai.azure.com/models").is_ok());
        assert!(validate_https_endpoint("http://x.example.com").is_err());
        assert!(validate_https_endpoint("https://").is_err());
        assert!(validate_https_endpoint("https:///path").is_err());
        assert!(validate_https_endpoint("https://a b").is_err());
    }
}
