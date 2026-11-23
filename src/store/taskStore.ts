import { create } from 'zustand';
import type { TranscriptionResult } from '../services/transcriptionService';
import type { SummaryResult } from '../services/summaryService';

/**
 * Tâches longues en cours (transcription, enregistrement, résumé).
 * L'état vit ici plutôt que dans les composants : fermer la fiche d'une réunion ne fait pas
 * perdre la progression, et l'en-tête (ActivityIndicator) peut afficher ce qui tourne.
 */
export interface TranscriptionTask {
  /** Job en cours côté backend (sert à l'annulation). */
  jobId: string | null;
  cancelRequested: boolean;
  /** Arrêt demandé après la partie en cours (moteur local uniquement). */
  stopAfterPartRequested: boolean;
  /** Moteur utilisé (`local` | `azure`), lu dans les préférences au lancement. */
  engine: string | null;
  isTranscribing: boolean;
  result: TranscriptionResult | null;
  error: string | null;
  progress: number;
  currentChunk: number | null;
  totalChunks: number | null;
  progressMessage: string | null;
  phase: string | null;
  processedSeconds: number | null;
  totalSeconds: number | null;
  modelLoadSeconds: number | null;
  modelLoadExpectedSeconds: number | null;
  isCancelled: boolean;
  /** Titre affiché par l'indicateur (titre de la réunion). */
  label?: string;
}

export const EMPTY_TRANSCRIPTION: TranscriptionTask = {
  jobId: null,
  cancelRequested: false,
  stopAfterPartRequested: false,
  engine: null,
  isTranscribing: false,
  result: null,
  error: null,
  progress: 0,
  currentChunk: null,
  totalChunks: null,
  progressMessage: null,
  phase: null,
  processedSeconds: null,
  totalSeconds: null,
  modelLoadSeconds: null,
  modelLoadExpectedSeconds: null,
  isCancelled: false,
};

/** Clé de la transcription lancée depuis l'onglet Enregistrer (sinon : id de la réunion). */
export const RECORDING_TRANSCRIPTION_KEY = 'recording';

/**
 * Résumé lancé depuis la fiche d'une réunion. Un seul à la fois : le backend n'a qu'un
 * indicateur d'arrêt. Reste après la fin (résultat, erreur) jusqu'à la fermeture de la fiche.
 */
export interface SummaryTask {
  meetingId: string;
  /** Version résumée : le résumé y est enregistré même si une autre version est affichée entre-temps. */
  versionId: string;
  /** Titre affiché par l'indicateur de l'en-tête. */
  meetingTitle: string;
  isGenerating: boolean;
  cancelRequested: boolean;
  /** Texte reçu jusqu'ici pendant la génération. */
  streamText: string;
  /** Génération terminée ; arrêtée (`cancelled`) : texte partiel, non enregistré. */
  result: SummaryResult | null;
  error: string | null;
}

interface TaskStore {
  transcriptions: Record<string, TranscriptionTask>;
  recording: { startedAt: number } | null;
  summary: SummaryTask | null;
  patchTranscription: (key: string, patch: Partial<TranscriptionTask>) => void;
  resetTranscription: (key: string) => void;
  setRecording: (recording: { startedAt: number } | null) => void;
  setSummary: (summary: SummaryTask | null) => void;
  /** Sans effet s'il n'y a pas de résumé. */
  patchSummary: (patch: Partial<SummaryTask>) => void;
  appendSummaryText: (text: string) => void;
}

export const useTaskStore = create<TaskStore>((set) => ({
  transcriptions: {},
  recording: null,
  summary: null,
  patchTranscription: (key, patch) =>
    set((state) => ({
      transcriptions: {
        ...state.transcriptions,
        [key]: { ...(state.transcriptions[key] ?? EMPTY_TRANSCRIPTION), ...patch },
      },
    })),
  resetTranscription: (key) =>
    set((state) => {
      if (!(key in state.transcriptions)) return state;
      const { [key]: _removed, ...rest } = state.transcriptions;
      return { transcriptions: rest };
    }),
  setRecording: (recording) => set({ recording }),
  setSummary: (summary) => set({ summary }),
  patchSummary: (patch) =>
    set((state) => (state.summary ? { summary: { ...state.summary, ...patch } } : state)),
  appendSummaryText: (text) =>
    set((state) =>
      state.summary ? { summary: { ...state.summary, streamText: state.summary.streamText + text } } : state
    ),
}));

/** Vrai si une transcription tourne, quelle qu'elle soit (la progression backend n'est pas par job). */
export const useIsAnyTranscribing = () =>
  useTaskStore((s) => Object.values(s.transcriptions).some((task) => task.isTranscribing));
