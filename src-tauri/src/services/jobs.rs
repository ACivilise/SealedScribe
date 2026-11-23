//! Suivi des jobs de traitement (transcription) : statut réel, progression,
//! annulation et persistance dans `jobs.json`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::power::PowerGuard;

pub const EVENT_JOB_UPDATED: &str = "job-updated";
const MAX_STORED_JOBS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: JobStatus,
    pub progress: u8,
    pub message: String,
    pub error: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

/// Drapeaux de contrôle d'un job en cours.
#[derive(Clone, Default)]
pub struct JobFlags {
    /// Arrêt immédiat : le travail en cours est abandonné.
    pub cancel: Arc<AtomicBool>,
    /// Arrêt après la partie en cours (moteur local) : les parties terminées restent
    /// dans le point de reprise.
    pub stop_after_part: Arc<AtomicBool>,
}

pub struct JobManager {
    jobs: Mutex<Vec<Job>>,
    flags: Mutex<HashMap<String, JobFlags>>,
    file: PathBuf,
    /// Garde le PC éveillé (capot compris) tant qu'un job tourne, ou qu'une extinction
    /// en fin de traitement est demandée.
    power: PowerGuard,
    shutdown_armed: AtomicBool,
}

impl JobManager {
    /// Charge les jobs persistés. Un job resté `running` (application fermée
    /// pendant le traitement) passe à `interrupted`.
    pub fn new(file: PathBuf) -> Self {
        let mut jobs: Vec<Job> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default();

        let now = now();
        for job in jobs.iter_mut().filter(|j| j.status == JobStatus::Running) {
            job.status = JobStatus::Interrupted;
            job.message = "Interrompu (application fermée pendant le traitement)".to_string();
            job.updated_at = now.clone();
        }

        let manager = Self {
            jobs: Mutex::new(jobs),
            flags: Mutex::new(HashMap::new()),
            shutdown_armed: AtomicBool::new(false),
            power: PowerGuard::new(file.with_file_name("lid_backup.json")),
            file,
        };
        manager.persist();
        manager
    }

    /// Enregistre un nouveau job en cours et renvoie ses drapeaux d'arrêt.
    pub fn start(&self, app: &AppHandle, id: &str, kind: &str, label: &str) -> JobFlags {
        let now = now();
        let job = Job {
            id: id.to_string(),
            kind: kind.to_string(),
            label: label.to_string(),
            status: JobStatus::Running,
            progress: 0,
            message: "Démarrage".to_string(),
            error: None,
            started_at: now.clone(),
            updated_at: now,
        };

        let job_flags = JobFlags::default();
        if let Ok(mut flags) = self.flags.lock() {
            if flags.insert(id.to_string(), job_flags.clone()).is_none() {
                self.power.acquire();
            }
        }

        self.upsert(job.clone());
        self.persist();
        emit(app, &job);
        job_flags
    }

    /// Met à jour la progression d'un job en cours.
    pub fn update(&self, app: &AppHandle, id: &str, progress: u8, message: &str) {
        if let Some(job) = self.mutate(id, |job| {
            if job.status == JobStatus::Running {
                job.progress = progress.min(100);
                job.message = message.to_string();
                true
            } else {
                false
            }
        }) {
            emit(app, &job);
        }
    }

    /// Termine un job avec son statut final.
    pub fn finish(&self, app: &AppHandle, id: &str, status: JobStatus, error: Option<String>) {
        if let Some(job) = self.mutate(id, |job| {
            job.status = status;
            job.error = error.clone();
            job.progress = if status == JobStatus::Done { 100 } else { job.progress };
            job.message = match status {
                JobStatus::Done => "Terminé".to_string(),
                JobStatus::Cancelled => "Annulé".to_string(),
                JobStatus::Failed => "Échec".to_string(),
                JobStatus::Interrupted => "Arrêté après la partie en cours (reprise possible)".to_string(),
                _ => job.message.clone(),
            };
            true
        }) {
            emit(app, &job);
        }
        if let Ok(mut flags) = self.flags.lock() {
            if flags.remove(id).is_some() {
                self.power.release();
            }
        }
        self.persist();
    }

    /// Demande l'annulation d'un job en cours. Renvoie `false` si le job
    /// n'existe pas ou n'est plus en cours.
    pub fn cancel(&self, id: &str) -> bool {
        self.raise(id, |flags| &flags.cancel)
    }

    /// Demande l'arrêt d'un job après la partie en cours de traitement.
    pub fn stop_after_part(&self, id: &str) -> bool {
        self.raise(id, |flags| &flags.stop_after_part)
    }

    fn raise(&self, id: &str, pick: impl Fn(&JobFlags) -> &Arc<AtomicBool>) -> bool {
        let flags = self.flags.lock().ok().and_then(|flags| flags.get(id).cloned());
        match flags {
            Some(flags) => {
                pick(&flags).store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// Extinction demandée en fin de traitement : le PC reste éveillé jusqu'à l'extinction
    /// (sinon il pourrait se mettre en veille entre la fin du dernier job et l'arrêt).
    pub fn set_shutdown_armed(&self, armed: bool) {
        let previous = self.shutdown_armed.swap(armed, Ordering::SeqCst);
        match (previous, armed) {
            (false, true) => self.power.acquire(),
            (true, false) => self.power.release(),
            _ => {}
        }
    }

    pub fn list(&self) -> Vec<Job> {
        let mut jobs = self.jobs.lock().map(|j| j.clone()).unwrap_or_default();
        jobs.reverse(); // plus récents en premier
        jobs
    }

    fn upsert(&self, job: Job) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(existing) = jobs.iter_mut().find(|j| j.id == job.id) {
                *existing = job;
            } else {
                jobs.push(job);
            }
            // On ne conserve que les N derniers jobs.
            let excess = jobs.len().saturating_sub(MAX_STORED_JOBS);
            if excess > 0 {
                jobs.drain(0..excess);
            }
        }
    }

    /// Applique une modification à un job existant et renvoie sa nouvelle version.
    fn mutate(&self, id: &str, change: impl FnOnce(&mut Job) -> bool) -> Option<Job> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = jobs.iter_mut().find(|j| j.id == id)?;
        if change(job) {
            job.updated_at = now();
            Some(job.clone())
        } else {
            None
        }
    }

    fn persist(&self) {
        let jobs = match self.jobs.lock() {
            Ok(jobs) => jobs.clone(),
            Err(_) => return,
        };
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string_pretty(&jobs) {
            Ok(content) => {
                if let Err(e) = std::fs::write(&self.file, content) {
                    eprintln!("Impossible d'écrire {}: {}", self.file.display(), e);
                }
            }
            Err(e) => eprintln!("Sérialisation des jobs impossible: {}", e),
        }
    }
}

fn emit(app: &AppHandle, job: &Job) {
    let _ = app.emit(EVENT_JOB_UPDATED, job);
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dossier temporaire unique, supprimé à la fin du test.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("meetscribe-test-jobs-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn jobs_file(&self) -> PathBuf {
            self.0.join("jobs.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn job(id: &str, status: JobStatus) -> Job {
        Job {
            id: id.to_string(),
            kind: "transcription".to_string(),
            label: format!("{id}.wav"),
            status,
            progress: 40,
            message: "en cours".to_string(),
            error: None,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn status_serializes_lowercase_and_job_in_camel_case() {
        assert_eq!(serde_json::to_value(JobStatus::Interrupted).unwrap(), "interrupted");
        assert_eq!(serde_json::from_str::<JobStatus>("\"cancelled\"").unwrap(), JobStatus::Cancelled);

        let json = serde_json::to_value(job("a", JobStatus::Running)).unwrap();
        assert_eq!(json["status"], "running");
        assert_eq!(json["startedAt"], "2026-01-01T00:00:00Z");
        assert!(json["error"].is_null());
    }

    #[test]
    fn running_jobs_become_interrupted_when_reloaded() {
        let dir = TempDir::new();
        let saved = vec![job("run", JobStatus::Running), job("fini", JobStatus::Done)];
        std::fs::write(dir.jobs_file(), serde_json::to_string(&saved).unwrap()).unwrap();

        let manager = JobManager::new(dir.jobs_file());
        let jobs = manager.list();
        let run = jobs.iter().find(|j| j.id == "run").unwrap();
        assert_eq!(run.status, JobStatus::Interrupted);
        assert!(run.message.contains("Interrompu"));
        assert_eq!(jobs.iter().find(|j| j.id == "fini").unwrap().status, JobStatus::Done);

        // Le nouvel état est persisté : un second chargement le retrouve.
        let reloaded: Vec<Job> =
            serde_json::from_str(&std::fs::read_to_string(dir.jobs_file()).unwrap()).unwrap();
        assert!(reloaded.iter().all(|j| j.status != JobStatus::Running));
    }

    #[test]
    fn unreadable_jobs_file_gives_an_empty_list() {
        let dir = TempDir::new();
        std::fs::write(dir.jobs_file(), "pas du json").unwrap();
        assert!(JobManager::new(dir.jobs_file()).list().is_empty());

        let missing = TempDir::new();
        assert!(JobManager::new(missing.jobs_file()).list().is_empty());
    }

    #[test]
    fn list_returns_most_recent_first() {
        let dir = TempDir::new();
        let manager = JobManager::new(dir.jobs_file());
        manager.upsert(job("1", JobStatus::Done));
        manager.upsert(job("2", JobStatus::Done));
        manager.upsert(job("3", JobStatus::Done));
        let ids: Vec<String> = manager.list().into_iter().map(|j| j.id).collect();
        assert_eq!(ids, ["3", "2", "1"]);
    }

    #[test]
    fn upsert_replaces_an_existing_job_and_caps_history() {
        let dir = TempDir::new();
        let manager = JobManager::new(dir.jobs_file());

        manager.upsert(job("a", JobStatus::Running));
        manager.upsert(job("a", JobStatus::Done));
        assert_eq!(manager.list().len(), 1);
        assert_eq!(manager.list()[0].status, JobStatus::Done);

        for i in 0..(MAX_STORED_JOBS + 10) {
            manager.upsert(job(&format!("j{i}"), JobStatus::Done));
        }
        let jobs = manager.list();
        assert_eq!(jobs.len(), MAX_STORED_JOBS);
        // Les plus anciens sont éliminés, le plus récent est conservé.
        assert_eq!(jobs[0].id, format!("j{}", MAX_STORED_JOBS + 9));
        assert!(!jobs.iter().any(|j| j.id == "a"));
    }

    #[test]
    fn mutate_only_applies_when_the_change_is_accepted() {
        let dir = TempDir::new();
        let manager = JobManager::new(dir.jobs_file());
        manager.upsert(job("a", JobStatus::Done));

        assert!(manager.mutate("inconnu", |_| true).is_none());
        // Refus du changement : le job n'est pas modifié (ici, progression sur un job terminé).
        assert!(manager
            .mutate("a", |j| {
                if j.status == JobStatus::Running {
                    j.progress = 99;
                    true
                } else {
                    false
                }
            })
            .is_none());
        assert_eq!(manager.list()[0].progress, 40);

        let updated = manager.mutate("a", |j| {
            j.progress = 77;
            true
        });
        assert_eq!(updated.unwrap().progress, 77);
        assert_eq!(manager.list()[0].progress, 77);
        assert_ne!(manager.list()[0].updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn cancel_and_stop_raise_only_their_own_flag() {
        let dir = TempDir::new();
        let manager = JobManager::new(dir.jobs_file());
        assert!(!manager.cancel("inconnu"));
        assert!(!manager.stop_after_part("inconnu"));

        let flags = JobFlags::default();
        manager.flags.lock().unwrap().insert("a".to_string(), flags.clone());

        assert!(manager.stop_after_part("a"));
        assert!(flags.stop_after_part.load(Ordering::SeqCst));
        assert!(!flags.cancel.load(Ordering::SeqCst));

        assert!(manager.cancel("a"));
        assert!(flags.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn persist_writes_jobs_that_can_be_reloaded() {
        let dir = TempDir::new();
        let manager = JobManager::new(dir.jobs_file());
        manager.upsert(job("a", JobStatus::Failed));
        manager.persist();

        let reloaded = JobManager::new(dir.jobs_file());
        let jobs = reloaded.list();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "a");
        assert_eq!(jobs[0].status, JobStatus::Failed);
    }
}
