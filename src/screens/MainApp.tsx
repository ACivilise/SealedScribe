import { useEffect, useState } from 'react';
import { Mic, Folder, Settings, X, AlertTriangle, LogOut, ScrollText, BookA } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { isAuthActive } from '../config/auth.config';
import { useMeetingStore } from '../store/meetingStore';
import { useNotificationStore } from '../store/notificationStore';
import RecordingTab from '../components/tabs/RecordingTab';
import RecordingsTab from '../components/tabs/RecordingsTab';
import PromptsTab from '../components/tabs/PromptsTab';
import LexiconsTab from '../components/tabs/LexiconsTab';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { WhatsNewButton } from '../components/common/WhatsNewButton';
import SettingsModal from '../components/modals/SettingsModal';
import { ActivityIndicator, type ActivityTarget } from '../components/common/ActivityIndicator';
import { ShutdownWatcher } from '../components/common/ShutdownWatcher';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useT } from '../i18n';
import { UpdateBanner } from '../components/common/UpdateBanner';

type TabType = 'recording' | 'recordings' | 'prompts' | 'lexicons';

export default function MainApp() {
  const [activeTab, setActiveTab] = useState<TabType>('recording');
  const [showSettings, setShowSettings] = useState(false);
  // Fiche réunion ouverte : portée ici pour que l'indicateur de l'en-tête puisse la rouvrir.
  const [openMeetingId, setOpenMeetingId] = useState<string | null>(null);
  // Prompt à ouvrir depuis le lien « Modifier les prompts » de la fiche d'une réunion (qui se ferme).
  const [focusPromptId, setFocusPromptId] = useState<string | null>(null);
  const openPrompts = (promptId?: string) => {
    setOpenMeetingId(null);
    setFocusPromptId(promptId ?? null);
    setActiveTab('prompts');
  };
  const goToActivity = (target: ActivityTarget) => {
    if (target.kind === 'recording') setActiveTab('recording');
    else {
      setActiveTab('recordings');
      setOpenMeetingId(target.meetingId);
    }
  };
  const { user, clearUser } = useAuthStore();
  // Connexion désactivée : ni nom d'utilisateur ni « Se déconnecter ».
  const authActive = useAuthStore((state) => isAuthActive(state.settings));
  const meetings = useMeetingStore((state) => state.meetings);
  const error = useNotificationStore((state) => state.error);
  const clearError = useNotificationStore((state) => state.clearError);
  const syncFromDisk = useMeetingStore((state) => state.syncFromDisk);
  const { t } = useT();

  // Au lancement et à chaque ouverture de l'onglet Réunions (le dossier a pu changer dans les Paramètres).
  useEffect(() => {
    if (activeTab === 'recording' && meetings.length > 0) return;
    syncFromDisk().catch((e) => console.error('Failed to list recordings:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, syncFromDisk]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <ShutdownWatcher />
      {/* Header */}
      <header className="bg-card/80 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/logo.png" alt="" className="h-9 w-9 shadow-card rounded-[22%]" />
            <h1 className="text-xl font-bold tracking-tight">SealedScribe</h1>
            <ActivityIndicator onNavigate={goToActivity} />
          </div>

          <div className="flex items-center gap-2">
            {authActive && <span className="mr-2 text-sm text-muted-foreground">{user?.name}</span>}
            <WhatsNewButton />
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label={t('header.openSettings')} title={t('header.settings')} onClick={() => setShowSettings(true)}>
              <Settings className="h-5 w-5" />
            </Button>
            {authActive && (
              <Button variant="ghost" onClick={clearUser}>
                <LogOut className="h-4 w-4" />
                {t('header.signOut')}
              </Button>
            )}
          </div>
        </div>
      </header>
      {/* Décor de l’habillage (rayures de cassette, filets de journal…) : remplace la bordure basse de l’en-tête. */}
      <div aria-hidden="true" className="header-band h-1.5 shrink-0" />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)} className="flex min-h-0 flex-1 flex-col">
        {/* Tab navigation */}
        <nav aria-label={t('nav.label')} className="border-b bg-card">
          <TabsList className="mx-auto flex max-w-7xl gap-0 px-6">
            <TabsTrigger value="recording" title={t('nav.recordHint')}>
              <Mic className="h-4 w-4" />
              {t('nav.record')}
            </TabsTrigger>
            <TabsTrigger value="recordings" title={t('nav.meetingsHint')}>
              <Folder className="h-4 w-4" />
              {t('nav.meetings')}
              {meetings.length > 0 && (
                <Badge variant="default" className="ml-1">
                  {meetings.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="prompts" title={t('nav.promptsHint')}>
              <ScrollText className="h-4 w-4" />
              {t('nav.prompts')}
            </TabsTrigger>
            <TabsTrigger value="lexicons" title={t('nav.lexiconsHint')}>
              <BookA className="h-4 w-4" />
              {t('nav.lexicons')}
            </TabsTrigger>
          </TabsList>
        </nav>

        {error && (
          <div className="border-b px-6 py-3">
            <div className="mx-auto max-w-7xl">
              <Alert variant="destructive" className="flex-row items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <AlertTitle>{error.title}</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('common.dismissError')} onClick={clearError}>
                  <X className="h-4 w-4" />
                </Button>
              </Alert>
            </div>
          </div>
        )}

        <UpdateBanner />

        {/* Les contenus restent montés (état préservé) ; seul l'affichage change */}
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl p-6">
            <TabsContent value="recording" forceMount>
              <RecordingTab />
            </TabsContent>
            <TabsContent value="recordings" forceMount>
              <RecordingsTab
                openMeetingId={openMeetingId}
                onOpenMeeting={setOpenMeetingId}
                onEditPrompts={openPrompts}
              />
            </TabsContent>
            <TabsContent value="prompts" forceMount>
              <PromptsTab focusPromptId={focusPromptId} />
            </TabsContent>
            <TabsContent value="lexicons" forceMount>
              <LexiconsTab />
            </TabsContent>
          </div>
        </main>
      </Tabs>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
