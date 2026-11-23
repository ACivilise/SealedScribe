import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { RECORDING_TRANSCRIPTION_KEY, useTaskStore } from '../../store/taskStore';
import { formatDuration } from '../../utils/format';
import { useT } from '../../i18n';
import { cn } from '@/lib/utils';

export type ActivityTarget = { kind: 'recording' } | { kind: 'meeting'; meetingId: string };

interface ActivityIndicatorProps {
  /** Amène l'utilisateur à la tâche cliquée (onglet, ou fiche de la réunion). */
  onNavigate: (target: ActivityTarget) => void;
}

const PILL =
  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Durée écoulée depuis `startedAt`, rafraîchie chaque seconde. */
function useElapsedSeconds(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** Pastilles des tâches en cours, à droite du logo (enregistrement, transcriptions, résumé). */
export function ActivityIndicator({ onNavigate }: ActivityIndicatorProps) {
  const { t } = useT();
  const recording = useTaskStore((s) => s.recording);
  const summary = useTaskStore((s) => s.summary);
  const transcriptions = useTaskStore((s) => s.transcriptions);
  const elapsed = useElapsedSeconds(recording?.startedAt ?? null);

  const running = Object.entries(transcriptions).filter(([, task]) => task.isTranscribing);

  return (
    <div role="group" aria-label={t('activity.label')} className="flex min-w-0 flex-wrap items-center gap-2">
      {recording && (
        <button
          type="button"
          className={cn(PILL, 'border-destructive/30 bg-destructive/10 text-destructive')}
          aria-label={t('activity.recordingAria', { duration: formatDuration(elapsed) })}
          onClick={() => onNavigate({ kind: 'recording' })}
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
          <span className="font-mono tabular-nums">{t('activity.recording', { duration: formatDuration(elapsed) })}</span>
        </button>
      )}

      {running.map(([key, task]) => {
        const title = task.label ?? '';
        const text =
          task.progress > 0
            ? t('activity.transcribing', { percent: Math.round(task.progress) })
            : t('activity.transcribingStarting');
        return (
          <button
            key={key}
            type="button"
            className={cn(PILL, 'border-primary/30 bg-primary/10 text-foreground')}
            title={title || undefined}
            aria-label={t('activity.transcribingAria', { title })}
            onClick={() =>
              onNavigate(
                key === RECORDING_TRANSCRIPTION_KEY ? { kind: 'recording' } : { kind: 'meeting', meetingId: key }
              )
            }
          >
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
            <span className="tabular-nums">{text}</span>
          </button>
        );
      })}

      {summary?.isGenerating && (
        <button
          type="button"
          className={cn(PILL, 'border-primary/30 bg-primary/10 text-foreground')}
          title={summary.meetingTitle || undefined}
          aria-label={t('activity.summarizingAria', { title: summary.meetingTitle })}
          onClick={() => onNavigate({ kind: 'meeting', meetingId: summary.meetingId })}
        >
          <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" aria-hidden="true" />
          {t('activity.summarizing')}
        </button>
      )}
    </div>
  );
}
