import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import SettingsModal from './SettingsModal';
import type { UserPreferences } from '../../services/preferencesService';
import type { LocalLlmModel } from '../../services/summaryService';
import { useSkinStore } from '../../store/skinStore';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUpdateStore } from '../../store/updateStore';
import { TOUR_STEPS } from '../../lib/onboarding';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const GB = 1_000_000_000;

const prefs = (overrides: Partial<UserPreferences> = {}): UserPreferences => ({
  default_language: 'fr-FR',
  auto_summary: false,
  save_locally: true,
  theme: 'system',
  recordings_directory: 'D:\\rec',
  transcription_engine: 'local',
  local_model: 'large-v3-turbo',
  summary_engine: 'ollama',
  local_llm_url: '',
  local_llm_model: 'qwen3:4b',
  mistral_transcription_model: '',
  mistral_summary_model: '',
  auth_enabled: false,
  azure_ad_client_id: '',
  azure_ad_tenant_id: '',
  ...overrides,
});

const whisperStatus = {
  models: [],
  loadedModel: null,
  loadedDevice: null,
  hardware: {
    gpus: [{ name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', vendor: 'nvidia', memoryBytes: 4 * 1024 ** 3 }],
    totalMemoryBytes: 32 * 1024 ** 3,
    physicalCores: 8,
    logicalCores: 16,
    avx2: true,
  },
  diarization: { installed: false, outdated: false, sizeBytes: 0, missingBytes: 0 },
};

const notConfigured = {
  speechConfigured: false,
  aiInferenceConfigured: false,
  aiEndpointConfigured: false,
  aiKeyConfigured: false,
  speechRegion: 'francecentral',
  mistralConfigured: false,
};

/** Backend simulé : préférences et clés données, et réponse de `list_local_llm_models`. */
function mockBackend(
  preferences: UserPreferences,
  listModels: () => Promise<LocalLlmModel[]>,
  credentials: typeof notConfigured = notConfigured
) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    switch (command) {
      case 'load_preferences':
        return preferences;
      case 'get_local_whisper_status':
        return whisperStatus;
      case 'get_credentials_status':
        return credentials;
      case 'get_launch_at_startup':
        return false;
      case 'list_local_llm_models':
        return listModels();
      default:
        return undefined;
    }
  });
}

const openAiTab = async () => {
  await screen.findByRole('tab', { name: 'AI summary' });
  await userEvent.click(screen.getByRole('tab', { name: 'AI summary' }));
};

const listCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_local_llm_models');

beforeAll(() => {
  // jsdom n'implémente pas ce que les listes déroulantes Radix appellent à l'ouverture.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('SettingsModal — moteur de transcription', () => {
  const openTranscriptionTab = async () => {
    await userEvent.click(await screen.findByRole('tab', { name: 'Transcription' }));
  };

  it('n’a plus d’onglet Azure Speech : clé et région se saisissent dans Transcription', async () => {
    mockBackend(prefs({ transcription_engine: 'azure' }), async () => []);
    render(<SettingsModal onClose={vi.fn()} />);
    await openTranscriptionTab();

    expect(screen.queryByRole('tab', { name: 'Azure Speech' })).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Speech key'), 'ma-cle');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_azure_credentials', expect.objectContaining({ speechKey: 'ma-cle' }))
    );
  });

  it('masque la clé Azure Speech avec le moteur local', async () => {
    mockBackend(prefs({ transcription_engine: 'local' }), async () => []);
    render(<SettingsModal onClose={vi.fn()} />);
    await openTranscriptionTab();

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Transcription engine' })).toHaveTextContent('Local model')
    );
    expect(screen.queryByLabelText('Speech key')).not.toBeInTheDocument();
  });
});

describe('SettingsModal — Mistral AI', () => {
  it('transcription : le moteur Mistral demande la clé et l’enregistre avec le choix du moteur', async () => {
    mockBackend(prefs({ transcription_engine: 'azure' }), async () => []);
    render(<SettingsModal onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Transcription' }));

    await userEvent.click(screen.getByRole('combobox', { name: 'Transcription engine' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Mistral AI (Voxtral, cloud)' }));
    expect(screen.queryByLabelText('Speech key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', 'voxtral-mini-latest');
    await userEvent.type(screen.getByLabelText('Mistral AI API key'), 'cle-mistral');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_azure_credentials', expect.objectContaining({ mistralKey: 'cle-mistral' }))
    );
    expect(invoke).toHaveBeenCalledWith('save_preferences', {
      preferences: expect.objectContaining({ transcription_engine: 'mistral' }),
    });
  });

  it('résumé : la même clé est proposée, avec le modèle par défaut et la suppression de la clé', async () => {
    mockBackend(prefs({ summary_engine: 'mistral' }), async () => [], { ...notConfigured, mistralConfigured: true });
    render(<SettingsModal onClose={vi.fn()} />);
    await openAiTab();

    expect(await screen.findByText('Mistral AI: configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', 'mistral-medium-latest');
    expect(screen.queryByLabelText('AI Inference key')).not.toBeInTheDocument();
    expect(listCalls()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Remove keys' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove keys' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_azure_credentials', { mistralKey: '' }));
  });
});

describe('SettingsModal — résumé par un modèle local', () => {
  it('liste les modèles déjà installés dans Ollama et dit si le modèle choisi tient sur la carte', async () => {
    mockBackend(prefs(), async () => [
      { name: 'qwen3:4b', sizeBytes: 2.5 * GB, fitsGpu: true },
      { name: 'qwen3:8b', sizeBytes: 5.2 * GB, fitsGpu: false },
    ]);
    render(<SettingsModal onClose={vi.fn()} />);
    await openAiTab();

    expect(await screen.findByText('Server reachable. Installed models: 2.')).toBeInTheDocument();
    expect(listCalls()[0][1]).toEqual({ engine: 'ollama', url: '' });
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('qwen3:4b');
    expect(screen.getByText(/Size: 2.5 GB\. The model fits on the graphics card \(NVIDIA GeForce RTX 3050 Ti Laptop GPU/)).toBeInTheDocument();
    // Pas de champ de clé Azure en mode local.
    expect(screen.queryByLabelText('AI Inference key')).not.toBeInTheDocument();
  });

  it('dit pourquoi la liste est vide quand le serveur ne répond pas, et laisse saisir le modèle', async () => {
    const error = "Impossible de joindre Ollama à l'adresse http://127.0.0.1:11434. Vérifiez qu'il est lancé sur ce PC.";
    mockBackend(prefs({ local_llm_model: '' }), () => Promise.reject(error));
    render(<SettingsModal onClose={vi.fn()} />);
    await openAiTab();

    expect(await screen.findByText(`Cannot list the models. ${error}`)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Model' }), 'qwen3:4b');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('enregistre le moteur et le modèle avec les autres préférences', async () => {
    mockBackend(prefs({ summary_engine: 'azure', local_llm_model: '' }), async () => [
      { name: 'qwen3:4b', sizeBytes: 2.5 * GB, fitsGpu: true },
    ]);
    render(<SettingsModal onClose={vi.fn()} />);
    await openAiTab();

    await userEvent.click(screen.getByRole('combobox', { name: 'Summary engine' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Ollama (on this PC)' }));
    await screen.findByText('Server reachable. Installed models: 1.');
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'qwen3:4b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_preferences', {
        preferences: expect.objectContaining({ summary_engine: 'ollama', local_llm_url: '', local_llm_model: 'qwen3:4b' }),
      })
    );
  });
});

describe('SettingsModal — habillage', () => {
  beforeEach(() => {
    useSkinStore.setState({ skin: 'cassette' });
    delete document.documentElement.dataset.skin;
    // Annuler rétablit aussi le thème, qui consulte matchMedia (absent de jsdom).
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  });

  it('applique l’habillage choisi tout de suite, avec sa description, et Annuler rétablit le précédent', async () => {
    mockBackend(prefs(), async () => []);
    const onClose = vi.fn();
    render(<SettingsModal onClose={onClose} />);

    await userEvent.click(await screen.findByRole('combobox', { name: 'Skin' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Newspaper' }));

    expect(document.documentElement.dataset.skin).toBe('journal');
    expect(screen.getByText(/Newsprint and black ink/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useSkinStore.getState().skin).toBe('cassette');
    expect(document.documentElement.dataset.skin).toBe('cassette');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SettingsModal — version Microsoft Store', () => {
  beforeEach(() => {
    useUpdateStore.setState({ distribution: 'store' });
  });

  afterEach(() => {
    useUpdateStore.setState({ distribution: null });
  });

  it('ne propose pas de rechercher une mise à jour : le Store s’en charge', async () => {
    mockBackend(prefs(), async () => []);
    render(<SettingsModal onClose={vi.fn()} />);

    expect(await screen.findByText('Updates come from the Microsoft Store.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument();
  });

  it('explique comment réactiver le lancement au démarrage coupé dans Windows', async () => {
    mockBackend(prefs(), async () => []);
    const backend = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === 'set_launch_at_startup' ? Promise.reject('startup-disabled-by-user') : backend(command, args)
    );
    render(<SettingsModal onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Start SealedScribe when Windows starts' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/turn SealedScribe back on in Settings > Apps > Startup/)).toBeInTheDocument();
  });
});

describe('SettingsModal — visite guidée', () => {
  beforeEach(() => {
    useOnboardingStore.setState({ completed: true, stepIndex: null });
  });

  it('affiche l’onglet qui contient l’élément présenté par l’étape en cours', async () => {
    mockBackend(prefs({ transcription_engine: 'local' }), async () => []);
    useOnboardingStore.setState({ stepIndex: TOUR_STEPS.findIndex((step) => step.id === 'engine') });
    render(<SettingsModal onClose={vi.fn()} />);
    expect(await screen.findByRole('tab', { name: 'Transcription', selected: true })).toBeInTheDocument();
  });

  it('« Revoir la visite guidée » la relance depuis le début', async () => {
    mockBackend(prefs(), async () => []);
    render(<SettingsModal onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Replay the guided tour' }));
    expect(useOnboardingStore.getState().stepIndex).toBe(0);
  });
});
