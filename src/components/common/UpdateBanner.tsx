import { useEffect } from 'react';
import { Download } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useUpdateStore } from '@/store/updateStore';
import { useTaskStore } from '@/store/taskStore';
import { useT } from '@/i18n';

/** Première recherche peu après le lancement, puis toutes les 6 heures. */
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Enregistrement, transcription ou résumé en cours : installer fermerait l'application. */
function useIsBusy() {
  return useTaskStore(
    (s) =>
      s.recording !== null ||
      s.summary?.isGenerating === true ||
      Object.values(s.transcriptions).some((task) => task.isTranscribing)
  );
}

interface UpdateBannerProps {
  /** Recherche automatique : désactivée en développement (la version locale serait toujours « ancienne »). */
  automaticChecks?: boolean;
}

/**
 * Bandeau « nouvelle version disponible », sous la barre d'onglets. « Installer » télécharge
 * l'installeur signé et le lance : l'application se ferme, puis l'installeur la relance.
 * « Plus tard » masque le bandeau jusqu'au prochain lancement (ou à la prochaine recherche
 * demandée dans les Paramètres).
 */
export function UpdateBanner({ automaticChecks = !import.meta.env.DEV }: UpdateBannerProps) {
  const { t } = useT();
  const status = useUpdateStore((s) => s.status);
  const available = useUpdateStore((s) => s.available);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const check = useUpdateStore((s) => s.check);
  const install = useUpdateStore((s) => s.install);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const distribution = useUpdateStore((s) => s.distribution);
  const loadDistribution = useUpdateStore((s) => s.loadDistribution);
  const busy = useIsBusy();

  useEffect(() => {
    void loadDistribution();
  }, [loadDistribution]);

  // Version du Microsoft Store : le Store fait les mises à jour, aucune recherche sur GitHub.
  useEffect(() => {
    if (!automaticChecks || distribution !== 'installer') return;
    const first = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    const every = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [automaticChecks, distribution, check]);

  if (distribution === 'store') return null;
  if (!available || (status === 'available' && dismissedVersion === available.version)) return null;

  const inProgress = status === 'downloading' || status === 'installing';
  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  const description =
    error === 'busy' || busy
      ? t('update.busy')
      : error === 'failed'
        ? t('update.failed')
        : t('update.description', { current: available.currentVersion });

  return (
    <div className="border-b px-6 py-3">
      <div className="mx-auto max-w-7xl">
        <Alert
          role="status"
          variant={error === 'failed' ? 'destructive' : 'default'}
          className="flex-row items-start justify-between gap-4"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Download className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-2">
              <AlertTitle>{t('update.available', { version: available.version })}</AlertTitle>
              {inProgress ? (
                <>
                  <AlertDescription id="update-progress-label">
                    {status === 'installing'
                      ? t('update.installing')
                      : percent === null
                        ? t('update.downloading')
                        : t('update.downloadingPercent', { percent })}
                  </AlertDescription>
                  {status === 'downloading' && (
                    <Progress
                      value={percent ?? 100}
                      aria-labelledby="update-progress-label"
                      className={percent === null ? 'animate-pulse' : undefined}
                    />
                  )}
                </>
              ) : (
                <AlertDescription>{description}</AlertDescription>
              )}
            </div>
          </div>
          {!inProgress && (
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => void install()} disabled={busy}>
                {t('update.install')}
              </Button>
              <Button size="sm" variant="ghost" onClick={dismiss}>
                {t('update.later')}
              </Button>
            </div>
          )}
        </Alert>
      </div>
    </div>
  );
}
