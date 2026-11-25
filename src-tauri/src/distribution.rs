//! Distribution de l'application : installeur NSIS (GitHub Releases) ou paquet MSIX (Microsoft Store).
//!
//! Le même `meetscribe.exe` sert aux deux. En paquet, Windows lui donne une identité de paquet, et
//! deux choses changent :
//! - les mises à jour passent par le Store (ses règles interdisent un autre canal) ;
//! - le lancement au démarrage passe par la tâche de démarrage déclarée dans
//!   `packaging/msix/AppxManifest.xml` : les écritures d'un paquet dans le registre sont isolées,
//!   la clé `Run` du plugin autostart n'y aurait aucun effet.

use serde::Serialize;
use std::sync::OnceLock;

/// Identifiant de la tâche de démarrage : le même que `TaskId` dans `packaging/msix/AppxManifest.xml`
/// (vérifié par `src/lib/msixManifest.test.ts`).
pub const STARTUP_TASK_ID: &str = "SealedScribeStartup";

// Codes d'erreur traduits par l'interface (les messages du backend ne le sont pas).
/// Lancement au démarrage coupé dans les paramètres Windows : l'application ne peut pas le réactiver.
pub const STARTUP_DISABLED_BY_USER: &str = "startup-disabled-by-user";
/// Lancement au démarrage bloqué par une stratégie de l'entreprise.
pub const STARTUP_DISABLED_BY_POLICY: &str = "startup-disabled-by-policy";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Distribution {
    /// Installeur NSIS des GitHub Releases, mis à jour par le plugin updater.
    Installer,
    /// Paquet MSIX du Microsoft Store, mis à jour par le Store.
    Store,
}

pub fn current() -> Distribution {
    if is_packaged() {
        Distribution::Store
    } else {
        Distribution::Installer
    }
}

/// Vrai quand l'application tourne dans son paquet MSIX.
pub fn is_packaged() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(detect_package)
}

#[cfg(windows)]
fn detect_package() -> bool {
    use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

    let mut length = 0u32;
    // Sans tampon : ERROR_INSUFFICIENT_BUFFER en paquet, APPMODEL_ERROR_NO_PACKAGE sinon.
    let status = unsafe { GetCurrentPackageFullName(&mut length, None) };
    status != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
fn detect_package() -> bool {
    false
}

/// `"store"` ou `"installer"` : l'interface masque la mise à jour par GitHub dans la version Store.
#[tauri::command]
pub fn get_distribution() -> Distribution {
    current()
}

/// État d'une tâche de démarrage MSIX (`StartupTaskState`), séparé de l'API Windows pour être testé.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupState {
    Disabled,
    DisabledByUser,
    Enabled,
    DisabledByPolicy,
    EnabledByPolicy,
}

impl StartupState {
    /// Valeurs de `Windows.ApplicationModel.StartupTaskState`.
    pub fn from_raw(value: i32) -> Self {
        match value {
            1 => Self::DisabledByUser,
            2 => Self::Enabled,
            3 => Self::DisabledByPolicy,
            4 => Self::EnabledByPolicy,
            _ => Self::Disabled,
        }
    }

    pub fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled | Self::EnabledByPolicy)
    }

    /// Après une demande d'activation : `Ok` si le lancement au démarrage est actif, sinon le code
    /// (ou le message) que l'interface affiche.
    pub fn enable_outcome(self) -> Result<(), String> {
        match self {
            Self::Enabled | Self::EnabledByPolicy => Ok(()),
            Self::DisabledByUser => Err(STARTUP_DISABLED_BY_USER.into()),
            Self::DisabledByPolicy => Err(STARTUP_DISABLED_BY_POLICY.into()),
            Self::Disabled => Err("La tâche de démarrage est restée désactivée".into()),
        }
    }
}

/// Lancement par la tâche de démarrage MSIX ? Elle ne passe pas d'arguments, contrairement à la clé
/// `Run` de l'installeur (`--minimized`) : c'est le type d'activation qui le dit.
pub fn launched_by_startup_task() -> bool {
    is_packaged() && startup_task::activated_by_startup_task().unwrap_or(false)
}

/// Tâche de démarrage du paquet. Les appels WinRT passent par un fil d'exécution initialisé en MTA :
/// les commandes Tauri synchrones tournent sur le fil de la fenêtre (STA), où attendre une opération
/// asynchrone pourrait bloquer.
#[cfg(windows)]
pub mod startup_task {
    use super::{StartupState, STARTUP_TASK_ID};
    use windows::core::HSTRING;
    use windows::ApplicationModel::Activation::ActivationKind;
    use windows::ApplicationModel::{AppInstance, StartupTask};
    use windows::Win32::Foundation::CO_E_ALREADYINITIALIZED;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    fn in_mta<T, F>(work: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> windows::core::Result<T> + Send + 'static,
    {
        std::thread::spawn(move || {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr.is_err() && hr != CO_E_ALREADYINITIALIZED {
                return Err(format!("Initialisation COM impossible : {hr:?}"));
            }
            let result = work().map_err(|e| e.message().to_string());
            if hr.is_ok() {
                unsafe { CoUninitialize() };
            }
            result
        })
        .join()
        .map_err(|_| "Tâche de démarrage : fil d'exécution interrompu".to_string())?
    }

    fn task() -> windows::core::Result<StartupTask> {
        StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))?.join()
    }

    pub fn state() -> Result<StartupState, String> {
        in_mta(|| task()?.State()).map(|state| StartupState::from_raw(state.0))
    }

    /// Demande l'activation et renvoie l'état obtenu (une application de bureau n'affiche aucune
    /// question : Windows active, sauf si l'utilisateur ou une stratégie l'a coupée).
    pub fn enable() -> Result<StartupState, String> {
        in_mta(|| task()?.RequestEnableAsync()?.join()).map(|state| StartupState::from_raw(state.0))
    }

    pub fn disable() -> Result<(), String> {
        in_mta(|| task()?.Disable())
    }

    pub fn activated_by_startup_task() -> Result<bool, String> {
        in_mta(|| Ok(AppInstance::GetActivatedEventArgs()?.Kind()? == ActivationKind::StartupTask))
    }
}

#[cfg(not(windows))]
pub mod startup_task {
    use super::StartupState;

    pub fn state() -> Result<StartupState, String> {
        Ok(StartupState::Disabled)
    }

    pub fn enable() -> Result<StartupState, String> {
        Err("Tâche de démarrage : Windows uniquement".into())
    }

    pub fn disable() -> Result<(), String> {
        Ok(())
    }

    pub fn activated_by_startup_task() -> Result<bool, String> {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_states_follow_windows_values() {
        assert_eq!(StartupState::from_raw(0), StartupState::Disabled);
        assert_eq!(StartupState::from_raw(1), StartupState::DisabledByUser);
        assert_eq!(StartupState::from_raw(2), StartupState::Enabled);
        assert_eq!(StartupState::from_raw(3), StartupState::DisabledByPolicy);
        assert_eq!(StartupState::from_raw(4), StartupState::EnabledByPolicy);
        assert_eq!(StartupState::from_raw(99), StartupState::Disabled);
    }

    #[test]
    fn only_enabled_states_count_as_enabled() {
        assert!(StartupState::Enabled.is_enabled());
        assert!(StartupState::EnabledByPolicy.is_enabled());
        assert!(!StartupState::Disabled.is_enabled());
        assert!(!StartupState::DisabledByUser.is_enabled());
        assert!(!StartupState::DisabledByPolicy.is_enabled());
    }

    #[test]
    fn a_refused_enable_returns_a_code_the_interface_translates() {
        assert_eq!(StartupState::Enabled.enable_outcome(), Ok(()));
        assert_eq!(StartupState::DisabledByUser.enable_outcome(), Err(STARTUP_DISABLED_BY_USER.to_string()));
        assert_eq!(StartupState::DisabledByPolicy.enable_outcome(), Err(STARTUP_DISABLED_BY_POLICY.to_string()));
        assert!(StartupState::Disabled.enable_outcome().is_err());
    }

    #[test]
    fn tests_run_outside_a_package() {
        assert!(!is_packaged());
        assert_eq!(current(), Distribution::Installer);
        assert!(!launched_by_startup_task());
    }
}
