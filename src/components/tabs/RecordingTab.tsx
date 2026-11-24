import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Mic, Square, Check, AlertTriangle, RefreshCw, Info } from 'lucide-react';
import { useMeetingStore, MeetingSession } from '../../store/meetingStore';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useNotificationStore } from '../../store/notificationStore';
import { appConfig } from '../../config/app.config';
import { useT } from '../../i18n';
import WaveformVisualizer from '../common/WaveformVisualizer';
import { Notice } from '../common/Notice';
import { useTranscription } from '../../hooks/useTranscription';
import { RECORDING_TRANSCRIPTION_KEY, useTaskStore } from '../../store/taskStore';
import { useShutdownStore } from '../../store/shutdownStore';
import { ShutdownWhenDoneCheckbox, TranscriptionStopButton } from '../common/TranscriptionStopControls';
import { formatDuration } from '../../utils/format';
import { describeTranscriptionProgress, isLoadingModel, modelLoadPercent } from '../../lib/transcriptionProgress';
import { parseAudioDevices, resolveDevice, type AudioDeviceList } from '../../lib/audioDevices';
import { useAudioDeviceStore } from '../../store/audioDeviceStore';
import { AudioDeviceSelect } from '../common/AudioDeviceSelect';
import { cn } from '@/lib/utils';
import { v4 as uuidv4 } from 'uuid';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
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

type RecordingState = 'idle' | 'recording' | 'transcribing' | 'saving';
/** Raison d'un arrêt décidé par le backend (événement `recording-auto-stopped`). */
type AutoStopReason = 'silence' | 'sleep';

export default function RecordingTab() {
  const [language, setLanguage] = useState(appConfig.defaultLanguage);
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [recordingsDir, setRecordingsDir] = useState<string>('');

  // Save form fields
  const [meetingName, setMeetingName] = useState('');
  const [meetingTag, setMeetingTag] = useState('');
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [autoStopReason, setAutoStopReason] = useState<AutoStopReason | null>(null);

  // Point d'entrée unique « démarrer / arrêter » : utilisé par le bouton
  // de la fenêtre et par le menu du tray (événement `tray-toggle-recording`).
  const toggleRecordingRef = useRef<() => void>(() => {});
  // Le backend a déjà arrêté la capture : on passe directement à l'étape d'enregistrement.
  const autoStoppedRef = useRef<(reason: AutoStopReason) => void>(() => {});

  const { addMeeting } = useMeetingStore();
  const notifyTour = useOnboardingStore((state) => state.notify);
  const setAppError = useNotificationStore((state) => state.setError);
  const setRecordingTask = useTaskStore((state) => state.setRecording);
  const clearAppError = useNotificationStore((state) => state.clearError);
  const { t, formatDate, languageName, intlLocale } = useT();

  // Micro et sortie audio : choix mémorisé, et liste des périphériques branchés (`null` tant
  // qu'elle n'est pas chargée).
  const { input: savedInput, output: savedOutput, setInput, setOutput } = useAudioDeviceStore();
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  const inputDevice = resolveDevice(savedInput, devices?.inputs ?? null);
  const outputDevice = resolveDevice(savedOutput, devices?.outputs ?? null);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(parseAudioDevices(await invoke<unknown>('list_audio_devices'), intlLocale));
    } catch (error) {
      // Liste inconnue (hors Tauri…) : le choix mémorisé est transmis tel quel.
      console.error('Failed to list audio devices:', error);
    }
  }, [intlLocale]);

  // Avant l'enregistrement, et à chaque retour sur la fenêtre (casque branché entre-temps).
  useEffect(() => {
    if (recordingState !== 'idle') {
      return;
    }
    refreshDevices();
    window.addEventListener('focus', refreshDevices);
    return () => window.removeEventListener('focus', refreshDevices);
  }, [recordingState, refreshDevices]);

  // Load recordings directory from preferences
  useEffect(() => {
    const loadRecordingsDir = async () => {
      try {
        const dir = await invoke<string>('get_recordings_dir');
        setRecordingsDir(dir);
      } catch (error) {
        console.error('Failed to load recordings directory:', error);
        // Fallback to current directory
        setRecordingsDir('.');
      }
    };
    loadRecordingsDir();
  }, []);

  // Transcription hook : les identifiants Azure sont gérés côté backend (Réglages > Clés Azure).
  const {
    result: transcriptionResult,
    error: transcriptionError,
    progress: transcriptionProgress,
    currentChunk,
    totalChunks,
    progressMessage,
    phase: transcriptionPhase,
    processedSeconds,
    totalSeconds,
    modelLoadSeconds,
    modelLoadExpectedSeconds,
    transcribe,
    cancel: cancelTranscription,
    stopAfterPart,
    engine: transcriptionEngine,
    stopAfterPartRequested,
    reset: resetTranscription,
  } = useTranscription(RECORDING_TRANSCRIPTION_KEY);
  // Extinction en fin de traitement : la réunion est enregistrée sans attendre le formulaire,
  // sinon la transcription, gardée en mémoire jusqu'au clic sur Enregistrer, serait perdue.
  const autoSaveRef = useRef(false);

  const progressState = {
    phase: transcriptionPhase,
    currentChunk,
    totalChunks,
    processedSeconds,
    totalSeconds,
    modelLoadSeconds,
    modelLoadExpectedSeconds,
    progress: transcriptionProgress,
  };
  const loadingModel = isLoadingModel(progressState);
  const loadPercent = modelLoadPercent(progressState);
  // Barre indéterminée seulement si le backend ne fournit pas de durée attendue.
  const indeterminate = loadingModel && loadPercent === null;
  const barValue = loadingModel ? loadPercent ?? 100 : transcriptionProgress;
  const progressText = describeTranscriptionProgress(t, progressState);

  // Erreur de transcription : bandeau global tant qu'on n'est pas dans l'étape « saving »,
  // où l'encart local la montre déjà (évite d'afficher le même message deux fois).
  useEffect(() => {
    if (!transcriptionError) {
      return;
    }
    if (recordingState === 'saving') {
      clearAppError();
    } else {
      setAppError({ title: t('record.transcriptionFailed'), message: transcriptionError });
    }
  }, [transcriptionError, recordingState, setAppError, clearAppError]);

  // Timer for recording duration
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (recordingState === 'recording') {
      interval = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [recordingState]);

  // Poll audio level while recording
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (recordingState === 'recording') {
      interval = setInterval(async () => {
        try {
          const level = await invoke<number>('get_audio_level');
          setAudioLevel(level);
        } catch (error) {
          console.error('Failed to get audio level:', error);
        }
      }, 100);
    }
    return () => clearInterval(interval);
  }, [recordingState]);

  const handleStart = async () => {
    try {
      clearAppError();
      const id = uuidv4();
      // Generate filename with timestamp for uniqueness
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `recording_${timestamp}_${id.slice(0, 8)}.wav`;

      // Build full path using configured recordings directory
      const outputPath = recordingsDir
        ? `${recordingsDir}\\${filename}`
        : filename;

      // Use combined mode to capture both microphone and system audio (speaker output)
      await invoke('set_recording_mode', { mode: 'combined' });

      await invoke('start_recording', {
        title: 'Recording',
        language,
        outputPath,
        // `null` : périphérique par défaut de Windows.
        inputDeviceId: inputDevice.id,
        outputDeviceId: outputDevice.id,
      });

      setSessionId(id);
      setAudioPath(outputPath);
      setRecordingState('recording');
      setDuration(0);
      setAudioLevel(0);
      setAutoStopReason(null);
      resetTranscription();
    } catch (error) {
      console.error('Failed to start recording:', error);
      setAppError({ title: t('record.startFailed'), message: String(error) });
    }
  };

  const handleStop = async () => {
    try {
      clearAppError();
      await invoke('stop_recording', {
        sessionId: sessionId || 'unknown',
      });

      setAudioLevel(0);
      setRecordingState('saving');
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setAppError({ title: t('record.stopFailed'), message: String(error) });
      setRecordingState('saving');
    }
  };

  // Le tray délègue au même handler que le bouton de la fenêtre.
  toggleRecordingRef.current = () => {
    if (recordingState === 'idle') {
      handleStart();
    } else if (recordingState === 'recording') {
      handleStop();
    }
  };

  autoStoppedRef.current = (reason) => {
    if (recordingState !== 'recording') {
      return;
    }
    setAudioLevel(0);
    setAutoStopReason(reason);
    setRecordingState('saving');
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<{ reason: AutoStopReason }>('recording-auto-stopped', (event) =>
      autoStoppedRef.current(event.payload.reason),
    )
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Hors Tauri (navigateur) : pas d'arrêt automatique.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // En StrictMode (dev), l'effet est monté, démonté puis remonté : le nettoyage
    // peut arriver avant que listen() ait résolu. Il faut alors retirer l'écouteur
    // dès la résolution, sinon chaque clic du tray déclenche deux démarrages.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen('tray-toggle-recording', () => toggleRecordingRef.current())
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Hors Tauri (navigateur) : pas d'événement tray.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Garde le libellé du tray et l'indicateur de l'en-tête synchronisés avec l'état d'enregistrement.
  useEffect(() => {
    const recording = recordingState === 'recording';
    invoke('set_tray_recording', { recording }).catch(() => {
      // Hors Tauri ou tray indisponible : sans effet.
    });
    setRecordingTask(recording ? { startedAt: Date.now() } : null);
  }, [recordingState, setRecordingTask]);

  const resetForm = useCallback(() => {
    setRecordingState('idle');
    setSessionId(null);
    setAudioPath(null);
    setMeetingName('');
    setMeetingTag('');
    setDuration(0);
    setAutoStopReason(null);
    resetTranscription();
    clearAppError();
  }, [resetTranscription, clearAppError]);

  // Visite guidée : démarrer puis arrêter (bouton, zone de notification ou arrêt automatique) la fait avancer.
  useEffect(() => {
    if (recordingState === 'recording') notifyTour('recording-started');
    else if (recordingState === 'saving') notifyTour('recording-stopped');
  }, [recordingState, notifyTour]);

  const handleSave = () => {
    const newMeeting: MeetingSession = {
      id: sessionId || uuidv4(),
      title:
        meetingName.trim() ||
        t('record.defaultTitle', { date: formatDate(new Date(), { dateStyle: 'short', timeStyle: 'short' }) }),
      language,
      duration,
      recordedAt: new Date(),
      status: transcriptionError ? 'failed' : 'completed',
      audioPath: audioPath || undefined,
      speakers: [],
      tag: meetingTag.trim() || undefined,
      transcriptionError: transcriptionError || undefined,
      transcription: transcriptionResult
        ? {
            sessionId: sessionId || '',
            segments: transcriptionResult.segments,
            summary: undefined,
          }
        : undefined,
    };

    addMeeting(newMeeting);
    resetForm();
    notifyTour('meeting-saved');
  };

  const handleRetryTranscription = async () => {
    if (audioPath) {
      clearAppError();
      setRecordingState('transcribing');
      await transcribe(audioPath, language, null, meetingName.trim() || undefined);
      autoSaveRef.current = useShutdownStore.getState().armed;
      setRecordingState('saving');
    }
  };

  useEffect(() => {
    if (recordingState === 'saving' && autoSaveRef.current) {
      autoSaveRef.current = false;
      handleSave();
    }
  });

  const transcriptionFailed = Boolean(transcriptionError);

  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center space-y-6">

      {/* IDLE STATE - Language and devices + Start button */}
      {recordingState === 'idle' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex w-full flex-col items-center space-y-6"
        >
          <div className="w-full max-w-sm space-y-4">
            <div className="space-y-2" data-tour="meeting-language">
              <Label htmlFor="recording-language">{t('record.language')}</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="recording-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {appConfig.supportedLanguages.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      {languageName(lang.code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-4" data-tour="audio-devices">
            <AudioDeviceSelect
              id="recording-input"
              label={t('record.microphone')}
              devices={devices?.inputs ?? null}
              saved={savedInput}
              resolved={inputDevice}
              onChange={setInput}
              onOpen={refreshDevices}
            />
            <AudioDeviceSelect
              id="recording-output"
              label={t('record.output')}
              devices={devices?.outputs ?? null}
              saved={savedOutput}
              resolved={outputDevice}
              onChange={setOutput}
              onOpen={refreshDevices}
            />
            </div>
          </div>

          {/* Big Start Button */}
          <motion.button
            type="button"
            onClick={handleStart}
            aria-label={t('record.startAria')}
            data-tour="record-start"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.95 }}
            className="flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-full bg-record text-record-foreground shadow-card transition-all duration-200 hover:bg-record/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Mic className="h-7 w-7" aria-hidden="true" />
            <span className="text-sm font-semibold">{t('record.start')}</span>
          </motion.button>

          <div className="flex flex-col items-center gap-2">
            <p className="text-center text-sm text-muted-foreground">
              {t('record.hint')}
            </p>
            <Notice>{t('record.consent')}</Notice>
          </div>
        </motion.div>
      )}

      {/* RECORDING STATE - Timer + Waveform + Stop button */}
      {recordingState === 'recording' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex w-full max-w-md flex-col items-center space-y-6"
        >
          {/* Recording Indicator + Timer */}
          <div className="text-center" role="timer" aria-live="off">
            <motion.div
              animate={{ opacity: [1, 0.5, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              className="flex items-center justify-center gap-3 font-mono text-4xl font-bold tabular-nums text-destructive"
            >
              <span className="text-xl" aria-hidden="true">●</span>
              {formatDuration(duration)}
            </motion.div>
            <p className="mt-2 text-muted-foreground">{t('record.inProgress')}</p>
          </div>

          <div className="w-full">
            <WaveformVisualizer audioLevel={audioLevel} />
          </div>

          {/* Audio Level Bar */}
          <div className="w-full">
            <div className="mb-1">
              <span id="audio-level-label" className="text-xs text-muted-foreground">{t('record.audioLevel')}</span>
            </div>
            <div
              role="meter"
              aria-labelledby="audio-level-label"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(audioLevel * 100)}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <motion.div
                animate={{ width: `${audioLevel * 100}%` }}
                transition={{ duration: 0.1 }}
                // Un niveau très faible mais non nul doit rester visible, pour le distinguer d'une capture muette.
                style={{ minWidth: audioLevel > 0 ? 8 : 0 }}
                className="h-full bg-linear-to-r from-success via-warning to-destructive"
              />
            </div>
          </div>

          {/* Big Stop Button */}
          <motion.button
            type="button"
            onClick={handleStop}
            aria-label={t('record.stopAria')}
            data-tour="record-stop"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.95 }}
            className="flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-full bg-destructive text-primary-foreground shadow-card transition-all duration-200 hover:bg-destructive/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Square className="h-6 w-6 fill-current" aria-hidden="true" />
            <span className="text-sm font-semibold">{t('record.stop')}</span>
          </motion.button>
        </motion.div>
      )}

      {/* TRANSCRIBING STATE */}
      {recordingState === 'transcribing' && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex w-full max-w-md flex-col items-center space-y-6"
          role="status"
        >
          <div className="text-center">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 2, ease: 'linear' }}
              className="mb-4 inline-flex text-primary"
              aria-hidden="true"
            >
              <RefreshCw className="h-12 w-12" />
            </motion.div>
            <h2 className="text-xl font-semibold">{t('record.transcribing')}</h2>
            <p className="mt-2 text-muted-foreground">{t('record.transcribingDetail')}</p>
          </div>

          <div className="w-full space-y-1">
            <div className="flex items-center justify-between">
              <span id="transcription-progress-label" className="text-xs text-muted-foreground">{t('record.progress')}</span>
              {!indeterminate && (
                <span className="text-xs text-muted-foreground">{barValue}%</span>
              )}
            </div>
            {/* Chargement du modèle local : avancement estimé, ou barre pleine qui pulse sans estimation. */}
            <Progress
              value={barValue}
              aria-labelledby="transcription-progress-label"
              aria-valuetext={indeterminate ? progressText ?? undefined : undefined}
              className={cn('h-3', indeterminate && 'animate-pulse')}
            />
          </div>

          <p className="text-sm text-muted-foreground">{t('common.duration', { duration: formatDuration(duration) })}</p>

          {(progressText || progressMessage) && (
            <p className="text-center text-sm text-muted-foreground">
              {progressText ?? t('record.preparingChunks')}
            </p>
          )}

          <TranscriptionStopButton
            engine={transcriptionEngine}
            currentChunk={currentChunk}
            totalChunks={totalChunks}
            stopAfterPartRequested={stopAfterPartRequested}
            onCancel={() => cancelTranscription()}
            onStopAfterPart={() => stopAfterPart()}
          />
          <ShutdownWhenDoneCheckbox id="record-shutdown-when-done" />
        </motion.div>
      )}

      {/* SAVING STATE - Result + name/tag form */}
      {recordingState === 'saving' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          <Card className="rounded-2xl p-6 shadow-xl">
            <CardContent className="space-y-4 p-0">
              <div className="text-center">
                <h2 className="mb-1 text-xl font-semibold">
                  {transcriptionFailed
                    ? t('record.doneWithoutTranscript')
                    : transcriptionResult
                      ? t('record.doneWithTranscript')
                      : t('record.readyToSave')}
                </h2>
                <p className="text-muted-foreground">{t('common.duration', { duration: formatDuration(duration) })}</p>
              </div>

              {autoStopReason && (
                <Alert role="status">
                  <AlertTitle className="flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    {t('record.autoStoppedTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {autoStopReason === 'silence' ? t('record.autoStoppedSilence') : t('record.autoStoppedSleep')}
                  </AlertDescription>
                </Alert>
              )}

              {transcriptionResult && (
                <Alert variant="success" role="status">
                  <AlertTitle className="flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    {t('record.transcriptionDone')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('record.transcriptionStats', {
                      segments: transcriptionResult.segments.length,
                      characters: transcriptionResult.fullText.length,
                    })}
                  </AlertDescription>
                </Alert>
              )}

              {transcriptionError && (
                <Alert variant="destructive">
                  <AlertTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {t('record.transcriptionFailed')}
                  </AlertTitle>
                  <AlertDescription>
                    {transcriptionError}
                    <div>
                      <Button variant="link" size="sm" className="h-auto p-0 text-destructive" onClick={handleRetryTranscription}>
                        {t('record.retryTranscription')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="meeting-name">{t('record.meetingName')}</Label>
                <Input
                  id="meeting-name"
                  type="text"
                  value={meetingName}
                  onChange={(e) => setMeetingName(e.target.value)}
                  placeholder={t('record.meetingNamePlaceholder')}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="meeting-tag">
                  {t('record.tag')} <span className="font-normal text-muted-foreground">{t('common.optional')}</span>
                </Label>
                <Input
                  id="meeting-tag"
                  type="text"
                  value={meetingTag}
                  onChange={(e) => setMeetingTag(e.target.value)}
                  placeholder={t('record.tagPlaceholder')}
                />
              </div>

              {transcriptionResult && transcriptionResult.fullText && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('common.transcriptPreview')}</p>
                  <div className="max-h-32 overflow-y-auto rounded-lg border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                    {transcriptionResult.fullText.substring(0, 500)}
                    {transcriptionResult.fullText.length > 500 && '…'}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2" data-tour="meeting-save">
                <Button variant="outline" className="flex-1" onClick={() => setConfirmDiscardOpen(true)}>
                  {t('record.discard')}
                </Button>
                <Button variant="record" className="flex-1" onClick={handleSave}>
                  {t('record.save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('record.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('record.discardDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                setConfirmDiscardOpen(false);
                resetForm();
                notifyTour('meeting-discarded');
              }}
            >
              {t('record.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
