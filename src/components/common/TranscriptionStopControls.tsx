import { useState } from 'react';
import { useT } from '../../i18n';
import { useShutdownStore } from '../../store/shutdownStore';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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

interface TranscriptionStopButtonProps {
  /** Moteur de la transcription en cours (`local` | `mistral` | `azure`), null si inconnu. */
  engine: string | null;
  currentChunk: number | null;
  totalChunks: number | null;
  stopAfterPartRequested: boolean;
  onCancel: () => void;
  onStopAfterPart: () => void;
}

/**
 * Arrêt d'une transcription. Moteur local (parties de ~5 min) et Mistral (~10 min), une partie à
 * la fois : choix entre arrêter après la partie en cours (reprise possible) et arrêter tout de suite.
 * Azure (parties de 30 s) : annulation directe, la différence serait de quelques secondes.
 */
export function TranscriptionStopButton({
  engine,
  currentChunk,
  totalChunks,
  stopAfterPartRequested,
  onCancel,
  onStopAfterPart,
}: TranscriptionStopButtonProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  if (engine !== 'local' && engine !== 'mistral') {
    return (
      <Button variant="outline" onClick={onCancel}>
        {t('record.cancelTranscription')}
      </Button>
    );
  }

  // Arrêt différé déjà demandé : seul l'arrêt immédiat reste possible.
  if (stopAfterPartRequested) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground" role="status">
          {t('stop.pending')}
        </span>
        <Button variant="outline" onClick={onCancel}>
          {t('stop.now')}
        </Button>
      </div>
    );
  }

  const afterPartLabel =
    currentChunk !== null && totalChunks !== null
      ? t('stop.afterPartWithIndex', { current: currentChunk, total: totalChunks })
      : t('stop.afterPart');

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t('stop.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('stop.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('stop.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* Libellés longs : boutons empilés, l'arrêt après la partie (recommandé) en haut. */}
          <AlertDialogFooter className="sm:flex-col-reverse sm:justify-start">
            <AlertDialogCancel>{t('stop.continue')}</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={onCancel}>
              {t('stop.now')}
            </AlertDialogAction>
            <AlertDialogAction onClick={onStopAfterPart}>{afterPartLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Case « Éteindre l'ordinateur à la fin du traitement » (état global, session en cours). */
export function ShutdownWhenDoneCheckbox({ id }: { id: string }) {
  const { t } = useT();
  const armed = useShutdownStore((s) => s.armed);
  const setArmed = useShutdownStore((s) => s.setArmed);
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={armed} onCheckedChange={(checked) => setArmed(checked === true)} />
      <Label htmlFor={id} className="cursor-pointer font-normal">
        {t('shutdown.checkbox')}
      </Label>
    </div>
  );
}
