import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EMPTY_TRANSCRIPTION, useIsAnyTranscribing, useTaskStore } from './taskStore';

const store = () => useTaskStore.getState();

beforeEach(() => {
  useTaskStore.setState({ transcriptions: {}, recording: null, summary: null });
});

describe('taskStore', () => {
  it('crée une tâche à partir de l’état vide lors du premier patch', () => {
    store().patchTranscription('m1', { isTranscribing: true, jobId: 'job-1' });
    expect(store().transcriptions.m1).toEqual({ ...EMPTY_TRANSCRIPTION, isTranscribing: true, jobId: 'job-1' });
  });

  it('fusionne les patchs successifs sans toucher aux autres tâches', () => {
    store().patchTranscription('m1', { progress: 10 });
    store().patchTranscription('m2', { progress: 50 });
    store().patchTranscription('m1', { phase: 'transcribing' });
    expect(store().transcriptions.m1).toMatchObject({ progress: 10, phase: 'transcribing' });
    expect(store().transcriptions.m2.progress).toBe(50);
  });

  it('supprime une tâche et ne change pas l’état pour une clé inconnue', () => {
    store().patchTranscription('m1', { progress: 10 });
    const before = store().transcriptions;
    store().resetTranscription('inconnue');
    expect(store().transcriptions).toBe(before);
    store().resetTranscription('m1');
    expect(store().transcriptions).toEqual({});
  });

  it('patchSummary et appendSummaryText sont sans effet sans résumé, puis complètent le résumé', () => {
    store().patchSummary({ error: 'x' });
    store().appendSummaryText('perdu');
    expect(store().summary).toBeNull();

    store().setSummary({
      meetingId: 'm1',
      versionId: 'v1',
      meetingTitle: 'Réunion',
      isGenerating: true,
      cancelRequested: false,
      streamText: '',
      result: null,
      error: null,
    });
    store().appendSummaryText('Bon');
    store().appendSummaryText('jour');
    store().patchSummary({ cancelRequested: true });
    expect(store().summary).toMatchObject({ streamText: 'Bonjour', cancelRequested: true, isGenerating: true });
  });

  it('useIsAnyTranscribing suit les tâches en cours', () => {
    const { result, rerender } = renderHook(() => useIsAnyTranscribing());
    expect(result.current).toBe(false);
    store().patchTranscription('m1', { isTranscribing: false });
    store().patchTranscription('m2', { isTranscribing: true });
    rerender();
    expect(result.current).toBe(true);
  });
});
