//! Transcription locale avec whisper.cpp (`whisper-server.exe`).
//!
//! - Le modèle tourne sur la carte NVIDIA s'il y tient (build CUDA), sinon sur le processeur
//!   (build CPU) : voir `hardware::HardwareProfile::place`.
//! - Les fichiers (programme, modèle, VAD) sont téléchargés à la demande depuis les Réglages.
//! - Rien n'est chargé au lancement de SealedScribe : le serveur démarre à la première
//!   transcription locale et s'arrête après `IDLE_UNLOAD` sans usage.
//! - Le serveur est un processus séparé, en priorité basse et rattaché à un Job Object
//!   Windows : il ne peut ni bloquer la capture audio, ni survivre à SealedScribe.

use crate::error::{AppError, AppResult};
use crate::models::{TranscriptionResult, TranscriptionSegment};
use crate::services::audio_prep::{self, TARGET_RATE};
use crate::services::checkpoint::{Checkpoint, ChunkResult};
use crate::services::hardware::{Device, Fit, HardwareProfile};
use crate::services::transcription::{TranscriptionProgressEvent, CANCELLED_MESSAGE, STOPPED_MESSAGE};
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Valeur de `UserPreferences::transcription_engine` pour le moteur local.
pub const ENGINE_LOCAL: &str = "local";

/// Durée sans usage avant d'arrêter le serveur (VRAM libérée).
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
/// Délai maximal de chargement du modèle.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
/// Durée cible d'un morceau envoyé au serveur (sert à mesurer la progression).
const CHUNK_TARGET_SECS: u32 = 300;
/// Threads CPU laissés à whisper.cpp quand le calcul est sur la carte graphique
/// (sur processeur : un par cœur physique).
const GPU_THREADS: usize = 4;
/// Estimation du premier chargement (aucune mesure enregistrée) : délai fixe de démarrage
/// du serveur + lecture du modèle et copie en mémoire graphique.
const LOAD_ESTIMATE_BASE_SECS: f64 = 3.0;
const LOAD_ESTIMATE_BYTES_PER_SEC: f64 = 250_000_000.0;

const SERVER_EXE: &str = "whisper-server.exe";
const MB: u64 = 1_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    /// Archive dont on extrait les .exe et .dll dans `<racine>\<dir>`. `marker` est écrit
    /// après une extraction complète et change avec la version.
    ServerZip { dir: &'static str, marker: &'static str },
    /// Archive sherpa-onnx (.tar.bz2) dont on extrait l'outil de séparation dans `diarization\`.
    DiarizationArchive,
    /// Fichier copié tel quel dans `models\`.
    Model,
}

/// Composant « séparation des intervenants » (sherpa-onnx, CPU) : installé et supprimé
/// depuis les Paramètres comme un modèle, sous cet identifiant.
pub const DIARIZATION_ID: &str = "diarization";
const DIARIZATION_EXE: &str = "sherpa-onnx-offline-speaker-diarization.exe";
/// API C de sherpa-onnx (dossier `lib/` de l'archive) : empreintes vocales des tours de parole.
const EMBEDDING_LIB: &str = "sherpa-onnx-c-api.dll";
/// Change quand les fichiers extraits changent : l'outil est alors à réinstaller.
const DIARIZATION_MARKER: &str = ".installed-sherpa-onnx-v2.0.1-md-capi";

struct RemoteFile {
    label: &'static str,
    file_name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
    kind: FileKind,
}

// whisper.cpp v1.9.2, build CUDA 12.4 (pilote NVIDIA ≥ 527 requis, ~670 Mo). Le build CUDA 11.8
// n'embarque pas cuBLAS : ggml-cuda.dll ne s'y charge pas et whisper.cpp retombe sans le dire
// sur le processeur. Les builds contiennent aussi les variantes CPU de ggml (choisies au lancement).
const CUDA_SERVER: RemoteFile = RemoteFile {
    label: "whisper.cpp (CUDA)",
    file_name: "whisper-cublas-12.4.0-bin-x64.zip",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-cublas-12.4.0-bin-x64.zip",
    size: 670_611_449,
    sha256: "443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c",
    kind: FileKind::ServerZip {
        dir: "bin",
        marker: ".installed-v1.9.2-cublas-12.4",
    },
};

// Même version, sans CUDA (~8 Mo) : PC sans carte NVIDIA, ou modèle trop gros pour la carte.
const CPU_SERVER: RemoteFile = RemoteFile {
    label: "whisper.cpp (processeur)",
    file_name: "whisper-bin-x64.zip",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
    size: 8_194_445,
    sha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
    kind: FileKind::ServerZip {
        dir: "bin-cpu",
        marker: ".installed-v1.9.2-cpu",
    },
};

fn server_for(device: Device) -> &'static RemoteFile {
    match device {
        Device::Gpu => &CUDA_SERVER,
        Device::Cpu => &CPU_SERVER,
    }
}

// Silero VAD : n'envoie au modèle que les passages parlés (évite les phrases inventées dans les silences).
const VAD_MODEL: RemoteFile = RemoteFile {
    label: "Silero VAD",
    file_name: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    size: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    kind: FileKind::Model,
};

// sherpa-onnx v2.0.1, build Windows x64 partagée (runtime MSVC /MD, ~21 Mo). Seuls l'outil
// de séparation, les DLL ONNX Runtime de `bin/` et l'API C de `lib/` sont extraits.
const DIARIZATION_RELEASE: RemoteFile = RemoteFile {
    label: "sherpa-onnx",
    file_name: "sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts.tar.bz2",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts.tar.bz2",
    size: 20_962_760,
    sha256: "11fd6a50b97eed38b54fb16d8219f49b16aa7f6a8e43a042316469ef47652e82",
    kind: FileKind::DiarizationArchive,
};

// Découpage en tours de parole et empreinte vocale : la même paire que pyannote 3.1.
const SEGMENTATION_MODEL: RemoteFile = RemoteFile {
    label: "pyannote segmentation 3.0",
    file_name: "pyannote-segmentation-3-0.onnx",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
    size: 5_992_913,
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    kind: FileKind::Model,
};

const EMBEDDING_MODEL: RemoteFile = RemoteFile {
    label: "WeSpeaker ResNet34-LM",
    file_name: "wespeaker_en_voxceleb_resnet34_LM.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    size: 26_530_550,
    sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
    kind: FileKind::Model,
};

const DIARIZATION_FILES: [&RemoteFile; 3] = [&DIARIZATION_RELEASE, &SEGMENTATION_MODEL, &EMBEDDING_MODEL];

/// Chemins de l'outil de séparation des intervenants, une fois installé.
#[derive(Debug, Clone)]
pub struct DiarizationTools {
    pub exe: PathBuf,
    pub segmentation_model: PathBuf,
    pub embedding_model: PathBuf,
    /// `sherpa-onnx-c-api.dll`, à côté de l'ONNX Runtime qu'elle charge.
    pub embedding_lib: PathBuf,
}

struct LocalModel {
    id: &'static str,
    file: RemoteFile,
    /// Mémoire occupée une fois chargé : poids + caches et tampons de calcul (lignes
    /// `kv … size` et `compute buffer` de whisper-server.log ; ~545 Mo pour large-v3).
    memory_bytes: u64,
}

const MODELS: &[LocalModel] = &[
    LocalModel {
        id: "large-v3-turbo",
        file: RemoteFile {
            label: "Whisper large-v3-turbo (q8_0)",
            file_name: "ggml-large-v3-turbo-q8_0.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
            size: 874_188_075,
            sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
            kind: FileKind::Model,
        },
        memory_bytes: 1_120 * MB,
    },
    LocalModel {
        id: "large-v3-turbo-q5",
        file: RemoteFile {
            label: "Whisper large-v3-turbo (q5_0)",
            file_name: "ggml-large-v3-turbo-q5_0.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
            size: 574_041_195,
            sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
            kind: FileKind::Model,
        },
        memory_bytes: 820 * MB,
    },
    LocalModel {
        id: "large-v3-french",
        file: RemoteFile {
            label: "Whisper large-v3 français (q5_0)",
            file_name: "ggml-large-v3-french-q5_0.bin",
            url: "https://huggingface.co/bofenghuang/whisper-large-v3-french/resolve/main/ggml-model-q5_0.bin",
            size: 1_081_140_203,
            sha256: "d8da7cb6cdadfac47829abf46fe8cd36fcfef06db5601bfd8acbcd40579010a5",
            kind: FileKind::Model,
        },
        memory_bytes: 1_630 * MB,
    },
    LocalModel {
        id: "medium",
        file: RemoteFile {
            label: "Whisper medium (q5_0)",
            file_name: "ggml-medium-q5_0.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
            size: 539_212_467,
            sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
            kind: FileKind::Model,
        },
        memory_bytes: 920 * MB,
    },
    LocalModel {
        id: "small",
        file: RemoteFile {
            label: "Whisper small (q5_1)",
            file_name: "ggml-small-q5_1.bin",
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
            size: 190_085_487,
            sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
            kind: FileKind::Model,
        },
        memory_bytes: 420 * MB,
    },
];

pub const DEFAULT_MODEL_ID: &str = "large-v3-turbo";

/// Modèles conseillés sur carte graphique pour une réunion en français, du meilleur au plus léger.
const GPU_PREFERENCE: [&str; 4] = ["large-v3-turbo", "large-v3-turbo-q5", "medium", "small"];

/// Modèle à conseiller sur ce PC : le meilleur qui tient sur la carte NVIDIA ; sans carte,
/// turbo q5 si le processeur suit (l'encodeur de large-v3 y coûte cher), sinon small.
fn recommended_model(hw: &HardwareProfile) -> &'static str {
    let on_gpu = |id: &&str| find_model(id).is_ok_and(|m| hw.place(m.memory_bytes).device == Device::Gpu);
    if let Some(id) = GPU_PREFERENCE.into_iter().find(on_gpu) {
        return id;
    }
    if hw.physical_cores >= 6 && hw.avx2 {
        "large-v3-turbo-q5"
    } else {
        "small"
    }
}

/// Options de calcul de whisper-server : `-ng` interdit la carte graphique.
fn compute_args(device: Device, hw: &HardwareProfile) -> Vec<String> {
    match device {
        Device::Gpu => vec!["-t".into(), GPU_THREADS.to_string()],
        Device::Cpu => vec!["-t".into(), hw.physical_cores.max(1).to_string(), "-ng".into()],
    }
}

/// Appareil réellement utilisé, d'après le journal de whisper-server. whisper.cpp écrit
/// « whisper_backend_init_gpu: using CUDA0 backend » quand il prend la carte, et
/// « no GPU found » quand il retombe sur le processeur (DLL CUDA manquante, pilote trop ancien…).
fn observed_device(log: &str) -> Device {
    if log.lines().any(|line| line.contains("whisper_backend_init_gpu: using ")) {
        Device::Gpu
    } else {
        Device::Cpu
    }
}

fn find_model(id: &str) -> AppResult<&'static LocalModel> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::Validation(format!("Modèle local inconnu : {id}")))
}

fn cancelled() -> AppError {
    AppError::TranscriptionError(CANCELLED_MESSAGE.to_string())
}

fn stopped() -> AppError {
    AppError::TranscriptionError(STOPPED_MESSAGE.to_string())
}

fn local_error(message: impl Into<String>) -> AppError {
    AppError::TranscriptionError(message.into())
}

// ============================================================================
// Statut et progression (sérialisés vers le front)
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    pub id: String,
    pub label: String,
    /// Programme, VAD et modèle présents : prêt à transcrire.
    pub installed: bool,
    pub size_bytes: u64,
    /// Octets restant à télécharger pour pouvoir utiliser ce modèle.
    pub missing_bytes: u64,
    /// Mémoire nécessaire une fois chargé.
    pub memory_bytes: u64,
    /// Appareil prévu sur ce PC (carte NVIDIA si le modèle y tient).
    pub device: Device,
    pub fit: Fit,
    /// Modèle conseillé pour ce PC.
    pub recommended: bool,
}

/// État d'un composant optionnel (séparation des intervenants).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub installed: bool,
    /// Une version précédente est installée : elle se met à jour d'elle-même à la prochaine
    /// séparation des voix.
    pub outdated: bool,
    /// Taille totale des fichiers du composant.
    pub size_bytes: u64,
    pub missing_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWhisperStatus {
    pub models: Vec<LocalModelStatus>,
    /// Modèle actuellement chargé en mémoire, s'il y en a un.
    pub loaded_model: Option<String>,
    /// Appareil réellement utilisé par le modèle chargé (lu dans le journal de whisper-server).
    pub loaded_device: Option<Device>,
    pub hardware: HardwareProfile,
    pub diarization: ComponentStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressEvent {
    pub model_id: String,
    pub file: String,
    pub file_index: usize,
    pub file_count: usize,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: u8,
    pub phase: String,
}

// ============================================================================
// Service
// ============================================================================

struct RunningServer {
    child: Child,
    port: u16,
    model_id: String,
    device: Device,
}

struct Inner {
    root: PathBuf,
    download_client: Client,
    inference_client: Client,
    /// Détecté au premier besoin (Paramètres ou transcription), pas au lancement.
    hardware: OnceLock<HardwareProfile>,
    server: Mutex<Option<RunningServer>>,
    /// Une seule transcription locale à la fois (un seul GPU).
    busy: Mutex<()>,
    /// Une seule installation à la fois.
    installing: Mutex<()>,
    /// Incrémenté à chaque usage : le minuteur d'arrêt ne s'applique qu'au dernier.
    idle_generation: AtomicU64,
}

pub struct LocalWhisperService {
    inner: Arc<Inner>,
}

impl LocalWhisperService {
    /// Aucune entrée-sortie ici : rien n'est chargé au lancement de l'application.
    pub fn new() -> Self {
        let root = dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            // Ancien nom de l'app, gardé : les modèles déjà téléchargés sont rangés là.
            .join("MeetScribe")
            .join("whisper");

        let download_client = Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());

        // Serveur local : pas de proxy, pas de délai global (un morceau peut être long sans GPU).
        let inference_client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            inner: Arc::new(Inner {
                root,
                download_client,
                inference_client,
                hardware: OnceLock::new(),
                server: Mutex::new(None),
                busy: Mutex::new(()),
                installing: Mutex::new(()),
                idle_generation: AtomicU64::new(0),
            }),
        }
    }

    /// Capacités du PC, détectées une fois (servent aussi au résumé par un modèle local).
    pub fn hardware(&self) -> &HardwareProfile {
        self.inner.hardware.get_or_init(HardwareProfile::detect)
    }

    /// Dossier d'un build de whisper.cpp (`bin` pour CUDA, `bin-cpu` pour le processeur).
    fn server_dir(&self, dir: &str) -> PathBuf {
        self.inner.root.join(dir)
    }

    /// Appareil prévu pour un modèle sur ce PC.
    fn device_for(&self, model: &LocalModel) -> Device {
        self.hardware().place(model.memory_bytes).device
    }

    fn models_dir(&self) -> PathBuf {
        self.inner.root.join("models")
    }

    /// Fichier où l'on mémorise la durée du dernier chargement d'un modèle.
    fn load_time_path(&self, model_id: &str) -> PathBuf {
        self.models_dir().join(format!("{model_id}.load-seconds"))
    }

    /// Durée attendue du chargement : dernière mesure, sinon estimation d'après la taille.
    fn expected_load_seconds(&self, model: &LocalModel) -> f64 {
        std::fs::read_to_string(self.load_time_path(model.id))
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or_else(|| LOAD_ESTIMATE_BASE_SECS + model.file.size as f64 / LOAD_ESTIMATE_BYTES_PER_SEC)
    }

    /// Outil de séparation des intervenants (sherpa-onnx) et ses DLL.
    fn diarization_dir(&self) -> PathBuf {
        self.inner.root.join("diarization")
    }

    fn target_path(&self, file: &RemoteFile) -> PathBuf {
        match file.kind {
            FileKind::ServerZip { .. } | FileKind::DiarizationArchive => self.inner.root.join(file.file_name),
            FileKind::Model => self.models_dir().join(file.file_name),
        }
    }

    fn is_present(&self, file: &RemoteFile) -> bool {
        match file.kind {
            FileKind::ServerZip { dir, marker } => {
                let dir = self.server_dir(dir);
                dir.join(SERVER_EXE).is_file() && dir.join(marker).is_file()
            }
            FileKind::DiarizationArchive => {
                let dir = self.diarization_dir();
                [DIARIZATION_EXE, EMBEDDING_LIB, DIARIZATION_MARKER].iter().all(|f| dir.join(f).is_file())
            }
            FileKind::Model => std::fs::metadata(self.target_path(file))
                .map(|m| m.len() == file.size)
                .unwrap_or(false),
        }
    }

    /// Fichiers nécessaires pour un modèle donné sur ce PC, dans l'ordre de téléchargement.
    fn required_files(&self, model: &'static LocalModel) -> [&'static RemoteFile; 3] {
        [server_for(self.device_for(model)), &VAD_MODEL, &model.file]
    }

    /// Fichiers d'un modèle Whisper ou du composant de séparation des intervenants.
    fn files_for(&self, id: &str) -> AppResult<Vec<&'static RemoteFile>> {
        if id == DIARIZATION_ID {
            return Ok(DIARIZATION_FILES.to_vec());
        }
        Ok(self.required_files(find_model(id)?).to_vec())
    }

    /// Outil de séparation des intervenants, s'il est installé.
    pub fn diarization_tools(&self) -> Option<DiarizationTools> {
        DIARIZATION_FILES.iter().all(|f| self.is_present(f)).then(|| DiarizationTools {
            exe: self.diarization_dir().join(DIARIZATION_EXE),
            segmentation_model: self.target_path(&SEGMENTATION_MODEL),
            embedding_model: self.target_path(&EMBEDDING_MODEL),
            embedding_lib: self.diarization_dir().join(EMBEDDING_LIB),
        })
    }

    /// Une version précédente de l'outil de séparation est installée (son programme est là,
    /// mais pas les fichiers de la version attendue).
    fn diarization_outdated(&self) -> bool {
        self.diarization_dir().join(DIARIZATION_EXE).is_file() && !self.is_present(&DIARIZATION_RELEASE)
    }

    /// Outil de séparation des intervenants, mis à jour d'abord s'il en reste une version
    /// précédente : l'utilisateur l'a installé, il n'a pas à le réinstaller après une mise à
    /// jour de SealedScribe. Jamais installé, ou supprimé : `Ok(None)`, sans téléchargement.
    /// `Err` si la mise à jour a échoué.
    pub async fn diarization_tools_updating<F>(&self, cancel: Arc<AtomicBool>, on_progress: F) -> AppResult<Option<DiarizationTools>>
    where
        F: FnMut(InstallProgressEvent) + Send,
    {
        if self.diarization_tools().is_none() && self.diarization_outdated() {
            log::info!("Mise à jour de la séparation des intervenants");
            self.install(DIARIZATION_ID, cancel, on_progress).await?;
        }
        Ok(self.diarization_tools())
    }

    pub fn is_model_installed(&self, model_id: &str) -> bool {
        find_model(model_id)
            .map(|m| self.required_files(m).iter().all(|f| self.is_present(f)))
            .unwrap_or(false)
    }

    pub async fn status(&self) -> LocalWhisperStatus {
        let (loaded_model, loaded_device) = match self.inner.server.lock().await.as_ref() {
            Some(running) => (Some(running.model_id.clone()), Some(running.device)),
            None => (None, None),
        };
        let hardware = self.hardware();
        let recommended = recommended_model(hardware);
        let models = MODELS
            .iter()
            .map(|model| {
                let missing_bytes = self
                    .required_files(model)
                    .iter()
                    .filter(|f| !self.is_present(f))
                    .map(|f| f.size)
                    .sum();
                let placement = hardware.place(model.memory_bytes);
                LocalModelStatus {
                    id: model.id.to_string(),
                    label: model.file.label.to_string(),
                    installed: missing_bytes == 0,
                    size_bytes: model.file.size,
                    missing_bytes,
                    memory_bytes: model.memory_bytes,
                    device: placement.device,
                    fit: placement.fit,
                    recommended: model.id == recommended,
                }
            })
            .collect();

        let diarization_missing: u64 =
            DIARIZATION_FILES.iter().filter(|f| !self.is_present(f)).map(|f| f.size).sum();
        LocalWhisperStatus {
            models,
            loaded_model,
            loaded_device,
            hardware: hardware.clone(),
            diarization: ComponentStatus {
                installed: diarization_missing == 0,
                outdated: self.diarization_outdated(),
                size_bytes: DIARIZATION_FILES.iter().map(|f| f.size).sum(),
                missing_bytes: diarization_missing,
            },
        }
    }

    // ------------------------------------------------------------------------
    // Installation
    // ------------------------------------------------------------------------

    /// Télécharge ce qui manque pour `model_id` (modèle Whisper ou `DIARIZATION_ID`).
    /// Reprend un téléchargement interrompu.
    pub async fn install<F>(&self, model_id: &str, cancel: Arc<AtomicBool>, mut on_progress: F) -> AppResult<()>
    where
        F: FnMut(InstallProgressEvent) + Send,
    {
        let files = self.files_for(model_id)?;
        let _guard = self
            .inner
            .installing
            .try_lock()
            .map_err(|_| local_error("Un téléchargement est déjà en cours"))?;

        let missing: Vec<&RemoteFile> = files.into_iter().filter(|f| !self.is_present(f)).collect();
        let total_bytes: u64 = missing.iter().map(|f| f.size).sum();
        let mut done_bytes = 0u64;

        // Remplacer le programme impose d'arrêter le serveur (il verrouille ses DLL) :
        // on refuse avant de télécharger plutôt qu'après.
        let replaces_server = missing.iter().any(|f| matches!(f.kind, FileKind::ServerZip { .. }));
        if replaces_server && self.inner.busy.try_lock().is_err() {
            return Err(local_error(
                "Transcription locale en cours : relancez le téléchargement quand elle sera terminée",
            ));
        }

        tokio::fs::create_dir_all(self.models_dir()).await?;

        for (index, file) in missing.iter().enumerate() {
            let mut event = InstallProgressEvent {
                model_id: model_id.to_string(),
                file: file.label.to_string(),
                file_index: index + 1,
                file_count: missing.len(),
                downloaded_bytes: done_bytes,
                total_bytes,
                progress: 0,
                phase: "downloading".to_string(),
            };

            let target = self.target_path(file);
            self.download(file, &target, &cancel, |file_bytes| {
                event.downloaded_bytes = done_bytes + file_bytes;
                event.progress = percent(event.downloaded_bytes, total_bytes);
                on_progress(event.clone());
            })
            .await?;
            done_bytes += file.size;

            if file.kind != FileKind::Model {
                event.phase = "extracting".to_string();
                event.downloaded_bytes = done_bytes;
                event.progress = percent(done_bytes, total_bytes);
                on_progress(event.clone());

                let archive = target.clone();
                let extraction = if let FileKind::ServerZip { dir, marker } = file.kind {
                    self.unload().await;
                    let dir = self.server_dir(dir);
                    tokio::task::spawn_blocking(move || extract_server(&archive, &dir, marker)).await
                } else {
                    let dir = self.diarization_dir();
                    tokio::task::spawn_blocking(move || extract_diarization(&archive, &dir)).await
                };
                extraction.map_err(|e| local_error(format!("Extraction interrompue : {e}")))??;
                let _ = tokio::fs::remove_file(&target).await;
            }
        }

        on_progress(InstallProgressEvent {
            model_id: model_id.to_string(),
            file: String::new(),
            file_index: missing.len(),
            file_count: missing.len(),
            downloaded_bytes: total_bytes,
            total_bytes,
            progress: 100,
            phase: "completed".to_string(),
        });
        Ok(())
    }

    /// Téléchargement en flux vers `<cible>.part`, avec reprise (Range) et vérification SHA-256.
    async fn download(
        &self,
        file: &RemoteFile,
        target: &Path,
        cancel: &AtomicBool,
        mut on_bytes: impl FnMut(u64),
    ) -> AppResult<()> {
        let part = target.with_extension("part");
        let mut hasher = Sha256::new();
        let mut existing = 0u64;

        // Reprise : on re-hache la partie déjà téléchargée.
        if let Ok(meta) = tokio::fs::metadata(&part).await {
            if meta.len() > 0 && meta.len() < file.size {
                let part_path = part.clone();
                let (len, partial_hasher) = tokio::task::spawn_blocking(move || -> std::io::Result<(u64, Sha256)> {
                    let mut hasher = Sha256::new();
                    let mut reader = std::fs::File::open(&part_path)?;
                    let len = std::io::copy(&mut reader, &mut hasher)?;
                    Ok((len, hasher))
                })
                .await
                .map_err(|e| local_error(format!("Lecture du fichier partiel : {e}")))??;
                existing = len;
                hasher = partial_hasher;
            } else {
                let _ = tokio::fs::remove_file(&part).await;
            }
        }

        let mut request = self.inner.download_client.get(file.url);
        if existing > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
        }
        let response = request.send().await?;
        let status = response.status();

        let mut out = if existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
            tokio::fs::OpenOptions::new().append(true).open(&part).await?
        } else if status.is_success() {
            // Le serveur ignore la reprise : on recommence de zéro.
            existing = 0;
            hasher = Sha256::new();
            tokio::fs::File::create(&part).await?
        } else {
            return Err(local_error(format!("Téléchargement de {} : HTTP {status}", file.label)));
        };

        let mut downloaded = existing;
        on_bytes(downloaded);
        let mut last_emit = Instant::now();
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                out.flush().await?;
                return Err(cancelled());
            }
            let chunk = chunk?;
            out.write_all(&chunk).await?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            if last_emit.elapsed() >= Duration::from_millis(200) {
                last_emit = Instant::now();
                on_bytes(downloaded);
            }
        }
        out.flush().await?;
        drop(out);
        on_bytes(downloaded);

        let digest = format!("{:x}", hasher.finalize());
        if downloaded != file.size || digest != file.sha256 {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(local_error(format!(
                "Fichier {} corrompu ({} octets, SHA-256 {}) : relancez le téléchargement",
                file.label, downloaded, digest
            )));
        }

        tokio::fs::rename(&part, target).await?;
        Ok(())
    }

    /// Supprime un modèle téléchargé (le programme et le VAD sont conservés), ou tout le
    /// composant de séparation des intervenants (`DIARIZATION_ID`).
    pub async fn delete_model(&self, model_id: &str) -> AppResult<()> {
        if model_id == DIARIZATION_ID {
            let dir = self.diarization_dir();
            if dir.exists() {
                tokio::fs::remove_dir_all(&dir)
                    .await
                    .map_err(|e| local_error(format!("Suppression impossible (séparation en cours ?) : {e}")))?;
            }
            for file in [&SEGMENTATION_MODEL, &EMBEDDING_MODEL] {
                let path = self.target_path(file);
                for p in [path.clone(), path.with_extension("part")] {
                    if p.exists() {
                        tokio::fs::remove_file(&p).await?;
                    }
                }
            }
            return Ok(());
        }
        let model = find_model(model_id)?;
        let is_loaded = self.inner.server.lock().await.as_ref().map(|s| s.model_id == model_id).unwrap_or(false);
        if is_loaded {
            if self.inner.busy.try_lock().is_err() {
                return Err(local_error("Transcription en cours avec ce modèle"));
            }
            self.unload().await;
        }
        let path = self.target_path(&model.file);
        for p in [path.clone(), path.with_extension("part")] {
            if p.exists() {
                tokio::fs::remove_file(&p).await?;
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------------
    // Cycle de vie du serveur
    // ------------------------------------------------------------------------

    /// Démarre le serveur avec le bon modèle s'il ne tourne pas déjà, et attend qu'il réponde.
    async fn ensure_running<F>(&self, model_id: &str, cancel: &AtomicBool, on_progress: &mut F) -> AppResult<u16>
    where
        F: FnMut(TranscriptionProgressEvent),
    {
        let mut server = self.inner.server.lock().await;

        if let Some(running) = server.as_mut() {
            let alive = matches!(running.child.try_wait(), Ok(None));
            if alive && running.model_id == model_id {
                return Ok(running.port);
            }
        }
        if let Some(old) = server.take() {
            stop_server(old).await;
        }

        let model = find_model(model_id)?;
        let device = self.device_for(model);
        let FileKind::ServerZip { dir, .. } = server_for(device).kind else {
            unreachable!("server_for renvoie toujours un build du serveur")
        };
        let server_dir = self.server_dir(dir);
        let port = free_port()?;
        let log_path = self.inner.root.join("whisper-server.log");
        let log = std::fs::File::create(&log_path)?;

        let mut command = Command::new(server_dir.join(SERVER_EXE));
        command
            .current_dir(&server_dir)
            .arg("-m")
            .arg(self.target_path(&model.file))
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(compute_args(device, self.hardware()))
            .args(["-l", "fr", "-fa", "-sns"])
            .arg("--vad")
            .arg("-vm")
            .arg(self.target_path(&VAD_MODEL))
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        }

        let mut child = command
            .spawn()
            .map_err(|e| local_error(format!("Lancement de whisper-server impossible : {e}")))?;

        #[cfg(windows)]
        if let Some(handle) = child.raw_handle() {
            job::assign(handle);
        }

        log::info!("[LocalWhisper] whisper-server lancé (port {port}, modèle {model_id}, {device:?})");

        let expected_secs = self.expected_load_seconds(model);
        let started = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill().await;
                return Err(cancelled());
            }
            if let Ok(Some(exit)) = child.try_wait() {
                return Err(local_error(format!(
                    "whisper-server s'est arrêté au chargement ({exit}). {}",
                    log_tail(&log_path)
                )));
            }
            if started.elapsed() > STARTUP_TIMEOUT {
                let _ = child.kill().await;
                return Err(local_error("Le modèle n'a pas fini de charger à temps"));
            }

            let elapsed = started.elapsed().as_secs_f64();
            on_progress(TranscriptionProgressEvent {
                phase: "loading-model".to_string(),
                progress: 5,
                message: format!("Chargement du modèle… {} s", elapsed as u64),
                model_load_seconds: Some(elapsed),
                model_load_expected_seconds: Some(expected_secs),
                ..Default::default()
            });

            let url = format!("http://127.0.0.1:{port}/");
            if self
                .inner
                .inference_client
                .get(&url)
                .timeout(Duration::from_secs(2))
                .send()
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        let load_secs = started.elapsed().as_secs_f64();
        let used = observed_device(&std::fs::read_to_string(&log_path).unwrap_or_default());
        log::info!("[LocalWhisper] modèle prêt en {load_secs:.1} s ({used:?})");
        if used != device {
            log::warn!("[LocalWhisper] carte graphique prévue mais non utilisée : voir {}", log_path.display());
        }
        // Sert d'estimation au prochain chargement (barre de progression de l'UI).
        if let Err(e) = std::fs::write(self.load_time_path(model_id), format!("{load_secs:.2}")) {
            log::warn!("[LocalWhisper] durée de chargement non enregistrée : {e}");
        }
        *server = Some(RunningServer {
            child,
            port,
            model_id: model_id.to_string(),
            device: used,
        });
        Ok(port)
    }

    /// Arrête le serveur et libère la mémoire graphique.
    pub async fn unload(&self) {
        if let Some(running) = self.inner.server.lock().await.take() {
            stop_server(running).await;
            log::info!("[LocalWhisper] serveur arrêté, mémoire libérée");
        }
    }

    /// Arrête le serveur s'il ne transcrit pas : libère la carte graphique pour un autre
    /// modèle local (résumé). Renvoie `true` si un serveur a été arrêté.
    pub async fn unload_if_idle(&self) -> bool {
        let Ok(_busy) = self.inner.busy.try_lock() else {
            return false; // transcription en cours : on ne l'interrompt pas
        };
        match self.inner.server.lock().await.take() {
            Some(running) => {
                stop_server(running).await;
                log::info!("[LocalWhisper] serveur arrêté pour libérer la mémoire");
                true
            }
            None => false,
        }
    }

    /// Réarme le minuteur d'arrêt après un usage.
    fn schedule_idle_unload(&self) {
        let generation = self.inner.idle_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let inner = self.inner.clone();
        let delay = std::env::var("MEETSCRIBE_WHISPER_IDLE_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or(IDLE_UNLOAD);

        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if inner.idle_generation.load(Ordering::SeqCst) != generation {
                return; // utilisé depuis : un minuteur plus récent prend le relais
            }
            let Ok(_busy) = inner.busy.try_lock() else { return };
            if let Some(running) = inner.server.lock().await.take() {
                stop_server(running).await;
                log::info!("[LocalWhisper] inactif depuis {:?} : serveur arrêté", delay);
            }
        });
    }

    // ------------------------------------------------------------------------
    // Transcription
    // ------------------------------------------------------------------------

    pub async fn transcribe<F>(
        &self,
        audio_path: String,
        language: String,
        model_id: String,
        prompt: Option<String>,
        cancel: Arc<AtomicBool>,
        stop_after_part: Arc<AtomicBool>,
        checkpoint: &Checkpoint,
        mut on_progress: F,
    ) -> AppResult<TranscriptionResult>
    where
        F: FnMut(TranscriptionProgressEvent) + Send,
    {
        if !self.is_model_installed(&model_id) {
            return Err(AppError::ConfigError(
                "Modèle local non installé : Réglages › Transcription › Télécharger".to_string(),
            ));
        }

        on_progress(TranscriptionProgressEvent {
            phase: "queued".to_string(),
            progress: 0,
            message: "En attente de la transcription en cours…".to_string(),
            ..Default::default()
        });
        let _busy = self.inner.busy.lock().await;

        let result = self
            .transcribe_inner(audio_path, language, model_id, prompt, &cancel, &stop_after_part, checkpoint, &mut on_progress)
            .await;

        if result.is_err() && cancel.load(Ordering::SeqCst) {
            // Annulation : on arrête le serveur, ce qui interrompt aussi le calcul GPU en cours.
            self.unload_locked().await;
        } else {
            self.schedule_idle_unload();
        }
        result
    }

    /// Variante de `unload` à appeler quand `busy` est déjà tenu.
    async fn unload_locked(&self) {
        if let Some(running) = self.inner.server.lock().await.take() {
            stop_server(running).await;
        }
    }

    async fn transcribe_inner<F>(
        &self,
        audio_path: String,
        language: String,
        model_id: String,
        prompt: Option<String>,
        cancel: &AtomicBool,
        stop_after_part: &AtomicBool,
        checkpoint: &Checkpoint,
        on_progress: &mut F,
    ) -> AppResult<TranscriptionResult>
    where
        F: FnMut(TranscriptionProgressEvent) + Send,
    {
        on_progress(TranscriptionProgressEvent {
            phase: "preparing".to_string(),
            progress: 2,
            message: "Préparation de l'audio…".to_string(),
            ..Default::default()
        });

        let samples = tokio::task::spawn_blocking(move || audio_prep::decode_to_mono_16k(&audio_path))
            .await
            .map_err(|e| local_error(format!("Préparation audio interrompue : {e}")))??;
        if cancel.load(Ordering::SeqCst) {
            return Err(cancelled());
        }

        let total_secs = samples.len() as f64 / TARGET_RATE as f64;
        let whisper_language = whisper_language(&language);
        let prompt = initial_prompt(prompt);

        let chunks = audio_prep::split_on_silence(&samples, CHUNK_TARGET_SECS);
        let total_chunks = chunks.len();
        let mut segments: Vec<TranscriptionSegment> = Vec::new();
        checkpoint.begin(total_chunks);

        // Le modèle n'est chargé que s'il reste au moins un morceau à transcrire.
        let mut server_port: Option<u16> = None;

        for (index, chunk) in chunks.iter().enumerate() {
            // Déjà transcrit lors d'une tentative précédente : repris tel quel.
            if let Some(saved) = checkpoint.get(index + 1) {
                segments.extend(with_offset(saved.segments, saved.offset_secs));
                continue;
            }
            // Arrêt demandé après la partie en cours : on ne commence pas la suivante.
            // Les parties terminées restent dans le point de reprise.
            if stop_after_part.load(Ordering::SeqCst) {
                return Err(stopped());
            }
            let port = match server_port {
                Some(port) => port,
                None => {
                    let port = self.ensure_running(&model_id, cancel, on_progress).await?;
                    server_port = Some(port);
                    port
                }
            };

            let processed = chunk.offset_secs;
            on_progress(TranscriptionProgressEvent {
                phase: "transcribing".to_string(),
                progress: transcribe_percent(processed, total_secs),
                current_chunk: Some(index + 1),
                total_chunks: Some(total_chunks),
                concurrency: Some(1),
                message: format!(
                    "Transcription locale… {} / {} min",
                    (processed / 60.0).floor(),
                    (total_secs / 60.0).ceil()
                ),
                processed_seconds: Some(processed),
                total_seconds: Some(total_secs),
                ..Default::default()
            });

            let wav = audio_prep::encode_wav_16k(chunk.samples)?;
            let response = self.infer(port, wav, &whisper_language, prompt.as_deref(), cancel).await?;

            // Horodatages relatifs au morceau dans le point de reprise, absolus dans le résultat.
            let chunk_segments: Vec<TranscriptionSegment> = response
                .segments
                .into_iter()
                .filter_map(|segment| {
                    let text = segment.text.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    Some(TranscriptionSegment {
                        text,
                        speaker: 0,
                        start_time: segment.start,
                        end_time: segment.end,
                        confidence: segment.avg_logprob.map(|lp| lp.exp().clamp(0.0, 1.0)).unwrap_or(1.0),
                        language: language.clone(),
                    })
                })
                .collect();
            checkpoint.save(
                index + 1,
                ChunkResult {
                    offset_secs: chunk.offset_secs,
                    full_text: chunk_segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" "),
                    segments: chunk_segments.clone(),
                },
            );
            segments.extend(with_offset(chunk_segments, chunk.offset_secs));
        }

        on_progress(TranscriptionProgressEvent {
            phase: "completed".to_string(),
            progress: 100,
            current_chunk: Some(total_chunks),
            total_chunks: Some(total_chunks),
            concurrency: Some(1),
            message: "Transcription terminée".to_string(),
            processed_seconds: Some(total_secs),
            total_seconds: Some(total_secs),
            ..Default::default()
        });

        let full_text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        Ok(TranscriptionResult {
            segments,
            full_text,
            language,
            duration_seconds: total_secs,
        })
    }

    /// Envoie un morceau au serveur. L'annulation abandonne la requête immédiatement.
    /// `prompt` : indice (termes des lexiques) que whisper traite comme du texte déjà entendu.
    async fn infer(
        &self,
        port: u16,
        wav: Vec<u8>,
        language: &str,
        prompt: Option<&str>,
        cancel: &AtomicBool,
    ) -> AppResult<VerboseJson> {
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("chunk.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("response_format", "verbose_json")
            .text("temperature", "0.0")
            .text("temperature_inc", "0.2")
            .text("language", language.to_string());
        if let Some(prompt) = prompt {
            form = form.text("prompt", prompt.to_string());
        }

        let request = self
            .inner
            .inference_client
            .post(format!("http://127.0.0.1:{port}/inference"))
            .multipart(form)
            .send();

        let response = tokio::select! {
            response = request => response?,
            _ = wait_for_cancel(cancel) => return Err(cancelled()),
        };

        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            return Err(local_error(format!("whisper-server a répondu {status} : {body}")));
        }
        parse_verbose_json(&body)
    }
}

impl Default for LocalWhisperService {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Utilitaires
// ============================================================================

#[derive(Debug, Deserialize)]
struct VerboseJson {
    #[serde(default)]
    segments: Vec<VerboseSegment>,
}

#[derive(Debug, Deserialize)]
struct VerboseSegment {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    end: f64,
    #[serde(default)]
    avg_logprob: Option<f32>,
}

fn parse_verbose_json(body: &str) -> AppResult<VerboseJson> {
    serde_json::from_str(body).map_err(|e| {
        let preview: String = body.chars().take(200).collect();
        local_error(format!("Réponse de whisper-server illisible ({e}) : {preview}"))
    })
}

/// "fr-FR" → "fr" ; Whisper n'utilise que le code de langue.
/// Indice transmis à whisper-server : absent s'il est vide.
fn initial_prompt(prompt: Option<String>) -> Option<String> {
    prompt.map(|p| p.trim().to_string()).filter(|p| !p.is_empty())
}

fn whisper_language(language: &str) -> String {
    let code = language.split(['-', '_']).next().unwrap_or("").trim().to_ascii_lowercase();
    if code.is_empty() {
        "auto".to_string()
    } else {
        code
    }
}

fn percent(done: u64, total: u64) -> u8 {
    if total == 0 {
        100
    } else {
        ((done.saturating_mul(100)) / total).min(100) as u8
    }
}

/// Recale des segments relatifs à un morceau sur l'audio complet.
fn with_offset(segments: Vec<TranscriptionSegment>, offset_secs: f64) -> impl Iterator<Item = TranscriptionSegment> {
    segments.into_iter().map(move |mut segment| {
        segment.start_time += offset_secs;
        segment.end_time += offset_secs;
        segment
    })
}

/// Progression de la phase de transcription, entre 10 et 99 %.
fn transcribe_percent(processed_secs: f64, total_secs: f64) -> u8 {
    if total_secs <= 0.0 {
        return 10;
    }
    (10.0 + 89.0 * (processed_secs / total_secs).clamp(0.0, 1.0)) as u8
}

async fn wait_for_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn stop_server(mut running: RunningServer) {
    let _ = running.child.kill().await;
}

fn free_port() -> AppResult<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn log_tail(path: &Path) -> String {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = content.lines().rev().take(5).collect();
    let tail: Vec<&str> = lines.into_iter().rev().collect();
    format!("Fin du journal {} : {}", path.display(), tail.join(" | "))
}

/// Extrait les .exe et .dll de l'archive whisper.cpp à plat dans `bin_dir`, vidé au préalable
/// (les DLL d'une ancienne version ne doivent pas être chargées à la place des nouvelles).
fn extract_server(zip_path: &Path, bin_dir: &Path, marker: &str) -> AppResult<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| local_error(format!("Archive invalide : {e}")))?;
    if bin_dir.exists() {
        std::fs::remove_dir_all(bin_dir)
            .map_err(|e| local_error(format!("Ancienne version de whisper.cpp non supprimée : {e}")))?;
    }
    std::fs::create_dir_all(bin_dir)?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| local_error(format!("Archive invalide : {e}")))?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name` refuse les chemins qui sortiraient du dossier (« ../ »).
        let Some(name) = entry.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_owned())) else {
            continue;
        };
        let lower = name.to_string_lossy().to_ascii_lowercase();
        if !(lower.ends_with(".dll") || lower == SERVER_EXE) {
            continue;
        }
        let mut out = std::fs::File::create(bin_dir.join(&name))?;
        std::io::copy(&mut entry, &mut out)?;
    }

    if !bin_dir.join(SERVER_EXE).is_file() {
        return Err(local_error("whisper-server.exe absent de l'archive"));
    }
    std::fs::write(bin_dir.join(marker), b"ok")?;
    Ok(())
}

/// Extrait d'une archive sherpa-onnx (.tar.bz2) l'outil de séparation des intervenants, les
/// DLL de son dossier `bin/` (ONNX Runtime) et l'API C de `lib/`, à plat dans `dir`.
fn extract_diarization(archive_path: &Path, dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let file = std::fs::File::open(archive_path)?;
    let mut archive = tar::Archive::new(bzip2::read::BzDecoder::new(std::io::BufReader::new(file)));
    let entries = archive.entries().map_err(|e| local_error(format!("Archive invalide : {e}")))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| local_error(format!("Archive invalide : {e}")))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|e| local_error(format!("Archive invalide : {e}")))?.into_owned();
        // Seul le nom de fichier est gardé : un chemin « ../ » ne peut pas sortir du dossier.
        let parent = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_ascii_lowercase());
        let Some(name) = path.file_name().map(|n| n.to_owned()) else { continue };
        let lower = name.to_string_lossy().to_ascii_lowercase();
        let wanted = match parent.as_deref() {
            Some("bin") => lower.ends_with(".dll") || lower == DIARIZATION_EXE,
            Some("lib") => lower == EMBEDDING_LIB,
            _ => false,
        };
        if !wanted {
            continue;
        }
        let mut out = std::fs::File::create(dir.join(&name))?;
        std::io::copy(&mut entry, &mut out)?;
    }

    for required in [DIARIZATION_EXE, EMBEDDING_LIB] {
        if !dir.join(required).is_file() {
            return Err(local_error(format!("{required} absent de l'archive")));
        }
    }
    std::fs::write(dir.join(DIARIZATION_MARKER), b"ok")?;
    Ok(())
}

/// Job Object partagé : quand SealedScribe se termine (même en plantant), Windows
/// ferme son handle et tue les processus enfants rattachés (whisper-server, sherpa-onnx).
#[cfg(windows)]
pub(crate) mod job {
    use std::os::windows::io::RawHandle;
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn job_handle() -> Option<HANDLE> {
        let raw = JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            // Handle volontairement jamais fermé : il vit autant que SealedScribe.
            Some(job.0 as usize)
        });
        raw.map(|h| HANDLE(h as *mut core::ffi::c_void))
    }

    pub fn assign(process: RawHandle) {
        match job_handle() {
            Some(job) => unsafe {
                if let Err(e) = AssignProcessToJobObject(job, HANDLE(process)) {
                    log::warn!("[LocalWhisper] Job Object non appliqué : {e}");
                }
            },
            None => log::warn!("[LocalWhisper] Job Object indisponible"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::hardware::tests::profile;

    const TEST_MARKER: &str = ".installed-test";

    #[test]
    fn maps_locale_to_whisper_language() {
        assert_eq!(whisper_language("fr-FR"), "fr");
        assert_eq!(whisper_language("en_US"), "en");
        assert_eq!(whisper_language("DE"), "de");
        assert_eq!(whisper_language(""), "auto");
    }

    #[test]
    fn parses_whisper_server_verbose_json() {
        let body = r#"{
            "task": "transcribe", "language": "french", "duration": 12.5,
            "text": " Bonjour à tous. On commence.",
            "segments": [
                {"id": 0, "text": " Bonjour à tous.", "start": 0.0, "end": 2.4, "avg_logprob": -0.2, "tokens": [1,2]},
                {"id": 1, "text": " On commence.", "start": 2.4, "end": 4.0}
            ]
        }"#;
        let parsed = parse_verbose_json(body).unwrap();
        assert_eq!(parsed.segments.len(), 2);
        assert_eq!(parsed.segments[0].text.trim(), "Bonjour à tous.");
        assert_eq!(parsed.segments[1].end, 4.0);
        assert!(parsed.segments[1].avg_logprob.is_none());
    }

    #[test]
    fn invalid_json_gives_readable_error() {
        assert!(parse_verbose_json("<html>oops</html>").is_err());
    }

    #[test]
    fn progress_helpers_stay_in_range() {
        assert_eq!(percent(50, 100), 50);
        assert_eq!(percent(0, 0), 100);
        assert_eq!(transcribe_percent(0.0, 600.0), 10);
        assert_eq!(transcribe_percent(600.0, 600.0), 99);
        assert_eq!(transcribe_percent(10.0, 0.0), 10);
    }

    #[test]
    fn catalog_is_consistent() {
        assert!(find_model(DEFAULT_MODEL_ID).is_ok());
        for file in MODELS.iter().map(|m| &m.file).chain([&CUDA_SERVER, &CPU_SERVER, &VAD_MODEL]) {
            assert_eq!(file.sha256.len(), 64, "{}", file.label);
            assert!(file.url.starts_with("https://"), "{}", file.label);
        }
        for model in MODELS {
            assert!(model.memory_bytes > model.file.size, "{} : poids + caches", model.id);
        }
        for id in GPU_PREFERENCE {
            assert!(find_model(id).is_ok(), "{id}");
        }
        // Les deux builds ne partagent ni dossier ni marqueur.
        let (FileKind::ServerZip { dir: a, marker: m }, FileKind::ServerZip { dir: b, marker: n }) =
            (CUDA_SERVER.kind, CPU_SERVER.kind)
        else {
            panic!("les builds du serveur doivent être des archives ServerZip")
        };
        assert_ne!(a, b);
        assert_ne!(m, n);
    }

    // ------------------------------------------------------------------ matériel

    const GB: u64 = 1_000_000_000;

    #[test]
    fn recommends_the_best_model_that_fits_on_the_card() {
        // RTX 3050 Ti Laptop : 4 Go.
        assert_eq!(recommended_model(&profile(4 * GB, 32 * GB, 8)), "large-v3-turbo");
        // Petite carte : turbo q8_0 (1,12 Go) ne tient plus, turbo q5_0 (0,82 Go) si.
        assert_eq!(recommended_model(&profile(1_600_000_000, 16 * GB, 8)), "large-v3-turbo-q5");
    }

    #[test]
    fn without_a_usable_card_the_recommendation_follows_the_cpu() {
        assert_eq!(recommended_model(&profile(0, 32 * GB, 8)), "large-v3-turbo-q5");
        assert_eq!(recommended_model(&profile(0, 8 * GB, 4)), "small");
        let mut old_cpu = profile(0, 16 * GB, 8);
        old_cpu.avx2 = false;
        assert_eq!(recommended_model(&old_cpu), "small");
    }

    #[test]
    fn cpu_runs_force_no_gpu_and_use_every_physical_core() {
        let hw = profile(4 * GB, 32 * GB, 8);
        assert_eq!(compute_args(Device::Gpu, &hw), ["-t", "4"]);
        assert_eq!(compute_args(Device::Cpu, &hw), ["-t", "8", "-ng"]);
    }

    #[test]
    fn the_log_tells_which_device_whisper_really_uses() {
        let cuda = "load_backend: loaded CUDA backend from bin\\ggml-cuda.dll\n\
                    whisper_backend_init_gpu: found GPU device 0: CUDA0 (type: 1, cnt: 0)\n\
                    whisper_backend_init_gpu: using CUDA0 backend\n\
                    whisper_backend_init_gpu: no GPU found\n"; // le VAD tourne toujours sur processeur
        assert_eq!(observed_device(cuda), Device::Gpu);

        // Build CUDA 11.8 sans cuBLAS : ggml-cuda.dll ne se charge pas, retour silencieux au processeur.
        let fallback = "load_backend: loaded CPU backend from bin\\ggml-cpu-cascadelake.dll\n\
                        whisper_backend_init_gpu: device 0: CPU (type: 0)\n\
                        whisper_backend_init_gpu: no GPU found\n";
        assert_eq!(observed_device(fallback), Device::Cpu);
        assert_eq!(observed_device(""), Device::Cpu);
    }

    #[test]
    fn required_files_use_the_build_of_the_planned_device() {
        let dir = TempDir::new();
        let model = find_model(DEFAULT_MODEL_ID).unwrap();

        let with_card = service_with(dir.0.clone(), profile(4 * GB, 32 * GB, 8));
        assert_eq!(with_card.required_files(model)[0].file_name, CUDA_SERVER.file_name);

        let without_card = service_with(dir.0.clone(), profile(0, 32 * GB, 8));
        assert_eq!(without_card.required_files(model)[0].file_name, CPU_SERVER.file_name);
    }

    // ------------------------------------------------------------------ outils

    /// Dossier temporaire unique, supprimé à la fin du test.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("meetscribe-test-whisper-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Service dont les fichiers vivent dans un dossier de test (sans toucher à `%LOCALAPPDATA%`),
    /// sur un PC à carte NVIDIA de 4 Go, 32 Go de mémoire vive et 8 cœurs.
    fn service_in(root: PathBuf) -> LocalWhisperService {
        service_with(root, profile(4 * GB, 32 * GB, 8))
    }

    fn service_with(root: PathBuf, hardware: HardwareProfile) -> LocalWhisperService {
        LocalWhisperService {
            inner: Arc::new(Inner {
                root,
                download_client: Client::new(),
                inference_client: Client::new(),
                hardware: OnceLock::from(hardware),
                server: Mutex::new(None),
                busy: Mutex::new(()),
                installing: Mutex::new(()),
                idle_generation: AtomicU64::new(0),
            }),
        }
    }

    fn segment(text: &str, start: f64, end: f64) -> TranscriptionSegment {
        TranscriptionSegment {
            text: text.to_string(),
            speaker: 0,
            start_time: start,
            end_time: end,
            confidence: 1.0,
            language: "fr-FR".to_string(),
        }
    }

    fn zip_with(path: &Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    fn tar_bz2_with(path: &Path, entries: &[(&str, &[u8])]) {
        let encoder = bzip2::write::BzEncoder::new(std::fs::File::create(path).unwrap(), bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, content) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *content).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
    }

    // ------------------------------------------------------------------ séparation des intervenants

    #[test]
    fn extract_diarization_keeps_only_the_tool_its_dlls_and_the_c_api() {
        let dir = TempDir::new();
        let archive = dir.0.join("sherpa.tar.bz2");
        let target = dir.0.join("diarization");
        tar_bz2_with(
            &archive,
            &[
                ("sherpa/bin/sherpa-onnx-offline-speaker-diarization.exe", b"exe"),
                ("sherpa/bin/onnxruntime.dll", b"ort"),
                ("sherpa/bin/sherpa-onnx-offline.exe", b"autre outil"),
                ("sherpa/lib/sherpa-onnx-c-api.dll", b"capi"),
                ("sherpa/lib/sherpa-onnx-cxx-api.dll", b"cxx"),
                ("sherpa/lib/sherpa-onnx-c-api.lib", b"import"),
                ("sherpa/README.md", b"doc"),
            ],
        );

        extract_diarization(&archive, &target).unwrap();
        assert_eq!(std::fs::read(target.join(DIARIZATION_EXE)).unwrap(), b"exe");
        assert_eq!(std::fs::read(target.join("onnxruntime.dll")).unwrap(), b"ort");
        assert_eq!(std::fs::read(target.join(EMBEDDING_LIB)).unwrap(), b"capi");
        assert!(target.join(DIARIZATION_MARKER).is_file());
        for ignored in ["sherpa-onnx-offline.exe", "sherpa-onnx-cxx-api.dll", "sherpa-onnx-c-api.lib", "README.md"] {
            assert!(!target.join(ignored).exists(), "{ignored} ne doit pas être extrait");
        }
    }

    #[test]
    fn extract_diarization_fails_without_the_tool_or_the_c_api() {
        let dir = TempDir::new();
        let archive = dir.0.join("sherpa.tar.bz2");
        let target = dir.0.join("diarization");
        tar_bz2_with(&archive, &[("sherpa/bin/onnxruntime.dll", b"ort")]);

        let error = extract_diarization(&archive, &target).unwrap_err();
        assert!(error.to_string().contains("absent de l'archive"));
        assert!(!target.join(DIARIZATION_MARKER).exists());
        assert!(extract_diarization(&dir.0.join("absent.tar.bz2"), &target).is_err());

        // Archive d'une version sans l'API C : l'outil seul ne suffit plus.
        tar_bz2_with(&archive, &[("sherpa/bin/sherpa-onnx-offline-speaker-diarization.exe", b"exe")]);
        let error = extract_diarization(&archive, &target).unwrap_err();
        assert!(error.to_string().contains(EMBEDDING_LIB), "{error}");
        assert!(!target.join(DIARIZATION_MARKER).exists());
    }

    #[tokio::test]
    async fn diarization_tools_are_available_once_every_file_is_present() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        assert!(service.diarization_tools().is_none());
        let status = service.status().await.diarization;
        assert!(!status.installed);
        assert_eq!(status.missing_bytes, status.size_bytes);
        assert_eq!(
            service.files_for(DIARIZATION_ID).unwrap().len(),
            3,
            "programme + deux modèles"
        );

        std::fs::create_dir_all(service.diarization_dir()).unwrap();
        std::fs::create_dir_all(service.models_dir()).unwrap();
        std::fs::write(service.diarization_dir().join(DIARIZATION_EXE), b"exe").unwrap();
        std::fs::write(service.diarization_dir().join(DIARIZATION_MARKER), b"ok").unwrap();
        for model in [&SEGMENTATION_MODEL, &EMBEDDING_MODEL] {
            std::fs::File::create(service.target_path(model)).unwrap().set_len(model.size).unwrap();
        }
        assert!(service.diarization_tools().is_none(), "installation d'avant l'API C : à refaire");
        std::fs::write(service.diarization_dir().join(EMBEDDING_LIB), b"capi").unwrap();

        let tools = service.diarization_tools().expect("composant installé");
        assert!(tools.exe.ends_with(DIARIZATION_EXE));
        assert!(tools.embedding_lib.ends_with(EMBEDDING_LIB));
        assert!(service.status().await.diarization.installed);

        service.delete_model(DIARIZATION_ID).await.unwrap();
        assert!(service.diarization_tools().is_none());
        assert!(!service.diarization_dir().exists());
        assert!(!service.target_path(&EMBEDDING_MODEL).exists());
    }

    #[tokio::test]
    async fn a_previous_diarization_install_is_outdated_and_only_that_one_is_updated() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        let no_progress = |_: InstallProgressEvent| panic!("aucun téléchargement attendu");

        // Jamais installé (ou supprimé) : pas de mise à jour, pas de téléchargement.
        assert!(!service.status().await.diarization.outdated);
        let tools = service.diarization_tools_updating(Arc::new(AtomicBool::new(false)), no_progress).await;
        assert!(tools.unwrap().is_none());

        // Installation de la 0.4.0 : programme, ancien marqueur, modèles ; pas d'API C.
        std::fs::create_dir_all(service.diarization_dir()).unwrap();
        std::fs::create_dir_all(service.models_dir()).unwrap();
        std::fs::write(service.diarization_dir().join(DIARIZATION_EXE), b"exe").unwrap();
        std::fs::write(service.diarization_dir().join(".installed-sherpa-onnx-v2.0.1-md"), b"ok").unwrap();
        for model in [&SEGMENTATION_MODEL, &EMBEDDING_MODEL] {
            std::fs::File::create(service.target_path(model)).unwrap().set_len(model.size).unwrap();
        }
        let status = service.status().await.diarization;
        assert!(!status.installed);
        assert!(status.outdated, "ancienne version à mettre à jour");
        assert_eq!(status.missing_bytes, DIARIZATION_RELEASE.size, "seule l'archive est à retélécharger");

        // À jour : rien à télécharger, l'outil est rendu tel quel.
        std::fs::write(service.diarization_dir().join(EMBEDDING_LIB), b"capi").unwrap();
        std::fs::write(service.diarization_dir().join(DIARIZATION_MARKER), b"ok").unwrap();
        assert!(!service.status().await.diarization.outdated);
        let tools = service.diarization_tools_updating(Arc::new(AtomicBool::new(false)), no_progress).await;
        assert!(tools.unwrap().is_some());
    }

    // ------------------------------------------------------------------ modèles

    #[test]
    fn unknown_model_is_a_validation_error() {
        let Err(error) = find_model("modele-inexistant") else { panic!("modèle inconnu accepté") };
        assert!(matches!(error, AppError::Validation(_)));
        assert!(error.to_string().contains("modele-inexistant"));
    }

    #[test]
    fn model_ids_are_unique() {
        for (i, model) in MODELS.iter().enumerate() {
            assert!(MODELS[i + 1..].iter().all(|other| other.id != model.id), "{}", model.id);
        }
    }

    #[test]
    fn cancel_and_stop_errors_use_the_shared_messages() {
        assert!(cancelled().to_string().contains(CANCELLED_MESSAGE));
        assert!(stopped().to_string().contains(STOPPED_MESSAGE));
    }

    // ------------------------------------------------------------------ horodatages

    #[test]
    fn with_offset_shifts_every_segment() {
        let shifted: Vec<_> = with_offset(vec![segment("a", 0.0, 1.5), segment("b", 2.0, 3.0)], 300.0).collect();
        assert_eq!((shifted[0].start_time, shifted[0].end_time), (300.0, 301.5));
        assert_eq!((shifted[1].start_time, shifted[1].end_time), (302.0, 303.0));
        assert_eq!(shifted[1].text, "b");
    }

    #[test]
    fn percent_handles_overflow_and_overshoot() {
        assert_eq!(percent(150, 100), 100);
        assert_eq!(percent(1, 3), 33);
        // Tailles de modèles réalistes (plusieurs Go) : pas de dépassement d'entier.
        assert_eq!(percent(5_000_000_000, 10_000_000_000), 50);
    }

    #[test]
    fn transcribe_percent_is_clamped_between_10_and_99() {
        assert_eq!(transcribe_percent(-5.0, 600.0), 10);
        assert_eq!(transcribe_percent(1200.0, 600.0), 99);
        assert_eq!(transcribe_percent(300.0, 600.0), 54);
    }

    #[test]
    fn an_empty_lexicon_prompt_is_not_sent() {
        assert_eq!(initial_prompt(None), None);
        assert_eq!(initial_prompt(Some("  \n ".to_string())), None);
        assert_eq!(initial_prompt(Some(" Zentra, ACME. ".to_string())), Some("Zentra, ACME.".to_string()));
    }

    #[test]
    fn whisper_language_keeps_only_the_language_code() {
        assert_eq!(whisper_language("  pt-BR "), "pt");
        assert_eq!(whisper_language("-FR"), "auto");
    }

    // ------------------------------------------------------------------ utilitaires

    #[test]
    fn free_port_is_bindable() {
        let port = free_port().unwrap();
        assert!(port > 0);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn log_tail_keeps_the_last_five_lines_in_order() {
        let dir = TempDir::new();
        let log = dir.0.join("server.log");
        let lines: Vec<String> = (1..=8).map(|i| format!("ligne{i}")).collect();
        std::fs::write(&log, lines.join("\n")).unwrap();

        let tail = log_tail(&log);
        assert!(tail.ends_with("ligne4 | ligne5 | ligne6 | ligne7 | ligne8"), "{tail}");
        assert!(!tail.contains("ligne3"));
        // Journal absent : message vide, sans panique.
        assert!(log_tail(&dir.0.join("absent.log")).starts_with("Fin du journal"));
    }

    // ------------------------------------------------------------------ extraction du serveur

    #[test]
    fn extract_server_flattens_binaries_and_writes_marker() {
        let dir = TempDir::new();
        let archive = dir.0.join("whisper.zip");
        let bin = dir.0.join("bin");
        zip_with(
            &archive,
            &[
                ("Release/whisper-server.exe", b"exe"),
                ("Release/ggml.DLL", b"dll"),
                ("Release/readme.txt", b"ignore"),
                ("../evil.dll", b"hors dossier"),
            ],
        );

        extract_server(&archive, &bin, TEST_MARKER).unwrap();
        assert_eq!(std::fs::read(bin.join(SERVER_EXE)).unwrap(), b"exe");
        assert_eq!(std::fs::read(bin.join("ggml.DLL")).unwrap(), b"dll");
        assert!(bin.join(TEST_MARKER).is_file());
        assert!(!bin.join("readme.txt").exists());
        assert!(!dir.0.join("evil.dll").exists(), "une entrée « ../ » ne doit pas sortir du dossier");
    }

    #[test]
    fn extract_server_removes_the_previous_version() {
        let dir = TempDir::new();
        let archive = dir.0.join("whisper.zip");
        let bin = dir.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for old in ["cudart64_110.dll", ".installed-v1.9.2-cublas-11.8"] {
            std::fs::write(bin.join(old), b"ancien").unwrap();
        }
        zip_with(&archive, &[("Release/whisper-server.exe", b"exe"), ("Release/cublas64_12.dll", b"dll")]);

        extract_server(&archive, &bin, TEST_MARKER).unwrap();
        assert!(bin.join("cublas64_12.dll").is_file());
        assert!(!bin.join("cudart64_110.dll").exists(), "DLL de l'ancienne version supprimée");
        assert!(!bin.join(".installed-v1.9.2-cublas-11.8").exists());
    }

    #[test]
    fn extract_server_fails_without_the_server_exe() {
        let dir = TempDir::new();
        let archive = dir.0.join("whisper.zip");
        let bin = dir.0.join("bin");
        zip_with(&archive, &[("ggml.dll", b"dll")]);

        let error = extract_server(&archive, &bin, TEST_MARKER).unwrap_err();
        assert!(error.to_string().contains("absent de l'archive"));
        assert!(!bin.join(TEST_MARKER).exists(), "pas de marqueur pour une installation incomplète");
    }

    #[test]
    fn extract_server_rejects_a_file_that_is_not_a_zip() {
        let dir = TempDir::new();
        let archive = dir.0.join("faux.zip");
        let bin = dir.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ggml.dll"), b"existant").unwrap();
        std::fs::write(&archive, b"ce n'est pas une archive").unwrap();
        assert!(extract_server(&archive, &bin, TEST_MARKER).is_err());
        assert!(bin.join("ggml.dll").is_file(), "une archive illisible ne doit pas vider le dossier");
    }

    // ------------------------------------------------------------------ état d'installation

    #[test]
    fn nothing_is_installed_in_an_empty_root() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        assert!(!service.is_model_installed(DEFAULT_MODEL_ID));
        assert!(!service.is_model_installed("modele-inexistant"));
    }

    #[test]
    fn server_is_present_only_with_exe_and_marker() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        let FileKind::ServerZip { dir: bin, marker } = CUDA_SERVER.kind else { unreachable!() };
        let bin = service.server_dir(bin);
        std::fs::create_dir_all(&bin).unwrap();

        std::fs::write(bin.join(SERVER_EXE), b"exe").unwrap();
        assert!(!service.is_present(&CUDA_SERVER));
        // Marqueur d'une ancienne version : il faut retélécharger.
        std::fs::write(bin.join(".installed-v1.9.2-cublas-11.8"), b"ok").unwrap();
        assert!(!service.is_present(&CUDA_SERVER));
        std::fs::write(bin.join(marker), b"ok").unwrap();
        assert!(service.is_present(&CUDA_SERVER));
        assert!(!service.is_present(&CPU_SERVER), "chaque build a son dossier");
    }

    #[test]
    fn model_file_is_present_only_with_the_exact_size() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        std::fs::create_dir_all(service.models_dir()).unwrap();

        // Téléchargement incomplet : la taille ne correspond pas.
        std::fs::write(service.target_path(&VAD_MODEL), b"partiel").unwrap();
        assert!(!service.is_present(&VAD_MODEL));
    }

    #[tokio::test]
    async fn status_lists_every_model_with_its_missing_bytes() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        let status = service.status().await;

        assert!(status.loaded_model.is_none());
        assert!(status.loaded_device.is_none());
        assert_eq!(status.models.len(), MODELS.len());
        for (listed, model) in status.models.iter().zip(MODELS) {
            assert_eq!(listed.id, model.id);
            assert!(!listed.installed);
            // Tout manque : programme CUDA (tout tient dans 4 Go) + VAD + modèle.
            assert_eq!(listed.device, Device::Gpu, "{}", model.id);
            assert_eq!(listed.missing_bytes, CUDA_SERVER.size + VAD_MODEL.size + model.file.size);
        }
        let recommended: Vec<_> = status.models.iter().filter(|m| m.recommended).map(|m| m.id.as_str()).collect();
        assert_eq!(recommended, ["large-v3-turbo"]);

        let json = serde_json::to_value(&status).unwrap();
        assert!(json["models"][0]["missingBytes"].is_number());
        assert_eq!(json["models"][0]["device"], "gpu");
        assert_eq!(json["models"][0]["fit"], "ok");
        assert!(json["loadedDevice"].is_null());
        assert!(json["hardware"]["gpus"].is_array());
    }

    #[tokio::test]
    async fn without_nvidia_every_model_needs_the_cpu_build() {
        let dir = TempDir::new();
        let service = service_with(dir.0.clone(), profile(0, 16 * GB, 8));
        let status = service.status().await;
        for listed in &status.models {
            assert_eq!(listed.device, Device::Cpu, "{}", listed.id);
            let model = find_model(&listed.id).unwrap();
            assert_eq!(listed.missing_bytes, CPU_SERVER.size + VAD_MODEL.size + model.file.size);
        }
    }

    #[test]
    fn expected_load_time_prefers_the_last_measure() {
        let dir = TempDir::new();
        let service = service_in(dir.0.clone());
        let model = find_model(DEFAULT_MODEL_ID).unwrap();
        std::fs::create_dir_all(service.models_dir()).unwrap();

        // Sans mesure : estimation d'après la taille du modèle.
        let estimate = service.expected_load_seconds(model);
        assert!((estimate - (LOAD_ESTIMATE_BASE_SECS + model.file.size as f64 / LOAD_ESTIMATE_BYTES_PER_SEC)).abs() < 1e-9);

        std::fs::write(service.load_time_path(model.id), "12.5\n").unwrap();
        assert_eq!(service.expected_load_seconds(model), 12.5);

        // Valeurs inutilisables : retour à l'estimation.
        for bad in ["0", "-3", "NaN", "inf", "abc"] {
            std::fs::write(service.load_time_path(model.id), bad).unwrap();
            assert_eq!(service.expected_load_seconds(model), estimate, "valeur {bad}");
        }
    }
}
