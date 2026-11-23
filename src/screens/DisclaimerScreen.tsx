import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { DisclaimerText } from '../components/common/DisclaimerText';
import { DISCLAIMER, type Disclaimer } from '../lib/disclaimer';
import { useDisclaimerStore } from '../store/disclaimerStore';
import { useT } from '../i18n';

/**
 * Premier lancement, ou avertissement modifié depuis la dernière acceptation : rien d'autre n'est
 * accessible tant que l'utilisateur ne l'a pas accepté (App n'affiche que cet écran).
 */
export default function DisclaimerScreen({ disclaimer = DISCLAIMER }: { disclaimer?: Disclaimer }) {
  const { t } = useT();
  const accept = useDisclaimerStore((state) => state.accept);
  const [checked, setChecked] = useState(false);

  // « Démarrer l'enregistrement » du tray ne peut rien enregistrer ici (l'onglet Enregistrer n'est pas
  // monté) : la fenêtre s'affiche pour présenter l'avertissement, par exemple après un lancement réduit.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen('tray-toggle-recording', () => {
      invoke('show_main_window').catch(() => {});
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Hors Tauri (navigateur) : pas d'événement tray.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleQuit = () => {
    invoke('quit_app').catch((error) => console.error('Failed to quit:', error));
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="border-b bg-card/80 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <img src="/logo.png" alt="" className="h-9 w-9 rounded-[22%] shadow-card" />
          <span className="text-xl font-bold tracking-tight">SealedScribe</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t('disclaimer.gateTitle')}</h1>
            <p className="text-muted-foreground">{t('disclaimer.gateIntro')}</p>
          </div>

          <Card className="shadow-soft">
            <CardContent className="space-y-4 p-6">
              <article aria-labelledby="disclaimer-title" className="space-y-4">
                <header className="space-y-1">
                  <h2 id="disclaimer-title" lang="fr" className="text-lg font-semibold">
                    {disclaimer.title}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t('disclaimer.updated', { date: disclaimer.updated })}
                  </p>
                </header>
                <DisclaimerText disclaimer={disclaimer} />
              </article>
            </CardContent>
          </Card>
        </div>
      </main>

      <footer className="border-t bg-card px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Checkbox
              id="disclaimer-accept"
              checked={checked}
              onCheckedChange={(value) => setChecked(value === true)}
              className="mt-0.5"
            />
            <Label htmlFor="disclaimer-accept" className="leading-snug">
              {t('disclaimer.checkbox')}
            </Label>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={handleQuit}>
              {t('disclaimer.quit')}
            </Button>
            <Button disabled={!checked} onClick={() => accept(disclaimer.updated)}>
              {t('disclaimer.accept')}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
