import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSummary } from './useSummary';
import { useTaskStore } from '../store/taskStore';
import { useMeetingStore } from '../store/meetingStore';
import { cancelSummary, generateSummary, type SummaryResult } from '../services/summaryService';

vi.mock('../services/summaryService', () => ({
  generateSummary: vi.fn(),
  cancelSummary: vi.fn().mockResolvedValue(undefined),
}));

const params = { versionId: 'v1', meetingTitle: 'Réunion', system: 'sys', prompt: 'Résume ça' };
const done = (summary: string, cancelled = false): SummaryResult => ({
  summary,
  style: '',
  tokensUsed: 42,
  model: 'gpt',
  cancelled,
});

let setVersionSummary: ReturnType<typeof vi.fn<(meetingId: string, versionId: string, summary: string) => void>>;

beforeEach(() => {
  useTaskStore.setState({ transcriptions: {}, recording: null, summary: null });
  setVersionSummary = vi.fn<(meetingId: string, versionId: string, summary: string) => void>();
  useMeetingStore.setState({ setVersionSummary });
  vi.mocked(generateSummary).mockReset();
  vi.mocked(cancelSummary).mockClear();
});

describe('useSummary', () => {
  it('diffuse le texte reçu puis enregistre le résumé dans la version résumée', async () => {
    let finish!: (r: SummaryResult) => void;
    vi.mocked(generateSummary).mockImplementation((_s, _p, onDelta) => {
      onDelta('Bon');
      onDelta('jour');
      return new Promise((resolve) => (finish = resolve));
    });
    const { result } = renderHook(() => useSummary('m1'));

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.generate(params);
    });
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.streamText).toBe('Bonjour');

    await act(async () => {
      finish(done('Bonjour'));
      await pending;
    });
    expect(setVersionSummary).toHaveBeenCalledWith('m1', 'v1', 'Bonjour');
    expect(result.current).toMatchObject({ isGenerating: false, streamText: '', versionId: 'v1' });
    expect(result.current.result?.tokensUsed).toBe(42);
  });

  it('n’enregistre pas un résumé arrêté', async () => {
    vi.mocked(generateSummary).mockResolvedValue(done('Début', true));
    const { result } = renderHook(() => useSummary('m1'));
    await act(() => result.current.generate(params));
    expect(setVersionSummary).not.toHaveBeenCalled();
    expect(result.current.result?.cancelled).toBe(true);
  });

  it('garde l’erreur, effaçable, sans enregistrer', async () => {
    vi.mocked(generateSummary).mockRejectedValue(new Error('Quota dépassé'));
    const { result } = renderHook(() => useSummary('m1'));
    await act(() => result.current.generate(params));
    expect(result.current.error).toBe('Quota dépassé');
    expect(setVersionSummary).not.toHaveBeenCalled();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('refuse un prompt vide sans appeler le backend', async () => {
    const { result } = renderHook(() => useSummary('m1'));
    await act(() => result.current.generate({ ...params, prompt: '  ' }));
    expect(generateSummary).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
  });

  it('un seul résumé à la fois : l’autre réunion le voit et ne peut pas en lancer', async () => {
    vi.mocked(generateSummary).mockReturnValue(new Promise(() => {}));
    const first = renderHook(() => useSummary('m1'));
    const other = renderHook(() => useSummary('m2'));
    act(() => {
      void first.result.current.generate(params);
    });
    expect(other.result.current).toMatchObject({ otherSummaryRunning: true, isGenerating: false });
    expect(first.result.current.otherSummaryRunning).toBe(false);

    await act(() => other.result.current.generate({ ...params, versionId: 'v9' }));
    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().summary?.meetingId).toBe('m1');
  });

  it('arrête une seule fois et ne s’efface pas pendant la génération', async () => {
    vi.mocked(generateSummary).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSummary('m1'));
    act(() => {
      void result.current.generate(params);
    });
    await act(() => result.current.cancel());
    await act(() => result.current.cancel());
    expect(cancelSummary).toHaveBeenCalledTimes(1);
    expect(result.current.cancelRequested).toBe(true);

    act(() => result.current.dismiss());
    expect(useTaskStore.getState().summary).not.toBeNull();
  });

  it('dismiss oublie le résultat terminé de cette réunion seulement', async () => {
    vi.mocked(generateSummary).mockResolvedValue(done('Fini'));
    const { result } = renderHook(() => useSummary('m1'));
    await act(() => result.current.generate(params));

    const other = renderHook(() => useSummary('m2'));
    act(() => other.result.current.dismiss());
    expect(useTaskStore.getState().summary).not.toBeNull();
    act(() => result.current.dismiss());
    expect(useTaskStore.getState().summary).toBeNull();
  });
});
