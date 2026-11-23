//! Regroupement des empreintes vocales par intervenant : regroupement spectral avec
//! estimation automatique du nombre d'intervenants (NME-SC, Park et al. 2019, celui de NeMo).
//!
//! Pourquoi pas un seuil de similarité : sur un enregistrement Teams, toutes les voix se
//! ressemblent (même codec, même canal). Deux personnes différentes y sont aussi proches que
//! deux passages d'une même personne, et le seuil qui convient change d'une réunion à l'autre.
//! NME-SC ne garde, pour chaque passage, que ses `p` plus proches voisins : la comparaison est
//! relative à l'enregistrement. `p` est choisi pour que le graphe se coupe le plus nettement
//! en groupes (écart entre valeurs propres du laplacien), ce qui donne aussi leur nombre.

use nalgebra::{DMatrix, SymmetricEigen};

/// Nombre maximal d'intervenants estimé automatiquement.
const MAX_SPEAKERS: usize = 8;
/// Les voisins gardés vont de 2 au quart des passages.
const MAX_NEIGHBOR_RATIO: f64 = 0.25;
/// Pas sur `p` : le résultat bouge peu d'une valeur à la suivante, le calcul trois fois moins.
const NEIGHBOR_STEP: usize = 3;
const KMEANS_MAX_ITERATIONS: usize = 100;

/// Intervenant (0, 1…) de chaque empreinte. `num_speakers` impose leur nombre.
pub fn cluster(embeddings: &[Vec<f32>], num_speakers: Option<usize>) -> Vec<usize> {
    let n = embeddings.len();
    if n <= 1 || num_speakers == Some(1) {
        return vec![0; n];
    }
    let similarity = cosine_similarity(embeddings);
    let neighbors = neighbor_order(&similarity);

    // Chaque passage est son propre plus proche voisin : il faut p >= 2 pour relier deux passages.
    let max_p = ((n as f64 * MAX_NEIGHBOR_RATIO) as usize).clamp(2, (n - 1).max(2));
    let mut best: Option<(f64, usize, usize)> = None;
    for p in (2..=max_p).step_by(NEIGHBOR_STEP) {
        let laplacian = laplacian(&pruned_graph(&neighbors, p));
        let mut eigenvalues: Vec<f64> = laplacian.symmetric_eigenvalues().iter().copied().collect();
        eigenvalues.sort_by(f64::total_cmp);
        let (count, ratio) = estimate(&eigenvalues, p, n);
        if best.map_or(true, |(r, _, _)| ratio < r) {
            best = Some((ratio, p, count));
        }
    }
    let (_, p, estimated) = best.unwrap_or((0.0, max_p, 1));
    let k = num_speakers.unwrap_or(estimated).clamp(1, n);
    if k == 1 {
        return vec![0; n];
    }

    // Coordonnées spectrales : vecteurs propres des k plus petites valeurs propres.
    let eigen = SymmetricEigen::new(laplacian(&pruned_graph(&neighbors, p)));
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| eigen.eigenvalues[a].total_cmp(&eigen.eigenvalues[b]));
    let points: Vec<Vec<f64>> = (0..n)
        .map(|row| order[..k].iter().map(|&col| eigen.eigenvectors[(row, col)]).collect())
        .collect();
    kmeans(&points, k)
}

fn cosine_similarity(embeddings: &[Vec<f32>]) -> DMatrix<f64> {
    let unit: Vec<Vec<f64>> = embeddings
        .iter()
        .map(|v| {
            let norm = v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt().max(1e-12);
            v.iter().map(|&x| x as f64 / norm).collect()
        })
        .collect();
    let n = unit.len();
    DMatrix::from_fn(n, n, |i, j| unit[i].iter().zip(&unit[j]).map(|(a, b)| a * b).sum())
}

/// Pour chaque ligne, les colonnes de la plus proche à la plus lointaine (elle-même en tête).
fn neighbor_order(similarity: &DMatrix<f64>) -> Vec<Vec<usize>> {
    let n = similarity.nrows();
    (0..n)
        .map(|i| {
            let mut columns: Vec<usize> = (0..n).collect();
            columns.sort_by(|&a, &b| similarity[(i, b)].total_cmp(&similarity[(i, a)]));
            columns
        })
        .collect()
}

/// Graphe des `p` plus proches voisins de chaque passage, rendu symétrique (0, 0,5 ou 1).
fn pruned_graph(neighbors: &[Vec<usize>], p: usize) -> DMatrix<f64> {
    let n = neighbors.len();
    let mut graph = DMatrix::zeros(n, n);
    for (i, columns) in neighbors.iter().enumerate() {
        for &j in columns.iter().take(p) {
            graph[(i, j)] += 0.5;
            graph[(j, i)] += 0.5;
        }
    }
    graph
}

fn laplacian(graph: &DMatrix<f64>) -> DMatrix<f64> {
    let mut laplacian = -graph.clone();
    for i in 0..graph.nrows() {
        laplacian[(i, i)] += graph.row(i).sum();
    }
    laplacian
}

/// Nombre d'intervenants (plus grand écart entre valeurs propres consécutives) et rapport
/// `(p / n) / écart normalisé` : plus il est petit, plus `p` sépare nettement les groupes.
fn estimate(sorted_eigenvalues: &[f64], p: usize, n: usize) -> (usize, f64) {
    let considered = &sorted_eigenvalues[..sorted_eigenvalues.len().min(MAX_SPEAKERS + 1)];
    let (mut count, mut gap) = (1, f64::MIN);
    for (i, pair) in considered.windows(2).enumerate() {
        if pair[1] - pair[0] > gap {
            (count, gap) = (i + 1, pair[1] - pair[0]);
        }
    }
    let largest = sorted_eigenvalues.last().copied().unwrap_or(0.0);
    let ratio = (p as f64 / n as f64) / (gap / (largest + 1e-10) + 1e-10);
    (count, ratio)
}

/// k-moyennes, départ déterministe : le point le plus éloigné du centre, puis à chaque fois
/// le plus éloigné des centres déjà pris.
fn kmeans(points: &[Vec<f64>], k: usize) -> Vec<usize> {
    let distance = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| (x - y).powi(2)).sum::<f64>();
    let dims = points[0].len();
    let mean: Vec<f64> = (0..dims).map(|d| points.iter().map(|p| p[d]).sum::<f64>() / points.len() as f64).collect();

    let farthest_from = |centers: &[Vec<f64>]| {
        (0..points.len())
            .max_by(|&a, &b| {
                let da = centers.iter().map(|c| distance(&points[a], c)).fold(f64::MAX, f64::min);
                let db = centers.iter().map(|c| distance(&points[b], c)).fold(f64::MAX, f64::min);
                da.total_cmp(&db).then(b.cmp(&a))
            })
            .unwrap_or(0)
    };
    let mut centers = vec![points[farthest_from(std::slice::from_ref(&mean))].clone()];
    while centers.len() < k {
        centers.push(points[farthest_from(&centers)].clone());
    }

    let mut labels = vec![0; points.len()];
    for _ in 0..KMEANS_MAX_ITERATIONS {
        for (label, point) in labels.iter_mut().zip(points) {
            *label = (0..k)
                .min_by(|&a, &b| distance(point, &centers[a]).total_cmp(&distance(point, &centers[b])))
                .unwrap_or(0);
        }
        let mut moved = false;
        for (c, center) in centers.iter_mut().enumerate() {
            let members: Vec<&Vec<f64>> = points.iter().zip(&labels).filter(|(_, &l)| l == c).map(|(p, _)| p).collect();
            if members.is_empty() {
                continue;
            }
            let updated: Vec<f64> = (0..dims).map(|d| members.iter().map(|p| p[d]).sum::<f64>() / members.len() as f64).collect();
            moved |= distance(&updated, center) > 1e-12;
            *center = updated;
        }
        if !moved {
            break;
        }
    }
    labels
}

/// Empreintes de synthèse pour les tests : comme sur un enregistrement Teams, une forte
/// composante commune (le canal) rend toutes les voix proches.
#[cfg(test)]
pub(crate) mod synthetic {
    pub const DIM: usize = 32;

    /// Générateur pseudo-aléatoire minimal (xorshift), reproductible.
    pub struct Noise(u64);

    impl Noise {
        pub fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }

        /// Valeur à peu près gaussienne, de moyenne 0 et d'écart type 1.
        pub fn next(&mut self) -> f32 {
            let mut sum = 0.0;
            for _ in 0..12 {
                self.0 ^= self.0 << 13;
                self.0 ^= self.0 >> 7;
                self.0 ^= self.0 << 17;
                sum += (self.0 >> 11) as f32 / (1u64 << 53) as f32;
            }
            sum - 6.0
        }
    }

    /// Empreinte d'un passage de la voix `voice` (0, 1…).
    pub fn embedding(voice: usize, noise: &mut Noise) -> Vec<f32> {
        (0..DIM)
            .map(|d| {
                let channel = if d == 0 { 1.5 } else { 0.0 };
                let speaker = if d == voice + 1 { 1.0 } else { 0.0 };
                channel + speaker + 0.15 * noise.next()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::synthetic::{embedding, Noise};
    use super::*;

    /// Même étiquette pour les passages d'une même voix, et une par voix.
    fn assert_grouped_by_voice(voices: &[usize], labels: &[usize]) {
        for (i, (&vi, &li)) in voices.iter().zip(labels).enumerate() {
            for (&vj, &lj) in voices.iter().zip(labels).skip(i + 1) {
                assert_eq!(vi == vj, li == lj, "voix {vi}/{vj}, étiquettes {li}/{lj}");
            }
        }
    }

    #[test]
    fn voices_that_all_sound_alike_are_still_told_apart_and_counted() {
        let mut noise = Noise::new(7);
        let voices: Vec<usize> = (0..90).map(|i| [0, 1, 0, 2, 0, 1][i % 6]).collect();
        let embeddings: Vec<Vec<f32>> = voices.iter().map(|&v| embedding(v, &mut noise)).collect();

        let same = similarity(&embeddings[0], &embeddings[2]);
        let other = similarity(&embeddings[0], &embeddings[1]);
        assert!(other > 0.5 && same - other < 0.35, "voix proches : {same:.2} / {other:.2}");

        assert_grouped_by_voice(&voices, &cluster(&embeddings, None));
    }

    #[test]
    fn the_number_of_speakers_can_be_imposed() {
        let mut noise = Noise::new(3);
        let voices: Vec<usize> = (0..60).map(|i| i % 3).collect();
        let embeddings: Vec<Vec<f32>> = voices.iter().map(|&v| embedding(v, &mut noise)).collect();
        assert_grouped_by_voice(&voices, &cluster(&embeddings, Some(3)));
        let two = cluster(&embeddings, Some(2));
        assert_eq!(two.iter().collect::<std::collections::HashSet<_>>().len(), 2);
    }

    #[test]
    fn a_single_voice_stays_one_speaker() {
        let mut noise = Noise::new(11);
        let embeddings: Vec<Vec<f32>> = (0..40).map(|_| embedding(0, &mut noise)).collect();
        let labels = cluster(&embeddings, None);
        assert!(labels.iter().all(|&l| l == labels[0]), "{labels:?}");
    }

    #[test]
    fn tiny_inputs_need_no_clustering() {
        assert!(cluster(&[], None).is_empty());
        assert_eq!(cluster(&[vec![1.0, 0.0]], None), [0]);
        assert_eq!(cluster(&[vec![1.0, 0.0], vec![0.0, 1.0]], Some(1)), [0, 0]);
        assert_eq!(cluster(&[vec![1.0, 0.0], vec![0.0, 1.0]], Some(5)).len(), 2);
    }

    fn similarity(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
        dot / (norm(a) * norm(b))
    }
}
