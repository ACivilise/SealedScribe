import { useEffect, useMemo, useState } from 'react';
import { MsalProvider, useIsAuthenticated, useMsal } from '@azure/msal-react';
import LoginScreen from './screens/LoginScreen';
import MainApp from './screens/MainApp';
import DisclaimerScreen from './screens/DisclaimerScreen';
import { useAuthStore } from './store/authStore';
import { useDisclaimerAccepted } from './store/disclaimerStore';
import { useThemeStore } from './store/themeStore';
import { useSkinStore } from './store/skinStore';
import { applySkin } from './lib/skins';
import { createMsalInstance, isAuthActive, scopes } from './config/auth.config';
import { useT } from './i18n';

function StartupScreen() {
  const { t } = useT();
  return (
    <div className="flex items-center justify-center w-screen h-screen bg-background" role="status">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2 text-foreground">SealedScribe</h1>
        <p className="text-muted-foreground">{t('app.initializing')}</p>
      </div>
    </div>
  );
}

function AppContent() {
  const { instance } = useMsal();
  const isMsalAuthenticated = useIsAuthenticated();
  const { isAuthenticated, setUser } = useAuthStore();
  const [isInitialized, setIsInitialized] = useState(false);

  // Sync auth state whenever MSAL authentication changes
  useEffect(() => {
    const syncAuthState = async () => {
      try {
        const accounts = instance.getAllAccounts();

        if (accounts.length > 0 && isMsalAuthenticated) {
          const account = accounts[0];

          try {
            // Sert uniquement à valider la session : le token n'est ni stocké ni utilisé.
            await instance.acquireTokenSilent({
              scopes,
              account,
            });

            setUser({
              userId: account.localAccountId,
              email: account.username,
              name: account.name || account.username,
            });
          } catch (tokenError) {
            console.error('[AppContent] Token acquisition failed:', tokenError);
          }
        }
      } catch (error) {
        console.error('[AppContent] Sync error:', error);
      } finally {
        setIsInitialized(true);
      }
    };

    syncAuthState();
  }, [instance, isMsalAuthenticated, setUser]);

  if (!isInitialized) {
    return <StartupScreen />;
  }

  return isAuthenticated ? <MainApp /> : <LoginScreen />;
}

/** Connexion Microsoft exigée : une instance MSAL par couple CLIENT_ID / TENANT_ID. */
function AuthGate({ clientId, tenantId }: { clientId: string; tenantId: string }) {
  const msalInstance = useMemo(() => createMsalInstance(clientId, tenantId), [clientId, tenantId]);
  return (
    <MsalProvider instance={msalInstance}>
      <AppContent />
    </MsalProvider>
  );
}

function App() {
  const { updateDarkMode } = useThemeStore();
  const skin = useSkinStore((state) => state.skin);
  const authSettings = useAuthStore((state) => state.settings);
  const loadAuthSettings = useAuthStore((state) => state.loadSettings);
  const disclaimerAccepted = useDisclaimerAccepted();

  useEffect(() => {
    // Initialise le thème, puis suit les changements du système
    updateDarkMode();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', updateDarkMode);
    return () => {
      mediaQuery.removeEventListener('change', updateDarkMode);
    };
  }, [updateDarkMode]);

  // Habillage choisi dans les Paramètres, posé sur <html> dès le démarrage.
  useEffect(() => applySkin(skin), [skin]);

  // Réglages de connexion lus dans les préférences ; ensuite mis à jour par les Paramètres.
  useEffect(() => {
    loadAuthSettings();
  }, [loadAuthSettings]);

  // Avant tout le reste, connexion Microsoft comprise : l'avertissement doit être accepté.
  if (!disclaimerAccepted) {
    return <DisclaimerScreen />;
  }

  if (!authSettings) {
    return <StartupScreen />;
  }

  if (!isAuthActive(authSettings)) {
    return <MainApp />;
  }

  // `key` : changer d'IDs dans les Paramètres recrée l'instance MSAL et revalide la session.
  return (
    <AuthGate
      key={`${authSettings.clientId}|${authSettings.tenantId}`}
      clientId={authSettings.clientId}
      tenantId={authSettings.tenantId}
    />
  );
}

export default App;
