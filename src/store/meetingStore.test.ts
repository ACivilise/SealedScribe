import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  useMeetingStore,
  type MeetingSession,
  type TranscriptionSegment,
} from './meetingStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const segment = (text: string, startTime = 0, endTime = 1): TranscriptionSegment => ({
  text,
  speaker: 1,
  startTime,
  endTime,
  confidence: 0.9,
  language: 'fr-FR',
});

const meeting = (overrides: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 'm1',
  title: 'Réunion',
  language: 'fr-FR',
  duration: 60,
  recordedAt: new Date('2026-11-10T10:00:00Z'),
  status: 'stopped',
  audioPath: 'C:\\rec\\a.wav',
  speakers: [],
  ...overrides,
});

const store = () => useMeetingStore.getState();
const get = (id = 'm1') => store().meetings.find((m) => m.id === id)!;

beforeEach(() => {
  useMeetingStore.setState({ meetings: [], currentMeeting: null, hiddenPaths: [] });
});

describe('addMeeting', () => {
  it('ajoute la réunion en tête de liste', () => {
    store().addMeeting(meeting({ id: 'a' }));
    store().addMeeting(meeting({ id: 'b' }));
    expect(store().meetings.map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('fait d’une transcription existante la version V1', () => {
    store().addMeeting(meeting({ transcription: { sessionId: 'm1', segments: [segment('Bonjour')] } }));
    const m = get();
    expect(m.transcriptionVersions).toHaveLength(1);
    expect(m.transcriptionVersions![0]).toMatchObject({ number: 1, createdAt: '2026-11-10T10:00:00.000Z' });
    expect(m.activeTranscriptionId).toBe(m.transcriptionVersions![0].id);
  });

  it('retire le fichier des chemins masqués (comparaison insensible à la casse et aux séparateurs)', () => {
    useMeetingStore.setState({ hiddenPaths: ['c:/REC/a.wav', 'C:\\rec\\b.wav'] });
    store().addMeeting(meeting());
    expect(store().hiddenPaths).toEqual(['C:\\rec\\b.wav']);
  });
});

describe('versions de transcription', () => {
  beforeEach(() => {
    store().addMeeting(meeting());
    store().setCurrentMeeting(get());
  });

  it('numérote les versions et active la dernière', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')], { start: 10, end: 20 });
    const m = get();
    expect(m.transcriptionVersions!.map((v) => v.number)).toEqual([1, 2]);
    expect(m.transcriptionVersions![1].range).toEqual({ start: 10, end: 20 });
    expect(m.transcription!.segments[0].text).toBe('v2');
    expect(m.status).toBe('completed');
    // La réunion ouverte est mise à jour elle aussi.
    expect(store().currentMeeting!.transcription!.segments[0].text).toBe('v2');
  });

  it('efface l’erreur de transcription précédente', () => {
    store().updateMeeting('m1', { transcriptionError: 'réseau', status: 'failed' });
    store().addTranscriptionVersion('m1', [segment('ok')]);
    expect(get().transcriptionError).toBeUndefined();
  });

  it('ne réutilise pas le numéro d’une version intermédiaire supprimée', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    store().addTranscriptionVersion('m1', [segment('v3')]);
    store().deleteTranscriptionVersion('m1', get().transcriptionVersions![1].id);
    store().addTranscriptionVersion('m1', [segment('v4')]);
    expect(get().transcriptionVersions!.map((v) => v.number)).toEqual([1, 3, 4]);
  });

  it('ne réutilise pas le numéro de la dernière version supprimée', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    store().deleteTranscriptionVersion('m1', get().transcriptionVersions![1].id);
    store().addTranscriptionVersion('m1', [segment('v3')]);
    expect(get().transcriptionVersions!.map((v) => v.number)).toEqual([1, 3]);
  });

  it('ne réutilise pas un numéro même après suppression de toutes les versions', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().deleteTranscriptionVersion('m1', get().transcriptionVersions![0].id);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    expect(get().transcriptionVersions!.map((v) => v.number)).toEqual([2]);
  });

  it('sélectionne une ancienne version et ignore un id inconnu', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    const v1 = get().transcriptionVersions![0];
    store().selectTranscriptionVersion('m1', v1.id);
    expect(get().activeTranscriptionId).toBe(v1.id);
    expect(get().transcription!.segments[0].text).toBe('v1');

    store().selectTranscriptionVersion('m1', 'inconnu');
    expect(get().activeTranscriptionId).toBe(v1.id);
  });

  it('enregistre le résumé dans la version visée, et dans la transcription si elle est active', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    const [v1, v2] = get().transcriptionVersions!;

    store().setVersionSummary('m1', v1.id, 'résumé v1');
    expect(get().transcriptionVersions![0].summary).toBe('résumé v1');
    expect(get().transcription!.summary).toBeUndefined();

    store().setVersionSummary('m1', v2.id, 'résumé v2');
    expect(get().transcription!.summary).toBe('résumé v2');
  });

  it('active la plus récente restante quand on supprime la version active', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().addTranscriptionVersion('m1', [segment('v2')]);
    const v2 = get().transcriptionVersions![1];
    store().deleteTranscriptionVersion('m1', v2.id);
    expect(get().transcription!.segments[0].text).toBe('v1');
    expect(get().status).toBe('completed');
  });

  it('repasse la réunion à « stopped » quand la dernière version est supprimée', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    store().deleteTranscriptionVersion('m1', get().transcriptionVersions![0].id);
    expect(get().transcription).toBeUndefined();
    expect(get().activeTranscriptionId).toBeUndefined();
    expect(get().status).toBe('stopped');
  });

  it('reporte une modification de la transcription sur la version active', () => {
    store().addTranscriptionVersion('m1', [segment('v1')]);
    const active = get().transcription!;
    store().updateMeeting('m1', { transcription: { ...active, summary: 'nouveau résumé' } });
    expect(get().transcriptionVersions![0].summary).toBe('nouveau résumé');
  });
});

describe('removeMeeting', () => {
  it('masque le fichier audio pour que la synchro disque ne le rajoute pas', () => {
    store().addMeeting(meeting());
    store().removeMeeting('m1');
    expect(store().meetings).toEqual([]);
    expect(store().hiddenPaths).toEqual(['C:\\rec\\a.wav']);
  });
});

describe('renameSpeaker', () => {
  const said = (speaker: number, start: number): TranscriptionSegment => ({ ...segment(`t${start}`, start, start + 1), speaker });
  const named = (labels: number[]) => {
    const segments = labels.map((label, i) => said(label, i));
    store().addMeeting(meeting({ transcription: { sessionId: 'm1', segments } }));
  };
  const labels = () => get().transcription!.segments.map((s) => s.speaker);

  it('nomme un intervenant, et revient au nom par défaut sur un nom vide', () => {
    named([1, 11, 12]);
    store().renameSpeaker('m1', 11, '  Anne  ');
    expect(get().speakers).toEqual([{ label: 11, name: 'Anne' }]);
    store().renameSpeaker('m1', 11, '');
    expect(get().speakers).toEqual([]);
    expect(labels()).toEqual([1, 11, 12]);
  });

  it('fusionne un intervenant renommé comme un autre, dans la transcription et sa version', () => {
    named([1, 13, 15, 13, 15]);
    store().renameSpeaker('m1', 13, 'GIRAUD, Gilles');
    store().renameSpeaker('m1', 15, 'Giraud, Gilles');

    expect(labels()).toEqual([1, 13, 13, 13, 13]);
    expect(get().transcriptionVersions![0].segments.map((s) => s.speaker)).toEqual([1, 13, 13, 13, 13]);
    expect(get().speakers).toEqual([{ label: 13, name: 'GIRAUD, Gilles' }]);
  });
});

describe('updateSpeakerName', () => {
  it('renomme le locuteur dans les segments et la liste des locuteurs', () => {
    store().addMeeting(meeting());
    store().updateDiarization('m1', {
      sessionId: 'm1',
      segments: [
        { text: 'a', speakerId: 'Speaker1', speakerName: 'Speaker1', startTime: 0, endTime: 1, confidence: 1, language: 'fr' },
        { text: 'b', speakerId: 'Speaker2', speakerName: 'Speaker2', startTime: 1, endTime: 2, confidence: 1, language: 'fr' },
      ],
      speakers: [
        { speakerId: 'Speaker1', displayName: 'Speaker1', totalSpeakingTime: 1, segmentCount: 1 },
        { speakerId: 'Speaker2', displayName: 'Speaker2', totalSpeakingTime: 1, segmentCount: 1 },
      ],
      fullText: 'a b',
      language: 'fr',
      durationSeconds: 2,
    });
    store().updateSpeakerName('m1', 'Speaker1', 'Alice');
    const d = get().diarization!;
    expect(d.segments.map((s) => s.speakerName)).toEqual(['Alice', 'Speaker2']);
    expect(d.speakers.map((s) => s.displayName)).toEqual(['Alice', 'Speaker2']);
  });
});

describe('syncFromDisk', () => {
  it('ajoute seulement les fichiers inconnus et non masqués, triés du plus récent au plus ancien', async () => {
    store().addMeeting(meeting({ audioPath: 'C:\\rec\\connu.wav', recordedAt: new Date('2026-11-05T00:00:00Z') }));
    useMeetingStore.setState({ hiddenPaths: ['C:\\rec\\masque.wav'] });
    vi.mocked(invoke).mockResolvedValue([
      { path: 'c:/rec/CONNU.wav', name: 'connu', modifiedMs: 0 },
      { path: 'C:\\rec\\masque.wav', name: 'masque', modifiedMs: 0 },
      { path: 'C:\\rec\\ancien.wav', name: 'ancien', modifiedMs: Date.parse('2026-11-01T00:00:00Z') },
      { path: 'C:\\rec\\recent.wav', name: 'recent', modifiedMs: Date.parse('2026-11-11T00:00:00Z') },
    ]);

    await store().syncFromDisk();

    expect(invoke).toHaveBeenCalledWith('list_recordings');
    expect(store().meetings.map((m) => m.title)).toEqual(['recent', 'Réunion', 'ancien']);
    expect(store().meetings[0]).toMatchObject({ status: 'stopped', audioPath: 'C:\\rec\\recent.wav' });
  });
});

describe('réhydratation depuis le localStorage', () => {
  it('convertit les dates et ne laisse aucun traitement « en cours »', async () => {
    localStorage.setItem(
      'meetscribe-meetings',
      JSON.stringify({
        state: {
          hiddenPaths: ['x.wav'],
          meetings: [
            { ...meeting({ id: 'rec', status: 'recording' }) },
            { ...meeting({ id: 'proc', status: 'processing', transcription: { sessionId: 'proc', segments: [segment('t')] } }) },
            { ...meeting({ id: 'done', status: 'completed' }) },
          ],
        },
        version: 0,
      })
    );

    await useMeetingStore.persist.rehydrate();

    const byId = (id: string) => store().meetings.find((m) => m.id === id)!;
    expect(byId('rec').status).toBe('stopped');
    expect(byId('proc').status).toBe('completed');
    expect(byId('proc').transcriptionVersions).toHaveLength(1);
    expect(byId('done').status).toBe('completed');
    expect(byId('rec').recordedAt).toBeInstanceOf(Date);
    expect(store().hiddenPaths).toEqual(['x.wav']);
  });

  it('retire les segments sans texte, de la transcription active et de chaque version', async () => {
    const others = (text: string, start: number): TranscriptionSegment => ({ ...segment(text, start, start + 15), speaker: 2 });
    const v1 = { id: 'v1', number: 1, createdAt: '2026-11-18T13:00:00Z', segments: [others('', 0), segment('Bonjour', 20, 21)] };
    const v2 = { id: 'v2', number: 2, createdAt: '2026-11-18T14:00:00Z', segments: [others(' ', 0), others('', 30), segment('Salut', 50, 51)] };
    localStorage.setItem(
      'meetscribe-meetings',
      JSON.stringify({
        state: {
          hiddenPaths: [],
          meetings: [
            meeting({
              status: 'completed',
              transcription: { sessionId: 'm1', segments: v2.segments },
              transcriptionVersions: [v1, v2],
              activeTranscriptionId: 'v2',
              lastTranscriptionNumber: 2,
            }),
          ],
        },
        version: 0,
      })
    );

    await useMeetingStore.persist.rehydrate();

    expect(get().transcription?.segments.map((s) => s.text)).toEqual(['Salut']);
    expect(get().transcriptionVersions?.map((v) => v.segments.map((s) => s.text))).toEqual([['Bonjour'], ['Salut']]);
    expect(get().activeTranscriptionId).toBe('v2');
  });

  it('fusionne les intervenants déjà nommés pareil', async () => {
    const said = (speaker: number, start: number): TranscriptionSegment => ({ ...segment(`t${start}`, start, start + 1), speaker });
    localStorage.setItem(
      'meetscribe-meetings',
      JSON.stringify({
        state: {
          hiddenPaths: [],
          meetings: [
            meeting({
              status: 'completed',
              transcription: { sessionId: 'm1', segments: [said(1, 0), said(13, 1), said(15, 2), said(17, 3), said(14, 4)] },
              speakers: [
                { label: 13, name: 'GIRAUD, Gilles' },
                { label: 15, name: 'GIRAUD, Gilles' },
                { label: 17, name: 'GIRAUD, Gilles' },
                { label: 14, name: 'MARTIN, Anne' },
              ],
            }),
          ],
        },
        version: 0,
      })
    );

    await useMeetingStore.persist.rehydrate();

    expect(get().transcription?.segments.map((s) => s.speaker)).toEqual([1, 13, 13, 13, 14]);
    expect(get().transcriptionVersions?.[0].segments.map((s) => s.speaker)).toEqual([1, 13, 13, 13, 14]);
    expect(get().speakers).toEqual([
      { label: 13, name: 'GIRAUD, Gilles' },
      { label: 14, name: 'MARTIN, Anne' },
    ]);
  });
});
