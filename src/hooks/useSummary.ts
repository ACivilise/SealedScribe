/**
 * useSummary : résumé d'une réunion en streaming, avec arrêt possible.
 * L'état vit dans le store des tâches : fermer la fiche ne perd pas la génération,
 * et le résumé est enregistré dans la version résumée même si la fiche a été fermée.
 */

import { translate } from '../i18n';
import { useCallback } from 'react';
import {
  cancelSummary,
  generateSummary as requestSummary,
  type SummaryResult,
} from '../services/summaryService';
import { useMeetingStore } from '../store/meetingStore';
import { useTaskStore } from '../store/taskStore';

interface GenerateParams {
  /** Version de la transcription résumée (celle où le résumé sera enregistré). */
  versionId: string;
  meetingTitle: string;
  system: string;
  prompt: string;
}

export function useSummary(meetingId: string) {
  const task = useTaskStore((s) => s.summary);
  // Le backend ne fait qu'un résumé à la fois.
  const ownTask = task?.meetingId === meetingId ? task : null;
  const otherSummaryRunning = Boolean(task?.isGenerating) && !ownTask;

  const generate = useCallback(
    async ({ versionId, meetingTitle, system, prompt }: GenerateParams): Promise<SummaryResult | null> => {
      const { summary, setSummary, patchSummary, appendSummaryText } = useTaskStore.getState();
      if (summary?.isGenerating) return null;

      const base = {
        meetingId,
        versionId,
        meetingTitle,
        cancelRequested: false,
        streamText: '',
        result: null,
      };
      if (!prompt.trim()) {
        setSummary({ ...base, isGenerating: false, error: translate('summary.emptyTranscript') });
        return null;
      }

      setSummary({ ...base, isGenerating: true, error: null });
      try {
        const result = await requestSummary(system, prompt, appendSummaryText);
        if (!result.cancelled) {
          useMeetingStore.getState().setVersionSummary(meetingId, versionId, result.summary);
        }
        patchSummary({ isGenerating: false, streamText: '', result });
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        patchSummary({ isGenerating: false, streamText: '', error: errorMessage });
        return null;
      }
    },
    [meetingId]
  );

  const cancel = useCallback(async () => {
    const { summary, patchSummary } = useTaskStore.getState();
    if (summary?.meetingId !== meetingId || !summary.isGenerating || summary.cancelRequested) return;
    patchSummary({ cancelRequested: true });
    try {
      await cancelSummary();
    } catch (err) {
      console.error('Failed to cancel summary:', err);
    }
  }, [meetingId]);

  const clearError = useCallback(() => {
    const { summary, patchSummary } = useTaskStore.getState();
    if (summary?.meetingId === meetingId) patchSummary({ error: null });
  }, [meetingId]);

  /** Oublie le dernier résultat de cette réunion (fiche fermée) ; sans effet pendant la génération. */
  const dismiss = useCallback(() => {
    const { summary, setSummary } = useTaskStore.getState();
    if (summary?.meetingId === meetingId && !summary.isGenerating) setSummary(null);
  }, [meetingId]);

  return {
    isGenerating: ownTask?.isGenerating ?? false,
    cancelRequested: ownTask?.cancelRequested ?? false,
    streamText: ownTask?.streamText ?? '',
    /** Version résumée par la dernière génération de cette réunion. */
    versionId: ownTask?.versionId ?? null,
    result: ownTask?.result ?? null,
    error: ownTask?.error ?? null,
    otherSummaryRunning,
    generate,
    cancel,
    clearError,
    dismiss,
  };
}
