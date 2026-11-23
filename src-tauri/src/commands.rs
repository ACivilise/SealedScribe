use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Result as TauriResult, State};
use tauri_plugin_autostart::ManagerExt;
use crate::error::AppResult;
use crate::models::{MeetingSession, UserPreferences, TranscriptionResult, TranscriptionSegment, SummaryResult, DiarizationResult, SpeakerMapping};
use crate::services::{AudioRecordingService, StorageService, TranscriptionService, SummaryService, DiarizationService, ExportService};
use crate::services::jobs::{Job, JobFlags, JobManager, JobStatus};
use crate::services::checkpoint::{self, Checkpoint, CheckpointInfo};
use crate::services::local_whisper::{LocalWhisperService, LocalWhisperStatus, ENGINE_LOCAL};
use crate::services::mistral::{self, MistralTranscriptionService, ENGINE_MISTRAL};
use crate::services::secrets::{self, AzureSecretsInput, CredentialsStatus};
use crate::tray::{self, TrayState};
use crate::services::audio::RecordingMode;
use crate::services::audio_devices::{AudioDevices, RecordingDevices};
use crate::services::summary::{LocalLlmModel, LocalServer, SummaryEngine, SummaryStreamEvent};
use crate::services::export::{MeetingExportData, ExportResult};

#[tauri::command]
pub async fn start_recording(
    title: String,
    language: String,
    output_path: String,
    // Micro et sortie audio choisis dans l'onglet Enregistrer ; absents : ceux par défaut de Windows.
    input_device_id: Option<String>,
    output_device_id: Option<String>,
    app_handle: tauri::AppHandle,
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<MeetingSession> {
    require_extension(&output_path, &["wav"])?;

    let devices = RecordingDevices { input: input_device_id, output: output_device_id };

    // Start actual audio recording
    audio_service
        .start_recording(output_path.clone(), devices)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;

    // Arrêt automatique après 5 min sans son (la mise en veille est surveillée dès le lancement).
    crate::services::recording_watch::watch_silence(app_handle);

    let session = MeetingSession {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        language,
        duration: 0,
        recorded_at: chrono::Utc::now(),
        status: crate::models::MeetingStatus::Recording,
        audio_path: Some(output_path),
        speakers: vec![],
    };

    Ok(session)
}

#[tauri::command]
pub async fn stop_recording(
    session_id: String,
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<String> {
    audio_service
        .stop_recording()
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;

    Ok(format!("Recording {} stopped", session_id))
}

#[tauri::command]
pub async fn get_audio_level(
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<f32> {
    let level = audio_service
        .get_audio_level()
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;
    
    Ok(level)
}

#[tauri::command]
pub async fn test_audio_devices(
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<bool> {
    let result = audio_service
        .test_audio_devices()
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;
    
    Ok(result)
}

/// Set the audio recording mode (microphone, system loopback, or combined)
#[tauri::command]
pub async fn set_recording_mode(
    mode: String,
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<String> {
    let recording_mode = match mode.to_lowercase().as_str() {
        "microphone" | "mic" => RecordingMode::Microphone,
        "loopback" | "system" | "system_loopback" => RecordingMode::SystemLoopback,
        "combined" | "both" | "mix" => RecordingMode::Combined,
        _ => {
            return Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Unknown recording mode: {}. Use 'microphone', 'loopback', or 'combined'", mode),
            )));
        }
    };

    audio_service
        .set_recording_mode(recording_mode)
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;

    let mode_name = match recording_mode {
        RecordingMode::Microphone => "microphone",
        RecordingMode::SystemLoopback => "system_loopback",
        RecordingMode::Combined => "combined",
    };

    Ok(format!("Recording mode set to: {}", mode_name))
}

/// Get the current audio recording mode
#[tauri::command]
pub async fn get_recording_mode(
    audio_service: State<'_, AudioRecordingService>,
) -> TauriResult<String> {
    let mode = audio_service
        .get_recording_mode()
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;

    let mode_name = match mode {
        RecordingMode::Microphone => "microphone",
        RecordingMode::SystemLoopback => "system_loopback",
        RecordingMode::Combined => "combined",
    };

    Ok(mode_name.to_string())
}

/// Micros et sorties audio branchés, proposés avant l'enregistrement.
#[tauri::command]
pub async fn list_audio_devices() -> TauriResult<AudioDevices> {
    // Thread dédié : cpal y initialise COM (voir `audio_devices`).
    tokio::task::spawn_blocking(crate::services::audio_devices::list)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))?
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e.to_string())))
}

#[tauri::command]
pub async fn load_preferences(
    storage_service: State<'_, StorageService>,
) -> TauriResult<UserPreferences> {
    storage_service
        .load_preferences()
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

#[tauri::command]
pub async fn save_preferences(
    preferences: UserPreferences,
    storage_service: State<'_, StorageService>,
) -> TauriResult<()> {
    storage_service
        .save_preferences(&preferences)
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    /// Date de dernière modification, en millisecondes depuis l'epoch.
    pub modified_ms: u64,
}

/// Liste les fichiers audio du dossier d'enregistrements (métadonnées seulement :
/// aucun contenu lu, donc pas de téléchargement des fichiers OneDrive « à la demande »).
#[tauri::command]
pub async fn list_recordings(
    storage_service: State<'_, StorageService>,
) -> TauriResult<Vec<RecordingFile>> {
    let dir = storage_service.get_recordings_dir().map_err(|e| {
        tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    })?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        let is_audio = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "wav" | "mp3" | "m4a"))
            .unwrap_or(false);
        if !is_audio {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(RecordingFile {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            modified_ms,
        });
    }
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(files)
}

#[tauri::command]
pub async fn get_recordings_dir(
    storage_service: State<'_, StorageService>,
) -> TauriResult<String> {
    storage_service
        .get_recordings_dir_string()
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

// ============================================================================
// Transcription Commands
// ============================================================================

/// Transcribe an audio file using Azure Speech Service
/// 
/// This command uses pre-configured credentials or environment variables
#[tauri::command]
pub async fn transcribe_audio(
    audio_path: String,
    language: String,
    job_id: String,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    // Termes des lexiques : indice du moteur local, vocabulaire à privilégier pour Mistral
    // (Azure n'en a pas l'équivalent ici).
    prompt: Option<String>,
    app_handle: AppHandle,
    transcription_service: State<'_, TranscriptionService>,
    local_whisper: State<'_, LocalWhisperService>,
    mistral_service: State<'_, MistralTranscriptionService>,
    storage_service: State<'_, StorageService>,
    jobs: State<'_, JobManager>,
) -> TauriResult<TranscriptionResult> {
    require_extension(&audio_path, AUDIO_INPUT_EXTENSIONS)?;
    // Préférences illisibles : on reste sur Azure, le comportement historique.
    let prefs = storage_service.load_preferences().ok();
    let engine = match prefs.as_ref().map(|p| p.transcription_engine.as_str()) {
        Some(ENGINE_LOCAL) => ENGINE_LOCAL,
        Some(ENGINE_MISTRAL) => ENGINE_MISTRAL,
        _ => "azure",
    };

    let flags = jobs.start(&app_handle, &job_id, "transcription", &file_label(&audio_path));
    let cancel = flags.cancel.clone();
    let report = |progress: crate::services::transcription::TranscriptionProgressEvent| {
        jobs.update(&app_handle, &job_id, progress.progress, &progress.message);
        let _ = app_handle.emit("transcription-progress", &progress);
    };

    // Plage demandée : on transcrit un extrait temporaire (mono 16 kHz), puis on recale
    // les horodatages sur l'enregistrement complet.
    let clip = match (start_seconds, end_seconds) {
        (None, None) => None,
        (start, end) => match write_range_clip(&audio_path, &job_id, start, end).await {
            Ok(clip) => Some(clip),
            Err(error) => {
                return finish_job(&app_handle, &jobs, &job_id, &flags, Err(error));
            }
        },
    };
    let (source_path, offset) = match &clip {
        Some((path, offset)) => (path.to_string_lossy().into_owned(), *offset),
        None => (audio_path.clone(), 0.0),
    };

    // Point de reprise : les morceaux terminés sont sur disque ; une relance avec les mêmes
    // paramètres (audio, plage, moteur, modèle, langue) repart du premier morceau manquant.
    let model = match engine {
        ENGINE_LOCAL => prefs.map(|p| p.local_model).unwrap_or_default(),
        ENGINE_MISTRAL => mistral::model_or_default(
            &prefs.map(|p| p.mistral_transcription_model).unwrap_or_default(),
            mistral::DEFAULT_TRANSCRIPTION_MODEL,
        ),
        _ => "azure".to_string(),
    };
    let checkpoint = Checkpoint::open(&audio_path, start_seconds, end_seconds, engine, &model, &language);

    let outcome = if engine == ENGINE_MISTRAL {
        mistral_service
            .transcribe(
                source_path,
                language,
                model,
                prompt,
                cancel.clone(),
                flags.stop_after_part.clone(),
                &checkpoint,
                report,
            )
            .await
    } else if engine == ENGINE_LOCAL {
        local_whisper
            .transcribe(
                source_path,
                language,
                model,
                prompt,
                cancel.clone(),
                flags.stop_after_part.clone(),
                &checkpoint,
                report,
            )
            .await
    } else {
        transcription_service
            .transcribe_audio_with_progress(source_path, language, cancel.clone(), &checkpoint, report)
            .await
    };

    if let Some((path, _)) = &clip {
        let _ = tokio::fs::remove_file(path).await;
    }
    // Terminée ou annulée volontairement : plus rien à reprendre. Échec : on garde.
    if outcome.is_ok() || cancel.load(Ordering::SeqCst) {
        checkpoint.discard();
    }
    let outcome = match outcome {
        // Horodatages recalés sur l'enregistrement complet, puis attribution sur ce même fichier.
        Ok(result) => {
            // Seul un enregistrement micro / son du PC a des voix à séparer.
            let tools = if crate::services::dual_channel::is_dual_channel(std::path::Path::new(&audio_path)) {
                local_whisper
                    .diarization_tools_updating(cancel.clone(), |p| report(diarization_update_event(p.progress)))
                    .await
                    .unwrap_or_else(|e| {
                        log::warn!("Mise à jour de la séparation des intervenants impossible : {e}");
                        None
                    })
            } else {
                None
            };
            let result = without_empty_segments(shift_segments(result, offset));
            Ok(attribute_speakers(&audio_path, result, tools, &cancel, &report).await)
        }
        Err(error) => Err(error),
    };
    finish_job(&app_handle, &jobs, &job_id, &flags, outcome)
}

/// Téléchargement de la nouvelle version de la séparation des intervenants, avant de l'utiliser.
fn diarization_update_event(percent: u8) -> crate::services::transcription::TranscriptionProgressEvent {
    crate::services::transcription::TranscriptionProgressEvent {
        phase: "updating-diarization".to_string(),
        progress: percent,
        message: format!("Mise à jour de la séparation des intervenants… {percent} %"),
        ..Default::default()
    }
}

fn diarizing_event(percent: f32) -> crate::services::transcription::TranscriptionProgressEvent {
    crate::services::transcription::TranscriptionProgressEvent {
        phase: "diarizing".to_string(),
        progress: percent.round() as u8,
        message: format!("Séparation des intervenants… {} %", percent.round()),
        ..Default::default()
    }
}

/// Enregistrement micro / son du PC : chaque segment est attribué à « moi » ou aux « autres »
/// selon le canal qui domine, puis les « autres » sont séparés par leur voix si l'outil est
/// installé. La transcription est déjà faite : un échec ou une annulation de la séparation
/// laisse « moi » / « autres », un échec de lecture laisse le résultat inchangé.
async fn attribute_speakers(
    audio_path: &str,
    mut result: TranscriptionResult,
    tools: Option<crate::services::local_whisper::DiarizationTools>,
    cancel: &std::sync::atomic::AtomicBool,
    report: &impl Fn(crate::services::transcription::TranscriptionProgressEvent),
) -> TranscriptionResult {
    use crate::services::local_diarization::label_speakers;

    if result.segments.is_empty() {
        return result;
    }
    let path = std::path::Path::new(audio_path);
    let spans: Vec<(f64, f64)> = result.segments.iter().map(|s| (s.start_time, s.end_time)).collect();
    let mut labels =
        label_speakers(path, &spans, tools.as_ref(), None, cancel, |p| report(diarizing_event(p))).await;
    if let (Err(e), Some(_)) = (&labels, &tools) {
        log::warn!("Séparation des intervenants impossible, on garde micro / son du PC : {e}");
        let not_cancelled = std::sync::atomic::AtomicBool::new(false);
        labels = label_speakers(path, &spans, None, None, &not_cancelled, |_| {}).await;
    }
    match labels {
        Ok(Some(labels)) => {
            for (segment, speaker) in result.segments.iter_mut().zip(labels) {
                segment.speaker = speaker;
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("Attribution micro / son du PC impossible : {e}"),
    }
    result
}

/// Relance la séparation des intervenants d'une transcription existante, éventuellement
/// avec le nombre de participants distants. Renvoie l'intervenant de chaque intervalle
/// (début, fin en secondes), dans l'ordre.
#[tauri::command]
pub async fn separate_speakers(
    audio_path: String,
    spans: Vec<(f64, f64)>,
    num_speakers: Option<u32>,
    job_id: String,
    app_handle: AppHandle,
    local_whisper: State<'_, LocalWhisperService>,
    jobs: State<'_, JobManager>,
) -> TauriResult<Vec<u32>> {
    require_extension(&audio_path, AUDIO_INPUT_EXTENSIONS)?;
    let flags = jobs.start(&app_handle, &job_id, "speakers", &file_label(&audio_path));
    let outcome = async {
        // Une version précédente se met à jour ici ; la progression reste à 0 % le temps du téléchargement.
        let tools = local_whisper
            .diarization_tools_updating(flags.cancel.clone(), |_| {
                jobs.update(&app_handle, &job_id, 0, "Mise à jour de la séparation des intervenants");
            })
            .await
            .map_err(|e| {
                crate::error::AppError::ConfigError(format!("Mise à jour de la séparation des intervenants impossible : {e}"))
            })?
            .ok_or_else(|| {
                crate::error::AppError::ConfigError(
                    "Séparation des intervenants non installée : Paramètres › Transcription".to_string(),
                )
            })?;
        let report = |percent: f32| {
            jobs.update(&app_handle, &job_id, percent.round() as u8, "Séparation des intervenants");
            let _ = app_handle.emit("speaker-separation-progress", percent);
        };
        crate::services::local_diarization::label_speakers(
            std::path::Path::new(&audio_path),
            &spans,
            Some(&tools),
            num_speakers,
            &flags.cancel,
            report,
        )
        .await?
        .ok_or_else(|| {
            crate::error::AppError::Validation(
                "Cet enregistrement n'a pas de canaux séparés pour le micro et le son du PC".to_string(),
            )
        })
    }
    .await;
    finish_job(&app_handle, &jobs, &job_id, &flags, outcome)
}

/// Transcriptions interrompues qu'une relance avec les mêmes paramètres reprendrait.
#[tauri::command]
pub async fn list_transcription_checkpoints() -> TauriResult<Vec<CheckpointInfo>> {
    Ok(tokio::task::spawn_blocking(checkpoint::list).await.unwrap_or_default())
}

/// Abandonne les transcriptions interrompues d'un fichier audio (la prochaine repart de zéro).
#[tauri::command]
pub async fn discard_transcription_checkpoints(audio_path: String) -> TauriResult<usize> {
    Ok(tokio::task::spawn_blocking(move || checkpoint::discard_for_audio(&audio_path))
        .await
        .unwrap_or(0))
}

/// Indices d'échantillons (mono 16 kHz) de la plage `[start, end]` en secondes, bornés à l'audio.
/// Refuse une plage de moins d'une demi-seconde.
fn clip_bounds(sample_count: usize, start: Option<f64>, end: Option<f64>) -> AppResult<(usize, usize)> {
    use crate::services::audio_prep::TARGET_RATE;

    let rate = TARGET_RATE as f64;
    let to_index = |secs: f64| ((secs.max(0.0) * rate) as usize).min(sample_count);
    let first = to_index(start.unwrap_or(0.0));
    let last = end.map(to_index).unwrap_or(sample_count);
    if last <= first + TARGET_RATE as usize / 2 {
        return Err(crate::error::AppError::TranscriptionError(
            "Sélection trop courte : choisissez au moins une demi-seconde d'audio".to_string(),
        ));
    }
    Ok((first, last))
}

/// Retire les segments sans texte : un passage sans parole rendu vide par le moteur (Azure le
/// fait sur un morceau muet) deviendrait un intervenant, souvent « Autres », qui ne dit rien.
fn without_empty_segments(mut result: TranscriptionResult) -> TranscriptionResult {
    result.segments.retain(|s| !s.text.trim().is_empty());
    result
}

/// Recale les horodatages d'un extrait sur l'enregistrement complet.
fn shift_segments(mut result: TranscriptionResult, offset: f64) -> TranscriptionResult {
    if offset > 0.0 {
        for segment in &mut result.segments {
            segment.start_time += offset;
            segment.end_time += offset;
        }
    }
    result
}

/// Écrit dans le dossier temporaire l'extrait `[start, end]` (secondes) de `audio_path`,
/// en WAV mono 16 kHz. Renvoie son chemin et le décalage réel du début.
async fn write_range_clip(
    audio_path: &str,
    job_id: &str,
    start: Option<f64>,
    end: Option<f64>,
) -> AppResult<(std::path::PathBuf, f64)> {
    use crate::services::audio_prep::{self, TARGET_RATE};

    let source = audio_path.to_string();
    let wav = tokio::task::spawn_blocking(move || -> AppResult<(Vec<u8>, f64)> {
        let samples = audio_prep::decode_to_mono_16k(&source)?;
        let rate = TARGET_RATE as f64;
        let (first, last) = clip_bounds(samples.len(), start, end)?;
        Ok((audio_prep::encode_wav_16k(&samples[first..last])?, first as f64 / rate))
    })
    .await
    .map_err(|e| crate::error::AppError::TranscriptionError(format!("Découpe audio interrompue : {e}")))??;

    let path = std::env::temp_dir().join(format!("meetscribe-range-{job_id}.wav"));
    tokio::fs::write(&path, &wav.0).await.map_err(crate::error::AppError::FileError)?;
    Ok((path, wav.1))
}

/// Aperçu d'écoute : l'enregistrement décodé en WAV mono 16 kHz (ce que voit la
/// transcription), renvoyé en binaire brut. Sert à la forme d'onde et au lecteur.
#[tauri::command]
pub async fn load_audio_preview(audio_path: String) -> TauriResult<tauri::ipc::Response> {
    require_extension(&audio_path, AUDIO_INPUT_EXTENSIONS)?;
    let wav = tokio::task::spawn_blocking(move || {
        crate::services::audio_prep::decode_to_mono_16k(&audio_path)
            .and_then(|samples| crate::services::audio_prep::encode_wav_16k(&samples))
    })
    .await
    .map_err(|e| to_tauri_error(e.to_string()))?
    .map_err(|e| to_tauri_error(e.to_string()))?;
    Ok(tauri::ipc::Response::new(wav))
}

// ============================================================================
// Local transcription (whisper.cpp) commands
// ============================================================================

/// État du moteur local : fichiers installés par modèle, modèle chargé.
#[tauri::command]
pub async fn get_local_whisper_status(
    local_whisper: State<'_, LocalWhisperService>,
) -> TauriResult<LocalWhisperStatus> {
    Ok(local_whisper.status().await)
}

/// Télécharge ce qui manque pour un modèle. Progression : événement
/// `local-whisper-install-progress` ; annulation : `cancel_job`.
#[tauri::command]
pub async fn install_local_whisper(
    model: String,
    job_id: String,
    app_handle: AppHandle,
    local_whisper: State<'_, LocalWhisperService>,
    jobs: State<'_, JobManager>,
) -> TauriResult<()> {
    let flags = jobs.start(&app_handle, &job_id, "install", &format!("Modèle local {model}"));
    let cancel = flags.cancel.clone();
    let outcome = local_whisper
        .install(&model, cancel.clone(), |progress| {
            jobs.update(&app_handle, &job_id, progress.progress, &progress.file);
            let _ = app_handle.emit("local-whisper-install-progress", &progress);
        })
        .await;
    finish_job(&app_handle, &jobs, &job_id, &flags, outcome)
}

/// Arrête le serveur whisper et libère la mémoire graphique.
#[tauri::command]
pub async fn unload_local_whisper(local_whisper: State<'_, LocalWhisperService>) -> TauriResult<()> {
    local_whisper.unload().await;
    Ok(())
}

/// Supprime le fichier d'un modèle local.
#[tauri::command]
pub async fn delete_local_model(
    model: String,
    local_whisper: State<'_, LocalWhisperService>,
) -> TauriResult<()> {
    local_whisper
        .delete_model(&model)
        .await
        .map_err(|e| to_tauri_error(e.to_string()))
}

/// Liste les jobs (plus récents en premier).
#[tauri::command]
pub fn list_jobs(jobs: State<'_, JobManager>) -> TauriResult<Vec<Job>> {
    Ok(jobs.list())
}

/// Demande l'annulation d'un job en cours. Renvoie `false` si le job n'est plus en cours.
#[tauri::command]
pub fn cancel_job(job_id: String, jobs: State<'_, JobManager>) -> TauriResult<bool> {
    Ok(jobs.cancel(&job_id))
}

/// Demande l'arrêt d'une transcription locale après la partie en cours. Les parties
/// terminées restent dans le point de reprise. Sans effet avec Azure (parties de 30 s).
#[tauri::command]
pub fn stop_job_after_part(job_id: String, jobs: State<'_, JobManager>) -> TauriResult<bool> {
    Ok(jobs.stop_after_part(&job_id))
}

/// Extinction en fin de traitement demandée ou non (garde le PC éveillé tant qu'elle l'est).
#[tauri::command]
pub fn set_shutdown_armed(armed: bool, jobs: State<'_, JobManager>) -> TauriResult<()> {
    jobs.set_shutdown_armed(armed);
    Ok(())
}

/// Programme l'extinction de Windows dans `delay_seconds` secondes et affiche la fenêtre
/// (cachée dans la zone de notification) pour que le compte à rebours soit visible.
#[tauri::command]
pub fn schedule_shutdown(delay_seconds: u32, app_handle: AppHandle) -> TauriResult<()> {
    crate::services::shutdown::schedule(delay_seconds).map_err(to_tauri_error)?;
    if delay_seconds > 0 {
        crate::tray::show_main_window(&app_handle);
    }
    Ok(())
}

/// Annule une extinction programmée (sans erreur s'il n'y en a pas).
#[tauri::command]
pub fn abort_shutdown() -> TauriResult<()> {
    crate::services::shutdown::abort();
    Ok(())
}

// ============================================================================
// Tray and startup commands
// ============================================================================

/// Met à jour le libellé et le tooltip du tray selon l'état d'enregistrement.
#[tauri::command]
pub fn set_tray_recording(recording: bool, tray_state: State<'_, TrayState>) -> TauriResult<()> {
    tray::set_recording_state(&tray_state, recording)
}

/// Affiche la fenêtre principale. Sert quand le tray demande un enregistrement alors que
/// l'avertissement n'est pas encore accepté : la fenêtre a pu être lancée réduite.
#[tauri::command]
pub fn show_main_window(app_handle: AppHandle) {
    tray::show_main_window(&app_handle);
}

/// Quitte l'application (« Refuser et quitter » de l'écran d'avertissement).
#[tauri::command]
pub fn quit_app(app_handle: AppHandle) {
    tray::quit_app(&app_handle);
}

/// Indique si SealedScribe est lancé automatiquement au démarrage de Windows.
#[tauri::command]
pub fn get_launch_at_startup(app_handle: AppHandle) -> TauriResult<bool> {
    app_handle
        .autostart()
        .is_enabled()
        .map_err(|e| to_tauri_error(e.to_string()))
}

/// Active ou désactive le lancement automatique au démarrage de Windows.
#[tauri::command]
pub fn set_launch_at_startup(enabled: bool, app_handle: AppHandle) -> TauriResult<()> {
    let autolaunch = app_handle.autostart();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|e| to_tauri_error(e.to_string()))
}

fn to_tauri_error(message: String) -> tauri::Error {
    tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, message))
}

/// Extensions des fichiers audio que le backend sait lire (voir `load_audio_as_wav`).
const AUDIO_INPUT_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a"];

/// Refuse un chemin dont l'extension n'est pas dans la liste autorisée.
/// Limite ce que le front peut lire ou écrire via les commandes IPC.
fn require_extension(path: &str, allowed: &[&str]) -> TauriResult<()> {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());

    match extension {
        Some(ext) if allowed.contains(&ext.as_str()) => Ok(()),
        _ => Err(tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Unsupported file type. Allowed: {}", allowed.join(", ")),
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_allowed_extensions_case_insensitively() {
        assert!(require_extension(r"C:\rec\meeting.WAV", AUDIO_INPUT_EXTENSIONS).is_ok());
        assert!(require_extension(r"C:\rec\meeting.mp3", AUDIO_INPUT_EXTENSIONS).is_ok());
        assert!(require_extension(r"C:\out\notes.md", &["md"]).is_ok());
    }

    fn segment(start: f64, end: f64) -> TranscriptionSegment {
        TranscriptionSegment {
            text: "x".to_string(),
            speaker: 0,
            start_time: start,
            end_time: end,
            confidence: 1.0,
            language: "fr-FR".to_string(),
        }
    }

    #[test]
    fn segments_without_text_are_dropped() {
        let mut silent = segment(0.0, 14.96);
        silent.text = String::new();
        let mut blank = segment(30.0, 44.92);
        blank.text = " \n".to_string();
        let result = TranscriptionResult {
            segments: vec![silent, segment(60.9, 75.8), blank, segment(78.3, 84.4)],
            full_text: "x x".to_string(),
            language: "fr-FR".to_string(),
            duration_seconds: 90.0,
        };
        let spoken = without_empty_segments(result);
        let starts: Vec<f64> = spoken.segments.iter().map(|s| s.start_time).collect();
        assert_eq!(starts, [60.9, 78.3]);
        assert_eq!(spoken.full_text, "x x");
    }

    #[test]
    fn clip_bounds_converts_seconds_to_sample_indices() {
        // 16 kHz : 2 s -> 32 000, 5 s -> 80 000.
        assert_eq!(clip_bounds(160_000, Some(2.0), Some(5.0)).unwrap(), (32_000, 80_000));
        assert_eq!(clip_bounds(160_000, None, Some(1.0)).unwrap(), (0, 16_000));
        assert_eq!(clip_bounds(160_000, Some(9.0), None).unwrap(), (144_000, 160_000));
    }

    #[test]
    fn clip_bounds_clamps_to_the_audio_length() {
        assert_eq!(clip_bounds(160_000, Some(-3.0), Some(60.0)).unwrap(), (0, 160_000));
    }

    #[test]
    fn clip_bounds_rejects_ranges_shorter_than_half_a_second() {
        assert!(clip_bounds(160_000, Some(1.0), Some(1.4)).is_err());
        assert!(clip_bounds(160_000, Some(5.0), Some(2.0)).is_err());
        // Début au-delà de la fin de l'audio : plage vide.
        assert!(clip_bounds(160_000, Some(20.0), None).is_err());
        assert!(clip_bounds(160_000, Some(1.0), Some(1.6)).is_ok());
    }

    #[test]
    fn shift_segments_moves_clip_timestamps_onto_the_full_recording() {
        let result = TranscriptionResult {
            segments: vec![segment(0.5, 1.5), segment(2.0, 3.0)],
            full_text: "x x".to_string(),
            language: "fr-FR".to_string(),
            duration_seconds: 3.0,
        };
        let shifted = shift_segments(result, 120.0);
        assert_eq!((shifted.segments[0].start_time, shifted.segments[0].end_time), (120.5, 121.5));
        assert_eq!(shifted.segments[1].end_time, 123.0);
        // Sans décalage, les horodatages sont inchangés.
        let same = shift_segments(shifted, 0.0);
        assert_eq!(same.segments[0].start_time, 120.5);
    }

    #[test]
    fn file_label_is_the_file_name() {
        assert_eq!(file_label("C:\\rec\\reunion.wav"), "reunion.wav");
        assert_eq!(file_label("reunion.wav"), "reunion.wav");
    }

    #[test]
    fn rejects_other_or_missing_extensions() {
        assert!(require_extension(r"C:\Windows\win.ini", AUDIO_INPUT_EXTENSIONS).is_err());
        assert!(require_extension(r"C:\rec\meeting", AUDIO_INPUT_EXTENSIONS).is_err());
        assert!(require_extension(r"C:\out\run.bat", &["md"]).is_err());
        assert!(require_extension(r"C:\out\notes.md.exe", &["md"]).is_err());
    }
}

fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Termine le job selon le résultat du traitement et renvoie le résultat à l'appelant.
fn finish_job<T>(
    app_handle: &AppHandle,
    jobs: &JobManager,
    job_id: &str,
    flags: &JobFlags,
    outcome: AppResult<T>,
) -> TauriResult<T> {
    match outcome {
        Ok(value) => {
            jobs.finish(app_handle, job_id, JobStatus::Done, None);
            Ok(value)
        }
        Err(error) => {
            let status = if flags.cancel.load(Ordering::SeqCst) {
                JobStatus::Cancelled
            } else if flags.stop_after_part.load(Ordering::SeqCst) {
                JobStatus::Interrupted
            } else {
                JobStatus::Failed
            };
            let message = error.to_string();
            jobs.finish(app_handle, job_id, status, Some(message.clone()));
            Err(to_tauri_error(message))
        }
    }
}

/// Get transcription segments from a result
/// 
/// Helper command to extract just the segments
#[tauri::command]
pub fn get_transcription_segments(
    result: TranscriptionResult,
) -> TauriResult<Vec<TranscriptionSegment>> {
    Ok(result.segments)
}

/// Get the full transcription text
/// 
/// Helper command to extract just the full text
#[tauri::command]
pub fn get_transcription_text(
    result: TranscriptionResult,
) -> TauriResult<String> {
    Ok(result.full_text)
}

// ============================================================================
// Summary Commands
// ============================================================================

/// Moteur de résumé choisi dans les préférences (illisibles : Azure, le comportement historique).
fn summary_engine(storage_service: &StorageService) -> SummaryEngine {
    storage_service
        .load_preferences()
        .map(|prefs| SummaryEngine::from_preferences(&prefs))
        .unwrap_or(SummaryEngine::Azure)
}

/// Génère un résumé en streaming. `system` fixe la langue de sortie, `prompt` contient
/// le prompt choisi (ou personnalisé) avec la transcription ; le texte arrive par `on_event`.
#[tauri::command]
pub async fn generate_summary(
    system: String,
    prompt: String,
    on_event: tauri::ipc::Channel<SummaryStreamEvent>,
    summary_service: State<'_, SummaryService>,
    storage_service: State<'_, StorageService>,
    local_whisper: State<'_, LocalWhisperService>,
) -> TauriResult<SummaryResult> {
    let engine = summary_engine(&storage_service);
    // Modèle local : Whisper, s'il est chargé et inactif, rend la carte graphique au LLM.
    if engine.is_local() {
        local_whisper.unload_if_idle().await;
    }
    summary_service
        .generate_stream(&engine, system, prompt, |text| {
            if let Err(e) = on_event.send(SummaryStreamEvent::Delta { text }) {
                log::warn!("Envoi d'un morceau de résumé impossible : {e}");
            }
        })
        .await
        .map_err(|e| to_tauri_error(e.to_string()))
}

/// Arrête la génération en cours ; `generate_summary` renvoie alors le texte déjà reçu.
#[tauri::command]
pub fn cancel_summary(summary_service: State<'_, SummaryService>) -> TauriResult<()> {
    summary_service.cancel();
    Ok(())
}

/// Le moteur de résumé choisi est-il prêt (clés Azure chargées, ou modèle local choisi) ?
#[tauri::command]
pub async fn is_summary_configured(
    summary_service: State<'_, SummaryService>,
    storage_service: State<'_, StorageService>,
) -> TauriResult<bool> {
    Ok(summary_service.is_ready(&summary_engine(&storage_service)).await)
}

/// Modèles déjà installés sur un serveur local (`engine` : "ollama" ou "openai"), pour les
/// proposer dans Paramètres. `url` vide : adresse par défaut du serveur.
#[tauri::command]
pub async fn list_local_llm_models(
    engine: String,
    url: String,
    summary_service: State<'_, SummaryService>,
    local_whisper: State<'_, LocalWhisperService>,
) -> TauriResult<Vec<LocalLlmModel>> {
    let server = LocalServer::from_engine(&engine)
        .ok_or_else(|| to_tauri_error(format!("Moteur de résumé local inconnu : {engine}")))?;
    summary_service
        .list_local_models(server, &url, local_whisper.hardware())
        .await
        .map_err(|e| to_tauri_error(e.to_string()))
}

// ============================================================================
// Speaker Diarization Commands
// ============================================================================

/// Transcribe audio with speaker diarization using pre-configured credentials
#[tauri::command]
pub async fn transcribe_with_diarization(
    audio_path: String,
    language: String,
    diarization_service: State<'_, DiarizationService>,
) -> TauriResult<DiarizationResult> {
    require_extension(&audio_path, AUDIO_INPUT_EXTENSIONS)?;
    diarization_service
        .transcribe_with_diarization(audio_path, language)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

/// Apply speaker name mappings to a diarization result
/// 
/// This allows users to rename "Speaker1", "Speaker2" to actual names like "Alice", "Bob"
#[tauri::command]
pub fn apply_speaker_mappings(
    result: DiarizationResult,
    mappings: Vec<SpeakerMapping>,
    diarization_service: State<'_, DiarizationService>,
) -> TauriResult<DiarizationResult> {
    Ok(diarization_service.apply_speaker_mappings(result, mappings))
}

/// Format diarization result as Markdown
#[tauri::command]
pub fn format_diarization_markdown(
    result: DiarizationResult,
    title: String,
    diarization_service: State<'_, DiarizationService>,
) -> TauriResult<String> {
    Ok(diarization_service.format_as_markdown(&result, &title))
}

/// Check if the diarization service is configured
#[tauri::command]
pub async fn is_diarization_configured(
    diarization_service: State<'_, DiarizationService>,
) -> TauriResult<bool> {
    Ok(diarization_service.is_configured().await)
}

// ============================================================================
// Markdown Export Commands
// ============================================================================

/// Export a full meeting transcript to a Markdown file
/// 
/// This exports the complete meeting including metadata, participants, summary, and transcript
#[tauri::command]
pub async fn export_full_transcript(
    session: MeetingSession,
    diarization: Option<DiarizationResult>,
    summary: Option<SummaryResult>,
    output_directory: String,
    export_service: State<'_, ExportService>,
) -> TauriResult<ExportResult> {
    let data = MeetingExportData {
        session: session.clone(),
        diarization,
        summary,
    };
    
    let filename = ExportService::generate_filename(&session.title, None);
    let output_path = std::path::Path::new(&output_directory).join(&filename);
    
    // Ensure directory exists
    export_service
        .ensure_directory(std::path::Path::new(&output_directory))
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;
    
    export_service
        .export_full_transcript(&data, &output_path)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

/// Export a summary only to a Markdown file
#[tauri::command]
pub async fn export_summary_file(
    session: MeetingSession,
    summary: SummaryResult,
    output_directory: String,
    export_service: State<'_, ExportService>,
) -> TauriResult<ExportResult> {
    let data = MeetingExportData {
        session: session.clone(),
        diarization: None,
        summary: Some(summary),
    };
    
    let filename = ExportService::generate_filename(&session.title, Some("_summary"));
    let output_path = std::path::Path::new(&output_directory).join(&filename);
    
    // Ensure directory exists
    export_service
        .ensure_directory(std::path::Path::new(&output_directory))
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;
    
    export_service
        .export_summary(&data, &output_path)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

/// Export transcript only (without summary) to a Markdown file
#[tauri::command]
pub async fn export_transcript_only(
    session: MeetingSession,
    diarization: DiarizationResult,
    output_directory: String,
    export_service: State<'_, ExportService>,
) -> TauriResult<ExportResult> {
    let data = MeetingExportData {
        session: session.clone(),
        diarization: Some(diarization),
        summary: None,
    };
    
    let filename = ExportService::generate_filename(&session.title, Some("_transcript"));
    let output_path = std::path::Path::new(&output_directory).join(&filename);
    
    // Ensure directory exists
    export_service
        .ensure_directory(std::path::Path::new(&output_directory))
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))?;
    
    export_service
        .export_transcript_only(&data, &output_path)
        .await
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

/// Generate Markdown content as a string for clipboard
/// 
/// This doesn't write to a file, just returns the markdown content
#[tauri::command]
pub fn generate_markdown_content(
    session: MeetingSession,
    diarization: Option<DiarizationResult>,
    summary: Option<SummaryResult>,
    include_summary: bool,
    include_transcript: bool,
    export_service: State<'_, ExportService>,
) -> TauriResult<String> {
    let data = MeetingExportData {
        session,
        diarization,
        summary,
    };
    
    Ok(export_service.generate_markdown_string(&data, include_summary, include_transcript))
}

/// Export to a custom path specified by the user (via file dialog)
#[tauri::command]
pub async fn export_to_path(
    session: MeetingSession,
    diarization: Option<DiarizationResult>,
    summary: Option<SummaryResult>,
    output_path: String,
    export_type: String,
    export_service: State<'_, ExportService>,
) -> TauriResult<ExportResult> {
    require_extension(&output_path, &["md"])?;

    let data = MeetingExportData {
        session,
        diarization,
        summary,
    };

    let path = std::path::Path::new(&output_path);
    
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        export_service
            .ensure_directory(parent)
            .await
            .map_err(|e| tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))?;
    }
    
    match export_type.as_str() {
        "summary" => {
            export_service
                .export_summary(&data, path)
                .await
                .map_err(|e| tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                )))
        }
        "transcript" => {
            export_service
                .export_transcript_only(&data, path)
                .await
                .map_err(|e| tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                )))
        }
        _ => {
            // Default to full export
            export_service
                .export_full_transcript(&data, path)
                .await
                .map_err(|e| tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                )))
        }
    }
}

/// Get the default recordings directory for exports
#[tauri::command]
pub async fn get_export_directory(
    storage_service: State<'_, StorageService>,
) -> TauriResult<String> {
    storage_service
        .get_recordings_dir_string()
        .map_err(|e| tauri::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )))
}

// ============================================================================
// Azure credentials (stockés dans le Gestionnaire d'identifiants Windows)
// ============================================================================

/// Indique quels services Azure sont configurés. Ne renvoie jamais de valeur secrète.
#[tauri::command]
pub fn get_credentials_status() -> TauriResult<CredentialsStatus> {
    Ok(secrets::status(&secrets::load()))
}

/// Enregistre les clés Azure dans le keyring puis reconfigure les services.
/// Pour chaque champ : absent = inchangé, chaîne vide = supprimer, valeur = remplacer.
#[tauri::command]
pub async fn save_azure_credentials(
    speech_key: Option<String>,
    speech_region: Option<String>,
    ai_endpoint: Option<String>,
    ai_key: Option<String>,
    ai_model: Option<String>,
    mistral_key: Option<String>,
    transcription_service: State<'_, TranscriptionService>,
    diarization_service: State<'_, DiarizationService>,
    summary_service: State<'_, SummaryService>,
    mistral_service: State<'_, MistralTranscriptionService>,
) -> TauriResult<CredentialsStatus> {
    let input = AzureSecretsInput {
        speech_key,
        speech_region,
        ai_endpoint,
        ai_key,
        ai_model,
        mistral_key,
    };
    secrets::save(&input).map_err(|e| to_tauri_error(e.to_string()))?;

    let loaded = secrets::load();
    secrets::configure_services(
        &loaded,
        &transcription_service,
        &diarization_service,
        &summary_service,
        &mistral_service,
    )
    .await
    .map_err(|e| to_tauri_error(e.to_string()))?;

    Ok(secrets::status(&loaded))
}
