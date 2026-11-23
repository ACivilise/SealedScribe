import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { loadPreferences, savePreferences, type UserPreferences } from '../../services/preferencesService';
import { isValidClientId, isValidTenantId, type AuthSettings } from '../../config/auth.config';
import { useAuthStore } from '../../store/authStore';
import { open } from '@tauri-apps/plugin-dialog';
import { Folder, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
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
import { useLocalWhisper } from '../../hooks/useLocalWhisper';
import {
  DIARIZATION_ID,
  cudaGpu,
  formatBytes,
  formatMemory,
  type TranscriptionEngine,
} from '../../services/localWhisperService';
import {
  DEFAULT_LOCAL_LLM_URL,
  listLocalModels,
  type LocalLlmModel,
  type LocalSummaryEngine,
  type SummaryEngine,
} from '../../services/summaryService';
import { DEFAULT_MISTRAL_CHAT_MODEL, DEFAULT_MISTRAL_TRANSCRIPTION_MODEL } from '../../services/mistral';
import { DiarizationSettings } from './DiarizationSettings';
import DisclaimerModal from './DisclaimerModal';
import { Notice } from '../common/Notice';
import { useDisclaimerStore } from '../../store/disclaimerStore';
import type { MessageKey } from '../../i18n';
import { useThemeStore } from '../../store/themeStore';
import { useSkinStore } from '../../store/skinStore';
import { isSkin, SKINS, type Skin } from '../../lib/skins';
import { AVAILABLE_LOCALES, useLocaleStore, useT, type LocalePreference } from '../../i18n';
import pkg from '../../../package.json';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  CredentialsStatus,
  getCredentialsStatus,
  saveAzureCredentials,
} from '../../services/credentialsService';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Réglages de connexion tels qu'enregistrés (IDs sans espaces superflus). */
const toAuthSettings = (prefs: UserPreferences): AuthSettings => ({
  enabled: prefs.auth_enabled,
  clientId: prefs.azure_ad_client_id.trim(),
  tenantId: prefs.azure_ad_tenant_id.trim(),
});

const sameAuthSettings = (a: AuthSettings | null, b: AuthSettings) =>
  !!a && a.enabled === b.enabled && a.clientId === b.clientId && a.tenantId === b.tenantId;

/** Libellé et aide de chaque modèle local (ids du catalogue Rust `local_whisper::MODELS`). */
/** Modèles du moteur local, dans l'ordre du catalogue Rust (`MODELS`). */
const LOCAL_MODEL_TEXT: Record<string, { label: MessageKey; help: MessageKey }> = {
  'large-v3-turbo': { label: 'settings.modelTurbo', help: 'settings.modelTurboHelp' },
  'large-v3-turbo-q5': { label: 'settings.modelTurboQ5', help: 'settings.modelTurboQ5Help' },
  'large-v3-french': { label: 'settings.modelFrench', help: 'settings.modelFrenchHelp' },
  medium: { label: 'settings.modelMedium', help: 'settings.modelMediumHelp' },
  small: { label: 'settings.modelSmall', help: 'settings.modelSmallHelp' },
};

const ENGINE_HELP: Record<TranscriptionEngine, MessageKey> = {
  azure: 'settings.engineAzureHelp',
  local: 'settings.engineLocalHelp',
  mistral: 'settings.engineMistralHelp',
};

const SUMMARY_ENGINE_HELP: Record<SummaryEngine, MessageKey> = {
  azure: 'settings.summaryEngineAzureHelp',
  mistral: 'settings.summaryEngineMistralHelp',
  ollama: 'settings.summaryEngineOllamaHelp',
  openai: 'settings.summaryEngineOpenaiHelp',
};

/** Modèles trouvés sur le serveur local de résumé. */
interface LocalModelsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  models: LocalLlmModel[];
  error?: string;
}

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'general' | 'transcription' | 'ai';
/** Groupe de clés supprimé ensemble. */
type KeysGroup = 'ai' | 'speech' | 'mistral';

const REMOVE_KEYS_DESCRIPTION: Record<KeysGroup, MessageKey> = {
  ai: 'settings.removeAiKeysDescription',
  speech: 'settings.removeSpeechKeysDescription',
  mistral: 'settings.removeMistralKeyDescription',
};

/**
 * Modèle de sauvegarde : tous les réglages forment un brouillon, appliqué par « Enregistrer »
 * et abandonné par « Annuler » (ou Échap / croix). Thème et langue s'appliquent tout de
 * suite pour l'aperçu et sont rétablis à l'annulation.
 * Actions immédiates (hors brouillon) : télécharger / supprimer un modèle local, supprimer des clés.
 */
/** Nom et description de chaque habillage (Général > Apparence). */
const SKIN_TEXTS = {
  cassette: { name: 'settings.skinCassette', hint: 'settings.skinCassetteHint' },
  terminal: { name: 'settings.skinTerminal', hint: 'settings.skinTerminalHint' },
  journal: { name: 'settings.skinJournal', hint: 'settings.skinJournalHint' },
  glacier: { name: 'settings.skinGlacier', hint: 'settings.skinGlacierHint' },
} as const satisfies Record<Skin, { name: MessageKey; hint: MessageKey }>;

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { theme, setTheme } = useThemeStore();
  const skin = useSkinStore((state) => state.skin);
  const setSkin = useSkinStore((state) => state.setSkin);
  const { t, intlLocale, formatDate } = useT();
  const disclaimerAcceptedAt = useDisclaimerStore((state) => state.acceptedAt);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const localWhisper = useLocalWhisper();
  const [confirmDeleteModel, setConfirmDeleteModel] = useState(false);
  const localePreference = useLocaleStore((state) => state.preference);
  const setLocalePreference = useLocaleStore((state) => state.setPreference);
  const [isSaving, setIsSaving] = useState(false);
  // `savedPreferences` : état sur disque ; `preferences` : brouillon affiché.
  const [savedPreferences, setSavedPreferences] = useState<UserPreferences | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [savedLaunchAtStartup, setSavedLaunchAtStartup] = useState(false);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Thème, habillage et langue à l'ouverture, rétablis si l'utilisateur annule.
  const initialTheme = useRef(theme);
  const initialSkin = useRef(skin);
  const initialLocale = useRef(localePreference);
  const [credentials, setCredentials] = useState<CredentialsStatus | null>(null);
  const [speechKey, setSpeechKey] = useState('');
  const [speechRegion, setSpeechRegion] = useState('');
  const [aiEndpoint, setAiEndpoint] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [mistralKey, setMistralKey] = useState('');
  const [tab, setTab] = useState<SettingsTab>('general');
  const [confirmRemoveKeys, setConfirmRemoveKeys] = useState<KeysGroup | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelsState>({ status: 'idle', models: [] });
  /** Numéro de la dernière recherche de modèles : une réponse plus ancienne est ignorée. */
  const modelsRequest = useRef(0);
  const authSettings = useAuthStore((state) => state.settings);
  const setAuthSettings = useAuthStore((state) => state.setSettings);

  // Load preferences on mount
  useEffect(() => {
    const loadPrefs = async () => {
      try {
        const prefs = await loadPreferences();
        setSavedPreferences(prefs);
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load preferences:', error);
        setSaveError(t('settings.loadFailed'));
      }
    };
    loadPrefs();

    getCredentialsStatus()
      .then(setCredentials)
      .catch((error) => console.error('Failed to read credentials status:', error));

    // L'état réel est celui de Windows (entrée de démarrage automatique).
    invoke<boolean>('get_launch_at_startup')
      .then((enabled) => {
        setSavedLaunchAtStartup(enabled);
        setLaunchAtStartup(enabled);
      })
      .catch((error) => console.error('Failed to read startup setting:', error));
  }, []);

  const updateDraft = (changes: Partial<UserPreferences>) =>
    setPreferences((prev) => (prev ? { ...prev, ...changes } : prev));

  const handleBrowseDirectory = async () => {
    setSaveError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: preferences?.recordings_directory || undefined,
        title: t('settings.chooseFolderTitle'),
      });
      if (selected && typeof selected === 'string') {
        updateDraft({ recordings_directory: selected });
      }
    } catch (error) {
      console.error('Failed to open directory picker:', error);
      setSaveError(t('settings.folderPickerFailed'));
    }
  };

  const hasSpeechInput = [speechKey, speechRegion].some((v) => v.trim() !== '');
  const hasAiInput = [aiEndpoint, aiKey, aiModel].some((v) => v.trim() !== '');
  const hasMistralInput = mistralKey.trim() !== '';
  const prefsChanged = JSON.stringify(preferences) !== JSON.stringify(savedPreferences);
  const startupChanged = launchAtStartup !== savedLaunchAtStartup;
  const isDirty =
    prefsChanged ||
    startupChanged ||
    hasSpeechInput ||
    hasAiInput ||
    hasMistralInput ||
    theme !== initialTheme.current ||
    skin !== initialSkin.current ||
    localePreference !== initialLocale.current;
  // Connexion activée : les deux IDs doivent être valides avant d'enregistrer.
  const authEnabled = preferences?.auth_enabled ?? false;
  const clientIdInvalid = authEnabled && !isValidClientId(preferences?.azure_ad_client_id ?? '');
  const tenantIdInvalid = authEnabled && !isValidTenantId(preferences?.azure_ad_tenant_id ?? '');

  const handleCancel = () => {
    setTheme(initialTheme.current);
    setSkin(initialSkin.current);
    setLocalePreference(initialLocale.current);
    onClose();
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    // Étapes successives : en cas d'échec, ce qui est déjà enregistré le reste
    // et la modale reste ouverte avec le message de l'étape fautive.
    try {
      if (prefsChanged && preferences) {
        try {
          await savePreferences(preferences);
          setSavedPreferences(preferences);
        } catch (error) {
          console.error('Failed to save preferences:', error);
          throw new Error(t('settings.saveFailed'));
        }
      }
      if (startupChanged) {
        try {
          await invoke('set_launch_at_startup', { enabled: launchAtStartup });
          setSavedLaunchAtStartup(launchAtStartup);
        } catch (error) {
          console.error('Failed to update startup setting:', error);
          throw new Error(t('settings.startupFailed'));
        }
      }
      if (hasSpeechInput || hasAiInput || hasMistralInput) {
        try {
          // Champ vide : valeur inchangée côté backend.
          const status = await saveAzureCredentials({
            speechKey: speechKey.trim() || undefined,
            speechRegion: speechRegion.trim() || undefined,
            aiEndpoint: aiEndpoint.trim() || undefined,
            aiKey: aiKey.trim() || undefined,
            aiModel: aiModel.trim() || undefined,
            mistralKey: mistralKey.trim() || undefined,
          });
          setCredentials(status);
          setSpeechKey('');
          setSpeechRegion('');
          setAiEndpoint('');
          setAiKey('');
          setAiModel('');
          setMistralKey('');
        } catch (error) {
          console.error('Failed to save Azure credentials:', error);
          throw new Error(typeof error === 'string' ? error : t('settings.keysSaveFailed'));
        }
      }
      // Appliqué en dernier : activer ou désactiver la connexion remplace l'écran (et ferme la modale).
      if (preferences && !sameAuthSettings(authSettings, toAuthSettings(preferences))) {
        setAuthSettings(toAuthSettings(preferences));
      }
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  // Suppression : action immédiate et confirmée, hors brouillon.
  const handleRemoveKeys = async (group: KeysGroup) => {
    setSaveError(null);
    try {
      const status = await saveAzureCredentials(
        group === 'speech'
          ? { speechKey: '', speechRegion: '' }
          : group === 'mistral'
            ? { mistralKey: '' }
            : { aiEndpoint: '', aiKey: '', aiModel: '' }
      );
      setCredentials(status);
    } catch (error) {
      console.error('Failed to remove Azure credentials:', error);
      setSaveError(t('settings.keysRemoveFailed'));
    }
  };

  const renderRemoveKeys = (group: KeysGroup, configured: boolean) =>
    configured && (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-destructive"
        onClick={() => setConfirmRemoveKeys(group)}
        disabled={isSaving}
      >
        {t('settings.removeKeys')}
      </Button>
    );

  /** Clé Mistral : une seule pour la transcription et le résumé, affichée là où Mistral est choisi. */
  const renderMistralKey = (id: string) => (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={credentials?.mistralConfigured ? 'success' : 'secondary'}>
          {t('settings.mistralStatus', {
            state: credentials?.mistralConfigured ? t('settings.configured') : t('settings.notConfigured'),
          })}
        </Badge>
        {renderRemoveKeys('mistral', Boolean(credentials?.mistralConfigured))}
      </div>
      <div className="space-y-2">
        <Label htmlFor={id}>{t('settings.mistralKey')}</Label>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={mistralKey}
          onChange={(e) => setMistralKey(e.target.value)}
          placeholder={credentials?.mistralConfigured ? t('settings.keepCurrentKey') : t('settings.pasteKey')}
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {t('settings.mistralKeyHelp')}
        </p>
      </div>
    </>
  );

  /** Champ du modèle Mistral (vide : modèle par défaut). */
  const renderMistralModel = (
    id: string,
    field: 'mistral_transcription_model' | 'mistral_summary_model',
    defaultModel: string,
    help: MessageKey
  ) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('settings.mistralModel')}</Label>
      <Input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={preferences?.[field] ?? ''}
        onChange={(e) => updateDraft({ [field]: e.target.value })}
        placeholder={defaultModel}
        disabled={!preferences || isSaving}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t(help, { model: defaultModel })}
      </p>
    </div>
  );

  const engine: TranscriptionEngine = preferences?.transcription_engine ?? 'azure';
  const selectedModelId = preferences?.local_model ?? 'large-v3-turbo';
  const selectedModel = localWhisper.status?.models.find((m) => m.id === selectedModelId);
  const selectedModelText = LOCAL_MODEL_TEXT[selectedModelId];
  const modelLoaded = localWhisper.status?.loadedModel === selectedModelId;
  /** Carte graphique prévue mais whisper.cpp est retombé sur le processeur (DLL CUDA, pilote…). */
  const gpuFallback = modelLoaded && selectedModel?.device === 'gpu' && localWhisper.status?.loadedDevice === 'cpu';
  const install = localWhisper.install;

  const hardware = localWhisper.status?.hardware;
  const gpu = hardware ? cudaGpu(hardware) : undefined;
  const hardwareText = !hardware
    ? null
    : gpu
      ? t('settings.hardwareGpu', {
          gpu: gpu.name,
          memory: formatMemory(gpu.memoryBytes, intlLocale),
          ram: formatMemory(hardware.totalMemoryBytes, intlLocale),
          cores: hardware.physicalCores,
        })
      : t('settings.hardwareNoGpu', {
          ram: formatMemory(hardware.totalMemoryBytes, intlLocale),
          cores: hardware.physicalCores,
        });

  const handleEngineChange = (value: string) => {
    if (value === 'azure' || value === 'local' || value === 'mistral') {
      updateDraft({ transcription_engine: value });
      if (value === 'local') localWhisper.refresh();
    }
  };

  const handleModelChange = (value: string) => {
    if (value in LOCAL_MODEL_TEXT) {
      updateDraft({ local_model: value });
    }
  };

  // Résumé : Azure, ou un modèle déjà installé dans un serveur local (Ollama, LM Studio…).
  const summaryEngine: SummaryEngine = preferences?.summary_engine ?? 'azure';
  const localEngine: LocalSummaryEngine | null =
    summaryEngine === 'ollama' || summaryEngine === 'openai' ? summaryEngine : null;
  const localUrl = preferences?.local_llm_url ?? '';
  const localModel = preferences?.local_llm_model ?? '';
  // Lu par l'effet ci-dessous sans le relancer à chaque frappe dans le champ.
  const localUrlRef = useRef(localUrl);
  localUrlRef.current = localUrl;

  const detectModels = useCallback(async (engine: LocalSummaryEngine, url: string) => {
    const request = ++modelsRequest.current;
    setLocalModels((prev) => ({ status: 'loading', models: prev.models }));
    try {
      const models = await listLocalModels(engine, url.trim());
      if (request === modelsRequest.current) setLocalModels({ status: 'ready', models });
    } catch (error) {
      if (request === modelsRequest.current) {
        setLocalModels({ status: 'error', models: [], error: typeof error === 'string' ? error : '' });
      }
    }
  }, []);

  // Liste des modèles à l'ouverture de l'onglet et à chaque changement de moteur local.
  useEffect(() => {
    if (tab === 'ai' && localEngine) detectModels(localEngine, localUrlRef.current);
  }, [tab, localEngine, detectModels]);

  const handleSummaryEngineChange = (value: string) => {
    if (value !== 'azure' && value !== 'mistral' && value !== 'ollama' && value !== 'openai') return;
    // Adresse et modèle d'Ollama ne valent pas pour un autre serveur local (et inversement).
    const switchingServer =
      localEngine !== null && (value === 'ollama' || value === 'openai') && value !== localEngine;
    setLocalModels({ status: 'idle', models: [] });
    updateDraft(
      switchingServer
        ? { summary_engine: value, local_llm_url: '', local_llm_model: '' }
        : { summary_engine: value }
    );
  };

  // Le modèle enregistré reste proposé même s'il n'est plus sur le serveur.
  const localModelNames = localModels.models.map((m) => m.name);
  const localModelOptions =
    localModel && !localModelNames.includes(localModel) ? [localModel, ...localModelNames] : localModelNames;
  const selectedLocalModel = localModels.models.find((m) => m.name === localModel);
  const localGpuLabel = gpu ? `${gpu.name}, ${formatMemory(gpu.memoryBytes, intlLocale)}` : null;
  const localModelHint = (() => {
    if (selectedLocalModel?.sizeBytes == null) return null;
    const size = formatBytes(selectedLocalModel.sizeBytes, intlLocale);
    if (localGpuLabel && selectedLocalModel.fitsGpu !== null) {
      return t(selectedLocalModel.fitsGpu ? 'settings.localModelFitsGpu' : 'settings.localModelTooBigForGpu', {
        size,
        gpu: localGpuLabel,
      });
    }
    return t('settings.localModelSize', { size });
  })();
  const localModelsStatus =
    localModels.status === 'loading'
      ? t('settings.detectingModels')
      : localModels.status === 'error'
        ? t('settings.modelsDetectFailed', { error: localModels.error ?? '' })
        : localModels.status === 'ready'
          ? localModels.models.length > 0
            ? t('settings.modelsFound', { count: localModels.models.length })
            : t('settings.noModelsFound')
          : null;

  const installLabel = install
    ? install.phase === 'extracting'
      ? t('settings.extracting')
      : t('settings.downloadingFile', { file: install.file, current: install.fileIndex, total: install.fileCount })
    : t('settings.downloadStarting');

  const handleLocaleChange = (value: string) => {
    if (value === 'system' || AVAILABLE_LOCALES.some((l) => l.value === value)) {
      setLocalePreference(value as LocalePreference);
    }
  };

  const handleSkinChange = (value: string) => {
    if (isSkin(value)) setSkin(value);
  };

  const handleThemeChange = (value: string) => {
    if (value === 'light' || value === 'dark' || value === 'system') {
      setTheme(value);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b p-6 pr-12">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)}>
          <TabsList aria-label={t('settings.title')} className="w-full border-b px-2">
            <TabsTrigger value="general">{t('settings.tabGeneral')}</TabsTrigger>
            <TabsTrigger value="transcription">{t('settings.transcription')}</TabsTrigger>
            <TabsTrigger value="ai">{t('settings.tabAi')}</TabsTrigger>
          </TabsList>

          {/* Hauteur fixe : la fenêtre ne change pas de taille d'un onglet à l'autre. */}
          <div className="h-[min(60vh,32rem)] space-y-6 overflow-y-auto p-6">
            <TabsContent value="general" className="space-y-6">
              {/* Recording */}
              <section aria-labelledby="settings-recording" className="space-y-4">
                <h3 id="settings-recording" className="text-sm font-semibold">
                  {t('settings.recording')}
                </h3>

                <div className="space-y-2">
                  <Label htmlFor="settings-recordings-dir">{t('settings.recordingsFolder')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="settings-recordings-dir"
                      type="text"
                      value={preferences?.recordings_directory ?? ''}
                      placeholder={t('settings.chooseFolder')}
                      readOnly
                      className="min-w-0 flex-1 truncate"
                    />
                    <Button variant="outline" onClick={handleBrowseDirectory} disabled={isSaving || !preferences}>
                      <Folder className="h-4 w-4" />
                      {t('settings.browse')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('settings.recordingsFolderHelp')}</p>
                </div>

                <div className="flex items-start gap-3">
                  <Checkbox
                    id="settings-startup"
                    className="mt-0.5"
                    checked={launchAtStartup}
                    onCheckedChange={(checked) => setLaunchAtStartup(checked === true)}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="settings-startup" className="font-normal">
                      {t('settings.launchAtStartup')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('settings.launchAtStartupHelp')}</p>
                  </div>
                </div>
              </section>

              {/* Appearance */}
              <section aria-labelledby="settings-appearance" className="space-y-4">
                <h3 id="settings-appearance" className="text-sm font-semibold">
                  {t('settings.appearance')}
                </h3>
                <div className="space-y-2">
                  <Label htmlFor="settings-theme">{t('settings.theme')}</Label>
                  <Select value={theme} onValueChange={handleThemeChange}>
                    <SelectTrigger id="settings-theme" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">{t('settings.themeSystem')}</SelectItem>
                      <SelectItem value="light">{t('settings.themeLight')}</SelectItem>
                      <SelectItem value="dark">{t('settings.themeDark')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settings-skin">{t('settings.skin')}</Label>
                  <Select value={skin} onValueChange={handleSkinChange}>
                    <SelectTrigger id="settings-skin" className="w-48" aria-describedby="settings-skin-hint">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SKINS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {t(SKIN_TEXTS[value].name)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p id="settings-skin-hint" className="text-xs text-muted-foreground">
                    {t(SKIN_TEXTS[skin].hint)}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="settings-language">{t('settings.language')}</Label>
                  <Select value={localePreference} onValueChange={handleLocaleChange}>
                    <SelectTrigger id="settings-language" className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">{t('settings.languageSystem')}</SelectItem>
                      {AVAILABLE_LOCALES.map((l) => (
                        <SelectItem key={l.value} value={l.value} lang={l.value}>
                          {l.nativeName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </section>

              {/* Microsoft sign-in */}
              <section aria-labelledby="settings-auth" className="space-y-4">
                <h3 id="settings-auth" className="text-sm font-semibold">
                  {t('settings.auth')}
                </h3>

                <div className="flex items-start gap-3">
                  <Checkbox
                    id="settings-auth-enabled"
                    className="mt-0.5"
                    checked={authEnabled}
                    disabled={!preferences}
                    onCheckedChange={(checked) => updateDraft({ auth_enabled: checked === true })}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="settings-auth-enabled" className="font-normal">
                      {t('settings.authEnabled')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('settings.authEnabledHelp')}</p>
                  </div>
                </div>

                {authEnabled && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="settings-auth-client-id">{t('settings.authClientId')}</Label>
                      <Input
                        id="settings-auth-client-id"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                        value={preferences?.azure_ad_client_id ?? ''}
                        onChange={(e) => updateDraft({ azure_ad_client_id: e.target.value.trim() })}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        aria-invalid={clientIdInvalid}
                        aria-describedby="settings-auth-client-id-error"
                      />
                      {clientIdInvalid && (
                        <p id="settings-auth-client-id-error" className="text-xs text-destructive">
                          {t('settings.authClientIdInvalid')}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-auth-tenant-id">{t('settings.authTenantId')}</Label>
                      <Input
                        id="settings-auth-tenant-id"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                        value={preferences?.azure_ad_tenant_id ?? ''}
                        onChange={(e) => updateDraft({ azure_ad_tenant_id: e.target.value.trim() })}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        aria-invalid={tenantIdInvalid}
                        aria-describedby="settings-auth-tenant-id-error"
                      />
                      {tenantIdInvalid && (
                        <p id="settings-auth-tenant-id-error" className="text-xs text-destructive">
                          {t('settings.authTenantIdInvalid')}
                        </p>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {t('settings.authRedirectHelp', { uri: window.location.origin })}
                    </p>
                  </>
                )}
              </section>

              {/* About */}
              <section aria-labelledby="settings-about" className="border-t pt-4">
                <h3 id="settings-about" className="mb-1 text-sm font-semibold">
                  {t('settings.about')}
                </h3>
                <p className="text-xs text-muted-foreground">
                  SealedScribe v{pkg.version} · © {new Date().getFullYear()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {disclaimerAcceptedAt && (
                    <>{t('disclaimer.acceptedOn', { date: formatDate(disclaimerAcceptedAt, { dateStyle: 'long' }) })} </>
                  )}
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setShowDisclaimer(true)}>
                    {t('disclaimer.read')}
                  </Button>
                </p>
                {showDisclaimer && <DisclaimerModal onClose={() => setShowDisclaimer(false)} />}
              </section>
            </TabsContent>

            <TabsContent value="transcription" className="space-y-6">
              {/* Transcription engine */}
              <section aria-labelledby="settings-transcription" className="space-y-4">
                <h3 id="settings-transcription" className="text-sm font-semibold">
                  {t('settings.transcription')}
                </h3>

                <div className="space-y-2">
                  <Label htmlFor="settings-engine">{t('settings.engine')}</Label>
                  <Select value={engine} onValueChange={handleEngineChange} disabled={!preferences || isSaving}>
                    <SelectTrigger id="settings-engine" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="azure">{t('settings.engineAzure')}</SelectItem>
                      <SelectItem value="local">{t('settings.engineLocal')}</SelectItem>
                      <SelectItem value="mistral">{t('settings.engineMistral')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t(ENGINE_HELP[engine])}
                  </p>
                </div>

                {engine === 'local' ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="settings-local-model">{t('settings.localModel')}</Label>
                      <Select
                        value={selectedModelId}
                        onValueChange={handleModelChange}
                        disabled={!preferences || isSaving || localWhisper.isInstalling}
                      >
                        <SelectTrigger id="settings-local-model" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(LOCAL_MODEL_TEXT).map(([id, text]) => {
                            const recommended = localWhisper.status?.models.find((m) => m.id === id)?.recommended;
                            return (
                              <SelectItem key={id} value={id}>
                                {recommended
                                  ? t('settings.modelRecommendedLabel', { model: t(text.label) })
                                  : t(text.label)}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {selectedModelText && (
                        <p className="text-xs text-muted-foreground">{t(selectedModelText.help)}</p>
                      )}
                      {hardwareText && <p className="text-xs text-muted-foreground">{hardwareText}</p>}
                    </div>

                    {selectedModel && (
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={selectedModel.installed ? 'success' : 'secondary'}>
                          {selectedModel.installed
                            ? t('settings.modelInstalled')
                            : t('settings.modelMissing', { size: formatBytes(selectedModel.missingBytes, intlLocale) })}
                        </Badge>
                        <Badge variant="outline">
                          {selectedModel.device === 'gpu' ? t('settings.runsOnGpu') : t('settings.runsOnCpu')}
                        </Badge>
                        {selectedModel.fit !== 'ok' && (
                          <Badge variant="warning">
                            {selectedModel.fit === 'tight' ? t('settings.fitTight') : t('settings.fitTooBig')}
                          </Badge>
                        )}
                        {modelLoaded && <Badge variant="outline">{t('settings.modelLoaded')}</Badge>}
                      </div>
                    )}
                    {selectedModel && selectedModel.fit !== 'ok' && (
                      <p className="text-xs text-muted-foreground">
                        {t('settings.fitHelp', { memory: formatBytes(selectedModel.memoryBytes, intlLocale) })}
                      </p>
                    )}
                    {gpuFallback && (
                      <Alert className="flex-row items-start gap-2" role="status">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <AlertDescription>{t('settings.cpuFallback')}</AlertDescription>
                      </Alert>
                    )}

                    {localWhisper.isInstalling && localWhisper.installingId !== DIARIZATION_ID ? (
                      <div className="space-y-2" role="status">
                        <div className="flex items-center justify-between gap-2">
                          <span id="settings-download-label" className="truncate text-xs text-muted-foreground" title={installLabel}>
                            {installLabel}
                          </span>
                          <span className="text-xs text-muted-foreground">{install?.progress ?? 0}{' '}%</span>
                        </div>
                        <Progress value={install?.progress ?? 0} aria-labelledby="settings-download-label" />
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
                    ) : selectedModel && !selectedModel.installed ? (
                      <Button
                        onClick={() => localWhisper.startInstall(selectedModelId)}
                        disabled={localWhisper.isInstalling}
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        {t('settings.download', { size: formatBytes(selectedModel.missingBytes, intlLocale) })}
                      </Button>
                    ) : selectedModel ? (
                      <div className="flex flex-wrap gap-2">
                        {modelLoaded && (
                          <Button variant="outline" onClick={localWhisper.unload} disabled={localWhisper.isBusy}>
                            {t('settings.freeMemory')}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          onClick={() => setConfirmDeleteModel(true)}
                          disabled={localWhisper.isBusy}
                        >
                          {t('settings.deleteModel')}
                        </Button>
                      </div>
                    ) : null}

                    {localWhisper.cancelled && localWhisper.actionId !== DIARIZATION_ID && (
                      <p role="status" className="text-sm text-muted-foreground">
                        {t('settings.downloadCancelled')}
                      </p>
                    )}
                    {localWhisper.error && localWhisper.actionId !== DIARIZATION_ID && (
                      <Alert variant="destructive" className="flex-row items-start gap-2" role="alert">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <AlertDescription>
                          {t('settings.localActionFailed')} {localWhisper.error}
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                ) : engine === 'mistral' ? (
                  <>
                    {renderMistralKey('settings-mistral-key-transcription')}
                    {renderMistralModel(
                      'settings-mistral-transcription-model',
                      'mistral_transcription_model',
                      DEFAULT_MISTRAL_TRANSCRIPTION_MODEL,
                      'settings.mistralTranscriptionModelHelp'
                    )}
                    <Notice>{t('settings.mistralAudioNotice')}</Notice>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={credentials?.speechConfigured ? 'success' : 'secondary'}>
                        {t('settings.speechStatus', {
                          state: credentials?.speechConfigured ? t('settings.configured') : t('settings.notConfigured'),
                        })}
                      </Badge>
                      {renderRemoveKeys('speech', Boolean(credentials?.speechConfigured))}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-speech-key">{t('settings.speechKey')}</Label>
                      <Input
                        id="settings-speech-key"
                        type="password"
                        autoComplete="off"
                        value={speechKey}
                        onChange={(e) => setSpeechKey(e.target.value)}
                        placeholder={credentials?.speechConfigured ? t('settings.keepCurrentKey') : t('settings.pasteKey')}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-speech-region">{t('settings.speechRegion')}</Label>
                      <Input
                        id="settings-speech-region"
                        type="text"
                        autoComplete="off"
                        value={speechRegion}
                        onChange={(e) => setSpeechRegion(e.target.value)}
                        placeholder={credentials?.speechRegion || 'francecentral'}
                      />
                    </div>

                    <Notice>{t('settings.speechDataNotice')}</Notice>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.keysHelp')}
                    </p>
                  </>
                )}
              </section>

              <DiarizationSettings localWhisper={localWhisper} />

              <AlertDialog open={confirmDeleteModel} onOpenChange={setConfirmDeleteModel}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('settings.deleteModelTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('settings.deleteModelDescription', {
                        model: selectedModelText ? t(selectedModelText.label) : selectedModelId,
                        size: selectedModel ? formatBytes(selectedModel.sizeBytes, intlLocale) : '',
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      className={buttonVariants({ variant: 'destructive' })}
                      onClick={() => localWhisper.remove(selectedModelId)}
                    >
                      {t('settings.deleteModel')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </TabsContent>

            <TabsContent value="ai" className="space-y-6">
              <section aria-labelledby="settings-ai" className="space-y-4">
                <h3 id="settings-ai" className="sr-only">{t('settings.tabAi')}</h3>

                <div className="space-y-2">
                  <Label htmlFor="settings-summary-engine">{t('settings.summaryEngine')}</Label>
                  <Select value={summaryEngine} onValueChange={handleSummaryEngineChange} disabled={!preferences || isSaving}>
                    <SelectTrigger id="settings-summary-engine" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="azure">{t('settings.summaryEngineAzure')}</SelectItem>
                      <SelectItem value="mistral">{t('settings.summaryEngineMistral')}</SelectItem>
                      <SelectItem value="ollama">{t('settings.summaryEngineOllama')}</SelectItem>
                      <SelectItem value="openai">{t('settings.summaryEngineOpenai')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t(SUMMARY_ENGINE_HELP[summaryEngine])}</p>
                </div>

                {localEngine ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="settings-local-llm-url">{t('settings.localLlmUrl')}</Label>
                      <Input
                        id="settings-local-llm-url"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={localUrl}
                        onChange={(e) => updateDraft({ local_llm_url: e.target.value })}
                        onBlur={() => detectModels(localEngine, localUrl)}
                        placeholder={DEFAULT_LOCAL_LLM_URL[localEngine]}
                        disabled={!preferences || isSaving}
                        aria-describedby="settings-local-llm-url-help"
                      />
                      <p id="settings-local-llm-url-help" className="text-xs text-muted-foreground">
                        {t('settings.localLlmUrlHelp', { url: DEFAULT_LOCAL_LLM_URL[localEngine] })}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="settings-local-llm-model">{t('settings.localLlmModel')}</Label>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() => detectModels(localEngine, localUrl)}
                          disabled={localModels.status === 'loading'}
                        >
                          <RefreshCw
                            className={localModels.status === 'loading' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                            aria-hidden="true"
                          />
                          {t('settings.detectModels')}
                        </Button>
                      </div>
                      {localModelOptions.length > 0 ? (
                        <Select
                          value={localModel}
                          onValueChange={(value) => updateDraft({ local_llm_model: value })}
                          disabled={!preferences || isSaving}
                        >
                          <SelectTrigger id="settings-local-llm-model" className="w-full">
                            <SelectValue placeholder={t('settings.localLlmModelChoose')} />
                          </SelectTrigger>
                          <SelectContent>
                            {localModelOptions.map((name) => (
                              <SelectItem key={name} value={name}>
                                {localModelNames.includes(name) ? name : t('settings.modelNotOnServer', { model: name })}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id="settings-local-llm-model"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          value={localModel}
                          onChange={(e) => updateDraft({ local_llm_model: e.target.value })}
                          placeholder={t('settings.localLlmModelPlaceholder')}
                          disabled={!preferences || isSaving}
                        />
                      )}
                      {localModelsStatus && (
                        <p
                          role="status"
                          className={
                            localModels.status === 'error' ||
                            (localModels.status === 'ready' && localModels.models.length === 0)
                              ? 'text-xs text-warning'
                              : 'text-xs text-muted-foreground'
                          }
                        >
                          {localModelsStatus}
                        </p>
                      )}
                      {localModelHint && <p className="text-xs text-muted-foreground">{localModelHint}</p>}
                    </div>

                    <Notice>{t('settings.localLlmDataNotice')}</Notice>
                  </>
                ) : summaryEngine === 'mistral' ? (
                  <>
                    {renderMistralKey('settings-mistral-key-summary')}
                    {renderMistralModel(
                      'settings-mistral-summary-model',
                      'mistral_summary_model',
                      DEFAULT_MISTRAL_CHAT_MODEL,
                      'settings.mistralSummaryModelHelp'
                    )}
                    <Notice>{t('settings.mistralSummaryNotice')}</Notice>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={credentials?.aiInferenceConfigured ? 'success' : 'secondary'}>
                        {t('settings.aiStatus', {
                          state: credentials?.aiInferenceConfigured ? t('settings.configured') : t('settings.notConfigured'),
                        })}
                      </Badge>
                      {renderRemoveKeys(
                        'ai',
                        Boolean(credentials?.aiEndpointConfigured || credentials?.aiKeyConfigured || credentials?.aiModel)
                      )}
                    </div>
                    {credentials && !credentials.aiInferenceConfigured && (credentials.aiEndpointConfigured || credentials.aiKeyConfigured) && (
                      <p className="text-xs text-warning">
                        {credentials.aiEndpointConfigured ? t('settings.aiMissingKey') : t('settings.aiMissingEndpoint')}
                      </p>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="settings-ai-endpoint">{t('settings.aiEndpoint')}</Label>
                      <Input
                        id="settings-ai-endpoint"
                        type="text"
                        autoComplete="off"
                        value={aiEndpoint}
                        onChange={(e) => setAiEndpoint(e.target.value)}
                        placeholder="https://<ressource>.services.ai.azure.com/openai/v1"
                        aria-describedby="settings-ai-endpoint-help"
                      />
                      <p id="settings-ai-endpoint-help" className="text-xs text-muted-foreground">
                        {t('settings.aiEndpointHelp')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-ai-model">{t('settings.aiModel')}</Label>
                      <Input
                        id="settings-ai-model"
                        type="text"
                        autoComplete="off"
                        value={aiModel}
                        onChange={(e) => setAiModel(e.target.value)}
                        placeholder={credentials?.aiModel || t('settings.aiModelPlaceholder')}
                        aria-describedby="settings-ai-model-help"
                      />
                      <p id="settings-ai-model-help" className="text-xs text-muted-foreground">
                        {t('settings.aiModelHelp')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="settings-ai-key">{t('settings.aiKey')}</Label>
                      <Input
                        id="settings-ai-key"
                        type="password"
                        autoComplete="off"
                        value={aiKey}
                        onChange={(e) => setAiKey(e.target.value)}
                        placeholder={credentials?.aiInferenceConfigured ? t('settings.keepCurrentKey') : t('settings.pasteKey')}
                      />
                    </div>

                    <Notice>{t('settings.aiDataNotice')}</Notice>
                    <p className="text-xs text-muted-foreground">
                      {t('settings.keysHelp')}
                    </p>
                  </>
                )}
              </section>
            </TabsContent>
          </div>
        </Tabs>

        {/* Erreur dans le pied : visible quel que soit l'onglet affiché. */}
        <DialogFooter className="flex-col border-t p-6 sm:flex-col">
          {saveError && (
            <Alert variant="destructive" role="alert" className="flex-row items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !isDirty || !preferences || clientIdInvalid || tenantIdInvalid}
            >
              {isSaving ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>
        </DialogFooter>

        <AlertDialog open={confirmRemoveKeys !== null} onOpenChange={(open) => !open && setConfirmRemoveKeys(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.removeKeysTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmRemoveKeys && t(REMOVE_KEYS_DESCRIPTION[confirmRemoveKeys])}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                onClick={() => confirmRemoveKeys && handleRemoveKeys(confirmRemoveKeys)}
              >
                {t('settings.removeKeys')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
