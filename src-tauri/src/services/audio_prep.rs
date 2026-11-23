//! Préparation audio pour la transcription locale (whisper.cpp) :
//! décodage wav/mp3/m4a, passage en mono 16 kHz, découpe sur les silences.
//!
//! Tout est synchrone et gourmand en CPU : à appeler dans `spawn_blocking`.

use crate::error::{AppError, AppResult};
use std::f64::consts::PI;
use std::path::Path;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::default::{get_codecs, get_probe};

/// Fréquence attendue par Whisper.
pub const TARGET_RATE: u32 = 16_000;

fn prep_error(message: impl Into<String>) -> AppError {
    AppError::TranscriptionError(message.into())
}

/// Décode un fichier audio (wav, mp3, m4a) en échantillons mono 16 kHz.
/// Le rééchantillonnage se fait au fil du décodage : une heure d'audio
/// occupe ~230 Mo au lieu de ~1,4 Go en stéréo 48 kHz.
pub fn decode_to_mono_16k(path: &str) -> AppResult<Vec<f32>> {
    let file = std::fs::File::open(path).map_err(AppError::FileError)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| prep_error(format!("Format audio illisible : {e}")))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| prep_error("Aucune piste audio dans le fichier"))?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| prep_error("Piste audio sans paramètres de codec"))?;
    let mut decoder = get_codecs()
        .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
        .map_err(|e| prep_error(format!("Décodeur audio indisponible : {e}")))?;

    // Enregistrement micro / son du PC : deux sources distinctes, additionnées comme
    // l'ancien mixage (une moyenne baisserait chacune de 6 dB).
    let sum_channels = crate::services::dual_channel::is_dual_channel(Path::new(path));

    let mut resampler: Option<Resampler> = None;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::IoError(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(prep_error(format!("Lecture audio impossible : {err}"))),
        };
        if packet.track_id != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(err) => return Err(prep_error(format!("Décodage audio impossible : {err}"))),
        };

        let rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count().max(1);
        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);

        let gain = if sum_channels { 1.0 } else { 1.0 / channels as f32 };
        mono.clear();
        mono.extend(
            interleaved
                .chunks_exact(channels)
                .map(|frame| (frame.iter().sum::<f32>() * gain).clamp(-1.0, 1.0)),
        );

        resampler
            .get_or_insert_with(|| Resampler::new(rate, TARGET_RATE))
            .push(&mono);
    }

    let samples = resampler.map(Resampler::finish).unwrap_or_default();
    if samples.is_empty() {
        return Err(prep_error("Aucun échantillon audio décodable"));
    }
    Ok(samples)
}

/// Rééchantillonneur en flux : filtre passe-bas (sinc fenêtrée) puis
/// interpolation linéaire. Suffisant pour de la parole.
pub(crate) struct Resampler {
    /// Pas en échantillons source par échantillon de sortie.
    step: f64,
    taps: Vec<f32>,
    half: usize,
    /// Échantillons source pas encore entièrement consommés.
    buffer: Vec<f32>,
    /// Position du prochain échantillon de sortie dans `buffer`.
    position: f64,
    output: Vec<f32>,
}

impl Resampler {
    const HALF_TAPS: usize = 16;

    pub(crate) fn new(in_rate: u32, out_rate: u32) -> Self {
        let half = Self::HALF_TAPS;
        // Coupure relative à la fréquence source (0,5 = Nyquist source).
        let cutoff = if in_rate > out_rate {
            0.45 * out_rate as f64 / in_rate as f64
        } else {
            0.5
        };
        let len = 2 * half + 1;
        let mut taps: Vec<f32> = (0..len)
            .map(|i| {
                let n = i as f64 - half as f64;
                let sinc = if n == 0.0 {
                    2.0 * cutoff
                } else {
                    (2.0 * PI * cutoff * n).sin() / (PI * n)
                };
                let window = 0.54 - 0.46 * (2.0 * PI * i as f64 / (len - 1) as f64).cos();
                (sinc * window) as f32
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|t| *t /= sum);

        Self {
            step: in_rate as f64 / out_rate as f64,
            taps,
            half,
            // Zéros d'amorce : le filtre a besoin d'un historique.
            buffer: vec![0.0; half],
            position: half as f64,
            output: Vec::new(),
        }
    }

    fn filtered(&self, center: usize) -> f32 {
        let start = center - self.half;
        self.buffer[start..start + self.taps.len()]
            .iter()
            .zip(&self.taps)
            .map(|(s, t)| s * t)
            .sum()
    }

    pub(crate) fn push(&mut self, samples: &[f32]) {
        self.buffer.extend_from_slice(samples);

        // Il faut `half` échantillons après le point d'interpolation suivant.
        while (self.position as usize) + 1 + self.half < self.buffer.len() {
            let index = self.position as usize;
            let frac = (self.position - index as f64) as f32;
            let value = if frac < 1e-6 {
                self.filtered(index)
            } else {
                let a = self.filtered(index);
                let b = self.filtered(index + 1);
                a + (b - a) * frac
            };
            self.output.push(value);
            self.position += self.step;
        }

        // On jette ce qui ne servira plus, en gardant l'historique du filtre.
        let consumed = (self.position as usize).saturating_sub(self.half);
        if consumed > 0 {
            self.buffer.drain(..consumed);
            self.position -= consumed as f64;
        }
    }

    pub(crate) fn finish(mut self) -> Vec<f32> {
        let tail = vec![0.0; self.half + 1];
        self.push(&tail);
        self.output
    }
}

/// Un morceau d'audio à transcrire et son décalage dans l'enregistrement.
pub struct AudioChunk<'a> {
    pub offset_secs: f64,
    pub samples: &'a [f32],
}

/// Découpe l'audio en morceaux d'environ `target_secs`, en coupant au
/// passage le plus silencieux des 20 dernières secondes pour ne pas couper un mot.
pub fn split_on_silence(samples: &[f32], target_secs: u32) -> Vec<AudioChunk<'_>> {
    let rate = TARGET_RATE as usize;
    let target = target_secs as usize * rate;
    let search = 20 * rate;
    let window = rate / 2;
    let hop = rate / 10;

    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < samples.len() {
        let remaining = samples.len() - start;
        // Le dernier morceau peut dépasser un peu la cible plutôt que de laisser un reliquat minuscule.
        let end = if remaining <= target + target / 10 {
            samples.len()
        } else {
            let search_start = start + target - search.min(target);
            let search_end = start + target;
            let mut best_cut = search_end;
            let mut best_energy = f32::MAX;
            let mut pos = search_start;
            while pos + window <= search_end {
                let energy: f32 = samples[pos..pos + window].iter().map(|s| s * s).sum();
                if energy < best_energy {
                    best_energy = energy;
                    best_cut = pos + window / 2;
                }
                pos += hop;
            }
            best_cut
        };

        chunks.push(AudioChunk {
            offset_secs: start as f64 / rate as f64,
            samples: &samples[start..end],
        });
        start = end;
    }

    chunks
}

/// Encode des échantillons mono 16 kHz en WAV PCM 16 bits.
pub fn encode_wav_16k(samples: &[f32]) -> AppResult<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::with_capacity(samples.len() * 2 + 44));
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|e| prep_error(format!("Encodage WAV impossible : {e}")))?;
        for sample in samples {
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer
                .write_sample(value)
                .map_err(|e| prep_error(format!("Encodage WAV impossible : {e}")))?;
        }
        writer
            .finalize()
            .map_err(|e| prep_error(format!("Encodage WAV impossible : {e}")))?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, secs: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn resampling_48k_to_16k_keeps_duration() {
        let input = sine(48_000, 440.0, 2.0);
        let mut resampler = Resampler::new(48_000, 16_000);
        // Par paquets de taille irrégulière, comme le décodeur.
        for chunk in input.chunks(1_237) {
            resampler.push(chunk);
        }
        let output = resampler.finish();
        assert!((output.len() as i64 - 32_000).abs() <= 2, "len = {}", output.len());
        // Le signal à 440 Hz passe le filtre sans être écrasé.
        let peak = output[1_000..31_000].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.45 && peak < 0.55, "peak = {peak}");
    }

    #[test]
    fn resampling_44_1k_is_fractional_and_keeps_duration() {
        let input = sine(44_100, 300.0, 1.0);
        let mut resampler = Resampler::new(44_100, 16_000);
        resampler.push(&input);
        let output = resampler.finish();
        assert!((output.len() as i64 - 16_000).abs() <= 2, "len = {}", output.len());
    }

    #[test]
    fn resampling_removes_frequencies_above_new_nyquist() {
        // 12 kHz n'existe pas à 16 kHz : il doit être fortement atténué.
        let input = sine(48_000, 12_000.0, 1.0);
        let mut resampler = Resampler::new(48_000, 16_000);
        resampler.push(&input);
        let output = resampler.finish();
        let peak = output[200..15_800].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak < 0.05, "peak = {peak}");
    }

    #[test]
    fn split_cuts_in_the_silence_near_the_target() {
        let rate = TARGET_RATE as usize;
        // 25 s de « parole », 1 s de silence (de 25 à 26 s), puis 14 s de parole.
        let mut samples = sine(TARGET_RATE, 200.0, 25.0);
        samples.extend(std::iter::repeat(0.0).take(rate));
        samples.extend(sine(TARGET_RATE, 200.0, 14.0));

        let chunks = split_on_silence(&samples, 30);
        assert_eq!(chunks.len(), 2);
        let cut = chunks[1].offset_secs;
        assert!((25.0..=26.0).contains(&cut), "cut = {cut}");
        assert_eq!(
            chunks.iter().map(|c| c.samples.len()).sum::<usize>(),
            samples.len()
        );
    }

    #[test]
    fn short_audio_is_a_single_chunk() {
        let samples = vec![0.1; TARGET_RATE as usize * 10];
        let chunks = split_on_silence(&samples, 300);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].offset_secs, 0.0);
    }

    #[test]
    fn wav_encoding_has_expected_size() {
        let wav = encode_wav_16k(&vec![0.0; 16_000]).unwrap();
        assert_eq!(wav.len(), 44 + 32_000);
        assert_eq!(&wav[0..4], b"RIFF");
    }
}
