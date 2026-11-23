//! System tray: icône dans la zone de notification, menu contextuel et
//! affichage/masquage de la fenêtre principale.
//!
//! Le tray ne démarre jamais l'enregistrement lui-même : l'entrée
//! « Démarrer / Arrêter l'enregistrement » émet `tray-toggle-recording`,
//! que le frontend traite avec le même handler que son propre bouton.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const EVENT_TOGGLE_RECORDING: &str = "tray-toggle-recording";

const TRAY_ID: &str = "meetscribe-tray";
const ITEM_SHOW: &str = "show";
const ITEM_TOGGLE: &str = "toggle-recording";
const ITEM_QUIT: &str = "quit";

const LABEL_START: &str = "Démarrer l'enregistrement";
const LABEL_STOP: &str = "Arrêter l'enregistrement";
const TOOLTIP_IDLE: &str = "SealedScribe";
const TOOLTIP_RECORDING: &str = "SealedScribe — enregistrement en cours";

/// Handles conservés pour mettre à jour le tray depuis les commandes.
pub struct TrayState {
    tray: TrayIcon,
    toggle_item: MenuItem<tauri::DynRuntime>,
}

/// Crée l'icône tray et la range dans le state de l'application.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "Afficher SealedScribe", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, ITEM_TOGGLE, LABEL_START, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &separator, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("icône par défaut de SealedScribe introuvable");

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TOOLTIP_IDLE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            ITEM_SHOW => show_main_window(app),
            ITEM_TOGGLE => {
                let _ = app.emit(EVENT_TOGGLE_RECORDING, ());
            }
            ITEM_QUIT => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayState {
        tray,
        toggle_item: toggle,
    });

    Ok(())
}

/// Met à jour le libellé du menu et le tooltip selon l'état d'enregistrement.
pub fn set_recording_state(state: &TrayState, recording: bool) -> tauri::Result<()> {
    state
        .toggle_item
        .set_text(if recording { LABEL_STOP } else { LABEL_START })?;
    state
        .tray
        .set_tooltip(Some(if recording { TOOLTIP_RECORDING } else { TOOLTIP_IDLE }))?;
    Ok(())
}

/// Affiche et met au premier plan la fenêtre principale.
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Masque la fenêtre principale sans quitter l'application.
pub fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// Quitte l'application. Un enregistrement en cours est arrêté d'abord,
/// pour que le fichier WAV soit finalisé.
pub fn quit_app(app: &AppHandle) {
    if let Some(audio) = app.try_state::<crate::services::AudioRecordingService>() {
        let _ = tauri::async_runtime::block_on(audio.stop_recording());
    }
    // Arrêt propre du serveur whisper (le Job Object le tue de toute façon si on plante).
    if let Some(local_whisper) = app.try_state::<crate::services::LocalWhisperService>() {
        tauri::async_runtime::block_on(local_whisper.unload());
    }
    app.exit(0);
}
