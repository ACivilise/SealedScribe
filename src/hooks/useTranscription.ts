import { translate } from '../i18n';
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { v4 as uuidv4 } from 'uuid';
import transcriptionService, {
  AudioRange,
  TranscriptionResult,
  TranscriptionSegment,
} from '../services/transcriptionService';
import { EMPTY_TRANSCRIPTION, type TranscriptionTask, useTaskStore } from '../store/taskStore';
import { useShutdownStore } from '../store/shutdownStore';
import { currentLexiconTerms } from '../store/lexiconStore';
import { correctSegments, whisperPrompt, type LexiconTerm } from '../lib/lexicon';

/** Corrige les segments avec les lexiques ; le texte complet suit. */
function applyLexicons(result: TranscriptionResult, terms: LexiconTerm[]): TranscriptionResult {
  const { segments, count } = correctSegments(result.segments, terms);
  if (count === 0) return result;
  return { ...result, segments, fullText: segments.map((s) => s.text).join(' ') };
}

interface TranscriptionProgressEvent {
  phase: string;
  progress: number;
  currentChunk?: number;
  totalChunks?: number;
  concurrency?: number;
  message?: string;
  processedSeconds?: number;
  totalSeconds?: number;
  modelLoadSeconds?: number;
  modelLoadExpectedSeconds?: number;
}

/**
 * Phase du traitement côté backend : `queued`, `preparing`, `chunking`,
 * `loading-model` (moteur local), `transcribing`, `completed`.
 */
export type TranscriptionPhase = string | null;

export interface UseTranscriptionOptions {
  /**
   * Callback when transcription starts
   */
  onStart?: () => void;
  /**
   * Callback when transcription completes successfully
   */
  onSuccess?: (result: TranscriptionResult) => void;
  /**
   * Callback when transcription fails
   */
  onError?: (error: Error) => void;
}

export interface UseTranscriptionReturn {
  /**
   * Whether transcription is in progress
   */
  isTranscribing: boolean;
  /**
   * The transcription result (null if not yet transcribed)
   */
  result: TranscriptionResult | null;
  /**
   * The transcription segments
   */
  segments: TranscriptionSegment[];
  /**
   * The full transcription text
   */
  fullText: string;
  /**
   * Error message if transcription failed
   */
  error: string | null;
  /**
   * Progress percentage (0-100, approximated for long audio)
   */
  progress: number;
  /**
   * Current processed chunk index when available
   */
  currentChunk: number | null;
  /**
   * Total chunks for the active transcription when available
   */
  totalChunks: number | null;
  /**
   * Human-readable backend progress message
   */
  progressMessage: string | null;
  /**
   * Current backend phase (see TranscriptionPhase)
   */
  phase: TranscriptionPhase;
  /**
   * Local engine: seconds of audio already processed / total duration
   */
  processedSeconds: number | null;
  totalSeconds: number | null;
  /**
   * Local engine, `loading-model` phase: elapsed seconds and expected load duration
   */
  modelLoadSeconds: number | null;
  modelLoadExpectedSeconds: number | null;
  /**
   * True when the last transcription was cancelled by the user
   */
  isCancelled: boolean;
  /**
   * Engine of the running transcription (`local` | `azure`), null if unknown
   */
  engine: string | null;
  /**
   * True once a stop after the current part has been requested
   */
  stopAfterPartRequested: boolean;
  /**
   * Start transcription of an audio file (optionally only the given range, in seconds)
   */
  transcribe: (
    audioPath: string,
    language: string,
    range?: AudioRange | null,
    /** Titre affiché par l'indicateur de l'en-tête */
    label?: string
  ) => Promise<TranscriptionResult | null>;
  /**
   * Cancel the transcription in progress (takes effect before the next chunk)
   */
  cancel: () => Promise<void>;
  /**
   * Local engine: stop once the current part is transcribed (finished parts stay resumable)
   */
  stopAfterPart: () => Promise<void>;
  /**
   * Reset the transcription state
   */
  reset: () => void;
}

/**
 * React hook for transcribing audio files using Azure Speech Service
 *
 * @example
 * ```tsx
 * const { transcribe, isTranscribing, result, error } = useTranscription(meeting.id, {
 *   onSuccess: (result) => console.log('Transcribed:', result.fullText),
 *   onError: (error) => console.error('Failed:', error),
 * });
 *
 * // Later in your code:
 * await transcribe('/path/to/audio.wav', 'en-US');
 * ```
 */
export function useTranscription(
  key: string,
  options: UseTranscriptionOptions = {}
): UseTranscriptionReturn {
  const { onStart, onSuccess, onError } = options;
  // L'état vit dans le store : il survit au démontage du composant (fiche fermée puis rouverte).
  const task = useTaskStore((s) => s.transcriptions[key]) ?? EMPTY_TRANSCRIPTION;

  const cancel = useCallback(async (): Promise<void> => {
    const { transcriptions, patchTranscription } = useTaskStore.getState();
    const jobId = transcriptions[key]?.jobId;
    if (!jobId) return;
    patchTranscription(key, {
      cancelRequested: true,
      progressMessage: translate('transcription.cancelling'),
    });
    // Arrêt immédiat : l'utilisateur est devant l'écran, pas d'extinction en fin de traitement.
    useShutdownStore.getState().setArmed(false);
    try {
      await transcriptionService.cancelJob(jobId);
    } catch (err) {
      console.error('Failed to cancel transcription:', err);
    }
  }, [key]);

  const stopAfterPart = useCallback(async (): Promise<void> => {
    const { transcriptions, patchTranscription } = useTaskStore.getState();
    const jobId = transcriptions[key]?.jobId;
    if (!jobId) return;
    patchTranscription(key, { stopAfterPartRequested: true });
    try {
      await transcriptionService.stopJobAfterPart(jobId);
    } catch (err) {
      console.error('Failed to stop transcription after the current part:', err);
    }
  }, [key]);

  const transcribe = useCallback(
    async (
      audioPath: string,
      language: string,
      range?: AudioRange | null,
      label?: string
    ): Promise<TranscriptionResult | null> => {
      const { patchTranscription } = useTaskStore.getState();
      const patch = (p: Partial<TranscriptionTask>) => patchTranscription(key, p);
      const jobId = uuidv4();

      patch({ ...EMPTY_TRANSCRIPTION, jobId, isTranscribing: true, label });
      onStart?.();
      // Même lecture que le backend au lancement : sert à proposer l'arrêt après la partie en cours.
      invoke<{ transcription_engine?: string }>('load_preferences')
        .then((prefs) => patch({ engine: prefs.transcription_engine ?? 'azure' }))
        .catch(() => {
          // Hors Tauri : moteur inconnu, seul l'arrêt immédiat est proposé.
        });

      let unlistenProgress: UnlistenFn | undefined;
      let progressInterval: ReturnType<typeof setInterval> | undefined;
      let hasBackendProgress = false;

      try {
        try {
          unlistenProgress = await listen<TranscriptionProgressEvent>(
            'transcription-progress',
            (event) => {
              hasBackendProgress = true;
              const payload = event.payload;
              const num = (v: unknown) => (typeof v === 'number' ? v : null);
              patch({
                ...(typeof payload.progress === 'number'
                  ? { progress: Math.max(0, Math.min(100, payload.progress)) }
                  : {}),
                currentChunk: num(payload.currentChunk),
                totalChunks: num(payload.totalChunks),
                progressMessage: payload.message || null,
                phase: payload.phase || null,
                processedSeconds: num(payload.processedSeconds),
                totalSeconds: num(payload.totalSeconds),
                modelLoadSeconds: num(payload.modelLoadSeconds),
                modelLoadExpectedSeconds: num(payload.modelLoadExpectedSeconds),
              });
            }
          );
        } catch {
          // Running outside Tauri (or event channel unavailable): fallback to simulated progress.
        }

        // Fallback progress simulation if backend events are unavailable
        progressInterval = setInterval(() => {
          if (!hasBackendProgress) {
            const current = useTaskStore.getState().transcriptions[key]?.progress ?? 0;
            patch({ progress: Math.min(current + 5, 90) });
          }
        }, 500);

        // Lexiques actifs : indice pour le moteur local, puis correction du texte (les deux moteurs).
        const terms = currentLexiconTerms();
        const rawResult = await transcriptionService.transcribe(
          audioPath,
          language,
          jobId,
          range,
          whisperPrompt(terms)
        );
        const transcriptionResult = applyLexicons(rawResult, terms);

        patch({
          progress: 100,
          progressMessage: translate('transcription.complete'),
          result: transcriptionResult,
        });
        onSuccess?.(transcriptionResult);

        return transcriptionResult;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        // Annulation volontaire : ce n'est pas une erreur à afficher.
        const current = useTaskStore.getState().transcriptions[key];
        if (current?.stopAfterPartRequested && !current.cancelRequested) {
          patch({ isCancelled: true, progressMessage: translate('transcription.stoppedAfterPart') });
          return null;
        }
        if (current?.cancelRequested || errorMessage.includes('annulée')) {
          patch({ isCancelled: true, progressMessage: translate('transcription.cancelled') });
          return null;
        }

        patch({ error: errorMessage });
        onError?.(err instanceof Error ? err : new Error(errorMessage));
        return null;
      } finally {
        clearInterval(progressInterval);
        if (unlistenProgress) {
          unlistenProgress();
        }
        patch({ jobId: null, isTranscribing: false });
      }
    },
    [key, onStart, onSuccess, onError]
  );

  const reset = useCallback(() => {
    useTaskStore.getState().resetTranscription(key);
  }, [key]);

  return {
    isTranscribing: task.isTranscribing,
    result: task.result,
    segments: task.result?.segments ?? [],
    fullText: task.result?.fullText ?? '',
    error: task.error,
    progress: task.progress,
    currentChunk: task.currentChunk,
    totalChunks: task.totalChunks,
    progressMessage: task.progressMessage,
    phase: task.phase,
    processedSeconds: task.processedSeconds,
    totalSeconds: task.totalSeconds,
    modelLoadSeconds: task.modelLoadSeconds,
    modelLoadExpectedSeconds: task.modelLoadExpectedSeconds,
    isCancelled: task.isCancelled,
    engine: task.engine,
    stopAfterPartRequested: task.stopAfterPartRequested,
    transcribe,
    cancel,
    stopAfterPart,
    reset,
  };
}

export default useTranscription;
