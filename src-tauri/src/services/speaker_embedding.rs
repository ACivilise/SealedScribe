//! Empreinte vocale d'un passage, par l'API C de sherpa-onnx (`sherpa-onnx-c-api.dll`,
//! installée avec l'outil de séparation) et le modèle WeSpeaker déjà téléchargé.
//!
//! Le calcul tourne dans un processus enfant : SealedScribe relancé avec `WORKER_ARG`, qui lit
//! une `WorkerRequest` (JSON) sur son entrée, écrit sa progression sur stderr et les empreintes
//! (JSON) sur sa sortie. Un plantage de la DLL n'emporte ainsi ni l'application ni la
//! transcription en cours.
//!
//! Windows fournit son propre `onnxruntime.dll` (System32, version 1.17) : chargée sans
//! précaution, la DLL de sherpa-onnx s'y lie, ne trouve pas la version d'API attendue et plante.
//! On charge donc d'abord l'ONNX Runtime posé à côté d'elle, par son chemin complet.

use crate::error::{AppError, AppResult};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void, CString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Argument qui fait de SealedScribe le calculateur d'empreintes.
pub const WORKER_ARG: &str = "--speaker-embeddings";

/// Ce que le processus enfant doit calculer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerRequest {
    /// `sherpa-onnx-c-api.dll`
    pub library: PathBuf,
    /// Modèle WeSpeaker (.onnx)
    pub model: PathBuf,
    /// Son du PC, WAV mono 16 kHz 16 bits
    pub wav: PathBuf,
    pub threads: i32,
    /// (indice du tour, début, fin en secondes)
    pub turns: Vec<(usize, f64, f64)>,
}

/// À appeler au tout début de `main` : si SealedScribe a été lancé en calculateur
/// d'empreintes, fait le calcul et renvoie le code de sortie.
pub fn run_worker_if_requested() -> Option<i32> {
    if std::env::args().nth(1).as_deref() != Some(WORKER_ARG) {
        return None;
    }
    Some(match worker() {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    })
}

fn worker() -> AppResult<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: WorkerRequest = serde_json::from_str(&input)?;
    let embedded = embed_turns(&request, |done, total| {
        eprintln!("progress {:.2}%", 100.0 * done as f64 / total.max(1) as f64);
    })?;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &embedded)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

/// Empreinte de chaque tour de `request`, lu dans le WAV. Les tours trop courts pour le
/// modèle n'en ont pas.
pub fn embed_turns(
    request: &WorkerRequest,
    mut on_progress: impl FnMut(usize, usize),
) -> AppResult<Vec<(usize, Vec<f32>)>> {
    let extractor = EmbeddingExtractor::load(&request.library, &request.model, request.threads)?;
    let read_error = |e: hound::Error| embedding_error(format!("Lecture du son du PC impossible : {e}"));
    let mut reader = hound::WavReader::open(&request.wav).map_err(read_error)?;
    let rate = reader.spec().sample_rate as f64;
    let length = reader.duration();

    let mut embedded = Vec::with_capacity(request.turns.len());
    for (done, &(index, start, end)) in request.turns.iter().enumerate() {
        let first = ((start.max(0.0) * rate) as u32).min(length);
        let last = ((end.max(0.0) * rate) as u32).clamp(first, length);
        reader.seek(first)?;
        let samples = reader
            .samples::<i16>()
            .take((last - first) as usize)
            .map(|s| s.map(|v| v as f32 / 32768.0))
            .collect::<Result<Vec<f32>, _>>()
            .map_err(read_error)?;
        if let Some(embedding) = extractor.compute(&samples) {
            embedded.push((index, embedding));
        }
        on_progress(done + 1, request.turns.len());
    }
    Ok(embedded)
}

/// `SherpaOnnxSpeakerEmbeddingExtractorConfig` (c-api.h).
#[repr(C)]
struct ExtractorConfig {
    model: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

type Create = unsafe extern "C" fn(*const ExtractorConfig) -> *const c_void;
type Destroy = unsafe extern "C" fn(*const c_void);
type Dim = unsafe extern "C" fn(*const c_void) -> i32;
type CreateStream = unsafe extern "C" fn(*const c_void) -> *const c_void;
type AcceptWaveform = unsafe extern "C" fn(*const c_void, i32, *const f32, i32);
type InputFinished = unsafe extern "C" fn(*const c_void);
type IsReady = unsafe extern "C" fn(*const c_void, *const c_void) -> i32;
type Compute = unsafe extern "C" fn(*const c_void, *const c_void) -> *const f32;
type DestroyEmbedding = unsafe extern "C" fn(*const f32);

/// Fonctions de la DLL ; valides tant que `_library` est chargée.
struct Api {
    destroy: Destroy,
    create_stream: CreateStream,
    accept_waveform: AcceptWaveform,
    input_finished: InputFinished,
    destroy_stream: Destroy,
    is_ready: IsReady,
    compute: Compute,
    destroy_embedding: DestroyEmbedding,
}

pub struct EmbeddingExtractor {
    api: Api,
    extractor: *const c_void,
    dim: usize,
    // Déchargées en dernier, dans cet ordre (les champs sont libérés après `Drop::drop`).
    _library: Library,
    _runtime: Option<Library>,
}

impl EmbeddingExtractor {
    pub fn load(library_path: &Path, model_path: &Path, num_threads: i32) -> AppResult<Self> {
        let library_path = absolute_windows_path(library_path)?;
        let runtime_path = library_path.with_file_name("onnxruntime.dll");
        let runtime = if runtime_path.is_file() { Some(open(&runtime_path)?) } else { None };
        let library = open(&library_path)?;
        // SAFETY: les signatures reprennent celles de c-api.h (sherpa-onnx v2.0.1).
        unsafe {
            let create: Create = symbol(&library, b"SherpaOnnxCreateSpeakerEmbeddingExtractor\0")?;
            let dim: Dim = symbol(&library, b"SherpaOnnxSpeakerEmbeddingExtractorDim\0")?;
            let api = Api {
                destroy: symbol(&library, b"SherpaOnnxDestroySpeakerEmbeddingExtractor\0")?,
                create_stream: symbol(&library, b"SherpaOnnxSpeakerEmbeddingExtractorCreateStream\0")?,
                accept_waveform: symbol(&library, b"SherpaOnnxOnlineStreamAcceptWaveform\0")?,
                input_finished: symbol(&library, b"SherpaOnnxOnlineStreamInputFinished\0")?,
                destroy_stream: symbol(&library, b"SherpaOnnxDestroyOnlineStream\0")?,
                is_ready: symbol(&library, b"SherpaOnnxSpeakerEmbeddingExtractorIsReady\0")?,
                compute: symbol(&library, b"SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding\0")?,
                destroy_embedding: symbol(&library, b"SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding\0")?,
            };

            let model = CString::new(model_path.to_string_lossy().into_owned())
                .map_err(|_| embedding_error("Chemin du modèle d'empreinte invalide"))?;
            let provider = CString::new("cpu").unwrap_or_default();
            let config = ExtractorConfig {
                model: model.as_ptr(),
                num_threads: num_threads.max(1),
                debug: 0,
                provider: provider.as_ptr(),
            };
            let extractor = create(&config);
            if extractor.is_null() {
                return Err(embedding_error(format!(
                    "Modèle d'empreinte vocale illisible : {}",
                    model_path.display()
                )));
            }
            let dim = usize::try_from(dim(extractor)).unwrap_or(0);
            Ok(Self { api, extractor, dim, _library: library, _runtime: runtime })
        }
    }

    /// Empreinte de `samples` (mono 16 kHz, entre -1 et 1) ; `None` si le passage est trop
    /// court pour le modèle.
    pub fn compute(&self, samples: &[f32]) -> Option<Vec<f32>> {
        let len = i32::try_from(samples.len()).ok()?;
        // SAFETY: le flux est créé, alimenté puis détruit ici ; l'empreinte renvoyée compte
        // `dim` valeurs et est libérée après copie.
        unsafe {
            let stream = (self.api.create_stream)(self.extractor);
            if stream.is_null() {
                return None;
            }
            (self.api.accept_waveform)(stream, crate::services::audio_prep::TARGET_RATE as i32, samples.as_ptr(), len);
            (self.api.input_finished)(stream);
            let mut embedding = None;
            if (self.api.is_ready)(self.extractor, stream) != 0 {
                let values = (self.api.compute)(self.extractor, stream);
                if !values.is_null() {
                    embedding = Some(std::slice::from_raw_parts(values, self.dim).to_vec());
                    (self.api.destroy_embedding)(values);
                }
            }
            (self.api.destroy_stream)(stream);
            embedding
        }
    }
}

impl Drop for EmbeddingExtractor {
    fn drop(&mut self) {
        // SAFETY: `extractor` vient de `create` et n'est détruit qu'ici.
        unsafe { (self.api.destroy)(self.extractor) }
    }
}

/// Chemin absolu avec des `\` : le chargeur de Windows ignore le dossier de la DLL pour ses
/// dépendances si le chemin contient des `/`.
fn absolute_windows_path(path: &Path) -> AppResult<PathBuf> {
    let absolute = std::path::absolute(path)?;
    Ok(if cfg!(windows) { PathBuf::from(absolute.to_string_lossy().replace('/', "\\")) } else { absolute })
}

/// Charge une DLL en cherchant ses dépendances dans son propre dossier, puis dans ceux du système.
fn open(path: &Path) -> AppResult<Library> {
    #[cfg(windows)]
    let library = unsafe {
        use libloading::os::windows::{
            Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        };
        WindowsLibrary::load_with_flags(path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
            .map(Library::from)
    };
    #[cfg(not(windows))]
    let library = unsafe { Library::new(path) };
    library.map_err(|e| embedding_error(format!("Chargement de {} impossible : {e}", path.display())))
}

unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> AppResult<T> {
    library.get::<T>(name).map(|s| *s).map_err(|e| {
        let name = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]).into_owned();
        embedding_error(format!("Fonction {name} absente de sherpa-onnx : {e}"))
    })
}

fn embedding_error(message: impl Into<String>) -> AppError {
    AppError::TranscriptionError(message.into())
}
