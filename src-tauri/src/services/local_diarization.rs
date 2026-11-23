//! Étiquetage des intervenants d'un enregistrement micro / son du PC.
//!
//! 1. Canal dominant (`dual_channel`) : « moi » (micro) ou « les autres » (son du PC).
//! 2. Si l'outil est installé, séparation des voix du son du PC : sherpa-onnx découpe en
//!    tours de parole (pyannote) et les regroupe, puis on regroupe à nouveau les tours par
//!    leurs empreintes vocales (`speaker_clustering`) : chaque segment des « autres » devient
//!    « intervenant 1 », « intervenant 2 »… par ordre d'apparition.
//!
//! Pourquoi regrouper à nouveau : sherpa-onnx regroupe en liens complets (toutes les paires
//! d'un groupe doivent se ressembler). Sur une longue réunion, une même voix varie assez pour
//! finir en deux ou trois groupes, mêlés tout du long : la même personne apparaissait sous
//! plusieurs numéros (11 groupes pour 4 personnes sur une réunion d'une heure).
//!
//! sherpa-onnx tourne sur le CPU dans un processus séparé, en priorité basse et rattaché
//! au Job Object de SealedScribe, comme whisper-server. Les empreintes aussi : SealedScribe se
//! relance en processus enfant pour appeler l'API C de sherpa-onnx (`speaker_embedding`).

use crate::error::{AppError, AppResult};
use crate::services::audio_prep;
use crate::services::dual_channel::{self, REMOTE_SPEAKER_BASE, SPEAKER_OTHERS};
use crate::services::local_whisper::DiarizationTools;
use crate::services::speaker_clustering;
use crate::services::speaker_embedding::{self, WorkerRequest};
use crate::services::transcription::CANCELLED_MESSAGE;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Seuil du premier regroupement, par sherpa-onnx (distance cosinus, liens complets) : plus
/// haut, moins de groupes. Il découpe finement, le regroupement par empreintes réunit ensuite
/// les groupes d'une même voix. À ajuster avec `MEETSCRIBE_DIARIZATION_THRESHOLD`.
const DEFAULT_CLUSTER_THRESHOLD: f32 = 0.7;
/// Un segment sans tour de parole qui le recouvre prend l'intervenant du tour le plus proche,
/// s'il est à moins de cette distance.
const NEAREST_TURN_SECS: f64 = 5.0;
/// Seuls les tours d'au moins 2 s ont une empreinte (plus courts, elle est trop bruitée).
const MIN_EMBEDDING_TURN_SECS: f64 = 2.0;
/// Au plus 250 tours (les plus longs) : le regroupement calcule des valeurs propres d'une
/// matrice carrée de cette taille. Les autres suivent la voix de leur cluster sherpa-onnx.
const MAX_EMBEDDED_TURNS: usize = 250;
/// Au-delà, un tour n'apporte rien de plus à son empreinte.
const MAX_EMBEDDING_SECS: f64 = 30.0;
const EMBEDDING_THREADS: i32 = 4;
/// Part de la progression affichée pour sherpa-onnx, le reste pour les empreintes.
const SHERPA_PROGRESS_SHARE: f32 = 0.9;

/// Tour de parole renvoyé par sherpa-onnx.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub start: f64,
    pub end: f64,
    pub cluster: u32,
}

/// Intervenant de chaque intervalle (début, fin en secondes) d'un enregistrement micro /
/// son du PC ; `None` pour un autre fichier. Sans `tools`, ou si aucun segment ne vient du
/// son du PC, on s'arrête aux deux canaux. `on_progress` reçoit l'avancement de la
/// séparation des voix (0-100).
pub async fn label_speakers(
    audio_path: &Path,
    spans: &[(f64, f64)],
    tools: Option<&DiarizationTools>,
    num_speakers: Option<u32>,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f32),
) -> AppResult<Option<Vec<u32>>> {
    let path = audio_path.to_path_buf();
    let owned_spans = spans.to_vec();
    let labels = tokio::task::spawn_blocking(move || dual_channel::speakers_for_spans(&path, &owned_spans))
        .await
        .map_err(|e| diarization_error(format!("Attribution interrompue : {e}")))??;
    let Some(mut labels) = labels else {
        return Ok(None);
    };

    let Some(tools) = tools else {
        return Ok(Some(labels));
    };
    if !labels.contains(&SPEAKER_OTHERS) {
        return Ok(Some(labels));
    }

    on_progress(0.0);
    let wav = write_system_channel(audio_path).await?;
    let turns = separate(tools, &wav, num_speakers, cancel, &mut on_progress).await;
    let _ = tokio::fs::remove_file(&wav).await;
    assign_remote_speakers(spans, &mut labels, &turns?);
    Ok(Some(labels))
}

/// Tours de parole de sherpa-onnx, puis regroupés par voix d'après leurs empreintes (voir
/// `relabel_turns`). sherpa-onnx découpe au seuil, finement ; le nombre d'intervenants donné
/// s'applique au regroupement. Si les empreintes échouent, on garde les clusters de sherpa-onnx.
async fn separate(
    tools: &DiarizationTools,
    wav: &Path,
    num_speakers: Option<u32>,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(f32),
) -> AppResult<Vec<Turn>> {
    let turns = run(tools, wav, cancel, &mut |p| on_progress(p * SHERPA_PROGRESS_SHARE)).await?;
    let selected = turns_to_embed(&turns);
    if selected.len() < 2 {
        return Ok(turns);
    }

    let request = WorkerRequest {
        library: tools.embedding_lib.clone(),
        model: tools.embedding_model.clone(),
        wav: wav.to_path_buf(),
        threads: EMBEDDING_THREADS,
        turns: selected,
    };
    let share = 100.0 * SHERPA_PROGRESS_SHARE;
    let embedded = embed_in_worker(&request, cancel, &mut |p| on_progress(share + p * (1.0 - SHERPA_PROGRESS_SHARE))).await;
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::TranscriptionError(CANCELLED_MESSAGE.to_string()));
    }
    match embedded {
        Ok(embedded) => Ok(relabel_turns(&turns, &embedded, num_speakers)),
        Err(e) => {
            log::warn!("Regroupement des voix impossible, on garde les clusters de sherpa-onnx : {e}");
            Ok(turns)
        }
    }
}

/// Tours assez longs pour une empreinte fiable, les plus longs d'abord, puis dans l'ordre :
/// (indice, début, fin), la fin bornée à `MAX_EMBEDDING_SECS` après le début.
fn turns_to_embed(turns: &[Turn]) -> Vec<(usize, f64, f64)> {
    let mut long: Vec<usize> = (0..turns.len())
        .filter(|&i| turns[i].end - turns[i].start >= MIN_EMBEDDING_TURN_SECS)
        .collect();
    long.sort_by(|&a, &b| (turns[b].end - turns[b].start).total_cmp(&(turns[a].end - turns[a].start)));
    long.truncate(MAX_EMBEDDED_TURNS);
    long.sort_unstable();
    long.into_iter()
        .map(|i| (i, turns[i].start, turns[i].end.min(turns[i].start + MAX_EMBEDDING_SECS)))
        .collect()
}

/// Écrit le canal du son du PC (mono 16 kHz) dans un fichier temporaire.
async fn write_system_channel(audio_path: &Path) -> AppResult<PathBuf> {
    let source = audio_path.to_path_buf();
    let wav = tokio::task::spawn_blocking(move || -> AppResult<Vec<u8>> {
        let samples = dual_channel::system_channel_16k(&source)?
            .ok_or_else(|| diarization_error("Enregistrement sans canal séparé pour le son du PC"))?;
        audio_prep::encode_wav_16k(&samples)
    })
    .await
    .map_err(|e| diarization_error(format!("Extraction du son du PC interrompue : {e}")))??;

    let path = std::env::temp_dir().join(format!("meetscribe-diarization-{}.wav", uuid::Uuid::new_v4()));
    tokio::fs::write(&path, wav).await?;
    Ok(path)
}

/// Lance sherpa-onnx sur `wav` et lit ses tours de parole.
async fn run(
    tools: &DiarizationTools,
    wav: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(f32),
) -> AppResult<Vec<Turn>> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let clustering = format!("--clustering.cluster-threshold={}", cluster_threshold());

    let mut command = Command::new(&tools.exe);
    if let Some(dir) = tools.exe.parent() {
        command.current_dir(dir);
    }
    command
        .arg(format!("--segmentation.pyannote-model={}", tools.segmentation_model.display()))
        .arg(format!("--embedding.model={}", tools.embedding_model.display()))
        .arg(format!("--segmentation.num-threads={threads}"))
        .arg(format!("--embedding.num-threads={threads}"))
        .arg(clustering)
        .arg(wav);
    let stdout = run_tool(command, None, "sherpa-onnx", cancel, on_progress).await?;
    Ok(parse_turns(&stdout))
}

/// Empreintes des tours, calculées par SealedScribe relancé en processus enfant (voir
/// `speaker_embedding::run_worker_if_requested`) : un plantage de la DLL n'y coûte que le
/// regroupement, pas l'application ni la transcription qui vient d'être faite.
async fn embed_in_worker(
    request: &WorkerRequest,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(f32),
) -> AppResult<Vec<(usize, Vec<f32>)>> {
    let mut command = Command::new(std::env::current_exe()?);
    command.arg(speaker_embedding::WORKER_ARG);
    let input = serde_json::to_vec(request)?;
    let stdout = run_tool(command, Some(input), "le calcul des empreintes vocales", cancel, on_progress).await?;
    let last_line = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
    serde_json::from_str(last_line)
        .map_err(|e| diarization_error(format!("Réponse du calcul des empreintes illisible : {e}")))
}

/// Lance un outil en arrière-plan (priorité basse, sans fenêtre, rattaché au Job Object de
/// SealedScribe), lui passe `input` sur l'entrée standard, suit sa progression
/// (« progress 42.50% » sur stderr) et l'annulation. Renvoie sa sortie standard.
async fn run_tool(
    mut command: Command,
    input: Option<Vec<u8>>,
    name: &str,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(f32),
) -> AppResult<String> {
    command
        .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }

    let mut child = command
        .spawn()
        .map_err(|e| diarization_error(format!("Lancement de {name} impossible : {e}")))?;

    #[cfg(windows)]
    if let Some(handle) = child.raw_handle() {
        crate::services::local_whisper::job::assign(handle);
    }

    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(&input).await?;
        drop(stdin);
    }
    let mut stdout = child.stdout.take().ok_or_else(|| diarization_error(format!("Sortie de {name} indisponible")))?;
    let stderr = child.stderr.take().ok_or_else(|| diarization_error(format!("Sortie de {name} indisponible")))?;
    let stdout_task = tokio::spawn(async move {
        let mut text = String::new();
        stdout.read_to_string(&mut text).await.map(|_| text)
    });

    // Progression sur stderr ; on garde la fin du journal pour un message d'erreur.
    let mut lines = BufReader::new(stderr).lines();
    let mut tail: VecDeque<String> = VecDeque::new();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Some(percent) = parse_progress(&line) {
                        on_progress(percent);
                    } else if !line.trim().is_empty() {
                        tail.push_back(line);
                        if tail.len() > 8 {
                            tail.pop_front();
                        }
                    }
                }
                _ => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill().await;
                    return Err(AppError::TranscriptionError(CANCELLED_MESSAGE.to_string()));
                }
            }
        }
    }

    let status = child.wait().await?;
    let stdout = stdout_task
        .await
        .map_err(|e| diarization_error(format!("Lecture de {name} interrompue : {e}")))??;
    if !status.success() {
        let detail = tail.into_iter().collect::<Vec<_>>().join(" | ");
        return Err(diarization_error(format!("{name} a échoué ({status}) : {detail}")));
    }
    Ok(stdout)
}

fn cluster_threshold() -> f32 {
    std::env::var("MEETSCRIBE_DIARIZATION_THRESHOLD")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| (0.0..=2.0).contains(v))
        .unwrap_or(DEFAULT_CLUSTER_THRESHOLD)
}

fn diarization_error(message: impl Into<String>) -> AppError {
    AppError::TranscriptionError(message.into())
}

/// « progress 42.50% » → 42.5
fn parse_progress(line: &str) -> Option<f32> {
    let value = line.trim().strip_prefix("progress")?.trim().strip_suffix('%')?;
    value.trim().parse::<f32>().ok().map(|p| p.clamp(0.0, 100.0))
}

/// Lignes « 0.318 -- 6.865 speaker_00 » (le reste de la sortie est ignoré).
fn parse_turns(stdout: &str) -> Vec<Turn> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let start = parts.next()?.parse::<f64>().ok()?;
            if parts.next()? != "--" {
                return None;
            }
            let end = parts.next()?.parse::<f64>().ok()?;
            let cluster = parts.next()?.strip_prefix("speaker_")?.parse::<u32>().ok()?;
            (end >= start).then_some(Turn { start, end, cluster })
        })
        .collect()
}

/// Chaque segment des « autres » prend l'intervenant qui le recouvre le plus (à défaut, celui
/// du tour le plus proche). Les intervenants sont numérotés par ordre d'apparition.
pub fn assign_remote_speakers(spans: &[(f64, f64)], labels: &mut [u32], turns: &[Turn]) {
    let mut order: Vec<usize> = (0..spans.len().min(labels.len())).collect();
    order.sort_by(|&a, &b| spans[a].0.total_cmp(&spans[b].0));

    let mut clusters: Vec<u32> = Vec::new();
    for i in order {
        if labels[i] != SPEAKER_OTHERS {
            continue;
        }
        let Some(cluster) = best_cluster(spans[i], turns) else {
            continue;
        };
        let rank = clusters.iter().position(|&c| c == cluster).unwrap_or_else(|| {
            clusters.push(cluster);
            clusters.len() - 1
        });
        labels[i] = REMOTE_SPEAKER_BASE + 1 + rank as u32;
    }
}

/// Regroupe les tours par voix à partir des empreintes `embedded` (indice du tour, empreinte),
/// au lieu des clusters de sherpa-onnx (voir `speaker_clustering`). Un tour sans empreinte
/// (trop court) prend la voix majoritaire de son cluster sherpa-onnx, à défaut celle du tour
/// avec empreinte le plus proche dans le temps. Moins de deux empreintes : rien ne change.
pub fn relabel_turns(turns: &[Turn], embedded: &[(usize, Vec<f32>)], num_speakers: Option<u32>) -> Vec<Turn> {
    let embedded: Vec<&(usize, Vec<f32>)> = embedded.iter().filter(|(i, _)| *i < turns.len()).collect();
    if embedded.len() < 2 {
        return turns.to_vec();
    }
    let vectors: Vec<Vec<f32>> = embedded.iter().map(|(_, v)| v.clone()).collect();
    let voices = speaker_clustering::cluster(&vectors, num_speakers.filter(|&n| n > 0).map(|n| n as usize));

    let mut voice_of: Vec<Option<u32>> = vec![None; turns.len()];
    for ((index, _), &voice) in embedded.iter().zip(&voices) {
        voice_of[*index] = Some(voice as u32);
    }

    // Temps de parole de chaque voix dans chaque cluster sherpa-onnx.
    let mut by_cluster: Vec<(u32, u32, f64)> = Vec::new();
    for (turn, voice) in turns.iter().zip(&voice_of) {
        let Some(voice) = *voice else { continue };
        match by_cluster.iter_mut().find(|(c, v, _)| *c == turn.cluster && *v == voice) {
            Some((_, _, total)) => *total += turn.end - turn.start,
            None => by_cluster.push((turn.cluster, voice, turn.end - turn.start)),
        }
    }
    let majority = |cluster: u32| {
        by_cluster
            .iter()
            .filter(|(c, _, _)| *c == cluster)
            .max_by(|a, b| a.2.total_cmp(&b.2))
            .map(|&(_, voice, _)| voice)
    };
    let nearest = |turn: &Turn| {
        embedded
            .iter()
            .zip(&voices)
            .map(|((index, _), &voice)| {
                let other = &turns[*index];
                ((other.start - turn.end).max(turn.start - other.end).max(0.0), voice as u32)
            })
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, voice)| voice)
    };

    turns
        .iter()
        .zip(&voice_of)
        .map(|(turn, voice)| Turn {
            cluster: voice.or_else(|| majority(turn.cluster)).or_else(|| nearest(turn)).unwrap_or(turn.cluster),
            ..turn.clone()
        })
        .collect()
}

fn best_cluster((start, end): (f64, f64), turns: &[Turn]) -> Option<u32> {
    let mut overlaps: Vec<(u32, f64)> = Vec::new();
    for turn in turns {
        let overlap = end.min(turn.end) - start.max(turn.start);
        if overlap > 0.0 {
            match overlaps.iter_mut().find(|(c, _)| *c == turn.cluster) {
                Some((_, total)) => *total += overlap,
                None => overlaps.push((turn.cluster, overlap)),
            }
        }
    }
    if let Some(&(cluster, _)) = overlaps.iter().max_by(|a, b| a.1.total_cmp(&b.1)) {
        return Some(cluster);
    }
    turns
        .iter()
        .map(|turn| ((turn.start - end).max(start - turn.end).max(0.0), turn.cluster))
        .filter(|&(distance, _)| distance <= NEAREST_TURN_SECS)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, cluster)| cluster)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::dual_channel::SPEAKER_ME;

    fn turn(start: f64, end: f64, cluster: u32) -> Turn {
        Turn { start, end, cluster }
    }

    #[test]
    fn progress_lines_are_parsed() {
        assert_eq!(parse_progress("progress 42.50%"), Some(42.5));
        assert_eq!(parse_progress("  progress 100.00%  "), Some(100.0));
        assert_eq!(parse_progress("Started"), None);
        assert_eq!(parse_progress("progress abc%"), None);
    }

    #[test]
    fn turns_are_read_from_the_tool_output() {
        let stdout = "OfflineSpeakerDiarizationConfig(...)\nStarted\n0.318 -- 6.865 speaker_00\n\
                      7.017 -- 10.747 speaker_01 confidence=0.812\n\nbroken -- line speaker_02\n";
        assert_eq!(parse_turns(stdout), [turn(0.318, 6.865, 0), turn(7.017, 10.747, 1)]);
    }

    #[test]
    fn other_segments_take_the_most_overlapping_speaker_in_order_of_appearance() {
        let spans = [(0.0, 4.0), (4.0, 8.0), (8.0, 12.0), (12.0, 16.0)];
        let mut labels = [SPEAKER_OTHERS, SPEAKER_ME, SPEAKER_OTHERS, SPEAKER_OTHERS];
        // Le cluster 3 parle en premier : il devient l'intervenant 1.
        let turns = [turn(0.0, 3.5, 3), turn(8.0, 9.0, 3), turn(9.0, 12.0, 0), turn(12.0, 16.0, 3)];
        assign_remote_speakers(&spans, &mut labels, &turns);
        assert_eq!(
            labels,
            [REMOTE_SPEAKER_BASE + 1, SPEAKER_ME, REMOTE_SPEAKER_BASE + 2, REMOTE_SPEAKER_BASE + 1],
            "le micro reste « moi », le 3e segment va au cluster 0 (3 s contre 1 s)"
        );
    }

    #[test]
    fn a_segment_without_overlap_takes_the_nearest_turn_or_stays_unseparated() {
        let spans = [(10.0, 11.0), (100.0, 101.0)];
        let mut labels = [SPEAKER_OTHERS, SPEAKER_OTHERS];
        assign_remote_speakers(&spans, &mut labels, &[turn(0.0, 8.0, 0), turn(13.0, 20.0, 1)]);
        assert_eq!(labels, [REMOTE_SPEAKER_BASE + 1, SPEAKER_OTHERS]);
    }

    /// Tours de 3 s : la voix de chacun et le cluster que sherpa-onnx lui a donné.
    fn sherpa_turns(voices_and_clusters: &[(usize, u32)]) -> (Vec<Turn>, Vec<(usize, Vec<f32>)>) {
        use crate::services::speaker_clustering::synthetic::{embedding, Noise};
        let mut noise = Noise::new(5);
        let turns = voices_and_clusters
            .iter()
            .enumerate()
            .map(|(i, &(_, cluster))| turn(3.0 * i as f64, 3.0 * i as f64 + 3.0, cluster))
            .collect();
        let embedded = voices_and_clusters
            .iter()
            .enumerate()
            .map(|(i, &(voice, _))| (i, embedding(voice, &mut noise)))
            .collect();
        (turns, embedded)
    }

    #[test]
    fn one_voice_split_by_sherpa_into_two_clusters_becomes_one_speaker_again() {
        // Liens complets : sherpa-onnx coupe la voix 0 en clusters 0 et 2, mêlés tout au long
        // de la réunion ; la voix 1 a le cluster 1.
        let pattern = [(0, 0), (1, 1), (0, 2), (0, 0), (1, 1), (0, 2), (0, 2), (1, 1)];
        let voices: Vec<(usize, u32)> = (0..48).map(|i| pattern[i % pattern.len()]).collect();
        let (turns, embedded) = sherpa_turns(&voices);

        let relabeled = relabel_turns(&turns, &embedded, None);

        let speaker_of = |voice: usize| -> std::collections::HashSet<u32> {
            relabeled.iter().zip(&voices).filter(|(_, v)| v.0 == voice).map(|(t, _)| t.cluster).collect()
        };
        assert_eq!(speaker_of(0).len(), 1, "voix 0 : {:?}", speaker_of(0));
        assert_eq!(speaker_of(1).len(), 1, "voix 1 : {:?}", speaker_of(1));
        assert_ne!(speaker_of(0), speaker_of(1));
    }

    #[test]
    fn turns_without_embedding_follow_their_cluster_or_the_nearest_voice() {
        let voices: Vec<(usize, u32)> = (0..24).map(|i| (i % 2, (i % 2) as u32)).collect();
        let (mut turns, embedded) = sherpa_turns(&voices);
        // Tour court du cluster 1 (voix 1), en fin de réunion ; tour d'un cluster que seul lui
        // porte, pendant le premier tour (voix 0).
        turns.push(turn(72.0, 72.4, 1));
        turns.push(turn(0.5, 0.8, 9));

        let relabeled = relabel_turns(&turns, &embedded, None);
        assert_ne!(relabeled[0].cluster, relabeled[1].cluster);
        assert_eq!(relabeled[24].cluster, relabeled[1].cluster, "majorité du cluster 1");
        assert_eq!(relabeled[25].cluster, relabeled[0].cluster, "tour le plus proche");
    }

    #[test]
    fn only_the_longest_turns_get_an_embedding_in_time_order() {
        let mut turns = vec![turn(0.0, 1.9, 0), turn(2.0, 4.0, 0), turn(10.0, 75.0, 1)];
        // Assez de tours de 3 s pour dépasser la limite : les plus courts sont écartés.
        turns.extend((0..MAX_EMBEDDED_TURNS).map(|i| turn(100.0 + 4.0 * i as f64, 103.0 + 4.0 * i as f64, 2)));

        let selected = turns_to_embed(&turns);
        assert_eq!(selected.len(), MAX_EMBEDDED_TURNS);
        assert!(selected.iter().all(|&(i, _, _)| i != 0 && i != 1), "1,9 s : trop court ; 2 s : le plus court écarté");
        assert_eq!(selected[0], (2, 10.0, 10.0 + MAX_EMBEDDING_SECS), "tour long borné, en tête (ordre du temps)");
        assert!(selected.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn without_two_embeddings_the_sherpa_clusters_are_kept() {
        let turns = [turn(0.0, 1.0, 4), turn(1.0, 2.0, 7)];
        assert_eq!(relabel_turns(&turns, &[(0, vec![1.0, 0.0])], None), turns);
        assert_eq!(relabel_turns(&turns, &[], Some(2)), turns);
    }

    #[tokio::test]
    async fn other_files_are_not_labelled() {
        let path = std::env::temp_dir().join(format!("meetscribe-not-dual-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, audio_prep::encode_wav_16k(&[0.0; 1600]).unwrap()).unwrap();
        let labels = label_speakers(&path, &[(0.0, 0.1)], None, None, &AtomicBool::new(false), |_| {}).await;
        let _ = std::fs::remove_file(&path);
        assert_eq!(labels.unwrap(), None);
    }
}
