import { create } from 'zustand';
import type { AuthSettings } from '../config/auth.config';
import { loadPreferences, savePreferences } from '../services/preferencesService';

interface UserSession {
  userId: string;
  email: string;
  name: string;
}

/** Dernier CLIENT_ID avec lequel une connexion a réussi (autorise la redirection SSO automatique). */
const LAST_SIGNED_IN_CLIENT_KEY = 'meetscribe.lastSignedInClientId';

const DISABLED: AuthSettings = { enabled: false, clientId: '', tenantId: '' };

/** Vrai si une connexion a déjà réussi avec ce CLIENT_ID sur ce poste. */
export function hasSignedInWith(clientId: string): boolean {
  try {
    return localStorage.getItem(LAST_SIGNED_IN_CLIENT_KEY) === clientId.trim();
  } catch {
    return false;
  }
}

function rememberSignedInClient(clientId: string | undefined) {
  if (!clientId) return;
  try {
    localStorage.setItem(LAST_SIGNED_IN_CLIENT_KEY, clientId.trim());
  } catch {
    // Stockage indisponible : la prochaine connexion passera par le bouton.
  }
}

interface AuthStore {
  isAuthenticated: boolean;
  user: UserSession | null;
  /** Réglages de connexion ; `null` tant qu'ils ne sont pas chargés depuis les préférences. */
  settings: AuthSettings | null;
  setUser: (user: UserSession) => void;
  clearUser: () => void;
  loadSettings: () => Promise<void>;
  setSettings: (settings: AuthSettings) => void;
  /** Désactive la connexion (préférences sauvegardées), en conservant les IDs saisis. */
  disableAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  isAuthenticated: false,
  user: null,
  settings: null,
  setUser: (user: UserSession) => {
    rememberSignedInClient(get().settings?.clientId);
    set({ isAuthenticated: true, user });
  },
  clearUser: () => set({ isAuthenticated: false, user: null }),
  loadSettings: async () => {
    try {
      const prefs = await loadPreferences();
      set({
        settings: {
          enabled: prefs.auth_enabled ?? false,
          clientId: prefs.azure_ad_client_id ?? '',
          tenantId: prefs.azure_ad_tenant_id ?? '',
        },
      });
    } catch (error) {
      // Préférences illisibles : on ouvre l'app sans connexion plutôt que de la bloquer.
      console.error('Failed to load auth settings:', error);
      set({ settings: DISABLED });
    }
  },
  setSettings: (settings: AuthSettings) => {
    // Changer de configuration invalide la session : elle sera revalidée par MSAL si besoin.
    set({ settings, isAuthenticated: false, user: null });
  },
  disableAuth: async () => {
    const prefs = await loadPreferences();
    await savePreferences({ ...prefs, auth_enabled: false });
    get().setSettings({
      enabled: false,
      clientId: prefs.azure_ad_client_id ?? '',
      tenantId: prefs.azure_ad_tenant_id ?? '',
    });
  },
}));
