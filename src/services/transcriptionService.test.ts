import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { transcriptionService } from './transcriptionService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('transcriptionService', () => {
  it('transmet la plage et convertit le résultat du backend en camelCase', async () => {
    vi.mocked(invoke).mockResolvedValue({
      segments: [{ text: 'Bonjour', speaker: 1, start_time: 10, end_time: 12.5, confidence: 0.8, language: 'fr-FR' }],
      full_text: 'Bonjour',
      language: 'fr-FR',
      duration_seconds: 30,
    });

    const result = await transcriptionService.transcribe('a.wav', 'fr-FR', 'job-1', { start: 10, end: 40 });

    expect(invoke).toHaveBeenCalledWith('transcribe_audio', {
      audioPath: 'a.wav',
      language: 'fr-FR',
      jobId: 'job-1',
      startSeconds: 10,
      endSeconds: 40,
      prompt: null,
    });
    expect(result).toEqual({
      segments: [{ text: 'Bonjour', speaker: 1, startTime: 10, endTime: 12.5, confidence: 0.8, language: 'fr-FR' }],
      fullText: 'Bonjour',
      language: 'fr-FR',
      durationSeconds: 30,
    });
  });

  it('envoie des bornes nulles sans plage (tout l’enregistrement)', async () => {
    vi.mocked(invoke).mockResolvedValue({ segments: [], full_text: '', language: 'fr-FR', duration_seconds: 0 });
    await transcriptionService.transcribe('a.wav', 'fr-FR', 'job-1');
    expect(invoke).toHaveBeenCalledWith('transcribe_audio', expect.objectContaining({ startSeconds: null, endSeconds: null }));
  });

  it('transmet l’indice des lexiques au backend', async () => {
    vi.mocked(invoke).mockResolvedValue({ segments: [], full_text: '', language: 'fr-FR', duration_seconds: 0 });
    await transcriptionService.transcribe('a.wav', 'fr-FR', 'job-1', null, 'Zentra, ACME.');
    expect(invoke).toHaveBeenCalledWith('transcribe_audio', expect.objectContaining({ prompt: 'Zentra, ACME.' }));
  });

  it('appelle les commandes de pilotage des jobs', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await transcriptionService.cancelJob('j');
    await transcriptionService.stopJobAfterPart('j');
    await transcriptionService.discardCheckpoints('a.wav');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['cancel_job', { jobId: 'j' }],
      ['stop_job_after_part', { jobId: 'j' }],
      ['discard_transcription_checkpoints', { audioPath: 'a.wav' }],
    ]);
  });

  it('formate les horodatages en mm:ss', () => {
    expect(transcriptionService.formatTimestamp(0)).toBe('00:00');
    expect(transcriptionService.formatTimestamp(754.9)).toBe('12:34');
    expect(
      transcriptionService.formatTranscriptionWithTimestamps([
        { text: 'a', speaker: 1, startTime: 5, endTime: 6, confidence: 1, language: 'fr' },
        { text: 'b', speaker: 1, startTime: 65, endTime: 66, confidence: 1, language: 'fr' },
      ])
    ).toBe('[00:05] a\n[01:05] b');
  });
});
