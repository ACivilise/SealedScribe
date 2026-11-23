import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useT } from '../../i18n';
import { useShutdownStore } from '../../store/shutdownStore';
import { useTaskStore } from '../../store/taskStore';
import { useNotificationStore } from '../../store/notificationStore';
import { buttonVariants } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Délai laissé pour annuler l'extinction. */
const COUNTDOWN_SECONDS = 60;
/** Attente avant de programmer l'extinction : laisse la réunion s'enregistrer après la fin du job. */
const SETTLE_MS = 2000;

/**
 * Extinction en fin de traitement : quand la case est cochée et que plus rien ne tourne
 * (enregistrement, transcriptions, résumé), programme l'extinction de Windows dans 60 s
 * et affiche un compte à rebours annulable. Le délai est tenu par Windows (`shutdown /t`),
 * pas par un minuteur de la WebView, qui peut être ralenti fenêtre cachée.
 */
export function ShutdownWatcher() {
  const { t } = useT();
  const armed = useShutdownStore((s) => s.armed);
  const setArmed = useShutdownStore((s) => s.setArmed);
  const setError = useNotificationStore((s) => s.setError);
  const busy = useTaskStore(
    (s) =>
      s.recording !== null ||
      s.summary?.isGenerating === true ||
      Object.values(s.transcriptions).some((task) => task.isTranscribing)
  );
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tout est terminé : programmer l'extinction.
  useEffect(() => {
    if (!armed || busy || deadline !== null) return;
    const timer = setTimeout(() => {
      invoke('schedule_shutdown', { delaySeconds: COUNTDOWN_SECONDS })
        .then(() => {
          setNow(Date.now());
          setDeadline(Date.now() + COUNTDOWN_SECONDS * 1000);
        })
        .catch((error) => {
          setArmed(false);
          setError({ title: t('shutdown.failed'), message: String(error) });
        });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [armed, busy, deadline, setArmed, setError, t]);

  // Case décochée, ou nouveau traitement lancé pendant le compte à rebours : on annule
  // (dans le second cas, l'extinction sera reprogrammée à la fin de ce traitement).
  useEffect(() => {
    if (deadline === null || (armed && !busy)) return;
    invoke('abort_shutdown').catch(() => {});
    setDeadline(null);
  }, [armed, busy, deadline]);

  useEffect(() => {
    if (deadline === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  const cancelShutdown = () => {
    invoke('abort_shutdown').catch(() => {});
    setDeadline(null);
    setArmed(false);
  };

  const shutdownNow = () => {
    invoke('schedule_shutdown', { delaySeconds: 0 }).catch((error) => {
      setError({ title: t('shutdown.failed'), message: String(error) });
    });
  };

  const seconds = deadline === null ? COUNTDOWN_SECONDS : Math.max(0, Math.ceil((deadline - now) / 1000));

  return (
    <AlertDialog
      open={deadline !== null}
      onOpenChange={(open) => {
        // « Annuler l'extinction » et Échap.
        if (!open) cancelShutdown();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('shutdown.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('shutdown.description', { seconds })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('shutdown.cancel')}</AlertDialogCancel>
          {/* preventDefault : la fermeture du dialogue annulerait l'extinction (voir onOpenChange). */}
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(event) => {
              event.preventDefault();
              shutdownNow();
            }}
          >
            {t('shutdown.now')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
