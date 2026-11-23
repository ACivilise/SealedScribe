import { translate } from '../i18n';
import type { Speaker, TranscriptionSegment } from '../store/meetingStore';
import { normalizeText } from './tags';

/**
 * Intervenants posés par le backend sur un enregistrement « micro + son du PC »
 * (voir `dual_channel.rs`) : 0 = non attribué, 1 = micro, 2 = son du PC, puis
 * `REMOTE_SPEAKER_BASE + n` pour le participant distant n une fois les voix séparées.
 */
export const SPEAKER_ME = 1;
export const SPEAKER_OTHERS = 2;
export const REMOTE_SPEAKER_BASE = 10;

/**
 * Nom affiché : nom saisi pour la réunion, sinon « Moi », « Autres » ou « Intervenant n »
 * (participant distant), sinon « Intervenant N ».
 */
export function speakerName(label: number, speakers: Speaker[] = []): string {
  const named = speakers.find((s) => s.label === label)?.name;
  if (named) return named;
  if (label === SPEAKER_ME) return translate('speaker.me');
  if (label === SPEAKER_OTHERS) return translate('speaker.others');
  if (label > REMOTE_SPEAKER_BASE) return translate('speaker.remote', { number: label - REMOTE_SPEAKER_BASE });
  return translate('common.speaker', { number: label });
}

/**
 * Même nom, même personne : parmi `labels`, les intervenants affichés sous le même nom
 * (casse, accents et espaces ignorés) sont rattachés au plus petit numéro du groupe.
 * Renvoie numéro rattaché → numéro gardé (vide si rien à fusionner).
 */
export function sameNameMerges(labels: number[], speakers: Speaker[]): Map<number, number> {
  const key = (label: number) => normalizeText(speakerName(label, speakers).trim().replace(/\s+/g, ' '));
  const kept = new Map<string, number>();
  const merges = new Map<number, number>();
  for (const label of [...new Set(labels)].sort((a, b) => a - b)) {
    const target = kept.get(key(label));
    if (target === undefined) kept.set(key(label), label);
    else merges.set(label, target);
  }
  return merges;
}

/** La transcription distingue au moins le micro du son du PC. */
export function hasSpeakerAttribution(segments: TranscriptionSegment[]): boolean {
  return segments.some((s) => s.speaker !== 0);
}

/**
 * Le son du PC n'a pas été séparé par voix : tous les participants distants sont restés
 * sous « Autres » (séparation non installée, en échec ou pas encore faite).
 */
export function remotesNotSeparated(segments: TranscriptionSegment[]): boolean {
  return segments.some((s) => s.speaker === SPEAKER_OTHERS) && !segments.some((s) => s.speaker > REMOTE_SPEAKER_BASE);
}

/** Intervenants présents dans la transcription, dans l'ordre de leur numéro. */
export function speakerLabels(segments: TranscriptionSegment[]): number[] {
  return [...new Set(segments.map((s) => s.speaker))].sort((a, b) => a - b);
}

/**
 * Texte envoyé au résumé : un segment par ligne, préfixé de l'intervenant quand la
 * transcription distingue les intervenants (sinon « Intervenant 0 » partout n'apporte rien).
 */
export function transcriptForSummary(segments: TranscriptionSegment[], speakers: Speaker[] = []): string {
  const attributed = hasSpeakerAttribution(segments);
  return segments
    .map((s) => (attributed ? `${speakerName(s.speaker, speakers)}: ${s.text}` : s.text))
    .join('\n');
}
