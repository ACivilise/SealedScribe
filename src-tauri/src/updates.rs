//! Mise à jour de l'application depuis les GitHub Releases du dépôt public (plugin updater de Tauri).
//!
//! Chaque release publie `latest.json` : version, notes, adresse de l'installeur et sa signature.
//! Le plugin le lit à l'adresse déclarée dans `tauri.conf.json` et vérifie la signature de
//! l'installeur avec la clé publique déclarée au même endroit : un installeur qui n'est pas signé
//! par la clé du projet est refusé. L'installation lance l'installeur NSIS en mode passif (barre de
//! progression, aucune question) ; l'application se ferme et l'installeur la relance à la fin.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::services::jobs::{JobManager, JobStatus};
use crate::services::AudioRecordingService;

/// Progression du téléchargement de l'installeur, émise à chaque morceau reçu.
pub const UPDATE_PROGRESS_EVENT: &str = "update-progress";

// Codes d'erreur traduits par l'interface (les messages du backend ne le sont pas).
const BUSY_RECORDING: &str = "busy-recording";
const BUSY_JOB: &str = "busy-job";
const NO_UPDATE: &str = "no-update";
/// Version Store : les mises à jour passent par le Store (l'interface ne propose pas ces commandes).
const STORE_MANAGED: &str = "store-managed";

/// Version plus récente que celle qui tourne.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    /// Notes de la release (section du changelog), telles que publiées dans `latest.json`.
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Cherche une version plus récente que celle qui tourne ; `None` si l'application est à jour.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<AvailableUpdate>, String> {
    if crate::distribution::is_packaged() {
        return Err(STORE_MANAGED.into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| AvailableUpdate {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Télécharge l'installeur, vérifie sa signature et le lance ; l'application se ferme alors et
/// l'installeur la relance. Refusé pendant un enregistrement ou une tâche de fond (transcription,
/// séparation des voix) : fermer l'application les interromprait.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    audio: State<'_, AudioRecordingService>,
    jobs: State<'_, JobManager>,
) -> Result<(), String> {
    if crate::distribution::is_packaged() {
        return Err(STORE_MANAGED.into());
    }
    if audio.is_recording() {
        return Err(BUSY_RECORDING.into());
    }
    if jobs.list().iter().any(|job| job.status == JobStatus::Running) {
        return Err(BUSY_JOB.into());
    }

    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| NO_UPDATE.to_string())?;

    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(UPDATE_PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || log::info!("[Update] Installeur {} téléchargé et vérifié", update.version),
        )
        .await
        .map_err(|e| e.to_string())
}
