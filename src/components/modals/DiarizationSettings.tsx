import { useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { useT } from '../../i18n';
import type { useLocalWhisper } from '../../hooks/useLocalWhisper';
import { DIARIZATION_ID, formatBytes } from '../../services/localWhisperService';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface DiarizationSettingsProps {
  /** État partagé avec la section du moteur local (un seul téléchargement à la fois). */
  localWhisper: ReturnType<typeof useLocalWhisper>;
}

/**
 * Paramètres › Transcription : téléchargement et suppression de la séparation des
 * intervenants (sherpa-onnx). Action immédiate, comme pour les modèles Whisper.
 */
export function DiarizationSettings({ localWhisper }: DiarizationSettingsProps) {
  const { t, intlLocale } = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const component = localWhisper.status?.diarization;
  const installing = localWhisper.installingId === DIARIZATION_ID;
  const install = installing ? localWhisper.install : null;
  const isOwnAction = localWhisper.actionId === DIARIZATION_ID;
  const size = component ? formatBytes(component.sizeBytes, intlLocale) : '';

  return (
    <section aria-labelledby="settings-diarization" className="space-y-4 border-t pt-4">
      <div className="space-y-1">
        <h3 id="settings-diarization" className="text-sm font-semibold">
          {t('settings.diarization')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('settings.diarizationHelp')}</p>
      </div>

      {component && (
        <Badge variant={component.installed ? 'success' : component.outdated ? 'warning' : 'secondary'}>
          {component.installed
            ? t('settings.modelInstalled')
            : t(component.outdated ? 'settings.componentOutdated' : 'settings.modelMissing', {
                size: formatBytes(component.missingBytes, intlLocale),
              })}
        </Badge>
      )}
      {component?.outdated && !installing && (
        <p className="text-xs text-muted-foreground">{t('settings.diarizationOutdatedHelp')}</p>
      )}

      {installing ? (
        <div className="space-y-2" role="status">
          <div className="flex items-center justify-between gap-2">
            <span id="settings-diarization-download" className="truncate text-xs text-muted-foreground">
              {install?.file ?? t('settings.diarization')}
            </span>
            <span className="text-xs text-muted-foreground">{install?.progress ?? 0}{' '}%</span>
          </div>
          <Progress value={install?.progress ?? 0} aria-labelledby="settings-diarization-download" />
          {install && (
            <p className="text-xs text-muted-foreground">
              {t('settings.downloadedOf', {
                done: formatBytes(install.downloadedBytes, intlLocale),
                total: formatBytes(install.totalBytes, intlLocale),
              })}
            </p>
          )}
          <Button variant="outline" size="sm" onClick={localWhisper.cancel}>
            {t('settings.cancelDownload')}
          </Button>
        </div>
      ) : component && !component.installed ? (
        <Button
          onClick={() => localWhisper.startInstall(DIARIZATION_ID)}
          disabled={localWhisper.isInstalling || localWhisper.isBusy}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t('settings.download', { size: formatBytes(component.missingBytes, intlLocale) })}
        </Button>
      ) : component ? (
        <Button variant="outline" onClick={() => setConfirmDelete(true)} disabled={localWhisper.isBusy}>
          {t('settings.deleteDiarization')}
        </Button>
      ) : null}

      {isOwnAction && localWhisper.cancelled && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.downloadCancelled')}
        </p>
      )}
      {isOwnAction && localWhisper.error && (
        <Alert variant="destructive" className="flex-row items-start gap-2" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <AlertDescription>
            {t('settings.localActionFailed')} {localWhisper.error}
          </AlertDescription>
        </Alert>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteDiarizationTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteDiarizationDescription', { size })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => localWhisper.remove(DIARIZATION_ID)}
            >
              {t('settings.deleteDiarization')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
