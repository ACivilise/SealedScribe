//! Enregistrements « micro + son du PC » sur deux canaux : le micro à gauche, le son du PC
//! (loopback) à droite.
//!
//! Le WAV porte un marqueur (chunk `LIST`/`INFO`, commentaire `ICMT`, visible dans les
//! propriétés du fichier sous Windows) qui distingue cette disposition d'un stéréo ordinaire
//! (fichier importé, ancien enregistrement mixé). Après transcription, chaque segment est
//! attribué au canal qui domine sur sa durée : « moi » (micro) ou « les autres » (son du PC).

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Segment non attribué (enregistrement sans canaux séparés).
pub const SPEAKER_UNKNOWN: u32 = 0;
/// Segment venu du micro.
pub const SPEAKER_ME: u32 = 1;
/// Segment venu du son du PC (participants distants).
pub const SPEAKER_OTHERS: u32 = 2;
/// Participants distants séparés par leur voix : l'intervenant n (1, 2…) porte le
/// numéro `REMOTE_SPEAKER_BASE + n` (voir `local_diarization`).
pub const REMOTE_SPEAKER_BASE: u32 = 10;

/// Commentaire `ICMT` qui signe la disposition micro à gauche, son du PC à droite. Il garde l'ancien
/// nom de l'app : c'est lui qui fait reconnaître les enregistrements déjà faits.
const LAYOUT_COMMENT: &str = "MeetScribe: left=microphone, right=system audio";

const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;
const BLOCK_ALIGN: u16 = CHANNELS * BITS_PER_SAMPLE / 8;

/// Durée d'une fenêtre d'analyse d'énergie.
const WINDOW_SECS: f64 = 0.01;
/// Carré moyen sous lequel une fenêtre est considérée comme silencieuse (≈ -50 dBFS).
const ACTIVE_ENERGY: f32 = 1e-5;
/// Garde-fous de lecture de l'en-tête (fichier corrompu).
const MAX_HEADER_CHUNKS: usize = 32;
const MAX_HEADER_CHUNK_BYTES: u64 = 64 * 1024;

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/// WAV PCM 16 bits stéréo, micro à gauche, son du PC à droite, marqueur compris.
pub struct DualChannelWavWriter<W: Write + Seek> {
    out: W,
    header_len: u64,
    data_bytes: u64,
}

impl DualChannelWavWriter<BufWriter<File>> {
    pub fn create(path: &Path, sample_rate: u32) -> io::Result<Self> {
        Self::new(BufWriter::new(File::create(path)?), sample_rate)
    }
}

impl<W: Write + Seek> DualChannelWavWriter<W> {
    pub fn new(mut out: W, sample_rate: u32) -> io::Result<Self> {
        let header = header(sample_rate);
        out.write_all(&header)?;
        Ok(Self { out, header_len: header.len() as u64, data_bytes: 0 })
    }

    /// Écrit une trame (échantillons entre -1 et 1).
    pub fn write_frame(&mut self, microphone: f32, system: f32) -> io::Result<()> {
        let mut frame = [0u8; BLOCK_ALIGN as usize];
        frame[..2].copy_from_slice(&to_pcm16(microphone).to_le_bytes());
        frame[2..].copy_from_slice(&to_pcm16(system).to_le_bytes());
        self.out.write_all(&frame)?;
        self.data_bytes += BLOCK_ALIGN as u64;
        Ok(())
    }

    /// Renseigne les tailles de l'en-tête et rend la sortie.
    pub fn finalize(mut self) -> io::Result<W> {
        // Au-delà de 4 Go (plus de 6 h à 48 kHz), les tailles saturent comme ailleurs.
        let data_size = u32::try_from(self.data_bytes).unwrap_or(u32::MAX - u32::MAX % BLOCK_ALIGN as u32);
        let riff_size = u32::try_from(self.header_len - 8 + data_size as u64).unwrap_or(u32::MAX);
        self.out.seek(SeekFrom::Start(4))?;
        self.out.write_all(&riff_size.to_le_bytes())?;
        self.out.seek(SeekFrom::Start(self.header_len - 4))?;
        self.out.write_all(&data_size.to_le_bytes())?;
        self.out.seek(SeekFrom::End(0))?;
        self.out.flush()?;
        Ok(self.out)
    }
}

fn to_pcm16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

/// En-tête complet : RIFF, `fmt `, `LIST`/`INFO` (marqueur), puis `data` (tailles à 0,
/// renseignées par `finalize`). Le marqueur précède les données : les lecteurs qui
/// prennent tout ce qui suit `data` pour de l'audio ne le lisent pas comme du son.
fn header(sample_rate: u32) -> Vec<u8> {
    let mut comment = LAYOUT_COMMENT.as_bytes().to_vec();
    comment.push(0);
    let comment_size = comment.len() as u32;
    if comment.len() % 2 == 1 {
        comment.push(0);
    }

    let mut h = Vec::with_capacity(128);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&0u32.to_le_bytes());
    h.extend_from_slice(b"WAVE");

    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&CHANNELS.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&(sample_rate * BLOCK_ALIGN as u32).to_le_bytes());
    h.extend_from_slice(&BLOCK_ALIGN.to_le_bytes());
    h.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

    h.extend_from_slice(b"LIST");
    h.extend_from_slice(&(4 + 8 + comment.len() as u32).to_le_bytes());
    h.extend_from_slice(b"INFO");
    h.extend_from_slice(b"ICMT");
    h.extend_from_slice(&comment_size.to_le_bytes());
    h.extend_from_slice(&comment);

    h.extend_from_slice(b"data");
    h.extend_from_slice(&0u32.to_le_bytes());
    h
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/// Emplacement des échantillons d'un WAV micro / son du PC.
#[derive(Debug, PartialEq)]
struct Layout {
    sample_rate: u32,
    data_offset: u64,
    data_len: u64,
}

/// Le fichier est un enregistrement micro / son du PC écrit par SealedScribe.
pub fn is_dual_channel(path: &Path) -> bool {
    File::open(path)
        .map(BufReader::new)
        .and_then(|mut file| read_layout(&mut file))
        .map(|layout| layout.is_some())
        .unwrap_or(false)
}

/// Parcourt les chunks jusqu'à `data` ; `None` si le fichier n'est pas un WAV PCM 16 bits
/// stéréo portant le marqueur.
fn read_layout<R: Read + Seek>(reader: &mut R) -> io::Result<Option<Layout>> {
    let file_len = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(0))?;

    let mut riff = [0u8; 12];
    if reader.read_exact(&mut riff).is_err() || &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Ok(None);
    }

    let mut sample_rate = 0u32;
    let mut format_ok = false;
    let mut marked = false;

    for _ in 0..MAX_HEADER_CHUNKS {
        let mut head = [0u8; 8];
        if reader.read_exact(&mut head).is_err() {
            return Ok(None);
        }
        let id: [u8; 4] = [head[0], head[1], head[2], head[3]];
        let size = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as u64;
        let padded = size + size % 2;

        match &id {
            b"data" => {
                if !(format_ok && marked) {
                    return Ok(None);
                }
                let data_offset = reader.stream_position()?;
                let data_len = size.min(file_len.saturating_sub(data_offset));
                return Ok(Some(Layout { sample_rate, data_offset, data_len }));
            }
            b"fmt " | b"LIST" if size <= MAX_HEADER_CHUNK_BYTES => {
                let mut body = vec![0u8; size as usize];
                reader.read_exact(&mut body)?;
                reader.seek(SeekFrom::Current((padded - size) as i64))?;
                if &id == b"fmt " {
                    if body.len() >= 16 {
                        let tag = u16::from_le_bytes([body[0], body[1]]);
                        let channels = u16::from_le_bytes([body[2], body[3]]);
                        sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                        let bits = u16::from_le_bytes([body[14], body[15]]);
                        format_ok = tag == 1 && channels == CHANNELS && bits == BITS_PER_SAMPLE && sample_rate > 0;
                    }
                } else {
                    marked |= has_layout_comment(&body);
                }
            }
            _ => {
                reader.seek(SeekFrom::Current(padded as i64))?;
            }
        }
    }
    Ok(None)
}

/// Le corps d'un chunk `LIST` est un `INFO` dont le commentaire `ICMT` est le marqueur.
fn has_layout_comment(list: &[u8]) -> bool {
    if list.len() < 4 || &list[0..4] != b"INFO" {
        return false;
    }
    let mut pos = 4;
    while pos + 8 <= list.len() {
        let size = u32::from_le_bytes([list[pos + 4], list[pos + 5], list[pos + 6], list[pos + 7]]) as usize;
        let start = pos + 8;
        let end = start.saturating_add(size).min(list.len());
        if &list[pos..pos + 4] == b"ICMT" {
            let text = &list[start..end];
            let text = text.split(|&b| b == 0).next().unwrap_or_default();
            if text == LAYOUT_COMMENT.as_bytes() {
                return true;
            }
        }
        pos = start.saturating_add(size + size % 2);
    }
    false
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/// Énergie (carré moyen) de chaque canal, par fenêtre de `WINDOW_SECS`.
#[derive(Debug, Default)]
struct ChannelEnergy {
    microphone: Vec<f32>,
    system: Vec<f32>,
}

fn read_energy<R: Read + Seek>(reader: &mut R, layout: &Layout) -> io::Result<ChannelEnergy> {
    reader.seek(SeekFrom::Start(layout.data_offset))?;
    let window = ((layout.sample_rate as f64 * WINDOW_SECS).round() as usize).max(1);
    let block_align = BLOCK_ALIGN as u64;

    let mut energy = ChannelEnergy::default();
    let (mut mic, mut sys, mut count) = (0f64, 0f64, 0usize);
    let mut remaining = layout.data_len - layout.data_len % block_align;
    let mut buffer = vec![0u8; 64 * 1024];

    while remaining > 0 {
        let n = (remaining as usize).min(buffer.len());
        if reader.read_exact(&mut buffer[..n]).is_err() {
            break; // fichier tronqué : on garde ce qui a été lu
        }
        remaining -= n as u64;
        for frame in buffer[..n].chunks_exact(BLOCK_ALIGN as usize) {
            let left = i16::from_le_bytes([frame[0], frame[1]]) as f64 / 32768.0;
            let right = i16::from_le_bytes([frame[2], frame[3]]) as f64 / 32768.0;
            mic += left * left;
            sys += right * right;
            count += 1;
            if count == window {
                energy.microphone.push((mic / count as f64) as f32);
                energy.system.push((sys / count as f64) as f32);
                (mic, sys, count) = (0.0, 0.0, 0);
            }
        }
    }
    if count > 0 {
        energy.microphone.push((mic / count as f64) as f32);
        energy.system.push((sys / count as f64) as f32);
    }
    Ok(energy)
}

/// Canal du son du PC seul, en mono 16 kHz (entrée de la séparation des intervenants) ;
/// `None` si le fichier n'est pas un enregistrement micro / son du PC.
pub fn system_channel_16k(path: &Path) -> io::Result<Option<Vec<f32>>> {
    let mut reader = BufReader::new(File::open(path)?);
    let Some(layout) = read_layout(&mut reader)? else {
        return Ok(None);
    };
    reader.seek(SeekFrom::Start(layout.data_offset))?;

    let mut resampler = crate::services::audio_prep::Resampler::new(
        layout.sample_rate,
        crate::services::audio_prep::TARGET_RATE,
    );
    let mut remaining = layout.data_len - layout.data_len % BLOCK_ALIGN as u64;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut system = Vec::with_capacity(buffer.len() / BLOCK_ALIGN as usize);
    while remaining > 0 {
        let n = (remaining as usize).min(buffer.len());
        if reader.read_exact(&mut buffer[..n]).is_err() {
            break;
        }
        remaining -= n as u64;
        system.clear();
        system.extend(
            buffer[..n]
                .chunks_exact(BLOCK_ALIGN as usize)
                .map(|frame| i16::from_le_bytes([frame[2], frame[3]]) as f32 / 32768.0),
        );
        resampler.push(&system);
    }
    Ok(Some(resampler.finish()))
}

/// Locuteur de chaque intervalle (début, fin en secondes) d'un enregistrement micro /
/// son du PC ; `None` si le fichier n'a pas cette disposition.
pub fn speakers_for_spans(path: &Path, spans: &[(f64, f64)]) -> io::Result<Option<Vec<u32>>> {
    let mut file = BufReader::new(File::open(path)?);
    let Some(layout) = read_layout(&mut file)? else {
        return Ok(None);
    };
    let energy = read_energy(&mut file, &layout)?;
    Ok(Some(spans.iter().map(|&(start, end)| speaker_for_span(&energy, start, end)).collect()))
}

/// Canal dominant sur l'intervalle : chaque fenêtre où l'un des deux canaux parle vote pour
/// le plus fort. Le vote, plutôt que la somme des énergies, résiste à un horodatage un peu
/// décalé (quelques dixièmes de seconde de l'autre canal, plus fort, ne renversent pas un
/// segment) et à un micro bien moins fort que le son du PC. Sans fenêtre active : énergie totale.
fn speaker_for_span(energy: &ChannelEnergy, start: f64, end: f64) -> u32 {
    let len = energy.microphone.len();
    let first = (start.max(0.0) / WINDOW_SECS).floor() as usize;
    if first >= len {
        return SPEAKER_UNKNOWN;
    }
    let last = ((end / WINDOW_SECS).ceil() as usize).clamp(first + 1, len);
    let mic = &energy.microphone[first..last];
    let sys = &energy.system[first..last];

    let (mut mic_votes, mut sys_votes) = (0usize, 0usize);
    for (&m, &s) in mic.iter().zip(sys) {
        if m.max(s) < ACTIVE_ENERGY {
            continue;
        }
        if m >= s {
            mic_votes += 1;
        } else {
            sys_votes += 1;
        }
    }
    let mic_wins = if mic_votes != sys_votes {
        mic_votes > sys_votes
    } else {
        mic.iter().sum::<f32>() >= sys.iter().sum::<f32>()
    };
    if mic_wins {
        SPEAKER_ME
    } else {
        SPEAKER_OTHERS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const RATE: u32 = 16_000;

    /// WAV écrit en mémoire : `frames` paires (micro, son du PC).
    fn written(frames: &[(f32, f32)]) -> Vec<u8> {
        let mut writer = DualChannelWavWriter::new(Cursor::new(Vec::new()), RATE).unwrap();
        for &(mic, sys) in frames {
            writer.write_frame(mic, sys).unwrap();
        }
        writer.finalize().unwrap().into_inner()
    }

    /// `secs` secondes où seul le micro (`true`) ou seul le son du PC parle.
    fn speech(secs: f64, microphone: bool, level: f32) -> Vec<(f32, f32)> {
        let n = (secs * RATE as f64) as usize;
        (0..n)
            .map(|i| {
                let s = level * ((i as f32) * 0.3).sin();
                if microphone { (s, 0.0) } else { (0.0, s) }
            })
            .collect()
    }

    fn energy_of(frames: &[(f32, f32)]) -> ChannelEnergy {
        let wav = written(frames);
        let mut cursor = Cursor::new(wav);
        let layout = read_layout(&mut cursor).unwrap().unwrap();
        read_energy(&mut cursor, &layout).unwrap()
    }

    #[test]
    fn written_file_is_a_valid_stereo_wav_with_its_sizes() {
        let wav = written(&[(0.5, -0.5), (0.0, 1.0)]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        let data = wav.windows(4).position(|w| w == b"data").unwrap();
        assert_eq!(u32::from_le_bytes(wav[data + 4..data + 8].try_into().unwrap()), 8);
        assert_eq!(wav.len(), data + 8 + 8, "les données suivent directement le chunk data");
        // Micro à gauche, son du PC à droite.
        let first = &wav[data + 8..data + 12];
        assert_eq!(i16::from_le_bytes([first[0], first[1]]), (0.5 * i16::MAX as f32) as i16);
        assert_eq!(i16::from_le_bytes([first[2], first[3]]), (-0.5 * i16::MAX as f32) as i16);
    }

    #[test]
    fn layout_is_recognised_only_with_the_marker() {
        let wav = written(&[(0.1, 0.2); 10]);
        let layout = read_layout(&mut Cursor::new(&wav)).unwrap().unwrap();
        assert_eq!(layout.sample_rate, RATE);
        assert_eq!(layout.data_len, 40);

        // Même fichier, commentaire différent : stéréo ordinaire.
        let mut other = wav.clone();
        let at = other.windows(10).position(|w| w == b"MeetScribe").unwrap();
        other[at] = b'X';
        assert_eq!(read_layout(&mut Cursor::new(&other)).unwrap(), None);
    }

    #[test]
    fn plain_wav_and_other_files_are_not_dual_channel() {
        let mut plain = Cursor::new(Vec::new());
        let spec = hound::WavSpec { channels: 2, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::new(&mut plain, spec).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.write_sample(0i16).unwrap();
        writer.finalize().unwrap();
        assert_eq!(read_layout(&mut Cursor::new(plain.into_inner())).unwrap(), None);

        assert_eq!(read_layout(&mut Cursor::new(b"ID3 not a wav file".to_vec())).unwrap(), None);
        assert_eq!(read_layout(&mut Cursor::new(Vec::new())).unwrap(), None);
    }

    #[test]
    fn truncated_data_chunk_is_limited_to_the_file() {
        let mut wav = written(&[(0.1, 0.2); 10]);
        wav.truncate(wav.len() - 12);
        let layout = read_layout(&mut Cursor::new(&wav)).unwrap().unwrap();
        assert_eq!(layout.data_len, 28);
    }

    #[test]
    fn energy_has_one_value_per_window_and_channel() {
        let energy = energy_of(&speech(0.5, true, 0.5));
        assert_eq!(energy.microphone.len(), 50);
        assert!(energy.microphone.iter().all(|&e| e > 0.05));
        assert!(energy.system.iter().all(|&e| e == 0.0));
    }

    #[test]
    fn each_span_goes_to_the_channel_that_speaks() {
        let mut frames = speech(2.0, true, 0.3);
        frames.extend(speech(2.0, false, 0.3));
        let energy = energy_of(&frames);
        assert_eq!(speaker_for_span(&energy, 0.0, 2.0), SPEAKER_ME);
        assert_eq!(speaker_for_span(&energy, 2.0, 4.0), SPEAKER_OTHERS);
    }

    #[test]
    fn a_quiet_microphone_still_wins_when_the_system_audio_is_silent() {
        let energy = energy_of(&speech(1.0, true, 0.01));
        assert_eq!(speaker_for_span(&energy, 0.0, 1.0), SPEAKER_ME);
    }

    #[test]
    fn a_slightly_shifted_timestamp_does_not_flip_the_segment() {
        // Le segment « micro » déborde de 0,4 s sur une réplique distante beaucoup plus forte.
        let mut frames = speech(1.0, false, 0.8);
        frames.extend(speech(2.0, true, 0.05));
        let energy = energy_of(&frames);
        assert_eq!(speaker_for_span(&energy, 0.6, 3.0), SPEAKER_ME);
    }

    #[test]
    fn silence_and_bleed_are_handled() {
        // Le micro capte faiblement les haut-parleurs pendant que les autres parlent.
        let frames: Vec<(f32, f32)> =
            speech(1.0, false, 0.5).into_iter().map(|(_, sys)| (sys * 0.1, sys)).collect();
        let energy = energy_of(&frames);
        assert_eq!(speaker_for_span(&energy, 0.0, 1.0), SPEAKER_OTHERS);

        // Silence complet : on retombe sur l'énergie totale (égalité : le micro).
        let silent = energy_of(&[(0.0, 0.0); 1600]);
        assert_eq!(speaker_for_span(&silent, 0.0, 0.1), SPEAKER_ME);
    }

    #[test]
    fn spans_outside_the_recording_are_left_unknown() {
        let energy = energy_of(&speech(1.0, true, 0.3));
        assert_eq!(speaker_for_span(&energy, 5.0, 6.0), SPEAKER_UNKNOWN);
        // Segment de durée nulle : au moins une fenêtre.
        assert_eq!(speaker_for_span(&energy, 0.5, 0.5), SPEAKER_ME);
    }

    #[test]
    fn recording_decodes_to_the_sum_of_both_sources() {
        // Micro et son du PC à 0,25 : 0,5 en mono, comme l'ancien mixage (et le marqueur
        // placé avant les données ne gêne pas le décodeur).
        let path = std::env::temp_dir().join(format!("meetscribe-dual-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, written(&vec![(0.25, 0.25); RATE as usize / 2])).unwrap();
        let mono = crate::services::audio_prep::decode_to_mono_16k(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        let mono = mono.unwrap();
        let middle = mono[mono.len() / 2];
        assert!((middle - 0.5).abs() < 0.01, "{middle}");
    }

    #[test]
    fn system_channel_is_extracted_alone_at_16_khz() {
        // 1 s : micro fort, son du PC constant à 0,25.
        let path = std::env::temp_dir().join(format!("meetscribe-dual-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, written(&vec![(0.9, 0.25); RATE as usize])).unwrap();
        let system = system_channel_16k(&path);
        let _ = std::fs::remove_file(&path);
        let system = system.unwrap().expect("enregistrement micro / son du PC");
        assert!((system.len() as i64 - crate::services::audio_prep::TARGET_RATE as i64).abs() <= 2);
        let middle = system[system.len() / 2];
        assert!((middle - 0.25).abs() < 0.01, "le micro ne doit pas s'y mêler : {middle}");
    }

    #[test]
    fn speakers_for_spans_reads_the_file_from_disk() {
        let mut frames = speech(1.0, false, 0.3);
        frames.extend(speech(1.0, true, 0.3));
        let path = std::env::temp_dir().join(format!("meetscribe-dual-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, written(&frames)).unwrap();

        let speakers = speakers_for_spans(&path, &[(0.0, 1.0), (1.0, 2.0)]).unwrap();
        assert!(is_dual_channel(&path));
        let _ = std::fs::remove_file(&path);
        assert_eq!(speakers, Some(vec![SPEAKER_OTHERS, SPEAKER_ME]));
    }
}
