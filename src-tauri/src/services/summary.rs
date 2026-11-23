//! Service de résumé IA. Trois moteurs, choisis dans Paramètres > Résumé IA
//! (`UserPreferences::summary_engine`) :
//!
//! - **Azure** (défaut) : API Chat Completions d'Azure en streaming SSE. API OpenAI v1 d'une
//!   ressource Foundry (`https://<ressource>.services.ai.azure.com/openai/v1`, modèle = nom du
//!   déploiement) ou endpoint Azure AI Inference historique (serverless).
//! - **Ollama** : API native `/api/chat` (une ligne JSON par morceau). Elle seule permet de fixer
//!   la taille du contexte (`num_ctx`) : l'endpoint compatible OpenAI d'Ollama garde 4 096 jetons
//!   sur une carte de moins de 24 Go et tronque la transcription sans le dire.
//! - **Serveur compatible OpenAI** (LM Studio, llama-server…) : `/v1/chat/completions` en SSE ;
//!   la taille du contexte se règle dans le serveur.
//! - **Mistral AI** en direct (`api.mistral.ai`), avec la clé Mistral partagée avec la transcription
//!   Voxtral (voir `mistral`).
//!
//! Un serveur local doit tourner sur ce PC (adresse de bouclage) : la transcription ne quitte pas
//! la machine, d'où HTTP accepté et aucune clé. Appels HTTP directs, sans SDK.
//!
//! Les prompts (types de résumé) et la langue de sortie sont choisis côté front :
//! ce service reçoit le message système et le prompt déjà rédigés.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::models::{SummaryConfig, SummaryResult, UserPreferences};
use crate::services::hardware::{Device, HardwareProfile};
use crate::services::mistral;

// ============================================================================
// Choix du moteur
// ============================================================================

/// Valeurs de `UserPreferences::summary_engine`.
pub const ENGINE_AZURE: &str = "azure";
pub const ENGINE_OLLAMA: &str = "ollama";
pub const ENGINE_OPENAI: &str = "openai";
pub const ENGINE_MISTRAL: &str = mistral::ENGINE_MISTRAL;

/// Serveur de modèles qui tourne sur ce PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalServer {
    Ollama,
    /// LM Studio, llama-server ou tout serveur qui expose `/v1/chat/completions`.
    OpenAi,
}

impl LocalServer {
    pub fn from_engine(engine: &str) -> Option<Self> {
        match engine {
            ENGINE_OLLAMA => Some(Self::Ollama),
            ENGINE_OPENAI => Some(Self::OpenAi),
            _ => None,
        }
    }

    /// Adresse par défaut : Ollama, et LM Studio pour le serveur compatible OpenAI.
    fn default_url(self) -> &'static str {
        match self {
            Self::Ollama => "http://127.0.0.1:11434",
            Self::OpenAi => "http://127.0.0.1:1234/v1",
        }
    }

    /// Nom dans les messages d'erreur (en milieu de phrase).
    fn name(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::OpenAi => "le serveur local",
        }
    }

    /// Racine de l'API d'après la saisie (vide : adresse par défaut). Une URL complète collée
    /// telle quelle (`…/api/chat`, `…/v1/chat/completions`) est ramenée à sa racine.
    fn base_url(self, input: &str) -> String {
        let input = input.trim();
        let mut base = if input.is_empty() { self.default_url() } else { input }.trim_end_matches('/');
        let suffixes: &[&str] = match self {
            Self::Ollama => &["/api/chat", "/api/tags", "/api", "/v1/chat/completions", "/v1"],
            Self::OpenAi => &["/chat/completions", "/models"],
        };
        if let Some(stripped) = suffixes.iter().find_map(|suffix| base.strip_suffix(suffix)) {
            base = stripped.trim_end_matches('/');
        }
        // `http://127.0.0.1:8080` (llama-server) : l'API OpenAI est sous `/v1`.
        let has_path = base.split_once("://").is_some_and(|(_, rest)| rest.contains('/'));
        if self == Self::OpenAi && !has_path {
            return format!("{base}/v1");
        }
        base.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalLlm {
    pub server: LocalServer,
    /// Racine de l'API, sans `/` final.
    pub base_url: String,
    /// Vide tant qu'aucun modèle n'est choisi.
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SummaryEngine {
    Azure,
    /// Mistral AI en direct, avec ce modèle (`mistral-medium-latest` si rien n'est saisi).
    Mistral { model: String },
    Local(LocalLlm),
}

impl SummaryEngine {
    /// Moteur choisi dans les préférences ; valeur inconnue : Azure.
    pub fn from_preferences(prefs: &UserPreferences) -> Self {
        if prefs.summary_engine == ENGINE_MISTRAL {
            return Self::Mistral {
                model: mistral::model_or_default(&prefs.mistral_summary_model, mistral::DEFAULT_CHAT_MODEL),
            };
        }
        match LocalServer::from_engine(&prefs.summary_engine) {
            Some(server) => Self::Local(LocalLlm {
                server,
                base_url: server.base_url(&prefs.local_llm_url),
                model: prefs.local_llm_model.trim().to_string(),
            }),
            None => Self::Azure,
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local(_))
    }
}

/// Un serveur local doit être sur ce PC : la transcription ne quitte pas la machine, et HTTP
/// (sans chiffrement) n'est acceptable qu'en bouclage.
pub fn validate_local_url(url: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| {
            AppError::Custom(format!(
                "Adresse du serveur local invalide : {url}. Exemple : http://127.0.0.1:11434"
            ))
        })?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if loopback {
        Ok(())
    } else {
        Err(AppError::Custom(format!(
            "Le serveur local doit tourner sur ce PC (localhost ou 127.0.0.1) : « {host} » n'est pas accepté, la transcription ne doit pas quitter la machine."
        )))
    }
}

// ============================================================================
// Azure : URL et corps de requête
// ============================================================================

/// API visée, déduite de l'URL saisie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiFlavor {
    /// API OpenAI v1 d'Azure (`…/openai/v1`) : pas d'`api-version`, `max_completion_tokens`,
    /// paramètres d'échantillonnage laissés par défaut (refusés par les modèles de raisonnement).
    OpenAiV1,
    /// Endpoint Azure AI Inference historique (serverless ou `…/models`) : `api-version` requis.
    Legacy,
}

const LEGACY_API_VERSION: &str = "2024-05-01-preview";
/// Budget de sortie pour l'API v1 : les modèles de raisonnement y comptent aussi leur réflexion.
const V1_MAX_COMPLETION_TOKENS: u32 = 16_000;
const DEFAULT_MODEL_LABEL: &str = "Azure AI";

/// Construit l'URL Chat Completions à partir de ce que l'utilisateur a collé :
/// la racine (`…/openai/v1`), ou une URL déjà complète en `/chat/completions` ou `/responses`.
fn build_chat_url(endpoint: &str) -> (String, ApiFlavor) {
    let (path, query) = match endpoint.trim().split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (endpoint.trim(), None),
    };
    let mut base = path.trim_end_matches('/');
    for suffix in ["/chat/completions", "/responses"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            base = stripped.trim_end_matches('/');
        }
    }

    if base.to_ascii_lowercase().ends_with("/openai/v1") {
        return (format!("{base}/chat/completions"), ApiFlavor::OpenAiV1);
    }

    let query = match query.filter(|q| !q.is_empty()) {
        Some(q) if q.contains("api-version=") => q.to_string(),
        Some(q) => format!("{q}&api-version={LEGACY_API_VERSION}"),
        None => format!("api-version={LEGACY_API_VERSION}"),
    };
    (format!("{base}/chat/completions?{query}"), ApiFlavor::Legacy)
}

/// Corps Chat Completions ; les champs absents ne sont pas envoyés.
#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    stream: bool,
    /// Demande l'usage des jetons dans le dernier morceau.
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
}

#[derive(Debug, Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

fn build_request(
    flavor: ApiFlavor,
    config: &SummaryConfig,
    messages: Vec<ChatMessage>,
) -> Result<ChatCompletionRequest, AppError> {
    Ok(match flavor {
        ApiFlavor::OpenAiV1 => {
            let model = config.model.clone().ok_or_else(|| {
                AppError::Configuration(
                    "Indiquez le modèle (nom du déploiement Azure) dans Paramètres pour utiliser un endpoint /openai/v1.".to_string(),
                )
            })?;
            ChatCompletionRequest {
                model: Some(model),
                messages,
                max_tokens: None,
                max_completion_tokens: Some(V1_MAX_COMPLETION_TOKENS),
                temperature: None,
                top_p: None,
                stream: true,
                stream_options: Some(StreamOptions { include_usage: true }),
            }
        }
        ApiFlavor::Legacy => ChatCompletionRequest {
            model: config.model.clone(),
            messages,
            max_tokens: Some(config.max_tokens),
            max_completion_tokens: None,
            temperature: Some(config.temperature),
            top_p: Some(config.top_p),
            stream: true,
            stream_options: None,
        },
    })
}

// ============================================================================
// Serveurs locaux : corps de requête
// ============================================================================

/// Estimation large pour du français (environ 3 caractères par jeton) : mieux vaut un contexte
/// un peu trop grand qu'une transcription tronquée.
const CHARS_PER_TOKEN: usize = 3;
/// Jetons laissés au résumé dans le contexte d'Ollama.
const OLLAMA_OUTPUT_RESERVE: usize = 4_096;
const OLLAMA_CONTEXT_STEP: usize = 4_096;
const OLLAMA_MIN_CONTEXT: usize = 8_192;
/// Au-delà (une dizaine d'heures de réunion), Ollama tronquera le début.
const OLLAMA_MAX_CONTEXT: usize = 131_072;

/// Contexte demandé à Ollama pour `input_chars` caractères de messages : de quoi tout lire et
/// écrire le résumé, arrondi au multiple de 4 096 supérieur. Plus le contexte est grand, plus il
/// prend de mémoire : Ollama reporte alors une partie du modèle sur le processeur.
fn ollama_context_tokens(input_chars: usize) -> u32 {
    let needed = input_chars.div_ceil(CHARS_PER_TOKEN) + OLLAMA_OUTPUT_RESERVE;
    let rounded = needed.div_ceil(OLLAMA_CONTEXT_STEP) * OLLAMA_CONTEXT_STEP;
    rounded.clamp(OLLAMA_MIN_CONTEXT, OLLAMA_MAX_CONTEXT) as u32
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    /// Pas de phase de réflexion : inutile pour un résumé et coûteuse sur une petite carte.
    /// Retiré si le modèle refuse le paramètre (voir `generate_stream`).
    think: bool,
    options: OllamaOptions,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    num_ctx: u32,
}

/// Format du flux de réponse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamFormat {
    /// Server-Sent Events (`data: {...}`) : Azure et serveurs compatibles OpenAI.
    Sse,
    /// Une ligne JSON par morceau : API native d'Ollama.
    Ndjson,
}

/// URL, corps et format d'une requête vers un serveur local.
fn local_request(llm: &LocalLlm, messages: Vec<ChatMessage>) -> Result<(String, serde_json::Value, StreamFormat), AppError> {
    Ok(match llm.server {
        LocalServer::Ollama => {
            let chars = messages.iter().map(|m| m.content.chars().count()).sum();
            let num_ctx = ollama_context_tokens(chars);
            log::info!("[Summary] Ollama : contexte de {num_ctx} jetons pour {chars} caractères");
            let body = OllamaChatRequest {
                model: llm.model.clone(),
                messages,
                stream: true,
                think: false,
                options: OllamaOptions { num_ctx },
            };
            (format!("{}/api/chat", llm.base_url), serde_json::to_value(body)?, StreamFormat::Ndjson)
        }
        LocalServer::OpenAi => {
            // Échantillonnage et longueur de sortie : réglages du modèle dans le serveur.
            let body = ChatCompletionRequest {
                model: Some(llm.model.clone()),
                messages,
                max_tokens: None,
                max_completion_tokens: None,
                temperature: None,
                top_p: None,
                stream: true,
                stream_options: Some(StreamOptions { include_usage: true }),
            };
            (format!("{}/chat/completions", llm.base_url), serde_json::to_value(body)?, StreamFormat::Sse)
        }
    })
}

// ============================================================================
// Lecture des réponses
// ============================================================================

/// Morceau de réponse en streaming (`data: {...}`), ou réponse complète si le serveur
/// n'a pas streamé : les deux formes sont lues avec la même structure.
#[derive(Debug, Default, Deserialize)]
struct ChatChunk {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<TokenUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    /// Présent en streaming.
    #[serde(default)]
    delta: Option<ChunkMessage>,
    /// Présent dans une réponse non streamée.
    #[serde(default)]
    message: Option<ChunkMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChunkMessage {
    /// Texte, ou liste de morceaux typés (modèles de raisonnement de Mistral :
    /// `[{"type":"thinking",…},{"type":"text","text":"…"}]`) dont on garde le texte.
    #[serde(default)]
    content: Option<serde_json::Value>,
}

impl ChunkMessage {
    fn text(self) -> Option<String> {
        match self.content? {
            serde_json::Value::String(text) => Some(text),
            serde_json::Value::Array(parts) => Some(
                parts
                    .iter()
                    .filter(|part| part.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                    .collect(),
            ),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TokenUsage {
    total_tokens: u32,
}

/// Ligne du flux d'Ollama. La dernière (`done`) porte la raison de fin et les compteurs ;
/// une erreur survenue en cours de génération arrive dans `error`.
#[derive(Debug, Default, Deserialize)]
struct OllamaChunk {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    message: Option<ChunkMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    done_reason: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
    #[serde(default)]
    error: Option<String>,
}

/// Évènement envoyé au front pendant la génération.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SummaryStreamEvent {
    /// Texte à ajouter à la fin du résumé.
    Delta { text: String },
}

/// Agrège les morceaux reçus.
#[derive(Default)]
struct StreamState {
    text: String,
    model: Option<String>,
    tokens_used: Option<u32>,
    finish_reason: Option<String>,
}

impl StreamState {
    /// Ajoute du texte et renvoie ce qui est nouveau.
    fn push_text(&mut self, added: String) -> Option<String> {
        if added.is_empty() {
            return None;
        }
        self.text.push_str(&added);
        Some(added)
    }

    fn set_model(&mut self, model: Option<String>) {
        if self.model.is_none() {
            self.model = model.filter(|m| !m.is_empty());
        }
    }

    /// Intègre un morceau Chat Completions et renvoie le texte nouveau à transmettre au front.
    fn absorb(&mut self, chunk: ChatChunk) -> Option<String> {
        self.set_model(chunk.model);
        if let Some(usage) = chunk.usage {
            self.tokens_used = Some(usage.total_tokens);
        }
        let mut added = String::new();
        for choice in chunk.choices {
            if let Some(reason) = choice.finish_reason {
                self.finish_reason = Some(reason);
            }
            let content = choice
                .delta
                .and_then(ChunkMessage::text)
                .or_else(|| choice.message.and_then(ChunkMessage::text));
            if let Some(content) = content {
                added.push_str(&content);
            }
        }
        self.push_text(added)
    }

    /// Intègre une ligne d'Ollama.
    fn absorb_ollama(&mut self, chunk: OllamaChunk) -> Option<String> {
        self.set_model(chunk.model);
        if let Some(reason) = chunk.done_reason {
            self.finish_reason = Some(reason);
        }
        if chunk.prompt_eval_count.is_some() || chunk.eval_count.is_some() {
            self.tokens_used = Some(chunk.prompt_eval_count.unwrap_or(0) + chunk.eval_count.unwrap_or(0));
        }
        self.push_text(chunk.message.and_then(ChunkMessage::text).unwrap_or_default())
    }

    /// Traite une ligne complète du flux : renvoie le texte nouveau et si le flux est terminé.
    fn absorb_line(&mut self, format: StreamFormat, line: &str) -> Result<(Option<String>, bool), AppError> {
        match format {
            StreamFormat::Sse => {
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    return Ok((None, false)); // `event:`, commentaire, ligne vide
                };
                if data == "[DONE]" {
                    return Ok((None, true));
                }
                match serde_json::from_str::<ChatChunk>(data) {
                    Ok(chunk) => Ok((self.absorb(chunk), false)),
                    Err(e) => {
                        log::warn!("Morceau SSE illisible ignoré : {e}");
                        Ok((None, false))
                    }
                }
            }
            StreamFormat::Ndjson => {
                if line.is_empty() {
                    return Ok((None, false));
                }
                let chunk: OllamaChunk = match serde_json::from_str(line) {
                    Ok(chunk) => chunk,
                    Err(e) => {
                        log::warn!("Ligne Ollama illisible ignorée : {e}");
                        return Ok((None, false));
                    }
                };
                if let Some(error) = chunk.error {
                    return Err(AppError::Custom(format!("Ollama a interrompu la génération : {error}")));
                }
                let done = chunk.done;
                Ok((self.absorb_ollama(chunk), done))
            }
        }
    }
}

/// Découpe le flux en lignes complètes ; un caractère UTF-8 ou une ligne coupés entre deux
/// paquets attendent le paquet suivant.
#[derive(Default)]
struct LineBuffer {
    bytes: Vec<u8>,
    text: String,
}

impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.bytes.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.bytes) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        self.text.push_str(std::str::from_utf8(&self.bytes[..valid]).unwrap_or_default());
        self.bytes.drain(..valid);

        let mut lines = Vec::new();
        while let Some(pos) = self.text.find('\n') {
            let line: String = self.text.drain(..=pos).collect();
            lines.push(line.trim().to_string());
        }
        lines
    }

    /// Dernière ligne, si le flux ne finit pas par un saut de ligne.
    fn finish(self) -> Option<String> {
        Some(self.text.trim().to_string()).filter(|line| !line.is_empty())
    }
}

/// Message d'une réponse en erreur : `{"error": "..."}` (Ollama), `{"error": {"message": "..."}}`
/// (OpenAI), `{"message": "..."}` ou `{"detail": [{"msg": "..."}]}` (Mistral), sinon le corps brut.
pub(crate) fn server_error_detail(body: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let detail = parsed.as_ref().and_then(|v| {
        let error = v.get("error");
        error
            .and_then(text)
            .or_else(|| error.and_then(|e| e.get("message")).and_then(text))
            .or_else(|| v.get("message").and_then(text))
            .or_else(|| {
                let items = v.get("detail")?.as_array()?;
                let messages: Vec<String> = items.iter().filter_map(|d| d.get("msg").and_then(text)).collect();
                (!messages.is_empty()).then(|| messages.join(" ; "))
            })
    });
    let detail = detail.unwrap_or_else(|| body.chars().take(300).collect());
    let detail = detail.trim();
    if detail.is_empty() {
        "réponse vide".to_string()
    } else {
        detail.to_string()
    }
}

// ============================================================================
// Requête préparée et attentes interruptibles
// ============================================================================

/// Silence maximal du serveur entre deux paquets. Azure, Mistral : réflexion d'un modèle de
/// raisonnement. Local : chargement du modèle puis lecture d'une longue transcription, parfois sur
/// le processeur.
const CLOUD_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LOCAL_IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Liste des modèles d'un serveur local.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// Destinataire d'une requête (authentification, messages d'erreur, client, délai d'attente).
enum Target {
    /// En-tête `api-key`.
    Azure { key: String },
    /// En-tête `Authorization: Bearer`.
    Mistral { key: String },
    /// Serveur sur ce PC : ni clé ni proxy.
    Local(LocalLlm),
}

struct PreparedRequest {
    url: String,
    body: serde_json::Value,
    format: StreamFormat,
    /// Nom du modèle si le serveur ne le renvoie pas.
    model_label: String,
    target: Target,
}

impl PreparedRequest {
    fn is_local(&self) -> bool {
        matches!(self.target, Target::Local(_))
    }

    fn idle_timeout(&self) -> Duration {
        if self.is_local() {
            LOCAL_IDLE_TIMEOUT
        } else {
            CLOUD_IDLE_TIMEOUT
        }
    }

    fn send_error(&self, error: &reqwest::Error) -> AppError {
        match &self.target {
            Target::Local(llm) => connect_error(llm.server, &llm.base_url, error),
            Target::Mistral { .. } => AppError::Custom(format!("Échange avec Mistral AI impossible : {error}")),
            Target::Azure { .. } => AppError::Network(format!("Failed to send request: {}", error)),
        }
    }

    fn status_error(&self, status: reqwest::StatusCode, body: &str) -> AppError {
        let llm = match &self.target {
            Target::Azure { .. } => {
                return AppError::Api(format!("AI Inference API returned {}: {}", status, body));
            }
            Target::Mistral { .. } => return mistral::api_error(status, body),
            Target::Local(llm) => llm,
        };
        if llm.server == LocalServer::Ollama && status == reqwest::StatusCode::NOT_FOUND {
            return AppError::Custom(format!(
                "Le modèle « {0} » n'est pas installé dans Ollama. Installez-le avec : ollama pull {0}",
                llm.model
            ));
        }
        AppError::Custom(format!(
            "Réponse {} de {} : {}",
            status.as_u16(),
            llm.server.name(),
            server_error_detail(body)
        ))
    }

    fn timeout_error(&self) -> AppError {
        let minutes = self.idle_timeout().as_secs() / 60;
        let source = match &self.target {
            Target::Azure { .. } => "le service de résumé",
            Target::Mistral { .. } => "Mistral AI",
            Target::Local(llm) => llm.server.name(),
        };
        AppError::Custom(format!(
            "Aucune réponse de {source} depuis {minutes} minutes : génération abandonnée."
        ))
    }
}

fn connect_error(server: LocalServer, base_url: &str, error: &reqwest::Error) -> AppError {
    if error.is_connect() {
        AppError::Custom(format!(
            "Impossible de joindre {} à l'adresse {base_url}. Vérifiez qu'il est lancé sur ce PC.",
            server.name()
        ))
    } else {
        AppError::Custom(format!("Échange avec {} impossible : {error}", server.name()))
    }
}

/// Issue d'une attente interruptible.
enum Wait<T> {
    Ready(T),
    Cancelled,
    TimedOut,
}

/// Attend `future`, sauf si l'utilisateur arrête la génération ou si le serveur reste muet
/// plus de `idle`. Le bouton « Arrêter » agit donc aussi pendant le chargement du modèle.
async fn wait<T>(cancel: &AtomicBool, idle: Duration, future: impl Future<Output = T>) -> Wait<T> {
    tokio::select! {
        result = tokio::time::timeout(idle, future) => match result {
            Ok(value) => Wait::Ready(value),
            Err(_) => Wait::TimedOut,
        },
        _ = wait_for_cancel(cancel) => Wait::Cancelled,
    }
}

async fn wait_for_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ============================================================================
// Modèles d'un serveur local
// ============================================================================

/// Modèle proposé par un serveur local.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmModel {
    pub name: String,
    /// Taille des poids (Ollama seulement).
    pub size_bytes: Option<u64>,
    /// Les poids tiennent sur la carte NVIDIA, contexte non compris. `None` : pas de carte
    /// NVIDIA ou taille inconnue.
    pub fits_gpu: Option<bool>,
}

#[derive(Deserialize)]
struct OllamaTags {
    #[serde(default)]
    models: Vec<OllamaTag>,
}

#[derive(Deserialize)]
struct OllamaTag {
    name: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Deserialize)]
struct OpenAiModels {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

/// Modèles de génération listés par le serveur, triés par nom. Les modèles d'embedding
/// (`nomic-embed-text`…) ne savent pas résumer : ils sont écartés.
fn parse_model_list(server: LocalServer, body: &str) -> Result<Vec<LocalLlmModel>, AppError> {
    let unreadable = |e: serde_json::Error| AppError::Custom(format!("Liste des modèles illisible : {e}"));
    let mut models: Vec<LocalLlmModel> = match server {
        LocalServer::Ollama => serde_json::from_str::<OllamaTags>(body)
            .map_err(unreadable)?
            .models
            .into_iter()
            .map(|m| LocalLlmModel { name: m.name, size_bytes: m.size, fits_gpu: None })
            .collect(),
        LocalServer::OpenAi => serde_json::from_str::<OpenAiModels>(body)
            .map_err(unreadable)?
            .data
            .into_iter()
            .map(|m| LocalLlmModel { name: m.id, size_bytes: None, fits_gpu: None })
            .collect(),
    };
    models.retain(|m| !m.name.to_ascii_lowercase().contains("embed"));
    models.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(models)
}

/// Les poids tiennent-ils sur la carte NVIDIA (même réserve que pour Whisper) ?
fn fits_gpu(hardware: &HardwareProfile, size_bytes: Option<u64>) -> Option<bool> {
    hardware.cuda_gpu()?;
    Some(hardware.place(size_bytes?).device == Device::Gpu)
}

// ============================================================================
// Service
// ============================================================================

pub struct SummaryService {
    /// Azure et Mistral : passe par le proxy du système s'il y en a un.
    client: Client,
    /// Serveurs locaux : jamais de proxy (127.0.0.1 ne doit pas partir vers un proxy).
    local_client: Client,
    config: Arc<RwLock<Option<SummaryConfig>>>,
    /// Clé Mistral AI (partagée avec la transcription Voxtral).
    mistral_key: RwLock<Option<String>>,
    /// Racine de l'API Mistral (remplacée dans les tests).
    mistral_base_url: String,
    /// Demande d'arrêt de la génération en cours (bouton « Arrêter »).
    cancel: Arc<AtomicBool>,
}

impl SummaryService {
    pub fn new() -> Self {
        Self::with_mistral_base_url(mistral::API_BASE)
    }

    fn with_mistral_base_url(mistral_base_url: &str) -> Self {
        // Pas de délai global (une réponse streamée peut durer plusieurs minutes) : le silence
        // entre deux paquets est borné par `PreparedRequest::idle_timeout`.
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client"),
            local_client: Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("Failed to create HTTP client"),
            config: Arc::new(RwLock::new(None)),
            mistral_key: RwLock::new(None),
            mistral_base_url: mistral_base_url.trim_end_matches('/').to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn set_mistral_key(&self, key: Option<String>) {
        *self.mistral_key.write().await = key;
    }

    /// Configure the summary service with Azure AI credentials
    pub async fn configure(&self, config: SummaryConfig) -> Result<(), AppError> {
        if config.endpoint.is_empty() {
            return Err(AppError::Configuration(
                "AI Inference endpoint is required".to_string(),
            ));
        }
        if config.api_key.is_empty() {
            return Err(AppError::Configuration(
                "AI Inference API key is required".to_string(),
            ));
        }

        let mut cfg = self.config.write().await;
        *cfg = Some(config);
        Ok(())
    }

    /// Supprime les identifiants en mémoire
    pub async fn clear(&self) {
        *self.config.write().await = None;
    }

    /// Le moteur peut-il résumer ? Azure, Mistral : clés chargées ; local : un modèle choisi.
    pub async fn is_ready(&self, engine: &SummaryEngine) -> bool {
        match engine {
            SummaryEngine::Azure => self.config.read().await.is_some(),
            SummaryEngine::Mistral { .. } => self.mistral_key.read().await.is_some(),
            SummaryEngine::Local(llm) => !llm.model.is_empty(),
        }
    }

    /// Demande l'arrêt de la génération en cours ; le texte déjà reçu est renvoyé.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    async fn config(&self) -> Result<SummaryConfig, AppError> {
        self.config.read().await.clone().ok_or_else(|| {
            let secrets = crate::services::secrets::load();
            let missing = match (secrets.ai_endpoint.is_some(), secrets.ai_key.is_some()) {
                (false, false) => "le point de terminaison et la clé",
                (false, true) => "le point de terminaison",
                (true, false) => "la clé",
                // Enregistrés mais pas chargés : l'enregistrement n'a pas reconfiguré le service.
                (true, true) => {
                    return AppError::Configuration(
                        "Le résumé IA est configuré mais pas chargé. Enregistrez à nouveau les clés dans Paramètres ou redémarrez l'application.".to_string(),
                    )
                }
            };
            AppError::Configuration(format!(
                "Résumé IA non configuré : il manque {missing}. Renseignez-le dans Paramètres puis cliquez sur « Enregistrer les clés »."
            ))
        })
    }

    async fn prepare(&self, engine: &SummaryEngine, messages: Vec<ChatMessage>) -> Result<PreparedRequest, AppError> {
        match engine {
            SummaryEngine::Azure => {
                let config = self.config().await?;
                // La clé API et le transcript partent vers cet endpoint : HTTPS obligatoire,
                // y compris quand l'endpoint vient d'une variable d'environnement de dev.
                crate::services::secrets::validate_https_endpoint(&config.endpoint)?;
                let (url, flavor) = build_chat_url(&config.endpoint);
                let request = build_request(flavor, &config, messages)?;
                log::info!("Sending summary request ({:?}, model {:?})", flavor, request.model);
                Ok(PreparedRequest {
                    url,
                    body: serde_json::to_value(request)?,
                    format: StreamFormat::Sse,
                    model_label: config.model.clone().unwrap_or_else(|| DEFAULT_MODEL_LABEL.to_string()),
                    target: Target::Azure { key: config.api_key.clone() },
                })
            }
            SummaryEngine::Mistral { model } => {
                let key = self.mistral_key.read().await.clone().ok_or_else(mistral::missing_key_error)?;
                log::info!("Sending summary request (Mistral, model {model})");
                // Échantillonnage et longueur de sortie : valeurs par défaut du modèle. Pas de
                // `stream_options` : Mistral envoie l'usage dans le dernier morceau.
                let request = ChatCompletionRequest {
                    model: Some(model.clone()),
                    messages,
                    max_tokens: None,
                    max_completion_tokens: None,
                    temperature: None,
                    top_p: None,
                    stream: true,
                    stream_options: None,
                };
                Ok(PreparedRequest {
                    url: format!("{}/chat/completions", self.mistral_base_url),
                    body: serde_json::to_value(request)?,
                    format: StreamFormat::Sse,
                    model_label: model.clone(),
                    target: Target::Mistral { key },
                })
            }
            SummaryEngine::Local(llm) => {
                if llm.model.is_empty() {
                    return Err(AppError::Custom(
                        "Aucun modèle local choisi : sélectionnez-en un dans Paramètres > Résumé IA.".to_string(),
                    ));
                }
                validate_local_url(&llm.base_url)?;
                let (url, body, format) = local_request(llm, messages)?;
                log::info!("Sending summary request ({:?}, model {})", llm.server, llm.model);
                Ok(PreparedRequest {
                    url,
                    body,
                    format,
                    model_label: llm.model.clone(),
                    target: Target::Local(llm.clone()),
                })
            }
        }
    }

    /// Génère un résumé en streaming : chaque morceau de texte est passé à `on_delta`.
    pub async fn generate_stream<F>(
        &self,
        engine: &SummaryEngine,
        system: String,
        prompt: String,
        mut on_delta: F,
    ) -> Result<SummaryResult, AppError>
    where
        F: FnMut(String),
    {
        if prompt.trim().is_empty() {
            return Err(AppError::Validation("Le prompt est vide.".to_string()));
        }
        let mut messages = Vec::new();
        if !system.trim().is_empty() {
            messages.push(ChatMessage { role: "system", content: system });
        }
        messages.push(ChatMessage { role: "user", content: prompt });

        let mut request = self.prepare(engine, messages).await?;
        let client = if request.is_local() { &self.local_client } else { &self.client };
        let idle = request.idle_timeout();
        self.cancel.store(false, Ordering::SeqCst);

        let mut response = loop {
            let builder = client.post(&request.url).json(&request.body);
            let builder = match &request.target {
                Target::Azure { key } => builder.header("api-key", key),
                Target::Mistral { key } => builder.bearer_auth(key),
                Target::Local(_) => builder,
            };
            let response = match wait(&self.cancel, idle, builder.send()).await {
                Wait::Ready(result) => result.map_err(|e| request.send_error(&e))?,
                Wait::Cancelled => return Ok(result(StreamState::default(), request.model_label, true)),
                Wait::TimedOut => return Err(request.timeout_error()),
            };
            let status = response.status();
            if status.is_success() {
                break response;
            }
            let body = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            // Ollama refuse `think` pour certains modèles sans phase de réflexion : on réessaie sans.
            let thinking_refused = request.format == StreamFormat::Ndjson
                && status == reqwest::StatusCode::BAD_REQUEST
                && body.contains("does not support thinking");
            if thinking_refused {
                if let Some(body) = request.body.as_object_mut() {
                    if body.remove("think").is_some() {
                        log::info!("[Summary] Modèle sans réflexion : nouvel essai sans « think »");
                        continue;
                    }
                }
            }
            log::error!("Summary API error: {} - {}", status, body);
            return Err(request.status_error(status, &body));
        };

        let streamed = request.format == StreamFormat::Ndjson
            || response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("text/event-stream"));

        let mut state = StreamState::default();
        let mut cancelled = false;

        if streamed {
            let mut lines = LineBuffer::default();
            'read: loop {
                let chunk = match wait(&self.cancel, idle, response.chunk()).await {
                    Wait::Ready(result) => result.map_err(|e| AppError::Network(format!("Flux interrompu : {}", e)))?,
                    Wait::Cancelled => {
                        cancelled = true;
                        break;
                    }
                    Wait::TimedOut => return Err(request.timeout_error()),
                };
                let Some(chunk) = chunk else {
                    // Fin du flux : dernière ligne sans saut de ligne éventuelle.
                    if let Some(line) = std::mem::take(&mut lines).finish() {
                        if let (Some(text), _) = state.absorb_line(request.format, &line)? {
                            on_delta(text);
                        }
                    }
                    break;
                };
                for line in lines.push(&chunk) {
                    let (text, done) = state.absorb_line(request.format, &line)?;
                    if let Some(text) = text {
                        on_delta(text);
                    }
                    if done {
                        break 'read;
                    }
                }
            }
        } else {
            // Le serveur a ignoré `stream` : réponse JSON complète.
            match wait(&self.cancel, idle, response.json::<ChatChunk>()).await {
                Wait::Ready(parsed) => {
                    let parsed = parsed.map_err(|e| AppError::Parse(format!("Failed to parse response: {}", e)))?;
                    if let Some(text) = state.absorb(parsed) {
                        on_delta(text);
                    }
                }
                Wait::Cancelled => cancelled = true,
                Wait::TimedOut => return Err(request.timeout_error()),
            }
        }

        if state.text.trim().is_empty() && !cancelled {
            let reason = state.finish_reason.as_deref().unwrap_or("inconnue");
            return Err(AppError::Api(if reason == "length" {
                "Le modèle a atteint sa limite de sortie avant d'écrire le résumé. Réessayez sur une partie plus courte de la transcription.".to_string()
            } else {
                format!("Le modèle n'a renvoyé aucun texte (raison : {reason}).")
            }));
        }

        log::info!(
            "Summary generated (cancelled: {cancelled}, tokens: {:?})",
            state.tokens_used
        );
        Ok(result(state, request.model_label, cancelled))
    }

    /// Modèles installés sur un serveur local, avec leur place sur la carte NVIDIA quand
    /// le serveur donne leur taille (Ollama).
    pub async fn list_local_models(
        &self,
        server: LocalServer,
        url: &str,
        hardware: &HardwareProfile,
    ) -> Result<Vec<LocalLlmModel>, AppError> {
        let base = server.base_url(url);
        validate_local_url(&base)?;
        let list_url = match server {
            LocalServer::Ollama => format!("{base}/api/tags"),
            LocalServer::OpenAi => format!("{base}/models"),
        };
        let response = tokio::time::timeout(LIST_TIMEOUT, self.local_client.get(&list_url).send())
            .await
            .map_err(|_| AppError::Custom(format!("{} ne répond pas à l'adresse {base}.", server.name())))?
            .map_err(|e| connect_error(server, &base, &e))?;
        let status = response.status();
        let body = response.text().await.map_err(|e| connect_error(server, &base, &e))?;
        if !status.is_success() {
            return Err(AppError::Custom(format!(
                "Réponse {} de {} : {}",
                status.as_u16(),
                server.name(),
                server_error_detail(&body)
            )));
        }
        let mut models = parse_model_list(server, &body)?;
        for model in &mut models {
            model.fits_gpu = fits_gpu(hardware, model.size_bytes);
        }
        Ok(models)
    }
}

fn result(state: StreamState, model_label: String, cancelled: bool) -> SummaryResult {
    SummaryResult {
        summary: state.text,
        style: String::new(),
        tokens_used: state.tokens_used,
        model: state.model.unwrap_or(model_label),
        cancelled,
    }
}

impl Default for SummaryService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::hardware::tests::profile;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const GB: u64 = 1_000_000_000;

    #[test]
    fn chat_url_from_v1_root_or_full_url() {
        let root = "https://res.services.ai.azure.com/openai/v1";
        let expected = (
            "https://res.services.ai.azure.com/openai/v1/chat/completions".to_string(),
            ApiFlavor::OpenAiV1,
        );
        assert_eq!(build_chat_url(root), expected);
        assert_eq!(build_chat_url(&format!("{root}/")), expected);
        assert_eq!(build_chat_url(&format!("{root}/responses")), expected);
        assert_eq!(build_chat_url(&format!("{root}/chat/completions")), expected);
    }

    #[test]
    fn chat_url_legacy_keeps_api_version() {
        assert_eq!(
            build_chat_url("https://m.francecentral.models.ai.azure.com"),
            (
                "https://m.francecentral.models.ai.azure.com/chat/completions?api-version=2024-05-01-preview".to_string(),
                ApiFlavor::Legacy
            )
        );
        assert_eq!(
            build_chat_url("https://r.services.ai.azure.com/models/chat/completions?api-version=2025-01-01"),
            (
                "https://r.services.ai.azure.com/models/chat/completions?api-version=2025-01-01".to_string(),
                ApiFlavor::Legacy
            )
        );
    }

    fn config(model: Option<&str>) -> SummaryConfig {
        SummaryConfig {
            endpoint: "https://x".into(),
            api_key: "k".into(),
            model: model.map(str::to_string),
            max_tokens: 2048,
            temperature: 0.3,
            top_p: 0.1,
        }
    }

    #[test]
    fn v1_request_streams_without_sampling_parameters() {
        let request = build_request(ApiFlavor::OpenAiV1, &config(Some("gpt")), vec![]).unwrap();
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "model": "gpt",
                "messages": [],
                "max_completion_tokens": 16000,
                "stream": true,
                "stream_options": { "include_usage": true }
            })
        );
        assert!(build_request(ApiFlavor::OpenAiV1, &config(None), vec![]).is_err());
    }

    #[test]
    fn lines_are_split_and_partial_line_kept() {
        let mut lines = LineBuffer::default();
        assert_eq!(lines.push(b"data: {\"a\":1}\n\ndata: [DONE]\ndata: {\"par"), vec!["data: {\"a\":1}", "", "data: [DONE]"]);
        assert_eq!(lines.finish().as_deref(), Some("data: {\"par"));
    }

    #[test]
    fn a_utf8_character_cut_between_two_packets_is_rebuilt() {
        let bytes = "é\n".as_bytes();
        let mut lines = LineBuffer::default();
        assert!(lines.push(&bytes[..1]).is_empty());
        assert_eq!(lines.push(&bytes[1..]), vec!["é"]);
    }

    #[test]
    fn stream_state_collects_deltas_usage_and_model() {
        let mut state = StreamState::default();
        let chunk = |json: &str| serde_json::from_str::<ChatChunk>(json).unwrap();
        assert_eq!(
            state.absorb(chunk(r#"{"model":"gpt-x","choices":[{"delta":{"role":"assistant","content":"Bon"}}]}"#)),
            Some("Bon".to_string())
        );
        assert_eq!(
            state.absorb(chunk(r#"{"choices":[{"delta":{"content":"jour"},"finish_reason":"stop"}]}"#)),
            Some("jour".to_string())
        );
        assert_eq!(state.absorb(chunk(r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}"#)), None);
        assert_eq!(state.text, "Bonjour");
        assert_eq!(state.model.as_deref(), Some("gpt-x"));
        assert_eq!(state.tokens_used, Some(3));
        assert_eq!(state.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn sse_lines_end_on_done() {
        let mut state = StreamState::default();
        let delta = r#"data: {"choices":[{"delta":{"content":"Salut"}}]}"#;
        assert_eq!(state.absorb_line(StreamFormat::Sse, delta).unwrap(), (Some("Salut".to_string()), false));
        assert_eq!(state.absorb_line(StreamFormat::Sse, ": keep-alive").unwrap(), (None, false));
        assert_eq!(state.absorb_line(StreamFormat::Sse, "data: [DONE]").unwrap(), (None, true));
    }

    #[test]
    fn non_streamed_response_is_read_too() {
        let mut state = StreamState::default();
        let parsed: ChatChunk = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"Résumé"},"finish_reason":"stop"}],"usage":{"total_tokens":9}}"#,
        )
        .unwrap();
        assert_eq!(state.absorb(parsed), Some("Résumé".to_string()));
        assert_eq!(state.tokens_used, Some(9));
    }

    #[test]
    fn ollama_lines_give_text_reason_and_token_counts() {
        let mut state = StreamState::default();
        let first = r#"{"model":"qwen3:4b","created_at":"2026-11-16T10:00:00Z","message":{"role":"assistant","content":"Ordre"},"done":false}"#;
        let last = r#"{"model":"qwen3:4b","message":{"role":"assistant","content":" du jour"},"done":true,"done_reason":"stop","prompt_eval_count":1200,"eval_count":300}"#;
        assert_eq!(state.absorb_line(StreamFormat::Ndjson, first).unwrap(), (Some("Ordre".to_string()), false));
        assert_eq!(state.absorb_line(StreamFormat::Ndjson, last).unwrap(), (Some(" du jour".to_string()), true));
        assert_eq!(state.text, "Ordre du jour");
        assert_eq!(state.model.as_deref(), Some("qwen3:4b"));
        assert_eq!(state.finish_reason.as_deref(), Some("stop"));
        assert_eq!(state.tokens_used, Some(1500));
    }

    #[test]
    fn an_ollama_error_line_stops_the_generation() {
        let mut state = StreamState::default();
        let error = state.absorb_line(StreamFormat::Ndjson, r#"{"error":"out of memory"}"#).unwrap_err();
        assert!(error.to_string().contains("out of memory"));
    }

    fn prefs(engine: &str, url: &str, model: &str) -> UserPreferences {
        let mut prefs: UserPreferences = serde_json::from_str(
            r#"{"default_language":"fr-FR","auto_summary":false,"save_locally":true,"theme":"dark"}"#,
        )
        .unwrap();
        prefs.summary_engine = engine.to_string();
        prefs.local_llm_url = url.to_string();
        prefs.local_llm_model = model.to_string();
        prefs
    }

    #[test]
    fn the_engine_comes_from_the_preferences() {
        assert_eq!(SummaryEngine::from_preferences(&prefs("azure", "", "")), SummaryEngine::Azure);
        assert_eq!(SummaryEngine::from_preferences(&prefs("inconnu", "", "")), SummaryEngine::Azure);
        assert_eq!(
            SummaryEngine::from_preferences(&prefs("ollama", "", " qwen3:4b ")),
            SummaryEngine::Local(LocalLlm {
                server: LocalServer::Ollama,
                base_url: "http://127.0.0.1:11434".to_string(),
                model: "qwen3:4b".to_string(),
            })
        );
        let SummaryEngine::Local(llm) = SummaryEngine::from_preferences(&prefs("openai", "", "m")) else {
            panic!("moteur local attendu");
        };
        assert_eq!(llm.base_url, "http://127.0.0.1:1234/v1");
    }

    #[test]
    fn a_pasted_url_is_brought_back_to_the_api_root() {
        let ollama = LocalServer::Ollama;
        assert_eq!(ollama.base_url("http://localhost:11434/"), "http://localhost:11434");
        assert_eq!(ollama.base_url("http://localhost:11434/api/chat"), "http://localhost:11434");
        assert_eq!(ollama.base_url("http://localhost:11434/v1"), "http://localhost:11434");
        let openai = LocalServer::OpenAi;
        assert_eq!(openai.base_url("http://127.0.0.1:1234/v1/chat/completions"), "http://127.0.0.1:1234/v1");
        assert_eq!(openai.base_url("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1");
        assert_eq!(openai.base_url("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/v1");
    }

    #[test]
    fn only_a_server_on_this_pc_is_accepted() {
        for url in ["http://127.0.0.1:11434", "http://localhost:1234/v1", "https://LOCALHOST", "http://[::1]:8080/v1", "http://127.0.0.2:80"] {
            assert!(validate_local_url(url).is_ok(), "{url}");
        }
        for url in ["http://192.168.1.10:11434", "http://example.com", "ftp://127.0.0.1", "127.0.0.1:11434", "http://localhost.evil.com"] {
            assert!(validate_local_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn ollama_context_covers_the_transcript_and_the_summary() {
        assert_eq!(ollama_context_tokens(0), 8_192);
        // Une heure de réunion : ~60 000 caractères ≈ 20 000 jetons + 4 096 pour le résumé.
        assert_eq!(ollama_context_tokens(60_000), 24_576);
        assert_eq!(ollama_context_tokens(10_000_000), 131_072);
    }

    #[test]
    fn local_requests_target_the_right_api() {
        let messages = || vec![ChatMessage { role: "user", content: "x".repeat(30_000) }];
        let ollama = LocalLlm { server: LocalServer::Ollama, base_url: "http://127.0.0.1:11434".into(), model: "qwen3:4b".into() };
        let (url, body, format) = local_request(&ollama, messages()).unwrap();
        assert_eq!(url, "http://127.0.0.1:11434/api/chat");
        assert_eq!(format, StreamFormat::Ndjson);
        assert_eq!(body["model"], "qwen3:4b");
        assert_eq!(body["stream"], true);
        assert_eq!(body["think"], false);
        assert_eq!(body["options"]["num_ctx"], 16_384);

        let openai = LocalLlm { server: LocalServer::OpenAi, base_url: "http://127.0.0.1:1234/v1".into(), model: "qwen3.5-4b".into() };
        let (url, body, format) = local_request(&openai, messages()).unwrap();
        assert_eq!(url, "http://127.0.0.1:1234/v1/chat/completions");
        assert_eq!(format, StreamFormat::Sse);
        assert_eq!(body["model"], "qwen3.5-4b");
        assert!(body.get("temperature").is_none() && body.get("max_tokens").is_none());
    }

    #[test]
    fn model_lists_skip_embedding_models() {
        let ollama = r#"{"models":[{"name":"qwen3:4b","model":"qwen3:4b","size":2500000000},{"name":"nomic-embed-text:latest","size":274000000},{"name":"gemma3:1b","size":815000000}]}"#;
        let models = parse_model_list(LocalServer::Ollama, ollama).unwrap();
        let names: Vec<_> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["gemma3:1b", "qwen3:4b"]);
        assert_eq!(models[1].size_bytes, Some(2_500_000_000));

        let openai = r#"{"object":"list","data":[{"id":"qwen3.5-4b","object":"model"},{"id":"text-embedding-nomic-embed-text-v1.5"}]}"#;
        let models = parse_model_list(LocalServer::OpenAi, openai).unwrap();
        assert_eq!(models, vec![LocalLlmModel { name: "qwen3.5-4b".into(), size_bytes: None, fits_gpu: None }]);
        assert!(parse_model_list(LocalServer::Ollama, "pas du json").is_err());
    }

    #[test]
    fn gpu_fit_needs_an_nvidia_card_and_a_size() {
        let laptop = profile(4 * GB, 32 * GB, 8);
        assert_eq!(fits_gpu(&laptop, Some(2_500_000_000)), Some(true));
        assert_eq!(fits_gpu(&laptop, Some(5_000_000_000)), Some(false));
        assert_eq!(fits_gpu(&laptop, None), None);
        assert_eq!(fits_gpu(&profile(0, 32 * GB, 8), Some(GB)), None);
    }

    #[test]
    fn server_errors_are_made_readable() {
        assert_eq!(server_error_detail(r#"{"error":"model is too large"}"#), "model is too large");
        assert_eq!(server_error_detail(r#"{"error":{"message":"context length exceeded","type":"x"}}"#), "context length exceeded");
        assert_eq!(server_error_detail("Bad Gateway"), "Bad Gateway");
    }

    #[test]
    fn reasoning_models_send_their_answer_in_typed_parts() {
        let mut state = StreamState::default();
        let line = r#"data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"je réfléchis"}]},{"type":"text","text":"Réponse"}]}}]}"#;
        assert_eq!(state.absorb_line(StreamFormat::Sse, line).unwrap(), (Some("Réponse".to_string()), false));
    }

    #[test]
    fn mistral_errors_are_made_readable() {
        assert_eq!(server_error_detail(r#"{"object":"error","message":"Invalid model","type":"invalid_model"}"#), "Invalid model");
        assert_eq!(server_error_detail(r#"{"detail":[{"loc":["body","model"],"msg":"Field required"}]}"#), "Field required");
    }

    #[test]
    fn mistral_engine_uses_the_default_model_when_none_is_typed() {
        let mut p = prefs("mistral", "", "");
        assert_eq!(SummaryEngine::from_preferences(&p), SummaryEngine::Mistral { model: "mistral-medium-latest".into() });
        p.mistral_summary_model = "mistral-large-latest".into();
        assert_eq!(SummaryEngine::from_preferences(&p), SummaryEngine::Mistral { model: "mistral-large-latest".into() });
    }

    // ------------------------------------------------------------------------
    // Bout en bout contre un faux serveur local
    // ------------------------------------------------------------------------

    /// Faux serveur HTTP sur 127.0.0.1 : renvoie les réponses données, une par connexion,
    /// et rend les requêtes reçues (en-têtes et corps).
    async fn fake_server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                let mut buf = [0u8; 8192];
                // Lit les en-têtes puis le corps annoncé par Content-Length.
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

    fn http_response(status: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn local(server: LocalServer, base_url: &str) -> SummaryEngine {
        SummaryEngine::Local(LocalLlm { server, base_url: server.base_url(base_url), model: "qwen3:4b".into() })
    }

    #[tokio::test]
    async fn ollama_summary_is_streamed_without_key() {
        let ndjson = concat!(
            r#"{"model":"qwen3:4b","message":{"role":"assistant","content":"Décisions"},"done":false}"#, "\n",
            r#"{"model":"qwen3:4b","message":{"role":"assistant","content":" : aucune."},"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":5}"#, "\n",
        );
        let (url, server) = fake_server(vec![http_response("200 OK", "application/x-ndjson", ndjson)]).await;
        let service = SummaryService::new();
        let mut deltas = Vec::new();
        let result = service
            .generate_stream(&local(LocalServer::Ollama, &url), "Réponds en français.".into(), "Résume.".into(), |t| deltas.push(t))
            .await
            .unwrap();
        assert_eq!(result.summary, "Décisions : aucune.");
        assert_eq!(deltas, ["Décisions", " : aucune."]);
        assert_eq!(result.model, "qwen3:4b");
        assert_eq!(result.tokens_used, Some(15));
        let requests = server.await.unwrap();
        assert!(requests[0].starts_with("POST /api/chat "));
        assert!(!requests[0].to_ascii_lowercase().contains("api-key"));
        assert!(requests[0].contains(r#""num_ctx":8192"#));
    }

    #[tokio::test]
    async fn ollama_retries_without_think_when_the_model_refuses_it() {
        let refused = http_response("400 Bad Request", "application/json", r#"{"error":"\"gemma3:1b\" does not support thinking"}"#);
        let ok = http_response("200 OK", "application/x-ndjson", "{\"message\":{\"content\":\"OK\"},\"done\":true}\n");
        let (url, server) = fake_server(vec![refused, ok]).await;
        let result = SummaryService::new()
            .generate_stream(&local(LocalServer::Ollama, &url), String::new(), "Résume.".into(), |_| {})
            .await
            .unwrap();
        assert_eq!(result.summary, "OK");
        let requests = server.await.unwrap();
        assert!(requests[0].contains(r#""think":false"#));
        assert!(!requests[1].contains("think"));
    }

    #[tokio::test]
    async fn a_missing_ollama_model_says_how_to_install_it() {
        let missing = http_response("404 Not Found", "application/json", r#"{"error":"model \"qwen3:4b\" not found, try pulling it first"}"#);
        let (url, _server) = fake_server(vec![missing]).await;
        let error = SummaryService::new()
            .generate_stream(&local(LocalServer::Ollama, &url), String::new(), "Résume.".into(), |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("ollama pull qwen3:4b"), "{error}");
    }

    #[tokio::test]
    async fn openai_compatible_server_is_read_as_sse() {
        let sse = concat!(
            "data: {\"model\":\"qwen3.5-4b\",\"choices\":[{\"delta\":{\"content\":\"Points\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" clés\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let (url, server) = fake_server(vec![http_response("200 OK", "text/event-stream", sse)]).await;
        let result = SummaryService::new()
            .generate_stream(&local(LocalServer::OpenAi, &url), String::new(), "Résume.".into(), |_| {})
            .await
            .unwrap();
        assert_eq!(result.summary, "Points clés");
        assert_eq!(result.model, "qwen3.5-4b");
        assert!(server.await.unwrap()[0].starts_with("POST /v1/chat/completions "));
    }

    #[tokio::test]
    async fn an_unreachable_server_says_to_start_it() {
        // Port libéré juste avant : personne n'écoute.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let error = SummaryService::new()
            .generate_stream(&local(LocalServer::Ollama, &format!("http://127.0.0.1:{port}")), String::new(), "Résume.".into(), |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Vérifiez qu'il est lancé"), "{error}");
    }

    #[tokio::test]
    async fn local_models_are_listed_with_their_gpu_fit() {
        let tags = r#"{"models":[{"name":"qwen3:8b","size":5200000000},{"name":"qwen3:4b","size":2500000000}]}"#;
        let (url, server) = fake_server(vec![http_response("200 OK", "application/json", tags)]).await;
        let models = SummaryService::new()
            .list_local_models(LocalServer::Ollama, &url, &profile(4 * GB, 32 * GB, 8))
            .await
            .unwrap();
        assert_eq!(models[0], LocalLlmModel { name: "qwen3:4b".into(), size_bytes: Some(2_500_000_000), fits_gpu: Some(true) });
        assert_eq!(models[1].fits_gpu, Some(false));
        assert!(server.await.unwrap()[0].starts_with("GET /api/tags "));
    }

    #[tokio::test]
    async fn mistral_summary_is_streamed_with_a_bearer_key() {
        let sse = concat!(
            "data: {\"model\":\"mistral-medium-2508\",\"choices\":[{\"delta\":{\"content\":\"Décisions\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" prises\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2,\"total_tokens\":11}}\n\n",
            "data: [DONE]\n\n",
        );
        let (url, server) = fake_server(vec![http_response("200 OK", "text/event-stream", sse)]).await;
        let service = SummaryService::with_mistral_base_url(&format!("{url}/v1"));
        let engine = SummaryEngine::Mistral { model: "mistral-medium-latest".into() };
        assert!(!service.is_ready(&engine).await);
        let error = service.generate_stream(&engine, String::new(), "Résume.".into(), |_| {}).await.unwrap_err();
        assert!(error.to_string().contains("Clé Mistral AI absente"), "{error}");

        service.set_mistral_key(Some("cle-mistral".into())).await;
        let result = service.generate_stream(&engine, String::new(), "Résume.".into(), |_| {}).await.unwrap();
        assert_eq!(result.summary, "Décisions prises");
        assert_eq!(result.model, "mistral-medium-2508");
        assert_eq!(result.tokens_used, Some(11));
        let request = &server.await.unwrap()[0];
        assert!(request.starts_with("POST /v1/chat/completions "));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer cle-mistral"));
        assert!(request.contains(r#""model":"mistral-medium-latest""#));
        assert!(!request.contains("stream_options"));
    }

    #[tokio::test]
    async fn a_refused_mistral_key_says_so() {
        let refused = http_response("401 Unauthorized", "application/json", r#"{"message":"Unauthorized","request_id":"x"}"#);
        let (url, _server) = fake_server(vec![refused]).await;
        let service = SummaryService::with_mistral_base_url(&format!("{url}/v1"));
        service.set_mistral_key(Some("mauvaise".into())).await;
        let error = service
            .generate_stream(&SummaryEngine::Mistral { model: "m".into() }, String::new(), "Résume.".into(), |_| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Clé Mistral AI refusée"), "{error}");
    }

    #[tokio::test]
    async fn a_remote_server_is_refused_before_any_request() {
        let error = SummaryService::new()
            .list_local_models(LocalServer::Ollama, "http://192.168.1.20:11434", &profile(0, 0, 4))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("doit tourner sur ce PC"), "{error}");
    }
}
