import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { MeetingSession, MeetingDiarization } from '../store/meetingStore';
import {
  diarizationFromTranscription,
  exportFullTranscript,
  exportWithDialog,
  generateMarkdownFallback,
} from './exportService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const session = (overrides: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 'm1',
  title: 'Point projet',
  language: 'fr-FR',
  duration: 3725,
  recordedAt: new Date('2026-11-10T10:00:00Z'),
  status: 'completed',
  speakers: [{ label: 1, name: 'Alice' }],
  transcription: {
    sessionId: 'm1',
    segments: [
      { text: 'Bonjour', speaker: 1, startTime: 0, endTime: 4, confidence: 1, language: 'fr-FR' },
      { text: 'Salut', speaker: 2, startTime: 4, endTime: 5, confidence: 1, language: 'fr-FR' },
      { text: 'On commence', speaker: 1, startTime: 5, endTime: 11, confidence: 1, language: 'fr-FR' },
    ],
  },
  ...overrides,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ filePath: 'x.md', fileSize: 1, exportType: 'full' });
  vi.mocked(save).mockReset();
});

describe('diarizationFromTranscription', () => {
  it('regroupe les segments par locuteur et cumule le temps de parole', () => {
    const d = diarizationFromTranscription(session())!;
    expect(d.speakers).toEqual([
      { speakerId: '1', displayName: 'Alice', totalSpeakingTime: 10, segmentCount: 2 },
      // 2 = son du PC d'un enregistrement micro + son du PC (voir utils/speakers).
      { speakerId: '2', displayName: 'Others', totalSpeakingTime: 1, segmentCount: 1 },
    ]);
    expect(d.segments.map((s) => s.speakerName)).toEqual(['Alice', 'Others', 'Alice']);
    expect(d.fullText).toBe('Bonjour Salut On commence');
    expect(d.durationSeconds).toBe(3725);
  });

  it('ignore les durées négatives', () => {
    const d = diarizationFromTranscription(
      session({
        transcription: {
          sessionId: 'm1',
          segments: [{ text: 'x', speaker: 1, startTime: 5, endTime: 3, confidence: 1, language: 'fr' }],
        },
      })
    )!;
    expect(d.speakers[0].totalSpeakingTime).toBe(0);
  });

  it('renvoie undefined sans transcription', () => {
    expect(diarizationFromTranscription(session({ transcription: undefined }))).toBeUndefined();
  });
});

describe('exportFullTranscript', () => {
  it('convertit en snake_case et déduit la diarisation de la transcription', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === 'get_export_directory' ? 'C:\\exports' : { filePath: 'x.md', fileSize: 1, exportType: 'full' }
    );

    await exportFullTranscript(session({ status: 'failed' }), undefined, { summary: 'Résumé', style: 'brief' });

    const [, args] = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'export_full_transcript')! as [
      string,
      Record<string, any>,
    ];
    expect(args.outputDirectory).toBe('C:\\exports');
    expect(args.session).toMatchObject({ recorded_at: '2026-11-10T10:00:00.000Z', status: 'completed' });
    expect(args.diarization.segments[0]).toMatchObject({ speaker_id: '1', speaker_name: 'Alice', start_time: 0 });
    expect(args.summary).toEqual({ summary: 'Résumé', style: 'brief', tokens_used: undefined, model: 'Azure AI' });
  });
});

describe('exportWithDialog', () => {
  it('ne fait rien si l’utilisateur annule', async () => {
    vi.mocked(save).mockResolvedValue(null);
    expect(await exportWithDialog(session())).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propose un nom de fichier sans caractères spéciaux et ajoute .md si besoin', async () => {
    vi.mocked(save).mockResolvedValue('C:\\exports\\compte-rendu');
    await exportWithDialog(session({ title: 'Point: projet/été' }), 'summary');

    const { defaultPath } = vi.mocked(save).mock.calls[0][0]!;
    expect(defaultPath).toMatch(/^\d{4}-\d{2}-\d{2}_\d{4}_Point__projet__t__summary\.md$/);
    expect(invoke).toHaveBeenCalledWith(
      'export_to_path',
      expect.objectContaining({ outputPath: 'C:\\exports\\compte-rendu.md', exportType: 'summary' })
    );
  });

  it('garde l’extension .md existante, quelle que soit la casse', async () => {
    vi.mocked(save).mockResolvedValue('C:\\exports\\cr.MD');
    await exportWithDialog(session());
    expect(invoke).toHaveBeenCalledWith('export_to_path', expect.objectContaining({ outputPath: 'C:\\exports\\cr.MD' }));
  });
});

describe('generateMarkdownFallback', () => {
  const diarization: MeetingDiarization = {
    sessionId: 'm1',
    segments: [
      { text: 'Bonjour', speakerId: '1', speakerName: 'Alice', startTime: 65, endTime: 70, confidence: 1, language: 'fr' },
    ],
    speakers: [{ speakerId: '1', displayName: 'Alice', totalSpeakingTime: 5, segmentCount: 1 }],
    fullText: 'Bonjour',
    language: 'fr',
    durationSeconds: 70,
  };

  it('contient les métadonnées, participants, résumé et transcription', () => {
    const md = generateMarkdownFallback(session(), diarization, { summary: 'Le résumé', style: 'brief' });
    expect(md).toMatch(/^# Point projet\n/);
    expect(md).toContain('**Language:** French (France)');
    expect(md).toContain('**Duration:** 01:02:05');
    expect(md).toContain('- **Alice** (1 segments, 00:05 speaking time)');
    expect(md).toContain('## Summary\n\nLe résumé');
    expect(md).toContain('**Alice** `[01:05]`\nBonjour');
  });

  it('liste les locuteurs de la réunion sans diarisation et omet les sections vides', () => {
    const md = generateMarkdownFallback(session({ language: 'xx-YY' }));
    expect(md).toContain('**Language:** xx-YY');
    expect(md).toContain('- **Alice** (Speaker 1)');
    expect(md).not.toContain('## Summary');
    expect(md).not.toContain('## Transcript');
  });
});
