// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod error;
mod services;
mod commands;
mod tray;

use services::{AudioRecordingService, StorageService, TranscriptionService, SummaryService, DiarizationService, ExportService, JobManager, LocalWhisperService};
use tauri_plugin_autostart::MacosLauncher;

/// Argument passé par l'autostart Windows : la fenêtre reste masquée au lancement.
const START_MINIMIZED_ARG: &str = "--minimized";

fn jobs_file() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        // Ancien nom de l'app, gardé : les données déjà présentes sur le poste sont rangées là.
        .join("MeetScribe")
        .join("jobs.json")
}

fn main() {
    // SealedScribe relancé en processus enfant pour calculer des empreintes vocales.
    if let Some(code) = services::speaker_embedding::run_worker_if_requested() {
        std::process::exit(code);
    }

    // Développement uniquement : charge le fichier d'environnement racine (variables AZURE_* sans préfixe VITE_, jamais lues côté front).
    #[cfg(debug_assertions)]
    let _ = dotenvy::from_path("../.env");

    // Logs : niveau info par défaut, réglable avec RUST_LOG (visibles seulement en dev, la console est masquée en release).
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let audio_service = AudioRecordingService::new();
    let storage_service = StorageService::default();
    let transcription_service = TranscriptionService::new();
    let summary_service = SummaryService::new();
    let mistral_service = services::mistral::MistralTranscriptionService::new();
    let diarization_service = DiarizationService::new();
    let export_service = ExportService::new();
    let job_manager = JobManager::new(jobs_file());

    // Clés Azure et Mistral : keyring Windows (ou variables AZURE_* / MISTRAL_API_KEY en dev),
    // chargées une seule fois côté Rust.
    let azure_secrets = services::secrets::load();
    if let Err(e) = tauri::async_runtime::block_on(services::secrets::configure_services(
        &azure_secrets,
        &transcription_service,
        &diarization_service,
        &summary_service,
        &mistral_service,
    )) {
        eprintln!("Configuration Azure impossible: {}", e);
    }

    tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![START_MINIMIZED_ARG]),
        ))
        .manage(audio_service)
        .manage(storage_service)
        .manage(transcription_service)
        .manage(summary_service)
        .manage(mistral_service)
        .manage(diarization_service)
        .manage(export_service)
        .manage(job_manager)
        // Moteur local : aucun chargement ici, le modèle démarre à la première transcription.
        .manage(LocalWhisperService::new())
        .setup(|app| {
            tray::setup(app)?;
            // Un enregistrement en cours s'arrête proprement à la mise en veille.
            services::recording_watch::watch_sleep(app.handle().clone());
            // Lancement automatique : fenêtre masquée, seule l'icône tray est visible.
            // Aucun flux audio n'est ouvert ici : l'enregistrement reste une action explicite.
            if std::env::args().any(|arg| arg == START_MINIMIZED_ARG) {
                tray::hide_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // La croix ferme la fenêtre dans le tray ; seul « Quitter » ferme l'application.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == tray::MAIN_WINDOW_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Audio recording commands
            commands::start_recording,
            commands::stop_recording,
            commands::get_audio_level,
            commands::test_audio_devices,
            commands::set_recording_mode,
            commands::get_recording_mode,
            commands::list_audio_devices,
            // Preferences commands
            commands::load_preferences,
            commands::save_preferences,
            commands::get_recordings_dir,
            commands::list_recordings,
            // Tray and startup commands
            commands::set_tray_recording,
            commands::show_main_window,
            commands::quit_app,
            commands::get_launch_at_startup,
            commands::set_launch_at_startup,
            // Job commands
            commands::list_jobs,
            commands::cancel_job,
            commands::stop_job_after_part,
            commands::set_shutdown_armed,
            commands::schedule_shutdown,
            commands::abort_shutdown,
            // Transcription commands
            commands::transcribe_audio,
            commands::separate_speakers,
            commands::load_audio_preview,
            commands::list_transcription_checkpoints,
            commands::discard_transcription_checkpoints,
            commands::get_local_whisper_status,
            commands::install_local_whisper,
            commands::unload_local_whisper,
            commands::delete_local_model,
            commands::get_transcription_segments,
            commands::get_transcription_text,
            // Summary commands
            commands::generate_summary,
            commands::cancel_summary,
            commands::is_summary_configured,
            commands::list_local_llm_models,
            // Diarization commands
            commands::transcribe_with_diarization,
            commands::apply_speaker_mappings,
            commands::format_diarization_markdown,
            commands::is_diarization_configured,
            // Azure credentials commands
            commands::get_credentials_status,
            commands::save_azure_credentials,
            // Export commands
            commands::export_full_transcript,
            commands::export_summary_file,
            commands::export_transcript_only,
            commands::generate_markdown_content,
            commands::export_to_path,
            commands::get_export_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
