import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { open } from '@tauri-apps/plugin-dialog';
import { v4 as uuidv4 } from 'uuid';
import {
  Eye,
  Trash2,
  Folder,
  Upload,
  Search,
  SearchX,
  X,
  ChevronLeft,
  ChevronRight,
  Tag,
  CircleCheck,
  CircleDashed,
  RefreshCw,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useMeetingStore, MeetingSession } from '../../store/meetingStore';
import { useNotificationStore } from '../../store/notificationStore';
import { useTaskStore } from '../../store/taskStore';
import { appConfig } from '../../config/app.config';
import { useT, type MessageKey } from '../../i18n';
import MeetingDetailModal from '../modals/MeetingDetailModal';
import { formatDuration } from '../../utils/format';
import { collectTags, normalizeText as normalize, parseTags, tagKey } from '../../utils/tags';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, badgeVariants, type BadgeProps } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const SUPPORTED_IMPORT_EXTENSIONS = ['wav', 'mp3', 'm4a'];
const PAGE_SIZE = 10;

/** Texte dans lequel on cherche : titre, étiquettes et transcription. */
const searchableText = (meeting: MeetingSession) =>
  normalize(
    [
      meeting.title,
      meeting.tag ?? '',
      ...(meeting.transcription?.segments ?? []).map((segment) => segment.text),
    ].join(' ')
  );

const getFilenameWithoutExtension = (path: string) => {
  const fileName = path.split(/[/\\]/).pop() || path;
  return fileName.replace(/\.[^/.]+$/, '');
};

/**
 * Statuts affichés dans la liste. « Non transcrite » et « Terminée » n'y figurent pas :
 * les pastilles Transcription / Résumé (ContentBadges) disent déjà ce que contient la réunion.
 */
const STATUS_BADGE: Partial<Record<MeetingSession['status'], { label: MessageKey; variant: BadgeProps['variant'] }>> = {
  recording: { label: 'status.recording', variant: 'warning' },
  processing: { label: 'status.processing', variant: 'default' },
  failed: { label: 'status.failed', variant: 'destructive' },
};

type ContentState = 'done' | 'running' | 'missing';

/**
 * Disponible : teinte de succès ; en cours : teinte de la marque ; absent : contour pointillé discret.
 * Bordure transparente sur les pleines : même largeur dans tous les états, la colonne reste alignée.
 */
const CONTENT_STYLE: Record<ContentState, { variant: BadgeProps['variant']; className: string }> = {
  done: { variant: 'success', className: 'border border-transparent' },
  running: { variant: 'default', className: 'border border-transparent' },
  missing: { variant: 'outline', className: 'border-dashed text-muted-foreground' },
};

const CONTENT_TEXT: Record<'transcript' | 'summary', { label: MessageKey } & Record<ContentState, MessageKey>> = {
  transcript: {
    label: 'meetings.transcript',
    done: 'meetings.transcriptDone',
    running: 'meetings.transcriptRunning',
    missing: 'meetings.transcriptMissing',
  },
  summary: {
    label: 'meetings.summary',
    done: 'meetings.summaryDone',
    running: 'meetings.summaryRunning',
    missing: 'meetings.summaryMissing',
  },
};

/**
 * Pastilles « Transcription » et « Résumé » d'une réunion : disponible, en cours ou absent.
 * Portent sur la version active de la transcription, celle que la fiche affiche à l'ouverture.
 * Icônes « en cours » reprises de l'indicateur de l'en-tête (ActivityIndicator).
 */
function ContentBadges({ meeting }: { meeting: MeetingSession }) {
  const { t } = useT();
  const isTranscribing = useTaskStore((s) => s.transcriptions[meeting.id]?.isTranscribing ?? false);
  const isSummarizing = useTaskStore((s) => s.summary?.meetingId === meeting.id && s.summary.isGenerating);

  const items: { kind: 'transcript' | 'summary'; state: ContentState; runningIcon: LucideIcon; runningClass: string }[] = [
    {
      kind: 'transcript',
      state: isTranscribing ? 'running' : meeting.transcription?.segments?.length ? 'done' : 'missing',
      runningIcon: RefreshCw,
      runningClass: 'animate-spin',
    },
    {
      kind: 'summary',
      state: isSummarizing ? 'running' : meeting.transcription?.summary?.trim() ? 'done' : 'missing',
      runningIcon: Sparkles,
      runningClass: 'animate-pulse',
    },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {items.map(({ kind, state, runningIcon, runningClass }) => {
        const text = CONTENT_TEXT[kind];
        const style = CONTENT_STYLE[state];
        const Icon = state === 'done' ? CircleCheck : state === 'running' ? runningIcon : CircleDashed;
        const description = t(text[state]);
        return (
          <Badge key={kind} variant={style.variant} className={cn('whitespace-nowrap', style.className)} title={description}>
            <Icon className={cn('h-3.5 w-3.5', state === 'running' && runningClass)} aria-hidden="true" />
            <span aria-hidden="true">{t(text.label)}</span>
            <span className="sr-only">{description}</span>
          </Badge>
        );
      })}
    </div>
  );
}

/** Puce d'étiquette (filtre ou réunion) : bordure neutre, teinte de la marque quand le filtre est actif. */
const TAG_CHIP = 'h-7 px-3 text-xs font-medium';
const TAG_ACTIVE = 'border-primary/40 bg-primary/10 text-brand-text hover:border-primary/60 hover:bg-primary/15';

interface RecordingsTabProps {
  /** Réunion dont la fiche est ouverte (portée par MainApp : l'indicateur de l'en-tête peut l'ouvrir). */
  openMeetingId: string | null;
  onOpenMeeting: (meetingId: string | null) => void;
  /** Lien « Modifier les prompts » de la fiche : ouvre l'onglet Prompts sur le prompt donné. */
  onEditPrompts: (promptId?: string) => void;
}

export default function RecordingsTab({ openMeetingId, onOpenMeeting, onEditPrompts }: RecordingsTabProps) {
  const meetings = useMeetingStore((state) => state.meetings);
  const removeMeeting = useMeetingStore((state) => state.removeMeeting);
  const addMeeting = useMeetingStore((state) => state.addMeeting);
  const setAppError = useNotificationStore((state) => state.setError);
  const { t, locale, formatDate } = useT();
  // On garde l'id, pas l'objet : la fiche suit ainsi les mises à jour du store (transcription lancée depuis la fiche).
  const selectedMeetingId = openMeetingId;
  const setSelectedMeetingId = onOpenMeeting;
  const selectedMeeting = meetings.find((m) => m.id === selectedMeetingId) ?? null;
  const [pendingDelete, setPendingDelete] = useState<MeetingSession | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // Filtre par étiquette (clé normalisée) ; ignoré si plus aucune réunion ne porte cette étiquette.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const allTags = useMemo(() => collectTags(meetings, locale), [meetings, locale]);
  const activeTag = allTags.find((tag) => tag.key === tagFilter) ?? null;
  const toggleTag = (key: string) => setTagFilter((current) => (current === key ? null : key));
  const isFiltered = query.trim() !== '' || activeTag !== null;
  const clearFilters = () => {
    setQuery('');
    setTagFilter(null);
  };

  // Index de recherche recalculé seulement quand la liste change (transcriptions longues).
  const searchIndex = useMemo(
    () =>
      meetings.map((meeting) => ({
        meeting,
        text: searchableText(meeting),
        tagKeys: parseTags(meeting.tag).map(tagKey),
      })),
    [meetings]
  );
  const filteredMeetings = useMemo(() => {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const tag = activeTag?.key;
    if (terms.length === 0 && !tag) return meetings;
    return searchIndex
      .filter(({ text, tagKeys }) => (!tag || tagKeys.includes(tag)) && terms.every((term) => text.includes(term)))
      .map(({ meeting }) => meeting);
  }, [query, activeTag?.key, meetings, searchIndex]);

  const totalPages = Math.max(1, Math.ceil(filteredMeetings.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMeetings = filteredMeetings.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Nouvelle recherche ou étiquette → première page. Suppression du dernier élément d'une page → page précédente.
  useEffect(() => setPage(1), [query, tagFilter]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Import d'un ou plusieurs fichiers audio : chacun devient une réunion « Not transcribed »,
  // transcrite à la demande depuis sa fiche. Une seule réunion importée → sa fiche s'ouvre.
  const handleImport = async () => {
    setIsImporting(true);
    try {
      const selection = await open({
        multiple: true,
        directory: false,
        filters: [{ name: t('meetings.audioFiles'), extensions: SUPPORTED_IMPORT_EXTENSIONS }],
      });
      if (!selection) {
        return;
      }
      const paths = Array.isArray(selection) ? selection : [selection];
      const imported: MeetingSession[] = paths.map((audioPath) => ({
        id: uuidv4(),
        title: getFilenameWithoutExtension(audioPath),
        language: appConfig.defaultLanguage,
        duration: 0,
        recordedAt: new Date(),
        status: 'stopped',
        audioPath,
        speakers: [],
      }));
      imported.forEach(addMeeting);
      if (imported.length === 1) {
        setSelectedMeetingId(imported[0].id);
      }
    } catch (error) {
      console.error('Failed to import audio files:', error);
      setAppError({
        title: t('meetings.importFailed'),
        message: t('meetings.importFailedDetail'),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const importButton = (
    <Button variant="outline" onClick={handleImport} disabled={isImporting}>
      <Upload className="h-4 w-4" aria-hidden="true" />
      {isImporting ? t('meetings.importing') : t('meetings.import')}
    </Button>
  );

  return (
    <div className="space-y-4">
      {meetings.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[16rem] flex-1">
            <Label htmlFor="meetings-search" className="sr-only">
              {t('meetings.search')}
            </Label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="meetings-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) setQuery('');
              }}
              placeholder={t('meetings.searchPlaceholder')}
              className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setQuery('')}
                aria-label={t('meetings.clearSearch')}
                title={t('meetings.clearSearch')}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {importButton}
        </div>
      )}

      {allTags.length > 0 && (
        <div role="group" aria-label={t('meetings.tagFilter')} className="flex flex-wrap items-center gap-2">
          <Tag className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Button
            size="sm"
            variant="outline"
            aria-pressed={!activeTag}
            onClick={() => setTagFilter(null)}
            className={cn(TAG_CHIP, !activeTag && TAG_ACTIVE)}
          >
            {t('meetings.allTags')}
          </Button>
          {allTags.map((tag) => {
            const active = activeTag?.key === tag.key;
            return (
              <Button
                key={tag.key}
                size="sm"
                variant="outline"
                aria-pressed={active}
                onClick={() => toggleTag(tag.key)}
                className={cn(TAG_CHIP, active && TAG_ACTIVE)}
              >
                {tag.label}
              </Button>
            );
          })}
        </div>
      )}

      {meetings.length > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {isFiltered
            ? t('meetings.resultCount', { count: filteredMeetings.length, total: meetings.length })
            : t('meetings.count', { count: meetings.length })}
        </p>
      )}

      {meetings.length === 0 ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="p-12 text-center shadow-soft">
            <div className="mb-4 inline-flex rounded-full bg-muted p-4 text-muted-foreground">
              <Folder className="h-7 w-7" aria-hidden="true" />
            </div>
            <h2 className="mb-2 text-lg font-semibold">{t('meetings.emptyTitle')}</h2>
            <p className="mb-6 text-muted-foreground">
              {t('meetings.emptyText')}
            </p>
            {importButton}
          </Card>
        </motion.div>
      ) : filteredMeetings.length === 0 ? (
        <Card className="p-12 text-center shadow-soft">
          <div className="mb-4 inline-flex rounded-full bg-muted p-4 text-muted-foreground">
            <SearchX className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="mb-2 text-lg font-semibold">{t('meetings.noResultsTitle')}</h2>
          <p className="mb-6 break-words text-muted-foreground">
            {activeTag
              ? t('meetings.noResultsTagText', { tag: activeTag.label, query: query.trim() })
              : t('meetings.noResultsText', { query: query.trim() })}
          </p>
          <Button variant="outline" onClick={clearFilters}>
            {t(activeTag ? 'meetings.clearFilters' : 'meetings.clearSearch')}
          </Button>
        </Card>
      ) : (
        <ul className="space-y-3">
          {pageMeetings.map((meeting, index) => {
            const status = STATUS_BADGE[meeting.status];
            return (
              <motion.li
                key={meeting.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(index * 0.05, 0.3) }}
              >
                <Card className="p-4 shadow-soft transition-shadow hover:shadow-medium">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold" title={meeting.title}>
                        {meeting.title}
                      </h3>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
                        <span>
                          {formatDate(meeting.recordedAt, { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                        {meeting.duration > 0 && (
                          <>
                            <span aria-hidden="true">•</span>
                            <span className="font-mono">{formatDuration(meeting.duration)}</span>
                          </>
                        )}
                        {status && <Badge variant={status.variant}>{t(status.label)}</Badge>}
                        {/* Étiquettes : un clic filtre la liste sur l'étiquette (ou retire le filtre). */}
                        {parseTags(meeting.tag).map((label) => {
                          const key = tagKey(label);
                          const active = activeTag?.key === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              aria-pressed={active}
                              aria-label={t('meetings.filterByTag', { tag: label })}
                              title={t('meetings.filterByTag', { tag: label })}
                              onClick={() => toggleTag(key)}
                              className={cn(
                                badgeVariants({ variant: 'outline' }),
                                'max-w-[12rem] hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                active && TAG_ACTIVE
                              )}
                            >
                              <span className="truncate">{label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {meeting.transcriptionError && (
                        <p className="mt-2 line-clamp-2 text-xs text-destructive">
                          {meeting.transcriptionError}
                        </p>
                      )}
                    </div>

                    {/* Colonne fixe : on lit d'un coup d'œil, de haut en bas, ce qui a été transcrit et résumé. */}
                    <div className="flex shrink-0 items-center gap-3">
                      <ContentBadges meeting={meeting} />
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setSelectedMeetingId(meeting.id)}
                          aria-label={t('meetings.viewAria', { title: meeting.title })}
                          title={t('meetings.view')}
                        >
                          <Eye className="h-5 w-5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPendingDelete(meeting)}
                          aria-label={t('meetings.deleteAria', { title: meeting.title })}
                          title={t('meetings.delete')}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-5 w-5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              </motion.li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <nav aria-label={t('meetings.pagination')} className="flex items-center justify-center gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {t('meetings.previousPage')}
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {t('meetings.pageOf', { current: currentPage, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            {t('meetings.nextPage')}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </nav>
      )}

      {selectedMeeting && (
        <MeetingDetailModal
          meeting={selectedMeeting}
          onClose={() => setSelectedMeetingId(null)}
          onEditPrompts={onEditPrompts}
        />
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('meetings.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? t('meetings.deleteDescription', { title: pendingDelete.title }) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                if (pendingDelete) {
                  removeMeeting(pendingDelete.id);
                }
                setPendingDelete(null);
              }}
            >
              {t('meetings.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
