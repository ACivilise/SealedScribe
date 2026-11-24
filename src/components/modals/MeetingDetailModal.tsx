import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  Copy,
  FileText,
  History,
  Inbox,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  SpellCheck,
  Square,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MeetingSession, TranscriptionVersion, useMeetingStore } from '../../store/meetingStore';
import { usePromptStore } from '../../store/promptStore';
import { useLexiconStore } from '../../store/lexiconStore';
import { activeTerms, correctSegments, correctText } from '../../lib/lexicon';
import { useExport } from '../../hooks/useExport';
import { useSummary } from '../../hooks/useSummary';
import { useTranscription } from '../../hooks/useTranscription';
import { useIsAnyTranscribing, useTaskStore } from '../../store/taskStore';
import { useTranscriptVersionLabel } from '../../hooks/useTranscriptVersionLabel';
import { buildSystemPrompt, renderPrompt } from '../../lib/renderPrompt';
import AudioRangeSelector from '../common/AudioRangeSelector';
import { ShutdownWhenDoneCheckbox, TranscriptionStopButton } from '../common/TranscriptionStopControls';
import transcriptionService, {
  type AudioRange,
  type TranscriptionCheckpoint,
} from '../../services/transcriptionService';
import { describeTranscriptionProgress, isLoadingModel, modelLoadPercent } from '../../lib/transcriptionProgress';
import { formatDuration } from '../../utils/format';
import { addTags, collectTags, parseTags, removeTag, tagKey } from '../../utils/tags';
import {
  SPEAKER_ME,
  hasSpeakerAttribution,
  speakerLabels,
  speakerName,
  transcriptForSummary,
} from '../../utils/speakers';
import { ParticipantList } from '../speakers/ParticipantList';
import { SpeakerSeparation } from '../speakers/SpeakerSeparation';
import { TagEditor } from '../common/TagEditor';
import { Notice } from '../common/Notice';
import { useT, type MessageKey } from '../../i18n';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/ui/markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface MeetingDetailModalProps {
  meeting: MeetingSession;
  onClose: () => void;
  /** Ouvre l'onglet Prompts sur le prompt donné (la fiche se ferme). */
  onEditPrompts: (promptId?: string) => void;
}

const SPEAKER_COLORS = [
  'text-brand-text',
  'text-success',
  'text-purple-700 dark:text-purple-400',
  'text-brand-text',
  'text-pink-700 dark:text-pink-400',
  'text-cyan-700 dark:text-cyan-400',
];
/** Couleurs des intervenants autres que « Moi » (sans doublon). */
const OTHER_SPEAKER_COLORS = [...new Set(SPEAKER_COLORS)].filter((c) => c !== SPEAKER_COLORS[1]);

const STATUS_LABELS: Record<string, MessageKey> = {
  stopped: 'status.stopped',
  recording: 'status.recording',
  processing: 'status.processing',
  completed: 'status.completed',
  failed: 'status.failed',
};

type DetailView = 'transcript' | 'summary';

const formatTimestamp = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function SectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-base font-semibold">
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {children}
    </h3>
  );
}

export default function MeetingDetailModal({ meeting, onClose, onEditPrompts }: MeetingDetailModalProps) {
  // Traitement déjà en cours (fiche rouverte) : on montre sa progression.
  // Sinon le résumé, quand il existe, est ce qu'on vient chercher en premier.
  const [view, setView] = useState<DetailView>(() => {
    const tasks = useTaskStore.getState();
    if (tasks.transcriptions[meeting.id]?.isTranscribing) return 'transcript';
    const summarizing = tasks.summary?.meetingId === meeting.id && tasks.summary.isGenerating;
    return summarizing || meeting.transcription?.summary ? 'summary' : 'transcript';
  });
  const [copySuccess, setCopySuccess] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  // Choix de la partie à transcrire, affiché avant de lancer la transcription.
  const [selectingRange, setSelectingRange] = useState(false);
  const [pendingDeleteVersion, setPendingDeleteVersion] = useState<TranscriptionVersion | null>(null);
  const { isExporting, error: exportError, clearError, exportWithSaveDialog, copyToClipboard } = useExport();

  // Transcription à la demande : l'enregistrement n'est transcrit que si l'utilisateur le demande.
  const addTranscriptionVersion = useMeetingStore((state) => state.addTranscriptionVersion);
  const selectTranscriptionVersion = useMeetingStore((state) => state.selectTranscriptionVersion);
  const deleteTranscriptionVersion = useMeetingStore((state) => state.deleteTranscriptionVersion);
  const { t, locale, formatDate, languageName } = useT();
  const versions = meeting.transcriptionVersions ?? [];
  const activeVersion = versions.find((v) => v.id === meeting.activeTranscriptionId);
  // Plus récente en tête dans la liste déroulante.
  const versionsNewestFirst = [...versions].reverse();
  const describeVersion = useTranscriptVersionLabel();
  const {
    isTranscribing,
    error: transcribeError,
    phase,
    currentChunk,
    totalChunks,
    processedSeconds,
    totalSeconds,
    modelLoadSeconds,
    modelLoadExpectedSeconds,
    progress,
    transcribe,
    cancel: cancelTranscription,
    stopAfterPart,
    engine,
    stopAfterPartRequested,
  } = useTranscription(meeting.id);
  // Une seule transcription à la fois : la progression émise par le backend n'est pas rattachée à un job.
  const otherTranscriptionRunning = useIsAnyTranscribing() && !isTranscribing;
  const progressState = {
    phase,
    currentChunk,
    totalChunks,
    processedSeconds,
    totalSeconds,
    modelLoadSeconds,
    modelLoadExpectedSeconds,
    progress,
  };
  const progressText = describeTranscriptionProgress(t, progressState);
  // Chargement du modèle local : avancement estimé (durée du dernier chargement),
  // ou barre indéterminée si aucune estimation n'est disponible.
  const loadingModel = isLoadingModel(progressState);
  const loadPercent = modelLoadPercent(progressState);
  const indeterminate = loadingModel && loadPercent === null;
  const barValue = loadingModel ? loadPercent ?? 100 : progress;

  // Transcription interrompue (PC éteint, application quittée, erreur réseau) : relancée avec
  // la même plage, le backend repart du premier morceau manquant. Relu à chaque fin de transcription.
  const [checkpoint, setCheckpoint] = useState<TranscriptionCheckpoint | null>(null);
  useEffect(() => {
    if (!meeting.audioPath || isTranscribing) return;
    let cancelled = false;
    transcriptionService
      .listCheckpoints()
      .then((all) => {
        if (cancelled) return;
        const found = all
          .filter((c) => c.audioPath === meeting.audioPath && c.language === meeting.language)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        setCheckpoint(found ?? null);
      })
      .catch(() => {
        // Hors Tauri : pas de reprise possible.
      });
    return () => {
      cancelled = true;
    };
  }, [meeting.audioPath, meeting.language, isTranscribing]);

  // Exactement la plage d'origine : elle fait partie de la clé du point de reprise.
  const checkpointRange: AudioRange | null =
    checkpoint && checkpoint.startSeconds !== null && checkpoint.endSeconds !== null
      ? { start: checkpoint.startSeconds, end: checkpoint.endSeconds }
      : null;

  const handleDiscardCheckpoint = async () => {
    if (!meeting.audioPath) return;
    setCheckpoint(null);
    await transcriptionService.discardCheckpoints(meeting.audioPath).catch(() => 0);
  };

  const handleTranscribe = async (range: AudioRange | null) => {
    if (!meeting.audioPath) return;
    setSelectingRange(false);
    // La suite s'exécute même si la fiche a été fermée entre-temps (actions de store).
    const meetingId = meeting.id;
    const result = await transcribe(meeting.audioPath, meeting.language, range, meeting.title);
    if (result) {
      addTranscriptionVersion(meetingId, result.segments, range);
    }
  };

  const getSpeakerName = (speakerLabel: number) => speakerName(speakerLabel, meeting.speakers);

  // « Moi » garde sa couleur ; les autres intervenants se partagent les suivantes.
  const getSpeakerColor = (speakerLabel: number) =>
    speakerLabel === SPEAKER_ME
      ? SPEAKER_COLORS[SPEAKER_ME]
      : OTHER_SPEAKER_COLORS[speakerLabel % OTHER_SPEAKER_COLORS.length];

  // Intervenants de la version affichée, quand l'enregistrement sépare micro et son du PC.
  const participantLabels = useMemo(() => {
    const segments = meeting.transcription?.segments ?? [];
    return hasSpeakerAttribution(segments) ? speakerLabels(segments) : [];
  }, [meeting.transcription?.segments]);

  // Nom vide ou nom par défaut : retour au nom par défaut ; nom d'un autre intervenant : fusion.
  const renameSpeakerInStore = useMeetingStore((state) => state.renameSpeaker);
  const renameSpeaker = (label: number, name: string) => renameSpeakerInStore(meeting.id, label, name);

  const hasTranscript = (meeting.transcription?.segments?.length ?? 0) > 0;

  // Lexiques actifs (onglet Lexiques) : orthographe des noms propres et du jargon.
  const lexicons = useLexiconStore((state) => state.lexicons);
  const terms = useMemo(() => activeTerms(lexicons), [lexicons]);
  // Corrections faites par « Appliquer les lexiques » (null : rien à signaler).
  const [lexiconFixes, setLexiconFixes] = useState<number | null>(null);
  const lexiconFixesTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(lexiconFixesTimer.current), []);

  // Étiquettes : modifiables ici ; les autres réunions fournissent suggestions et orthographe.
  const updateMeeting = useMeetingStore((state) => state.updateMeeting);
  const allMeetings = useMeetingStore((state) => state.meetings);
  const tags = parseTags(meeting.tag);
  const knownTags = useMemo(() => collectTags(allMeetings, locale), [allMeetings, locale]);
  const tagSuggestions = useMemo(() => {
    const own = new Set(parseTags(meeting.tag).map(tagKey));
    return knownTags.filter((tag) => !own.has(tag.key)).map((tag) => tag.label);
  }, [knownTags, meeting.tag]);

  // Résumé de la version affichée : l'état de la génération vit dans le store des tâches,
  // comme la transcription (fiche fermée puis rouverte, indicateur de l'en-tête).
  const prompts = usePromptStore((state) => state.prompts);
  const selectedPromptId = usePromptStore((state) => state.selectedPromptId);
  const selectPrompt = usePromptStore((state) => state.selectPrompt);
  const addPrompt = usePromptStore((state) => state.addPrompt);
  const selectedPrompt = prompts.find((p) => p.id === selectedPromptId) ?? prompts[0];
  // Personnalisation ponctuelle : le prompt enregistré n'est pas modifié.
  const [customize, setCustomize] = useState(false);
  const [customTemplate, setCustomTemplate] = useState('');
  const {
    isGenerating,
    cancelRequested: summaryCancelRequested,
    streamText,
    versionId: summarizedVersionId,
    result: summaryResult,
    error: summaryError,
    otherSummaryRunning,
    generate: generateSummary,
    cancel: cancelSummary,
    clearError: clearSummaryError,
    dismiss: dismissSummary,
  } = useSummary(meeting.id);
  // Le dernier résultat (résumé partiel, jetons, erreur) ne vaut que pour la version résumée.
  const isSummarizedVersion = summarizedVersionId === meeting.activeTranscriptionId;
  // Arrêté : le début reçu est affiché mais pas enregistré dans la version.
  const partialSummary = isSummarizedVersion && summaryResult?.cancelled ? summaryResult.summary : '';
  const savedSummary = meeting.transcription?.summary ?? '';
  const displaySummary = isGenerating ? streamText : partialSummary || savedSummary;
  const template = customize ? customTemplate : selectedPrompt?.template ?? '';

  // Un segment par ligne : le modèle repère mieux les changements de sujet.
  // Recalculé au changement de langue : les intervenants « Moi » / « Autres » sont traduits.
  // Corrigé avec les lexiques actifs, même si la transcription date d'avant eux.
  const transcriptText = useMemo(
    () =>
      transcriptForSummary(correctSegments(meeting.transcription?.segments ?? [], terms).segments, meeting.speakers),
    [meeting.transcription?.segments, meeting.speakers, terms, locale]
  );

  const handlePromptChange = (id: string) => {
    selectPrompt(id);
    setCustomTemplate(prompts.find((p) => p.id === id)?.template ?? '');
  };
  const handleCustomizeChange = (checked: boolean) => {
    setCustomize(checked);
    if (checked) setCustomTemplate(selectedPrompt?.template ?? '');
  };
  // Corrige la version affichée (transcription et résumé) : utile pour celles faites avant le lexique.
  const handleApplyLexicons = () => {
    const transcription = meeting.transcription;
    if (!transcription) return;
    const fixed = correctSegments(transcription.segments, terms);
    const summary = transcription.summary ? correctText(transcription.summary, terms) : null;
    const count = fixed.count + (summary?.count ?? 0);
    if (count > 0) {
      updateMeeting(meeting.id, {
        transcription: { ...transcription, segments: fixed.segments, summary: summary?.text ?? transcription.summary },
      });
    }
    setLexiconFixes(count);
    clearTimeout(lexiconFixesTimer.current);
    lexiconFixesTimer.current = setTimeout(() => setLexiconFixes(null), 4000);
  };

  const handleSaveAsPrompt = () => {
    if (!selectedPrompt) return;
    const id = addPrompt({
      name: `${selectedPrompt.name} ${t('prompts.copySuffix')}`,
      description: selectedPrompt.description,
      template: customTemplate,
    });
    selectPrompt(id);
    setCustomize(false);
  };

  const handleGenerateSummary = async () => {
    const versionId = meeting.activeTranscriptionId;
    if (!versionId || !transcriptText || !template.trim()) return;
    const prompt = renderPrompt(template, {
      transcript: transcriptText,
      title: meeting.title,
      date: formatDate(meeting.recordedAt, { dateStyle: 'long' }),
    });
    // Le résumé est enregistré dans `versionId`, même si la fiche est fermée entre-temps.
    await generateSummary({
      versionId,
      meetingTitle: meeting.title,
      system: buildSystemPrompt(locale, terms),
      prompt,
    });
  };

  // Suit la fin du texte pendant le streaming.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isGenerating && view === 'summary' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isGenerating, streamText, view]);

  // Fermer la fiche oublie le dernier résultat (résumé partiel, erreur) ; une génération en cours continue.
  const handleClose = () => {
    dismissSummary();
    onClose();
  };
  const handleEditPrompts = () => {
    dismissSummary();
    onEditPrompts(selectedPrompt?.id);
  };

  // Copier et Enregistrer sous portent sur l'onglet affiché.
  const hasContent = view === 'summary' ? Boolean(displaySummary) && !isGenerating : hasTranscript;
  const summaryData = displaySummary ? { summary: displaySummary, style: 'comprehensive' } : undefined;

  const handleViewChange = (value: string) => {
    setView(value as DetailView);
    setCopySuccess(false);
    setExportSuccess(null);
    clearError();
  };

  const handleCopy = async () => {
    const isSummary = view === 'summary';
    const success = await copyToClipboard(meeting, meeting.diarization, summaryData, isSummary, !isSummary);
    if (success) {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleSaveAs = async () => {
    const result = await exportWithSaveDialog(meeting, view, meeting.diarization, summaryData);
    if (result) {
      setExportSuccess(result.filePath);
      setTimeout(() => setExportSuccess(null), 3000);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="flex h-[90vh] max-w-3xl flex-col gap-0 p-0"
        // Échap dans le champ d'étiquette annule la saisie, sans fermer la fiche.
        onEscapeKeyDown={(e) => {
          if (e.target instanceof Element && e.target.closest('[data-tag-input], [data-speaker-input]')) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader className="shrink-0 p-6 pb-4 pr-12">
          <DialogTitle className="truncate text-xl font-bold">{meeting.title}</DialogTitle>
          <DialogDescription className="sr-only">{t('detail.description')}</DialogDescription>
          <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <div>
              <dt className="sr-only">{t('detail.date')}</dt>
              <dd>{formatDate(meeting.recordedAt, { dateStyle: 'full', timeStyle: 'short' })}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('detail.duration')}</dt>
              <dd className="font-mono">{meeting.duration > 0 ? formatDuration(meeting.duration) : '—'}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('detail.language')}</dt>
              <dd>{languageName(meeting.language)}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('detail.status')}</dt>
              <dd>{t(STATUS_LABELS[meeting.status] ?? 'status.unknown')}</dd>
            </div>
            <div>
              <dt className="sr-only">{t('detail.tag')}</dt>
              <dd>
                <TagEditor
                  tags={tags}
                  suggestions={tagSuggestions}
                  onAdd={(input) => updateMeeting(meeting.id, { tag: addTags(meeting.tag, input, knownTags) })}
                  onRemove={(tag) => updateMeeting(meeting.id, { tag: removeTag(meeting.tag, tagKey(tag)) })}
                />
              </dd>
            </div>
          </dl>
          {/* La version choisie vaut pour les deux onglets : chaque version a sa transcription et son résumé. */}
          {versions.length > 0 && (
            <div className="flex items-end gap-2 pt-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="detail-transcript-version">{t('detail.version')}</Label>
                <Select
                  value={meeting.activeTranscriptionId}
                  onValueChange={(id) => selectTranscriptionVersion(meeting.id, id)}
                  disabled={isTranscribing || isGenerating}
                >
                  <SelectTrigger id="detail-transcript-version" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versionsNewestFirst.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        {describeVersion(version)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {activeVersion && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPendingDeleteVersion(activeVersion)}
                  disabled={isTranscribing || isGenerating}
                  aria-label={t('detail.deleteVersion')}
                  title={t('detail.deleteVersion')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </DialogHeader>

        <Tabs value={view} onValueChange={handleViewChange} className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label={t('detail.description')} className="w-full shrink-0 border-b px-2">
            <TabsTrigger value="transcript">
              <FileText className="h-4 w-4" aria-hidden="true" />
              {t('detail.transcript')}
            </TabsTrigger>
            <TabsTrigger value="summary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {t('detail.summary')}
            </TabsTrigger>
          </TabsList>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-6">
            <TabsContent value="summary">
              {summaryError && isSummarizedVersion && (
                <Alert variant="destructive" className="mb-4 flex-row items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <AlertTitle>{t('summary.generateFailed')}</AlertTitle>
                    <AlertDescription>{summaryError}</AlertDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={clearSummaryError}
                    aria-label={t('common.dismissError')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </Alert>
              )}

              {hasTranscript && (
                <div className="mb-6 space-y-3">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="detail-summary-prompt">{t('summary.prompt')}</Label>
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={handleEditPrompts}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('summary.editPrompts')}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={selectedPrompt?.id ?? ''}
                        onValueChange={handlePromptChange}
                        disabled={isGenerating || prompts.length === 0}
                      >
                        <SelectTrigger
                          id="detail-summary-prompt"
                          className="min-w-[12rem] flex-1"
                          aria-describedby={selectedPrompt?.description ? 'detail-summary-prompt-help' : undefined}
                        >
                          <SelectValue placeholder={t('summary.noPrompts')} />
                        </SelectTrigger>
                        <SelectContent>
                          {prompts.map((prompt) => (
                            <SelectItem key={prompt.id} value={prompt.id}>
                              {prompt.name || t('prompts.untitled')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {isGenerating ? (
                        <Button variant="outline" onClick={cancelSummary} disabled={summaryCancelRequested}>
                          <Square className="h-4 w-4" aria-hidden="true" />
                          {t('summary.stop')}
                        </Button>
                      ) : (
                        <Button
                          variant={savedSummary ? 'outline' : 'default'}
                          onClick={handleGenerateSummary}
                          disabled={otherSummaryRunning || !template.trim()}
                        >
                          {savedSummary ? (
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                          ) : (
                            <Sparkles className="h-4 w-4" aria-hidden="true" />
                          )}
                          {t(savedSummary ? 'summary.regenerate' : 'summary.generate')}
                        </Button>
                      )}
                    </div>
                    {selectedPrompt?.description && (
                      <p id="detail-summary-prompt-help" className="text-xs text-muted-foreground">
                        {selectedPrompt.description}
                      </p>
                    )}
                    {otherSummaryRunning && (
                      <p className="text-sm text-muted-foreground">{t('detail.otherSummaryRunning')}</p>
                    )}
                  </div>

                  {selectedPrompt && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="detail-summary-customize"
                          checked={customize}
                          onCheckedChange={(v) => handleCustomizeChange(v === true)}
                          disabled={isGenerating}
                        />
                        <Label htmlFor="detail-summary-customize" className="font-normal">
                          {t('summary.customize')}
                        </Label>
                      </div>
                      {customize && (
                        <>
                          <Textarea
                            id="detail-summary-custom-template"
                            aria-label={t('summary.customTemplate')}
                            value={customTemplate}
                            onChange={(e) => setCustomTemplate(e.target.value)}
                            rows={10}
                            spellCheck={false}
                            disabled={isGenerating}
                            className="font-mono text-xs leading-relaxed"
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">{t('summary.customizeHelp')}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleSaveAsPrompt}
                              disabled={!customTemplate.trim()}
                            >
                              <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
                              {t('summary.saveAsPrompt')}
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {isGenerating && (
                <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {t('summary.generating')}
                </p>
              )}
              {partialSummary && !isGenerating && (
                <Alert role="status" className="mb-4">
                  <AlertDescription>{t('summary.stopped')}</AlertDescription>
                </Alert>
              )}

              {displaySummary ? (
                <div aria-busy={isGenerating}>
                  <Markdown>{displaySummary}</Markdown>
                  {isGenerating && (
                    <span className="mt-1 inline-block h-4 w-2 animate-pulse bg-primary align-middle" aria-hidden="true" />
                  )}
                  {!isGenerating && <Notice className="mt-4">{t('detail.summaryAiNotice')}</Notice>}
                  {!isGenerating && isSummarizedVersion && summaryResult?.tokensUsed && (
                    <p className="mt-4 text-xs text-muted-foreground">
                      {summaryResult.model} · {t('summary.tokens', { count: summaryResult.tokensUsed })}
                    </p>
                  )}
                </div>
              ) : (
                !isGenerating && (
                  <div className="py-8 text-center text-muted-foreground">
                    <div className="mb-2 inline-flex rounded-full bg-muted p-3">
                      <Sparkles className="h-6 w-6" aria-hidden="true" />
                    </div>
                    <p className="font-medium text-foreground">{t('detail.noSummary')}</p>
                    <p className="mt-1 text-sm">
                      {hasTranscript ? t('detail.noSummaryHint') : t('detail.noSummaryNoTranscript')}
                    </p>
                  </div>
                )
              )}
            </TabsContent>

            <TabsContent value="transcript">
              {/* Participants */}
              {participantLabels.length > 0 && (
                <section className="mb-6">
                  <SectionTitle icon={Users}>{t('detail.participants')}</SectionTitle>
                  <ParticipantList
                    labels={participantLabels}
                    speakers={meeting.speakers}
                    colorOf={getSpeakerColor}
                    onRename={renameSpeaker}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">{t('detail.participantsHelp')}</p>
                  <SpeakerSeparation meeting={meeting} disabled={isTranscribing} />
                </section>
              )}

              {meeting.transcriptionError && (
                <Alert variant="destructive" className="mb-4 flex-row items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <AlertDescription>{meeting.transcriptionError}</AlertDescription>
                </Alert>
              )}
              {transcribeError && (
                <Alert variant="destructive" className="mb-4 flex-row items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <AlertDescription>{transcribeError}</AlertDescription>
                </Alert>
              )}
              {meeting.audioPath && checkpoint && !isTranscribing && !selectingRange && (
                <Alert variant="default" className="mb-4 flex-row items-start gap-2">
                  <History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <AlertTitle>{t('detail.resumeTitle')}</AlertTitle>
                    <AlertDescription>
                      {t('detail.resumeDescription', {
                        done: checkpoint.doneChunks,
                        total: checkpoint.totalChunks,
                        range: checkpointRange
                          ? `${formatTimestamp(checkpointRange.start)} – ${formatTimestamp(checkpointRange.end)}`
                          : t('detail.resumeWholeRecording'),
                      })}
                    </AlertDescription>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleTranscribe(checkpointRange)}
                        disabled={otherTranscriptionRunning}
                      >
                        <Play className="h-4 w-4" aria-hidden="true" />
                        {t('detail.resume')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={handleDiscardCheckpoint}>
                        {t('detail.resumeDiscard')}
                      </Button>
                    </div>
                  </div>
                </Alert>
              )}
              {meeting.audioPath && (
                <div className="mb-4 space-y-3">
                  {selectingRange && !isTranscribing ? (
                    <AudioRangeSelector
                      audioPath={meeting.audioPath}
                      initialRange={activeVersion?.range}
                      onConfirm={handleTranscribe}
                      onCancel={() => setSelectingRange(false)}
                    />
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant={versions.length > 0 ? 'outline' : 'default'}
                        onClick={() => setSelectingRange(true)}
                        disabled={isTranscribing || otherTranscriptionRunning}
                      >
                        {versions.length > 0 ? (
                          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                        )}
                        {isTranscribing
                          ? t('detail.transcribing')
                          : t(versions.length > 0 ? 'detail.retranscribe' : 'detail.transcribe')}
                      </Button>
                      {isTranscribing && (
                        <TranscriptionStopButton
                          engine={engine}
                          currentChunk={currentChunk}
                          totalChunks={totalChunks}
                          stopAfterPartRequested={stopAfterPartRequested}
                          onCancel={() => cancelTranscription()}
                          onStopAfterPart={() => stopAfterPart()}
                        />
                      )}
                      {hasTranscript && terms.length > 0 && !isTranscribing && (
                        <Button
                          variant="ghost"
                          onClick={handleApplyLexicons}
                          disabled={isGenerating}
                          title={t('detail.applyLexiconsHelp')}
                        >
                          <SpellCheck className="h-4 w-4" aria-hidden="true" />
                          {t('detail.applyLexicons')}
                        </Button>
                      )}
                      {lexiconFixes !== null && (
                        <p role="status" className="text-sm text-muted-foreground">
                          {lexiconFixes > 0
                            ? t('detail.lexiconFixes', { count: lexiconFixes })
                            : t('detail.lexiconNoFix')}
                        </p>
                      )}
                      {otherTranscriptionRunning && (
                        <p className="text-sm text-muted-foreground">{t('detail.otherTranscriptionRunning')}</p>
                      )}
                    </div>
                  )}
                  {isTranscribing && (
                    <div className="space-y-1 rounded-lg bg-muted/50 p-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span id="detail-transcription-progress" role="status">
                          {progressText ?? t('detail.transcribing')}
                        </span>
                        {!indeterminate && <span className="font-mono">{barValue}%</span>}
                      </div>
                      <Progress
                        value={barValue}
                        aria-labelledby="detail-transcription-progress"
                        aria-valuetext={indeterminate ? progressText ?? undefined : undefined}
                        className={cn(indeterminate && 'animate-pulse')}
                      />
                      <div className="pt-2">
                        <ShutdownWhenDoneCheckbox id="detail-shutdown-when-done" />
                      </div>
                    </div>
                  )}
                </div>
              )}
              {meeting.transcription?.segments && meeting.transcription.segments.length > 0 && (
                <Notice className="mb-4">{t('detail.transcriptAiNotice')}</Notice>
              )}
              {meeting.transcription?.segments && meeting.transcription.segments.length > 0 ? (
                <ol className="space-y-4">
                  {meeting.transcription.segments.map((segment, index) => (
                    <li key={index} className="border-l-2 border-border pl-4">
                      <div className="mb-1 flex items-center gap-2">
                        <span className={`font-semibold ${getSpeakerColor(segment.speaker)}`}>
                          {getSpeakerName(segment.speaker)}
                        </span>
                        <time className="font-mono text-xs text-muted-foreground">
                          {formatTimestamp(segment.startTime)}
                        </time>
                        {segment.confidence < 0.8 && (
                          <span
                            role="img"
                            aria-label={t('detail.lowConfidence', { percent: Math.round(segment.confidence * 100) })}
                            title={t('detail.confidence', { percent: Math.round(segment.confidence * 100) })}
                            className="inline-flex text-warning"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        )}
                      </div>
                      <p className="leading-relaxed">{segment.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="py-8 text-center text-muted-foreground">
                  <div className="mb-2 inline-flex rounded-full bg-muted p-3">
                    <Inbox className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <p className="font-medium text-foreground">{t('detail.noTranscript')}</p>
                  <p className="mt-1 text-sm">{t('detail.noTranscriptHint')}</p>
                </div>
              )}

              {/* Audio file */}
              {meeting.audioPath && (
                <div className="mt-6 border-t pt-4 text-sm text-muted-foreground">
                  <span className="font-medium">{t('detail.audioFile')}</span>
                  <code className="mt-1 block break-all rounded bg-muted px-2 py-1 text-xs text-foreground">
                    {meeting.audioPath}
                  </code>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="shrink-0 flex-col border-t p-6 sm:flex-col">
          {exportSuccess && (
            <Alert variant="success" role="status" className="flex-row items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription className="break-all">{t('common.exportedTo', { path: exportSuccess })}</AlertDescription>
            </Alert>
          )}

          {exportError && (
            <Alert variant="destructive" className="flex-row items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <AlertDescription>{exportError}</AlertDescription>
            </Alert>
          )}

          <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={handleCopy} disabled={isExporting || !hasContent}>
              {copySuccess ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copySuccess
                ? t('common.copied')
                : t(view === 'summary' ? 'detail.copySummary' : 'detail.copyTranscript')}
            </Button>
            <Button variant="record" onClick={handleSaveAs} disabled={isExporting || !hasContent}>
              <Save className="h-4 w-4" />
              {isExporting
                ? t('common.exporting')
                : t(view === 'summary' ? 'detail.saveSummaryAs' : 'detail.saveTranscriptAs')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={pendingDeleteVersion !== null}
        onOpenChange={(open) => !open && setPendingDeleteVersion(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.deleteVersionTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteVersion
                ? t('detail.deleteVersionDescription', { number: pendingDeleteVersion.number })
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                if (pendingDeleteVersion) deleteTranscriptionVersion(meeting.id, pendingDeleteVersion.id);
                setPendingDeleteVersion(null);
              }}
            >
              {t('meetings.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
