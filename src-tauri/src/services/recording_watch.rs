//! Arrêt automatique de l'enregistrement :
//! - après 5 minutes sans son (micro et son système confondus) ;
//! - à la mise en veille du PC (et, par sécurité, au réveil si l'arrêt n'a pas pu se faire avant).
//!
//! L'arrêt passe par le service audio (le WAV est finalisé proprement), puis l'événement
//! `recording-auto-stopped` prévient le front, qui enchaîne comme après un arrêt manuel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::AudioRecordingService;

pub const EVENT_RECORDING_AUTO_STOPPED: &str = "recording-auto-stopped";

/// Durée sans son au-delà de laquelle l'enregistrement s'arrête.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Niveau RMS sous lequel on considère qu'il n'y a pas de son (≈ -40 dBFS, au-dessus du souffle d'un micro).
const SILENCE_LEVEL: f32 = 0.01;
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Identifie l'enregistrement surveillé : un nouveau démarrage rend caduque l'ancienne surveillance.
static SESSION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoStopReason {
    Silence,
    Sleep,
}

#[derive(Clone, Serialize)]
struct AutoStoppedPayload {
    reason: AutoStopReason,
}

/// Le niveau mesuré compte comme du son s'il dépasse le seuil ET a changé depuis la mesure précédente.
/// Le niveau n'est mis à jour que si des échantillons arrivent : une valeur strictement identique
/// d'une seconde à l'autre signifie que plus rien n'arrive (flux coupé).
fn is_sound(level: f32, previous_level: f32) -> bool {
    level > SILENCE_LEVEL && level != previous_level
}

/// Le silence dure depuis assez longtemps pour arrêter l'enregistrement.
fn silence_timed_out(since_last_sound: Duration) -> bool {
    since_last_sound >= SILENCE_TIMEOUT
}

/// Lance la surveillance du silence pour l'enregistrement qui vient de démarrer.
pub fn watch_silence(app: AppHandle) {
    let session = SESSION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let mut last_sound = Instant::now();
        let mut previous_level = f32::NAN;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if SESSION.load(Ordering::SeqCst) != session {
                return;
            }
            let audio = app.state::<AudioRecordingService>();
            if !audio.is_recording() {
                return;
            }
            let level = audio.get_audio_level().await.unwrap_or(0.0);
            // Le niveau n'est mis à jour que si des échantillons arrivent : une valeur strictement
            // identique d'une seconde à l'autre signifie que plus rien n'arrive (flux coupé).
            if is_sound(level, previous_level) {
                last_sound = Instant::now();
            }
            previous_level = level;
            if silence_timed_out(last_sound.elapsed()) {
                log::info!("Aucun son depuis {} min : arrêt de l'enregistrement", SILENCE_TIMEOUT.as_secs() / 60);
                auto_stop(&app, AutoStopReason::Silence).await;
                return;
            }
        }
    });
}

/// Arrête l'enregistrement s'il est en cours et prévient le front.
async fn auto_stop(app: &AppHandle, reason: AutoStopReason) {
    let audio = app.state::<AudioRecordingService>();
    if !audio.is_recording() {
        return;
    }
    if let Err(e) = audio.stop_recording().await {
        log::warn!("Arrêt automatique de l'enregistrement impossible : {e}");
    }
    let _ = app.emit(EVENT_RECORDING_AUTO_STOPPED, AutoStoppedPayload { reason });
}

/// S'abonne aux notifications de mise en veille / réveil de Windows (à appeler une fois au démarrage).
pub fn watch_sleep(app: AppHandle) {
    #[cfg(windows)]
    win::register(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
mod win {
    use std::sync::OnceLock;

    use tauri::AppHandle;
    use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
    use windows::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    use super::{auto_stop, AutoStopReason};

    const PBT_APMSUSPEND: u32 = 0x4;
    const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    // Windows garde un pointeur vers ces paramètres tant que l'abonnement existe (toute la vie du processus).
    static mut PARAMS: DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(on_power_event),
        Context: std::ptr::null_mut(),
    };

    pub fn register(app: AppHandle) {
        if APP.set(app).is_err() {
            return;
        }
        let mut registration = std::ptr::null_mut();
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(std::ptr::addr_of_mut!(PARAMS) as _),
                &mut registration,
            )
        };
        if status != ERROR_SUCCESS {
            log::warn!("Abonnement aux notifications de veille impossible : {:?}", status);
        }
    }

    /// Appelé par Windows sur un thread système. À la mise en veille, Windows attend le retour
    /// de la fonction (dans une limite de quelques secondes) : on arrête l'enregistrement de façon
    /// synchrone pour que le WAV soit finalisé avant la suspension.
    unsafe extern "system" fn on_power_event(
        _context: *const core::ffi::c_void,
        event: u32,
        _setting: *const core::ffi::c_void,
    ) -> u32 {
        if matches!(event, PBT_APMSUSPEND | PBT_APMRESUMEAUTOMATIC) {
            if let Some(app) = APP.get() {
                log::info!("Mise en veille / réveil (événement {event:#x}) : arrêt de l'enregistrement");
                tauri::async_runtime::block_on(auto_stop(app, AutoStopReason::Sleep));
            }
        }
        ERROR_SUCCESS.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_above_threshold_and_changing_is_sound() {
        assert!(is_sound(0.2, 0.1));
        // Première mesure : pas de valeur précédente (NaN).
        assert!(is_sound(0.2, f32::NAN));
    }

    #[test]
    fn level_below_or_at_threshold_is_silence() {
        assert!(!is_sound(0.0, 0.5));
        assert!(!is_sound(SILENCE_LEVEL, 0.5));
        assert!(!is_sound(0.005, f32::NAN));
    }

    #[test]
    fn frozen_level_means_the_stream_is_cut() {
        // Même valeur élevée deux fois de suite : aucun nouvel échantillon n'arrive.
        assert!(!is_sound(0.3, 0.3));
    }

    #[test]
    fn silence_stops_recording_after_five_minutes() {
        assert!(!silence_timed_out(Duration::from_secs(5 * 60 - 1)));
        assert!(silence_timed_out(Duration::from_secs(5 * 60)));
        assert!(silence_timed_out(Duration::from_secs(3600)));
    }

    #[test]
    fn auto_stop_reason_is_sent_lowercase_to_the_front() {
        let silence = serde_json::to_value(AutoStoppedPayload { reason: AutoStopReason::Silence }).unwrap();
        assert_eq!(silence, serde_json::json!({"reason": "silence"}));
        let sleep = serde_json::to_value(AutoStoppedPayload { reason: AutoStopReason::Sleep }).unwrap();
        assert_eq!(sleep["reason"], "sleep");
    }
}
