//! Extinction de Windows en fin de traitement, via `shutdown.exe`.
//!
//! Le délai est géré par Windows (avertissement système affiché) : l'extinction a lieu
//! même si la WebView est ralentie fenêtre cachée. `/f` ferme les applications sans
//! attendre, sinon une application ouverte peut bloquer l'arrêt indéfiniment.

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Pas de console visible pour `shutdown.exe`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn shutdown_command(args: &[&str]) -> Command {
    let mut command = Command::new("shutdown");
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Arguments de `shutdown.exe` pour une extinction différée (sans la lancer).
fn schedule_args(delay: &str) -> [&str; 6] {
    [
        "/s",
        "/f",
        "/t",
        delay,
        "/c",
        "SealedScribe : traitement terminé, extinction de l'ordinateur.",
    ]
}

/// Programme l'extinction dans `delay_seconds` secondes (remplace une extinction déjà programmée).
pub fn schedule(delay_seconds: u32) -> Result<(), String> {
    abort();
    let delay = delay_seconds.to_string();
    let status = shutdown_command(&schedule_args(&delay))
    .status()
    .map_err(|e| format!("Impossible de lancer l'extinction : {e}"))?;
    if status.success() {
        log::info!("Extinction programmée dans {delay_seconds} s");
        Ok(())
    } else {
        Err(format!("L'extinction a été refusée par Windows (code {})", status.code().unwrap_or(-1)))
    }
}

/// Annule l'extinction programmée. Sans extinction en attente, `shutdown /a` échoue : ignoré.
pub fn abort() {
    let _ = shutdown_command(&["/a"]).status();
}

#[cfg(test)]
mod tests {
    use super::*;

    // Aucun de ces tests ne lance `shutdown.exe` : on n'inspecte que la commande construite.

    #[test]
    fn schedule_args_request_a_forced_delayed_shutdown() {
        let args = schedule_args("90");
        assert_eq!(&args[..4], ["/s", "/f", "/t", "90"]);
        // Le message affiché par Windows suit l'option /c.
        assert_eq!(args[4], "/c");
        assert!(args[5].contains("extinction"));
    }

    #[test]
    fn command_targets_shutdown_with_the_given_arguments() {
        let command = shutdown_command(&["/a"]);
        assert_eq!(command.get_program(), "shutdown");
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["/a"]);
    }
}
