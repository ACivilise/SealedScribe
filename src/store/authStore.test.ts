import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { hasSignedInWith, useAuthStore } from './authStore';
import type { UserPreferences } from '../services/preferencesService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const CLIENT = '0f8fad5b-d9cb-469f-a165-70867728950e';

const prefs = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  default_language: 'fr-FR',
  auto_summary: false,
  save_locally: true,
  theme: 'dark',
  recordings_directory: 'D:\\rec',
  transcription_engine: 'local',
  local_model: 'tiny',
  summary_engine: 'azure',
  local_llm_url: '',
  local_llm_model: '',
  mistral_transcription_model: '',
  mistral_summary_model: '',
  auth_enabled: true,
  azure_ad_client_id: CLIENT,
  azure_ad_tenant_id: 'organizations',
  ...overrides,
});

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: false, user: null, settings: null });
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

describe('authStore.loadSettings', () => {
  it('lit les réglages de connexion dans les préférences', async () => {
    vi.mocked(invoke).mockResolvedValue(prefs());
    await useAuthStore.getState().loadSettings();
    expect(invoke).toHaveBeenCalledWith('load_preferences');
    expect(useAuthStore.getState().settings).toEqual({
      enabled: true,
      clientId: CLIENT,
      tenantId: 'organizations',
    });
  });

  it('ouvre l’app sans connexion si les préférences sont illisibles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error('pas de Tauri'));
    await useAuthStore.getState().loadSettings();
    expect(useAuthStore.getState().settings).toEqual({ enabled: false, clientId: '', tenantId: '' });
  });
});

describe('authStore.disableAuth', () => {
  it('désactive la connexion en conservant les IDs et les autres préférences', async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'load_preferences' ? prefs() : undefined
    );
    useAuthStore.setState({ isAuthenticated: true, user: { userId: 'u', email: 'e', name: 'n' } });

    await useAuthStore.getState().disableAuth();

    expect(invoke).toHaveBeenCalledWith('save_preferences', { preferences: prefs({ auth_enabled: false }) });
    const state = useAuthStore.getState();
    expect(state.settings).toEqual({ enabled: false, clientId: CLIENT, tenantId: 'organizations' });
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
  });

  it('ne change rien si la sauvegarde échoue', async () => {
    const settings = { enabled: true, clientId: CLIENT, tenantId: 'organizations' };
    useAuthStore.setState({ settings });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'load_preferences') return prefs();
      throw new Error('disque plein');
    });

    await expect(useAuthStore.getState().disableAuth()).rejects.toThrow('disque plein');
    expect(useAuthStore.getState().settings).toEqual(settings);
  });
});

describe('authStore.setUser', () => {
  it('mémorise le CLIENT_ID de la connexion réussie (redirection SSO autorisée ensuite)', () => {
    useAuthStore.setState({ settings: { enabled: true, clientId: CLIENT, tenantId: 'organizations' } });
    expect(hasSignedInWith(CLIENT)).toBe(false);

    useAuthStore.getState().setUser({ userId: 'u', email: 'e', name: 'n' });

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(hasSignedInWith(CLIENT)).toBe(true);
    expect(hasSignedInWith('11111111-1111-1111-1111-111111111111')).toBe(false);
  });
});
