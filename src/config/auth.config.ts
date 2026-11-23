import { Configuration, PublicClientApplication } from '@azure/msal-browser';

/** Réglages de la connexion Microsoft, saisis dans Paramètres > Général. */
export interface AuthSettings {
  enabled: boolean;
  clientId: string;
  tenantId: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Nom de domaine d'un annuaire (ex. `contoso.onmicrosoft.com`). */
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TENANT_ALIASES = ['common', 'organizations'];

/** ID d'application (client) Entra ID : un GUID. */
export const isValidClientId = (value: string) => GUID.test(value.trim());

/** ID de l'annuaire : GUID, domaine ou alias multi-locataire. Il est inséré dans l'URL d'autorité. */
export const isValidTenantId = (value: string) => {
  const tenant = value.trim();
  return GUID.test(tenant) || DOMAIN.test(tenant) || TENANT_ALIASES.includes(tenant.toLowerCase());
};

/**
 * La connexion n'est exigée que si elle est activée avec des IDs valides : un `preferences.json`
 * modifié à la main avec des IDs invalides ouvre l'app sans connexion plutôt que de la bloquer.
 */
export const isAuthActive = (settings: AuthSettings | null): settings is AuthSettings =>
  !!settings && settings.enabled && isValidClientId(settings.clientId) && isValidTenantId(settings.tenantId);

const buildMsalConfig = (clientId: string, tenantId: string): Configuration => ({
  auth: {
    clientId: clientId.trim(),
    authority: `https://login.microsoftonline.com/${tenantId.trim()}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    // localStorage : nécessaire à la connexion silencieuse au relancement. Seul un token user.read
    // y est mis en cache, et il n'est pas utilisé pour les services Azure (clés dans le keyring).
    cacheLocation: 'localStorage',
  },
  system: {
    allowPlatformBroker: false,
    loggerOptions: {
      // Niveaux MSAL : 0 = Error, 1 = Warning, 2 = Info, 3 = Verbose. On ignore Info et Verbose.
      logLevel: 1,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) {
          return;
        }
        if (level === 0) {
          console.error('MSAL Error:', message);
        } else if (level === 1) {
          console.warn('MSAL Warning:', message);
        }
      },
      piiLoggingEnabled: false,
    },
  },
});

export const createMsalInstance = (clientId: string, tenantId: string) =>
  new PublicClientApplication(buildMsalConfig(clientId, tenantId));

export const scopes = [
  'user.read',
  'openid',
  'profile',
];
