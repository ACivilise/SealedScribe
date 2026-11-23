import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { appConfig } from '../config/app.config';
import { sameNameMerges, speakerName } from '../utils/speakers';

interface RecordingFile {
  path: string;
  name: string;
  modifiedMs: number;
}

const samePath = (a: string, b: string) =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();

export interface MeetingSession {
  id: string;
  title: string;
  language: string;
  duration: number;
  recordedAt: Date;
  status: 'stopped' | 'recording' | 'processing' | 'completed' | 'failed';
  audioPath?: string;
  /** Version active de la transcription (lue par le résumé, l'export, la recherche). */
  transcription?: MeetingTranscription;
  /** Historique des transcriptions, de la plus ancienne à la plus récente. */
  transcriptionVersions?: TranscriptionVersion[];
  /** Identifiant de la version recopiée dans `transcription`. */
  activeTranscriptionId?: string;
  /** Plus grand numéro de version jamais attribué (survit aux suppressions). */
  lastTranscriptionNumber?: number;
  transcriptionError?: string;
  diarization?: MeetingDiarization;
  speakers: Speaker[];
  tag?: string;
}

export interface Speaker {
  label: number;
  name: string;
}

export interface TranscriptionSegment {
  text: string;
  speaker: number;
  startTime: number;
  endTime: number;
  confidence: number;
  language: string;
}

export interface MeetingTranscription {
  sessionId: string;
  segments: TranscriptionSegment[];
  summary?: string;
}

/** Portion transcrite, en secondes depuis le début de l'enregistrement. */
export interface TranscribedRange {
  start: number;
  end: number;
}

/** Une transcription conservée dans l'historique de la réunion. */
export interface TranscriptionVersion {
  id: string;
  /** Numéro affiché (V1, V2…), jamais réutilisé après une suppression. */
  number: number;
  /** Date ISO de création. */
  createdAt: string;
  /** Partie transcrite ; absente : tout l'enregistrement. */
  range?: TranscribedRange;
  segments: TranscriptionSegment[];
  summary?: string;
}

/**
 * Réunion sans historique mais avec une transcription (données d'avant le
 * versionnage, ou réunion tout juste enregistrée) : celle-ci devient la V1.
 */
function withVersions(meeting: MeetingSession): MeetingSession {
  if (meeting.transcriptionVersions?.length || !meeting.transcription?.segments?.length) {
    return meeting;
  }
  const version: TranscriptionVersion = {
    id: uuidv4(),
    number: 1,
    createdAt: new Date(meeting.recordedAt).toISOString(),
    segments: meeting.transcription.segments,
    summary: meeting.transcription.summary,
  };
  return {
    ...meeting,
    transcriptionVersions: [version],
    activeTranscriptionId: version.id,
    lastTranscriptionNumber: Math.max(meeting.lastTranscriptionNumber ?? 0, 1),
  };
}

/**
 * Retire les segments sans texte (passages sans parole rendus vides par un moteur) : sinon
 * ils restent affichés et comptés comme un intervenant, souvent « Autres », sans rien dire.
 * Le backend ne les renvoie plus ; ceci nettoie les transcriptions enregistrées avant.
 */
function withoutEmptySegments(meeting: MeetingSession): MeetingSession {
  const spoken = (segments: TranscriptionSegment[]) => segments.filter((s) => s.text.trim() !== '');
  return {
    ...meeting,
    transcription: meeting.transcription && {
      ...meeting.transcription,
      segments: spoken(meeting.transcription.segments ?? []),
    },
    transcriptionVersions: meeting.transcriptionVersions?.map((v) => ({ ...v, segments: spoken(v.segments) })),
  };
}

/**
 * Même nom, même personne : les intervenants nommés pareil (voir `sameNameMerges`) passent
 * sous un seul numéro, dans la transcription active et dans chaque version, puisque les
 * noms valent pour toute la réunion. C'est ainsi qu'on fusionne une personne que la
 * séparation des voix a coupée en plusieurs numéros.
 */
function withSameNamedSpeakersMerged(meeting: MeetingSession): MeetingSession {
  const speakers = meeting.speakers ?? [];
  const versions = meeting.transcriptionVersions ?? [];
  const labels = [meeting.transcription?.segments ?? [], ...versions.map((v) => v.segments)].flat().map((s) => s.speaker);
  const merges = sameNameMerges(labels, speakers);
  if (merges.size === 0) return meeting;
  const relabel = (segments: TranscriptionSegment[]) =>
    segments.map((s) => (merges.has(s.speaker) ? { ...s, speaker: merges.get(s.speaker)! } : s));
  return {
    ...meeting,
    speakers: speakers.filter((s) => !merges.has(s.label)),
    transcription: meeting.transcription && { ...meeting.transcription, segments: relabel(meeting.transcription.segments) },
    transcriptionVersions: meeting.transcriptionVersions?.map((v) => ({ ...v, segments: relabel(v.segments) })),
  };
}

/** Recopie une version dans `transcription` (ou vide la transcription active). */
function activate(meeting: MeetingSession, version: TranscriptionVersion | undefined): MeetingSession {
  return {
    ...meeting,
    activeTranscriptionId: version?.id,
    transcription: version
      ? { sessionId: meeting.id, segments: version.segments, summary: version.summary }
      : undefined,
  };
}

/**
 * Applique `updates` à une réunion ; une modification de `transcription` (ex. résumé
 * généré) est reportée sur la version active pour que l'historique reste à jour.
 */
function applyUpdates(meeting: MeetingSession, updates: Partial<MeetingSession>): MeetingSession {
  const next = { ...meeting, ...updates };
  if (!('transcription' in updates) || 'transcriptionVersions' in updates) return next;
  const transcription = updates.transcription;
  if (!transcription) return next;
  if (!next.activeTranscriptionId) return withVersions(next);
  return {
    ...next,
    transcriptionVersions: next.transcriptionVersions?.map((v) =>
      v.id === next.activeTranscriptionId
        ? { ...v, segments: transcription.segments, summary: transcription.summary }
        : v
    ),
  };
}

export interface DiarizedSegment {
  text: string;
  speakerId: string;
  speakerName: string;
  startTime: number;
  endTime: number;
  confidence: number;
  language: string;
}

export interface IdentifiedSpeaker {
  speakerId: string;
  displayName: string;
  totalSpeakingTime: number;
  segmentCount: number;
}

export interface MeetingDiarization {
  sessionId: string;
  segments: DiarizedSegment[];
  speakers: IdentifiedSpeaker[];
  fullText: string;
  language: string;
  durationSeconds: number;
}

interface MeetingStore {
  meetings: MeetingSession[];
  currentMeeting: MeetingSession | null;
  addMeeting: (meeting: MeetingSession) => void;
  updateMeeting: (id: string, updates: Partial<MeetingSession>) => void;
  /** Ajoute une transcription à l'historique et en fait la version active. */
  addTranscriptionVersion: (
    meetingId: string,
    segments: TranscriptionSegment[],
    range?: TranscribedRange | null
  ) => void;
  /** Affiche une version de l'historique (transcription et résumé). */
  selectTranscriptionVersion: (meetingId: string, versionId: string) => void;
  /** Enregistre un résumé dans une version donnée (même si ce n'est plus la version active). */
  setVersionSummary: (meetingId: string, versionId: string, summary: string) => void;
  /** Supprime une version ; si c'était l'active, la plus récente restante prend sa place. */
  deleteTranscriptionVersion: (meetingId: string, versionId: string) => void;
  removeMeeting: (id: string) => void;
  setCurrentMeeting: (meeting: MeetingSession | null) => void;
  updateDiarization: (id: string, diarization: MeetingDiarization) => void;
  updateSpeakerName: (meetingId: string, speakerId: string, newName: string) => void;
  /**
   * Nomme un intervenant de la transcription (nom vide ou nom par défaut : retour au nom par
   * défaut). Le nom d'un autre intervenant fusionne les deux sous un seul numéro.
   */
  renameSpeaker: (meetingId: string, label: number, name: string) => void;
  /** Fichiers retirés de la liste par l'utilisateur : la synchro disque ne les rajoute pas. */
  hiddenPaths: string[];
  /** Ajoute à la liste les fichiers audio du dossier d'enregistrements qui n'y sont pas encore. */
  syncFromDisk: () => Promise<void>;
}

/** Applique `update` à la réunion `id` dans la liste et dans `currentMeeting`. */
function mapMeeting(
  state: Pick<MeetingStore, 'meetings' | 'currentMeeting'>,
  id: string,
  update: (meeting: MeetingSession) => MeetingSession
): Pick<MeetingStore, 'meetings' | 'currentMeeting'> {
  return {
    meetings: state.meetings.map((m) => (m.id === id ? update(m) : m)),
    currentMeeting: state.currentMeeting?.id === id ? update(state.currentMeeting) : state.currentMeeting,
  };
}

export const useMeetingStore = create<MeetingStore>()(
  persist(
    (set, get) => ({
  meetings: [],
  currentMeeting: null,
  hiddenPaths: [],
  syncFromDisk: async () => {
    const files = await invoke<RecordingFile[]>('list_recordings');
    const { meetings, hiddenPaths } = get();
    const known = [
      ...meetings.map((m) => m.audioPath).filter((p): p is string => !!p),
      ...hiddenPaths,
    ];
    const fresh: MeetingSession[] = files
      .filter((f) => !known.some((p) => samePath(p, f.path)))
      .map((f) => ({
        id: uuidv4(),
        title: f.name,
        language: appConfig.defaultLanguage,
        duration: 0,
        recordedAt: new Date(f.modifiedMs),
        status: 'stopped',
        audioPath: f.path,
        speakers: [],
      }));
    if (fresh.length === 0) return;
    set((state) => ({
      meetings: [...state.meetings, ...fresh].sort(
        (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
      ),
    }));
  },
  addMeeting: (meeting) =>
    set((state) => ({
      meetings: [withVersions(meeting), ...state.meetings],
      hiddenPaths: meeting.audioPath
        ? state.hiddenPaths.filter((p) => !samePath(p, meeting.audioPath!))
        : state.hiddenPaths,
    })),
  updateMeeting: (id, updates) =>
    set((state) => ({
      meetings: state.meetings.map((m) => (m.id === id ? applyUpdates(m, updates) : m)),
      currentMeeting:
        state.currentMeeting?.id === id
          ? applyUpdates(state.currentMeeting, updates)
          : state.currentMeeting,
    })),
  addTranscriptionVersion: (meetingId, segments, range) =>
    set((state) => {
      const update = (m: MeetingSession): MeetingSession => {
        const base = withVersions(m);
        const versions = base.transcriptionVersions ?? [];
        // Les versions restantes ne suffisent pas : la plus récente a pu être supprimée.
        const number =
          Math.max(base.lastTranscriptionNumber ?? 0, ...versions.map((v) => v.number), 0) + 1;
        const version: TranscriptionVersion = {
          id: uuidv4(),
          number,
          createdAt: new Date().toISOString(),
          range: range ?? undefined,
          segments,
        };
        return activate(
          {
            ...base,
            transcriptionVersions: [...versions, version],
            lastTranscriptionNumber: number,
            transcriptionError: undefined,
            status: 'completed',
          },
          version
        );
      };
      return mapMeeting(state, meetingId, update);
    }),
  selectTranscriptionVersion: (meetingId, versionId) =>
    set((state) =>
      mapMeeting(state, meetingId, (m) => {
        const version = m.transcriptionVersions?.find((v) => v.id === versionId);
        return version ? activate(m, version) : m;
      })
    ),
  setVersionSummary: (meetingId, versionId, summary) =>
    set((state) =>
      mapMeeting(state, meetingId, (m) => {
        const versions = (m.transcriptionVersions ?? []).map((v) =>
          v.id === versionId ? { ...v, summary } : v
        );
        const updated = { ...m, transcriptionVersions: versions };
        return m.activeTranscriptionId === versionId
          ? activate(updated, versions.find((v) => v.id === versionId))
          : updated;
      })
    ),
  deleteTranscriptionVersion: (meetingId, versionId) =>
    set((state) =>
      mapMeeting(state, meetingId, (m) => {
        const remaining = (m.transcriptionVersions ?? []).filter((v) => v.id !== versionId);
        const updated = { ...m, transcriptionVersions: remaining };
        if (m.activeTranscriptionId !== versionId) return updated;
        const latest = remaining[remaining.length - 1];
        return { ...activate(updated, latest), status: latest ? m.status : 'stopped' };
      })
    ),
  removeMeeting: (id) =>
    set((state) => {
      const removed = state.meetings.find((m) => m.id === id);
      return {
        meetings: state.meetings.filter((m) => m.id !== id),
        hiddenPaths: removed?.audioPath
          ? [...state.hiddenPaths, removed.audioPath]
          : state.hiddenPaths,
      };
    }),
  setCurrentMeeting: (meeting) => set({ currentMeeting: meeting }),
  updateDiarization: (id, diarization) =>
    set((state) => ({
      meetings: state.meetings.map((m) =>
        m.id === id ? { ...m, diarization } : m
      ),
      currentMeeting:
        state.currentMeeting?.id === id
          ? { ...state.currentMeeting, diarization }
          : state.currentMeeting,
    })),
  renameSpeaker: (meetingId, label, name) =>
    set((state) =>
      mapMeeting(state, meetingId, (meeting) => {
        const trimmed = name.trim();
        const others = (meeting.speakers ?? []).filter((s) => s.label !== label);
        const custom = trimmed !== '' && trimmed !== speakerName(label);
        return withSameNamedSpeakersMerged({
          ...meeting,
          speakers: custom ? [...others, { label, name: trimmed }] : others,
        });
      })
    ),
  updateSpeakerName: (meetingId, speakerId, newName) =>
    set((state) => {
      const updateDiarizationSpeakers = (diarization?: MeetingDiarization) => {
        if (!diarization) return diarization;
        return {
          ...diarization,
          segments: diarization.segments.map((s) =>
            s.speakerId === speakerId ? { ...s, speakerName: newName } : s
          ),
          speakers: diarization.speakers.map((s) =>
            s.speakerId === speakerId ? { ...s, displayName: newName } : s
          ),
        };
      };

      return {
        meetings: state.meetings.map((m) =>
          m.id === meetingId
            ? { ...m, diarization: updateDiarizationSpeakers(m.diarization) }
            : m
        ),
        currentMeeting:
          state.currentMeeting?.id === meetingId
            ? {
                ...state.currentMeeting,
                diarization: updateDiarizationSpeakers(state.currentMeeting.diarization),
              }
            : state.currentMeeting,
      };
    }),
    }),
    {
      name: 'meetscribe-meetings',
      partialize: (state) => ({ meetings: state.meetings, hiddenPaths: state.hiddenPaths }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Pick<MeetingStore, 'meetings' | 'hiddenPaths'>>;
        return {
          ...current,
          hiddenPaths: saved.hiddenPaths ?? [],
          // JSON → Date, un traitement interrompu par la fermeture de l'app n'est plus « en cours »,
          // les segments sans texte disparaissent et les intervenants nommés pareil sont fusionnés.
          meetings: (saved.meetings ?? []).map((m) => withVersions(withSameNamedSpeakersMerged(withoutEmptySegments({
            ...m,
            recordedAt: new Date(m.recordedAt),
            status:
              m.status === 'recording' || m.status === 'processing'
                ? m.transcription
                  ? 'completed'
                  : 'stopped'
                : m.status,
          })))),
        };
      },
    }
  )
);
