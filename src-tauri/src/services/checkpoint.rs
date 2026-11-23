//! Points de reprise des transcriptions : chaque morceau terminé est écrit sur disque.
//! Si la transcription s'interrompt (PC éteint, application quittée, erreur réseau),
//! la relancer avec les mêmes paramètres repart du premier morceau manquant.
//!
//! Un fichier par transcription dans `%LOCALAPPDATA%\MeetScribe\partials\`, nommé par le
//! hash de sa clé (fichier audio + taille + date de modification, plage, moteur, modèle, langue).
//! La découpe en morceaux est déterministe pour un même audio : les index restent valables.

use crate::error::{AppError, AppResult};
use crate::models::TranscriptionSegment;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Ce qui identifie une transcription reprenable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointKey {
    pub audio_path: String,
    pub audio_size: u64,
    pub audio_modified: u64,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    pub engine: String,
    pub model: String,
    pub language: String,
}

/// Résultat d'un morceau, horodatages relatifs au début du morceau.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkResult {
    pub offset_secs: f64,
    pub segments: Vec<TranscriptionSegment>,
    pub full_text: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointData {
    key: Option<CheckpointKey>,
    total_chunks: usize,
    chunks: BTreeMap<usize, ChunkResult>,
    updated_at: String,
}

/// Transcription interrompue, telle que l'affiche l'interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub audio_path: String,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    pub engine: String,
    pub model: String,
    pub language: String,
    pub done_chunks: usize,
    pub total_chunks: usize,
    pub updated_at: String,
}

pub fn checkpoints_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        // Ancien nom de l'app, gardé : les données déjà présentes sur le poste sont rangées là.
        .join("MeetScribe")
        .join("partials")
}

/// Taille et date de modification (secondes Unix) : un audio modifié invalide la reprise.
fn fingerprint(audio_path: &str) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(audio_path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((meta.len(), modified))
}

fn read_data(path: &Path) -> Option<CheckpointData> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub struct Checkpoint {
    path: Option<PathBuf>,
    data: Mutex<CheckpointData>,
}

impl Checkpoint {
    /// Point de reprise inactif (rien n'est lu ni écrit).
    pub fn disabled() -> Self {
        Self { path: None, data: Mutex::new(CheckpointData::default()) }
    }

    /// Ouvre (ou prépare) le point de reprise de cette transcription.
    pub fn open(
        audio_path: &str,
        start_seconds: Option<f64>,
        end_seconds: Option<f64>,
        engine: &str,
        model: &str,
        language: &str,
    ) -> Self {
        Self::open_in(&checkpoints_dir(), audio_path, start_seconds, end_seconds, engine, model, language)
    }

    /// Comme `open`, dans un dossier donné (permet de tester sans toucher au dossier réel).
    fn open_in(
        dir: &Path,
        audio_path: &str,
        start_seconds: Option<f64>,
        end_seconds: Option<f64>,
        engine: &str,
        model: &str,
        language: &str,
    ) -> Self {
        let Some((audio_size, audio_modified)) = fingerprint(audio_path) else {
            return Self::disabled();
        };
        let key = CheckpointKey {
            audio_path: audio_path.to_string(),
            audio_size,
            audio_modified,
            start_seconds,
            end_seconds,
            engine: engine.to_string(),
            model: model.to_string(),
            language: language.to_string(),
        };
        let hash = Sha256::digest(serde_json::to_vec(&key).unwrap_or_default());
        let name: String = hash.iter().take(12).map(|b| format!("{b:02x}")).collect();
        let path = dir.join(format!("{name}.json"));

        let data = read_data(&path)
            .filter(|d| d.key.as_ref() == Some(&key))
            .unwrap_or(CheckpointData { key: Some(key), ..Default::default() });
        if !data.chunks.is_empty() {
            log::info!(
                "[Checkpoint] Reprise : {} morceau(x) déjà transcrit(s) pour {}",
                data.chunks.len(),
                audio_path
            );
        }
        Self { path: Some(path), data: Mutex::new(data) }
    }

    /// Fixe le nombre de morceaux. S'il a changé (découpe différente), on repart de zéro.
    pub fn begin(&self, total_chunks: usize) {
        let mut data = self.data.lock().unwrap();
        if data.total_chunks != total_chunks {
            data.chunks.clear();
            data.total_chunks = total_chunks;
        }
    }

    pub fn get(&self, index: usize) -> Option<ChunkResult> {
        self.data.lock().unwrap().chunks.get(&index).cloned()
    }

    /// Enregistre un morceau terminé (écriture atomique : fichier temporaire puis renommage).
    pub fn save(&self, index: usize, chunk: ChunkResult) {
        let Some(path) = &self.path else { return };
        let mut data = self.data.lock().unwrap();
        data.chunks.insert(index, chunk);
        data.updated_at = chrono::Utc::now().to_rfc3339();
        if let Err(e) = write_atomic(path, &data) {
            log::warn!("[Checkpoint] Écriture impossible ({}) : {}", path.display(), e);
        }
    }

    /// Supprime le point de reprise (transcription terminée ou annulée).
    pub fn discard(&self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn write_atomic(path: &Path, data: &CheckpointData) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec(data).map_err(|e| AppError::Custom(e.to_string()))?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Transcriptions interrompues encore reprenables. Les points de reprise dont l'audio
/// a disparu ou changé sont supprimés au passage.
pub fn list() -> Vec<CheckpointInfo> {
    list_in(&checkpoints_dir())
}

fn list_in(dir: &Path) -> Vec<CheckpointInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut infos = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(data) = read_data(&path) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        let Some(key) = data.key else { continue };
        if fingerprint(&key.audio_path) != Some((key.audio_size, key.audio_modified)) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if data.chunks.is_empty() {
            continue;
        }
        infos.push(CheckpointInfo {
            audio_path: key.audio_path,
            start_seconds: key.start_seconds,
            end_seconds: key.end_seconds,
            engine: key.engine,
            model: key.model,
            language: key.language,
            done_chunks: data.chunks.len(),
            total_chunks: data.total_chunks,
            updated_at: data.updated_at,
        });
    }
    infos
}

/// Supprime tous les points de reprise d'un fichier audio.
pub fn discard_for_audio(audio_path: &str) -> usize {
    discard_for_audio_in(&checkpoints_dir(), audio_path)
}

fn discard_for_audio_in(dir: &Path, audio_path: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let matches = read_data(&path)
            .and_then(|d| d.key)
            .map(|k| k.audio_path == audio_path)
            .unwrap_or(false);
        if matches && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dossier temporaire unique, supprimé à la fin du test.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("meetscribe-test-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_audio(dir: &TempDir, name: &str, content: &[u8]) -> String {
        let path = dir.0.join(name);
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn chunk(offset: f64, text: &str) -> ChunkResult {
        ChunkResult {
            offset_secs: offset,
            segments: vec![TranscriptionSegment {
                text: text.to_string(),
                speaker: 0,
                start_time: 0.0,
                end_time: 1.0,
                confidence: 1.0,
                language: "fr-FR".to_string(),
            }],
            full_text: text.to_string(),
        }
    }

    fn open(store: &TempDir, audio: &str, language: &str) -> Checkpoint {
        Checkpoint::open_in(&store.0.join("partials"), audio, None, None, "local", "tiny", language)
    }

    #[test]
    fn saved_chunks_are_resumed_by_a_new_checkpoint() {
        let store = TempDir::new("cp-store");
        let audio = write_audio(&store, "a.wav", b"audio");

        let first = open(&store, &audio, "fr-FR");
        first.begin(3);
        first.save(1, chunk(0.0, "un"));
        first.save(2, chunk(30.0, "deux"));

        let second = open(&store, &audio, "fr-FR");
        second.begin(3);
        assert_eq!(second.get(1).unwrap().full_text, "un");
        assert_eq!(second.get(2).unwrap().offset_secs, 30.0);
        assert!(second.get(3).is_none());
    }

    #[test]
    fn different_parameters_do_not_share_a_checkpoint() {
        let store = TempDir::new("cp-params");
        let audio = write_audio(&store, "a.wav", b"audio");

        let fr = open(&store, &audio, "fr-FR");
        fr.begin(1);
        fr.save(1, chunk(0.0, "bonjour"));

        let en = open(&store, &audio, "en-US");
        en.begin(1);
        assert!(en.get(1).is_none());
        let ranged = Checkpoint::open_in(&store.0.join("partials"), &audio, Some(5.0), None, "local", "tiny", "fr-FR");
        ranged.begin(1);
        assert!(ranged.get(1).is_none());
    }

    #[test]
    fn begin_with_another_chunk_count_restarts_from_scratch() {
        let store = TempDir::new("cp-begin");
        let audio = write_audio(&store, "a.wav", b"audio");

        let cp = open(&store, &audio, "fr-FR");
        cp.begin(4);
        cp.save(1, chunk(0.0, "un"));
        // Même nombre de morceaux : on garde.
        cp.begin(4);
        assert!(cp.get(1).is_some());
        // Découpe différente : les index ne sont plus valables.
        cp.begin(5);
        assert!(cp.get(1).is_none());
    }

    #[test]
    fn modified_audio_invalidates_the_checkpoint() {
        let store = TempDir::new("cp-modified");
        let audio = write_audio(&store, "a.wav", b"audio");

        let cp = open(&store, &audio, "fr-FR");
        cp.begin(1);
        cp.save(1, chunk(0.0, "un"));

        // La taille change : l'empreinte change, donc la clé aussi.
        std::fs::write(&audio, b"audio plus long").unwrap();
        let reopened = open(&store, &audio, "fr-FR");
        reopened.begin(1);
        assert!(reopened.get(1).is_none());
    }

    #[test]
    fn missing_audio_gives_a_disabled_checkpoint() {
        let store = TempDir::new("cp-missing");
        let missing = store.0.join("absent.wav").to_string_lossy().into_owned();

        let cp = open(&store, &missing, "fr-FR");
        cp.begin(1);
        cp.save(1, chunk(0.0, "un"));
        assert!(!store.0.join("partials").exists(), "rien ne doit être écrit");
    }

    #[test]
    fn discard_removes_the_checkpoint_file() {
        let store = TempDir::new("cp-discard");
        let audio = write_audio(&store, "a.wav", b"audio");
        let partials = store.0.join("partials");

        let cp = open(&store, &audio, "fr-FR");
        cp.begin(1);
        cp.save(1, chunk(0.0, "un"));
        assert_eq!(std::fs::read_dir(&partials).unwrap().count(), 1);
        cp.discard();
        assert_eq!(std::fs::read_dir(&partials).unwrap().count(), 0);
    }

    #[test]
    fn list_reports_progress_and_cleans_stale_entries() {
        let store = TempDir::new("cp-list");
        let partials = store.0.join("partials");
        let audio = write_audio(&store, "a.wav", b"audio");
        let other = write_audio(&store, "other.wav", b"audio");

        let cp = Checkpoint::open_in(&partials, &audio, Some(1.0), Some(9.0), "local", "tiny", "fr-FR");
        cp.begin(4);
        cp.save(1, chunk(0.0, "un"));
        cp.save(3, chunk(60.0, "trois"));
        // Point de reprise sans morceau terminé : non listé (et jamais écrit sur disque).
        Checkpoint::open_in(&partials, &other, None, None, "azure", "azure", "fr-FR").begin(2);
        // Fichier illisible : supprimé au passage.
        std::fs::write(partials.join("corrompu.json"), b"{pas du json").unwrap();

        let infos = list_in(&partials);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].done_chunks, 2);
        assert_eq!(infos[0].total_chunks, 4);
        assert_eq!(infos[0].start_seconds, Some(1.0));
        assert_eq!(infos[0].model, "tiny");
        assert!(!partials.join("corrompu.json").exists());

        // L'audio disparaît : le point de reprise est nettoyé.
        std::fs::remove_file(&audio).unwrap();
        assert!(list_in(&partials).is_empty());
        assert_eq!(std::fs::read_dir(&partials).unwrap().count(), 0);
    }

    #[test]
    fn discard_for_audio_only_removes_matching_checkpoints() {
        let store = TempDir::new("cp-discard-audio");
        let partials = store.0.join("partials");
        let a = write_audio(&store, "a.wav", b"audio");
        let b = write_audio(&store, "b.wav", b"autre audio");

        for audio in [&a, &b] {
            let cp = open(&store, audio, "fr-FR");
            cp.begin(1);
            cp.save(1, chunk(0.0, "x"));
        }
        let other_lang = open(&store, &a, "en-US");
        other_lang.begin(1);
        other_lang.save(1, chunk(0.0, "y"));

        assert_eq!(discard_for_audio_in(&partials, &a), 2);
        let left = list_in(&partials);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].audio_path, b);
        assert_eq!(discard_for_audio_in(&partials, "inconnu.wav"), 0);
    }

    #[test]
    fn checkpoint_key_serializes_in_camel_case() {
        let key = CheckpointKey {
            audio_path: "a.wav".into(),
            audio_size: 1,
            audio_modified: 2,
            start_seconds: None,
            end_seconds: Some(3.0),
            engine: "local".into(),
            model: "tiny".into(),
            language: "fr-FR".into(),
        };
        let json = serde_json::to_value(&key).unwrap();
        assert_eq!(json["audioPath"], "a.wav");
        assert_eq!(json["endSeconds"], 3.0);
        assert!(json["startSeconds"].is_null());
        let back: CheckpointKey = serde_json::from_value(json).unwrap();
        assert_eq!(back, key);
    }
}
