//! Périphériques proposés à l'enregistrement : les micros (entrées) et les sorties audio dont
//! on capte le son (loopback).
//!
//! Un périphérique est désigné par l'identifiant de son point de terminaison Windows (celui que
//! rend `IMMDevice::GetId`, et cpal sous WASAPI) : il ne change pas quand on débranche puis
//! rebranche le périphérique, et `IMMDeviceEnumerator::GetDevice` le retrouve pour la capture
//! du son du PC. Aucun identifiant : le périphérique par défaut de Windows.
//!
//! cpal initialise COM en STA sur le thread qui l'appelle : ces fonctions tournent sur un
//! thread dédié (`spawn_blocking`, threads de capture), jamais sur un thread de tokio où un
//! autre code initialise COM en MTA.

use crate::error::{AppError, AppResult};
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    /// Périphérique par défaut de Windows, au moment de la liste.
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AudioDevices {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

/// Périphériques choisis pour un enregistrement ; `None` : celui par défaut de Windows.
#[derive(Debug, Clone, Default)]
pub struct RecordingDevices {
    /// Micro.
    pub input: Option<String>,
    /// Sortie audio dont on enregistre le son (haut-parleurs, casque…).
    pub output: Option<String>,
}

fn device_id(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.id().to_string())
}

/// Micros et sorties audio actifs (l'interface les trie par nom, accents compris).
pub fn list() -> AppResult<AudioDevices> {
    let host = cpal::default_host();
    let inputs = host
        .input_devices()
        .map_err(|e| AppError::AudioError(format!("Liste des micros indisponible : {e}")))?;
    let outputs = host
        .output_devices()
        .map_err(|e| AppError::AudioError(format!("Liste des sorties audio indisponible : {e}")))?;
    let default_input = host.default_input_device().as_ref().and_then(device_id);
    let default_output = host.default_output_device().as_ref().and_then(device_id);
    Ok(AudioDevices {
        inputs: describe(inputs, default_input.as_deref()),
        outputs: describe(outputs, default_output.as_deref()),
    })
}

fn describe(devices: impl Iterator<Item = cpal::Device>, default_id: Option<&str>) -> Vec<AudioDevice> {
    devices
        .filter_map(|device| {
            let id = device_id(&device)?;
            let name = device.description().ok()?.name().to_string();
            Some(AudioDevice { is_default: default_id == Some(id.as_str()), id, name })
        })
        .collect()
}

/// Micro choisi, ou celui par défaut.
pub fn input_device(id: Option<&str>) -> AppResult<cpal::Device> {
    let host = cpal::default_host();
    let Some(id) = id else {
        return host
            .default_input_device()
            .ok_or_else(|| AppError::AudioError("Aucun micro n'est branché".to_string()));
    };
    host.input_devices()
        .map_err(|e| AppError::AudioError(format!("Liste des micros indisponible : {e}")))?
        .find(|device| device_id(device).as_deref() == Some(id))
        .ok_or_else(|| AppError::AudioError(MISSING_INPUT.to_string()))
}

const MISSING_INPUT: &str = "Le micro choisi n'est plus branché : choisissez-en un autre dans l'onglet Enregistrer.";
const MISSING_OUTPUT: &str =
    "La sortie audio choisie n'est plus branchée : choisissez-en une autre dans l'onglet Enregistrer.";

/// Vérifie, avant de lancer la capture, que les périphériques choisis sont toujours branchés :
/// sans cela, un canal resterait muet pendant toute la réunion.
pub fn check_available(devices: &RecordingDevices) -> AppResult<()> {
    if let Some(id) = devices.input.as_deref() {
        input_device(Some(id))?;
    }
    if let Some(id) = devices.output.as_deref() {
        let found = cpal::default_host()
            .output_devices()
            .map_err(|e| AppError::AudioError(format!("Liste des sorties audio indisponible : {e}")))?
            .any(|device| device_id(&device).as_deref() == Some(id));
        if !found {
            return Err(AppError::AudioError(MISSING_OUTPUT.to_string()));
        }
    }
    Ok(())
}

/// Point de terminaison de sortie dont on capte le son : celui choisi, ou celui par défaut.
#[cfg(windows)]
pub unsafe fn render_endpoint(
    enumerator: &windows::Win32::Media::Audio::IMMDeviceEnumerator,
    id: Option<&str>,
) -> AppResult<windows::Win32::Media::Audio::IMMDevice> {
    use windows::Win32::Media::Audio::{eConsole, eRender};
    match id {
        Some(id) => enumerator
            .GetDevice(&windows::core::HSTRING::from(id))
            .map_err(|e| AppError::AudioError(format!("{MISSING_OUTPUT} ({e})"))),
        None => enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| AppError::AudioError(format!("Aucune sortie audio : {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_are_sent_in_camel_case() {
        let json = serde_json::to_value(AudioDevice { id: "x".into(), name: "Micro".into(), is_default: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "id": "x", "name": "Micro", "isDefault": true }));
    }

    #[test]
    fn no_choice_means_nothing_to_check() {
        assert!(check_available(&RecordingDevices::default()).is_ok());
    }

    #[test]
    fn an_unknown_device_is_reported_as_unplugged() {
        let missing = RecordingDevices { input: Some("{absent}".into()), output: None };
        assert!(check_available(&missing).unwrap_err().to_string().contains("micro choisi"));
        let missing = RecordingDevices { input: None, output: Some("{absent}".into()) };
        assert!(check_available(&missing).unwrap_err().to_string().contains("sortie audio choisie"));
    }
}
