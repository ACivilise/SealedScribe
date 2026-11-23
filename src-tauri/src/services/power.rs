//! Garde le PC éveillé pendant les traitements longs (transcription), même capot fermé.
//!
//! Tant qu'au moins un job tourne :
//! - une requête d'alimentation `SystemRequired` + `ExecutionRequired` empêche la mise en veille
//!   par inactivité et la suspension du processus par la veille moderne ;
//! - l'action « fermeture du capot » du mode d'alimentation actif passe à « Ne rien faire »
//!   (secteur et batterie). Aucune API ne permet de bloquer la veille du capot autrement.
//!
//! Les valeurs d'origine du capot sont sauvegardées dans un fichier avant modification et
//! restaurées à la fin du dernier job, ou au démarrage suivant si l'application a planté.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct LidBackup {
    scheme: u128,
    ac: u32,
    dc: u32,
}

#[derive(Default)]
struct State {
    active: usize,
    #[cfg(windows)]
    request: Option<windows::Win32::Foundation::HANDLE>,
}

// Le HANDLE de la requête n'est manipulé que sous le verrou.
unsafe impl Send for State {}

pub struct PowerGuard {
    state: Mutex<State>,
    backup_file: PathBuf,
}

impl PowerGuard {
    /// Restaure d'abord un réglage du capot laissé modifié par une session précédente.
    pub fn new(backup_file: PathBuf) -> Self {
        let guard = Self { state: Mutex::new(State::default()), backup_file };
        guard.restore_lid();
        guard
    }

    /// Un traitement commence : active la protection au premier.
    pub fn acquire(&self) {
        let Ok(mut state) = self.state.lock() else { return };
        state.active += 1;
        if state.active == 1 {
            #[cfg(windows)]
            {
                state.request = win::create_request();
            }
            self.override_lid();
            log::info!("Veille bloquée (capot compris) le temps du traitement");
        }
    }

    /// Un traitement se termine : lève la protection après le dernier.
    pub fn release(&self) {
        let Ok(mut state) = self.state.lock() else { return };
        if state.active == 0 {
            return;
        }
        state.active -= 1;
        if state.active == 0 {
            #[cfg(windows)]
            if let Some(handle) = state.request.take() {
                win::clear_request(handle);
            }
            self.restore_lid();
            log::info!("Réglages de veille restaurés");
        }
    }

    fn override_lid(&self) {
        #[cfg(windows)]
        {
            // Une sauvegarde déjà présente contient les vraies valeurs d'origine : on ne l'écrase pas.
            if !self.backup_file.exists() {
                let Some(backup) = win::read_lid() else { return };
                if let Some(parent) = self.backup_file.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let saved = serde_json::to_string(&backup)
                    .ok()
                    .and_then(|json| std::fs::write(&self.backup_file, json).ok());
                if saved.is_none() {
                    // Sans sauvegarde, on ne touche pas au réglage pour ne pas le perdre.
                    log::warn!("Sauvegarde du réglage du capot impossible : réglage laissé tel quel");
                    return;
                }
            }
            if let Some(backup) = self.read_backup() {
                win::write_lid(backup.scheme, win::LID_DO_NOTHING, win::LID_DO_NOTHING);
            }
        }
    }

    fn restore_lid(&self) {
        let Some(backup) = self.read_backup() else { return };
        #[cfg(windows)]
        let restored = win::write_lid(backup.scheme, backup.ac, backup.dc);
        #[cfg(not(windows))]
        let restored = { let _ = backup; true };
        if restored {
            let _ = std::fs::remove_file(&self.backup_file);
        }
    }

    fn read_backup(&self) -> Option<LidBackup> {
        let content = std::fs::read_to_string(&self.backup_file).ok()?;
        serde_json::from_str(&content).ok()
    }
}

impl Drop for PowerGuard {
    fn drop(&mut self) {
        self.restore_lid();
    }
}

#[cfg(windows)]
mod win {
    use super::LidBackup;
    use windows::core::{GUID, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL};
    use windows::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerGetActiveScheme, PowerReadACValueIndex,
        PowerReadDCValueIndex, PowerSetActiveScheme, PowerSetRequest, PowerWriteACValueIndex,
        PowerWriteDCValueIndex, POWER_REQUEST_TYPE, PowerRequestSystemRequired,
    };
    use windows::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    pub const LID_DO_NOTHING: u32 = 0;

    // Sous-groupe « Boutons d'alimentation et capot » et réglage « Action de fermeture du capot ».
    const SUB_BUTTONS: GUID = GUID::from_u128(0x4f971e89_eebd_4455_a8de_9e59040e7347);
    const LID_ACTION: GUID = GUID::from_u128(0x5ca83367_6e45_459f_a27b_476b1d01c936);
    // Le processus continue de s'exécuter même quand la veille moderne suspend les applications.
    const EXECUTION_REQUIRED: POWER_REQUEST_TYPE = POWER_REQUEST_TYPE(3);

    pub fn create_request() -> Option<HANDLE> {
        let mut reason: Vec<u16> = "SealedScribe : transcription en cours\0".encode_utf16().collect();
        let context = REASON_CONTEXT {
            Version: 0, // POWER_REQUEST_CONTEXT_VERSION
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(reason.as_mut_ptr()) },
        };
        let handle = match unsafe { PowerCreateRequest(&context) } {
            Ok(handle) => handle,
            Err(e) => {
                log::warn!("PowerCreateRequest a échoué : {e}");
                return None;
            }
        };
        for kind in [PowerRequestSystemRequired, EXECUTION_REQUIRED] {
            if let Err(e) = unsafe { PowerSetRequest(handle, kind) } {
                log::warn!("PowerSetRequest({}) a échoué : {e}", kind.0);
            }
        }
        Some(handle)
    }

    pub fn clear_request(handle: HANDLE) {
        unsafe {
            let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
            let _ = PowerClearRequest(handle, EXECUTION_REQUIRED);
            let _ = CloseHandle(handle);
        }
    }

    fn active_scheme() -> Option<GUID> {
        let mut ptr: *mut GUID = std::ptr::null_mut();
        if unsafe { PowerGetActiveScheme(None, &mut ptr) } != ERROR_SUCCESS || ptr.is_null() {
            return None;
        }
        let guid = unsafe { *ptr };
        unsafe { LocalFree(Some(HLOCAL(ptr as _))) };
        Some(guid)
    }

    pub fn read_lid() -> Option<LidBackup> {
        let scheme = active_scheme()?;
        let (mut ac, mut dc) = (0u32, 0u32);
        let ok_ac = unsafe {
            PowerReadACValueIndex(None, Some(&scheme), Some(&SUB_BUTTONS), Some(&LID_ACTION), &mut ac)
        } == ERROR_SUCCESS;
        let ok_dc = unsafe {
            PowerReadDCValueIndex(None, Some(&scheme), Some(&SUB_BUTTONS), Some(&LID_ACTION), &mut dc)
        } == ERROR_SUCCESS.0;
        if !(ok_ac && ok_dc) {
            log::warn!("Lecture de l'action du capot impossible");
            return None;
        }
        Some(LidBackup { scheme: scheme.to_u128(), ac, dc })
    }

    /// Écrit l'action du capot et réapplique le mode pour qu'elle prenne effet tout de suite.
    pub fn write_lid(scheme: u128, ac: u32, dc: u32) -> bool {
        let scheme = GUID::from_u128(scheme);
        let ok = unsafe {
            PowerWriteACValueIndex(None, &scheme, Some(&SUB_BUTTONS), Some(&LID_ACTION), ac) == ERROR_SUCCESS
                && PowerWriteDCValueIndex(None, &scheme, Some(&SUB_BUTTONS), Some(&LID_ACTION), dc)
                    == ERROR_SUCCESS.0
        };
        if !ok {
            log::warn!("Écriture de l'action du capot impossible");
            return false;
        }
        // Réappliquer le mode (sans changer de mode si un autre est devenu actif entre-temps).
        if active_scheme() == Some(scheme) {
            let _ = unsafe { PowerSetActiveScheme(None, Some(&scheme)) };
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Aucun test n'appelle `acquire` ni ne fournit de sauvegarde valide : ni la requête
    // d'alimentation ni le réglage du capot de la machine ne sont touchés.

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("meetscribe-test-power-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lid_backup_keeps_the_full_128_bit_scheme_guid() {
        // Le GUID du mode d'alimentation est stocké en u128 : aucune perte de précision dans le JSON.
        let backup = LidBackup { scheme: u128::MAX - 12345, ac: 1, dc: 2 };
        let json = serde_json::to_string(&backup).unwrap();
        let back: LidBackup = serde_json::from_str(&json).unwrap();
        assert_eq!((back.scheme, back.ac, back.dc), (u128::MAX - 12345, 1, 2));
    }

    #[test]
    fn corrupt_backup_is_ignored_and_left_in_place() {
        let dir = TempDir::new();
        let file = dir.0.join("lid_backup.json");
        std::fs::write(&file, "{pas du json").unwrap();

        let guard = PowerGuard::new(file.clone());
        assert!(guard.read_backup().is_none());
        // Illisible : on ne peut rien restaurer, mais on ne supprime pas le fichier pour autant.
        assert!(file.exists());
    }

    #[test]
    fn missing_backup_reads_as_none() {
        let dir = TempDir::new();
        let guard = PowerGuard::new(dir.0.join("lid_backup.json"));
        assert!(guard.read_backup().is_none());
    }

    #[test]
    fn release_without_acquire_is_a_no_op() {
        let dir = TempDir::new();
        let guard = PowerGuard::new(dir.0.join("lid_backup.json"));
        guard.release();
        assert_eq!(guard.state.lock().unwrap().active, 0);
    }
}
