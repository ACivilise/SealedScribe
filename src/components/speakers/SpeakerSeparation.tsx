import { useEffect, useId, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, AudioLines } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useT } from '../../i18n';
import { type MeetingSession, useMeetingStore } from '../../store/meetingStore';
import { remotesNotSeparated } from '../../utils/speakers';
import {
  SPEAKER_SEPARATION_PROGRESS_EVENT,
  getLocalWhisperStatus,
  separateSpeakers,
} from '../../services/localWhisperService';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Choix proposés pour le nombre de participants distants. */
const REMOTE_COUNTS = ['auto', '1', '2', '3', '4', '5', '6', '7', '8'];

interface SpeakerSeparationProps {
  meeting: MeetingSession;
  /** Une transcription de cette réunion est en cours. */
  disabled?: boolean;
}

/** Encart : les participants distants sont tous restés sous « Autres ». */
function NotSeparatedNotice({ children }: { children: string }) {
  return (
    <Alert variant="warning" className="flex-row items-start gap-2" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/**
 * Relance la séparation des participants distants sur la version affichée, avec leur
 * nombre s'il est connu (sinon il est estimé ; l'imposer peut couper en deux une voix
 * dominante si un participant n'a presque pas parlé). Le résultat remplace les intervenants
 * de la version, même si la fiche a été fermée entre-temps. Une version précédente de
 * l'outil se met à jour d'elle-même au lancement (backend). Si les participants distants
 * sont tous restés sous « Autres », un encart le signale et dit quoi faire.
 */
export function SpeakerSeparation({ meeting, disabled = false }: SpeakerSeparationProps) {
  const { t } = useT();
  const selectId = useId();
  const updateMeeting = useMeetingStore((state) => state.updateMeeting);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [count, setCount] = useState('auto');
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const notSeparated = remotesNotSeparated(meeting.transcription?.segments ?? []);

  useEffect(() => {
    getLocalWhisperStatus()
      .then((status) => setAvailable(status.diarization.installed || status.diarization.outdated))
      .catch(() => setAvailable(false));
  }, []);

  if (available === null) return null;
  if (!available) {
    return notSeparated ? (
      <div className="mt-3">
        <NotSeparatedNotice>{t('detail.remotesNotSeparatedNotInstalled')}</NotSeparatedNotice>
      </div>
    ) : (
      <p className="mt-3 text-xs text-muted-foreground">{t('detail.separationNotInstalled')}</p>
    );
  }

  const run = async () => {
    const segments = meeting.transcription?.segments;
    if (!meeting.audioPath || !segments?.length) return;
    const meetingId = meeting.id;
    const versionId = meeting.activeTranscriptionId;
    setRunning(true);
    setPercent(0);
    setError(null);
    const unlisten = await listen<number>(SPEAKER_SEPARATION_PROGRESS_EVENT, (event) =>
      setPercent(Math.round(event.payload))
    ).catch(() => undefined);

    try {
      const labels = await separateSpeakers(
        meeting.audioPath,
        segments.map((s) => [s.startTime, s.endTime]),
        count === 'auto' ? null : Number(count),
        uuidv4()
      );
      // État relu à la fin : la fiche a pu être fermée ou la version changée entre-temps.
      const current = useMeetingStore.getState().meetings.find((m) => m.id === meetingId);
      if (!current?.transcription || current.activeTranscriptionId !== versionId) {
        setError(t('detail.separationVersionChanged'));
        return;
      }
      updateMeeting(meetingId, {
        transcription: {
          ...current.transcription,
          segments: current.transcription.segments.map((s, i) => ({ ...s, speaker: labels[i] ?? s.speaker })),
        },
      });
    } catch (err) {
      const message = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setError(`${t('detail.separateFailed')} ${message}`);
    } finally {
      unlisten?.();
      setRunning(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      {notSeparated && !running && <NotSeparatedNotice>{t('detail.remotesNotSeparated')}</NotSeparatedNotice>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={selectId} className="text-xs">
            {t('detail.remoteCount')}
          </Label>
          <Select value={count} onValueChange={setCount} disabled={running || disabled}>
            <SelectTrigger id={selectId} className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REMOTE_COUNTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === 'auto' ? t('detail.remoteCountAuto') : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={run} disabled={running || disabled}>
          <AudioLines className="h-4 w-4" aria-hidden="true" />
          {running ? t('detail.separating', { percent }) : t('detail.separateSpeakers')}
        </Button>
      </div>
      {running && (
        <p role="status" className="sr-only">
          {t('detail.separating', { percent })}
        </p>
      )}
      {error && (
        <Alert variant="destructive" className="flex-row items-start gap-2" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
