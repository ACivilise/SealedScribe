import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { hasSignedInWith, useAuthStore } from '../store/authStore';
import { scopes } from '../config/auth.config';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useT } from '../i18n';

/** Marque la tentative de connexion automatique (SSO Windows) de la session en cours. */
const AUTO_LOGIN_FLAG = 'meetscribe.autoLoginAttempted';

export default function LoginScreen() {
  const { instance, inProgress } = useMsal();
  const setUser = useAuthStore((state) => state.setUser);
  const disableAuth = useAuthStore((state) => state.disableAuth);
  const clientId = useAuthStore((state) => state.settings?.clientId ?? '');
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [silentLoginFailed, setSilentLoginFailed] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);

  useEffect(() => {
    // MSAL traite peut-être encore le retour d'une redirection : lancer une autre
    // interaction maintenant lèverait `interaction_in_progress`.
    if (inProgress !== InteractionStatus.None) return;

    const showLoginButton = () => {
      setSilentLoginFailed(true);
      setIsLoading(false);
    };

    /**
     * Sans compte en cache (cache MSAL perdu à la fermeture de l'app), on relance la
     * connexion automatiquement. La WebView partage le compte Windows principal
     * (`additionalBrowserArgs` dans tauri.conf.json), donc Entra ID répond sans rien
     * demander. Une seule tentative par session, pour ne pas boucler si le SSO échoue.
     * Seulement si une connexion a déjà réussi avec ce CLIENT_ID : avec un ID erroné, Entra
     * afficherait sa page d'erreur dans la WebView à chaque lancement, sans retour à l'app.
     */
    const attemptWindowsSso = async () => {
      if (!hasSignedInWith(clientId) || sessionStorage.getItem(AUTO_LOGIN_FLAG)) {
        showLoginButton();
        return;
      }
      sessionStorage.setItem(AUTO_LOGIN_FLAG, '1');
      console.log('No usable cached account, attempting Windows SSO redirect...');
      await instance.loginRedirect({ scopes });
    };

    const attemptSilentLogin = async () => {
      const account = instance.getAllAccounts()[0];
      if (!account) {
        await attemptWindowsSso();
        return;
      }

      try {
        console.log('Found cached account, attempting silent token acquisition...');
        // Sert uniquement à valider la session : le token n'est ni stocké ni utilisé.
        await instance.acquireTokenSilent({ scopes, account });

        setUser({
          userId: account.localAccountId,
          email: account.username,
          name: account.name || account.username,
        });
        sessionStorage.removeItem(AUTO_LOGIN_FLAG);
        setIsLoading(false);
      } catch (error) {
        console.log('Silent token acquisition failed, falling back to Windows SSO:', error);
        await attemptWindowsSso();
      }
    };

    attemptSilentLogin().catch((error) => {
      console.error('Automatic login failed:', error);
      showLoginButton();
    });
  }, [inProgress, instance, setUser, clientId]);

  /** Désactive la connexion (réactivable dans Paramètres) : App affiche alors directement l'app. */
  const handleContinueWithout = async () => {
    setIsDisabling(true);
    setError(null);
    try {
      await disableAuth();
    } catch (error) {
      console.error('Failed to disable sign-in:', error);
      setError(t('login.continueWithoutFailed'));
      setIsDisabling(false);
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Use loginRedirect for Tauri desktop app
      // Le bouton reste le recours manuel : on laisse choisir le compte.
      await instance.loginRedirect({
        scopes,
        prompt: 'select_account',
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Login failed:', errorMsg, error);
      setError(t('login.failed', { error: errorMsg }));
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center w-screen h-screen">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center max-w-md mx-auto px-6"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="mb-8"
        >
          <img src="/logo.png" alt="" className="w-24 h-24 mx-auto drop-shadow-lg" />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="text-4xl font-bold mb-2 text-foreground"
        >
          SealedScribe
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="text-muted-foreground mb-8"
        >
          {t('app.tagline')}
        </motion.p>

        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            role="status"
            className="flex flex-col items-center gap-4"
          >
            <svg className="w-8 h-8 animate-spin text-brand-text" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="62.83" strokeDashoffset="0" opacity="0.25" />
              <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-muted-foreground">{t('login.checking')}</p>
          </motion.div>
        )}

        {!isLoading && silentLoginFailed && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.5 }}
            onClick={handleLogin}
            disabled={isLoading}
            whileHover={{ scale: isLoading ? 1 : 1.02 }}
            whileTap={{ scale: isLoading ? 1 : 0.98 }}
            className={buttonVariants({ size: 'lg', className: 'w-full shadow-md' })}
          >
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M11.4 0H0v11.4h11.4V0zm12.6 0H12v11.4h11.4V0zM11.4 12.6H0V24h11.4v-11.4zm12.6 0H12V24h11.4v-11.4z" />
            </svg>
            {t('login.signIn')}
          </motion.button>
        )}

        {!isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6, duration: 0.3 }}
            className="mt-4 space-y-1"
          >
            <Button variant="link" size="sm" className="h-auto p-0" onClick={handleContinueWithout} disabled={isDisabling}>
              {t('login.continueWithout')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('login.continueWithoutHelp')}</p>
          </motion.div>
        )}

        {error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </motion.div>
        )}

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          className="text-sm text-muted-foreground mt-6"
        >
          {t('login.footer')}
        </motion.p>
      </motion.div>
    </div>
  );
}
