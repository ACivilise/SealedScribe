import type { MessageKey, TranslateParams } from '../i18n';

type Translate = (key: MessageKey, params?: TranslateParams) => string;

export interface TranscriptionProgressState {
  phase: string | null;
  currentChunk: number | null;
  totalChunks: number | null;
  processedSeconds: number | null;
  totalSeconds: number | null;
  /** Moteur local : chargement du modèle, secondes écoulées et durée attendue. */
  modelLoadSeconds?: number | null;
  modelLoadExpectedSeconds?: number | null;
  /** Avancement de la phase en cours (0-100), utilisé par la séparation des intervenants. */
  progress?: number | null;
}

/** Le moteur local charge son modèle : la durée est inconnue, barre indéterminée. */
export function isLoadingModel(state: Pick<TranscriptionProgressState, 'phase'>): boolean {
  return state.phase === 'loading-model';
}

/**
 * Avancement estimé du chargement du modèle local (0-95 %), ou `null` si le backend
 * n'a pas fourni de durée attendue (barre indéterminée). On plafonne à 95 % : seule
 * la fin réelle du chargement fait passer à la phase suivante.
 */
export function modelLoadPercent(
  state: Pick<TranscriptionProgressState, 'phase' | 'modelLoadSeconds' | 'modelLoadExpectedSeconds'>
): number | null {
  if (!isLoadingModel(state)) return null;
  const { modelLoadSeconds: elapsed, modelLoadExpectedSeconds: expected } = state;
  if (elapsed == null || !expected || expected <= 0) return null;
  return Math.min(95, Math.round((elapsed / expected) * 100));
}

/**
 * Texte de progression dans la langue de l'interface, construit à partir de la
 * phase envoyée par le backend (ses propres messages ne sont pas traduits).
 */
export function describeTranscriptionProgress(t: Translate, state: TranscriptionProgressState): string | null {
  switch (state.phase) {
    case 'queued':
      return t('transcription.queued');
    case 'preparing':
      return t('transcription.preparing');
    case 'chunking':
      return t('record.preparingChunks');
    case 'loading-model':
      return t('transcription.loadingModel');
    case 'transcribing':
      if (state.totalSeconds != null && state.processedSeconds != null) {
        return t('transcription.minutes', {
          current: Math.floor(state.processedSeconds / 60),
          total: Math.max(1, Math.ceil(state.totalSeconds / 60)),
        });
      }
      if (state.currentChunk && state.totalChunks) {
        return t('record.chunk', { current: state.currentChunk, total: state.totalChunks });
      }
      return null;
    case 'updating-diarization':
      return t('transcription.updatingDiarization', { percent: Math.round(state.progress ?? 0) });
    case 'diarizing':
      return t('transcription.diarizing', { percent: Math.round(state.progress ?? 0) });
    case 'completed':
      return t('transcription.complete');
    default:
      return null;
  }
}
