import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { AlertTriangle, Loader2, Pause, Play, Scissors } from 'lucide-react';
import transcriptionService, { type AudioRange } from '../../services/transcriptionService';
import { useT } from '../../i18n';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface AudioRangeSelectorProps {
  audioPath: string;
  /** Sélection proposée à l'ouverture (ex. plage de la version affichée) ; absente : tout. */
  initialRange?: AudioRange | null;
  /** Plage choisie, ou `null` pour tout l'enregistrement. */
  onConfirm: (range: AudioRange | null) => void;
  onCancel: () => void;
}

/** Résolution de la courbe calculée une fois ; regroupée ensuite par colonne affichée. */
const PEAK_COUNT = 4000;
/** Durée minimale d'une sélection (secondes), alignée sur le backend. */
const MIN_SELECTION = 0.5;
/** Tolérance (px) pour attraper un bord de la sélection. */
const HANDLE_HIT_PX = 8;
const BAR_WIDTH = 2;
const BAR_GAP = 1;

interface Preview {
  url: string;
  duration: number;
  peaks: Float32Array;
}

/** Lit l'en-tête WAV (PCM 16 bits) renvoyé par `load_audio_preview`. */
function parseWav(buffer: ArrayBuffer): { samples: Int16Array; sampleRate: number } {
  const view = new DataView(buffer);
  let sampleRate = 16000;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
    if (id === 'data') {
      const start = offset + 8;
      const length = Math.min(size, view.byteLength - start) >> 1;
      const samples =
        start % 2 === 0
          ? new Int16Array(buffer, start, length)
          : new Int16Array(buffer.slice(start, start + length * 2));
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV without data chunk');
}

/** Amplitude crête par tranche, normalisée sur la crête globale (une réunion calme reste lisible). */
function computePeaks(samples: Int16Array, count: number): Float32Array {
  const peaks = new Float32Array(count);
  const perPeak = samples.length / count;
  let globalMax = 0;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * perPeak);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * perPeak)));
    let max = 0;
    for (let j = from; j < to; j++) {
      const value = samples[j] < 0 ? -samples[j] : samples[j];
      if (value > max) max = value;
    }
    peaks[i] = max;
    if (max > globalMax) globalMax = max;
  }
  const scale = globalMax > 0 ? 1 / globalMax : 0;
  for (let i = 0; i < count; i++) peaks[i] *= scale;
  return peaks;
}

/** `m:ss.d`, ou `h:mm:ss.d` au-delà d'une heure. */
function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const sec = s.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Choix de la partie d'un enregistrement à transcrire : forme d'onde, sélection
 * à la souris (ou au clavier via les poignées) et écoute.
 */
export default function AudioRangeSelector({
  audioPath,
  initialRange,
  onConfirm,
  onCancel,
}: AudioRangeSelectorProps) {
  const { t } = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selection, setSelection] = useState<AudioRange>({ start: 0, end: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playUntilRef = useRef<number | null>(null);
  const dragRef = useRef<{ mode: 'start' | 'end' | 'new'; anchor: number; originX: number; moved: boolean } | null>(
    null
  );

  const duration = preview?.duration ?? 0;
  // Lue au chargement seulement : changer de version pendant la sélection ne la réinitialise pas.
  const initialRangeRef = useRef(initialRange);

  // Chargement : décodage côté backend (mono 16 kHz), courbe calculée ici.
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    setPreview(null);
    setLoadError(false);
    transcriptionService
      .loadAudioPreview(audioPath)
      .then((buffer) => {
        if (disposed) return;
        const { samples, sampleRate } = parseWav(buffer);
        const total = samples.length / sampleRate;
        url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
        setPreview({ url, duration: total, peaks: computePeaks(samples, PEAK_COUNT) });
        const initial = initialRangeRef.current;
        const start = initial ? clamp(initial.start, 0, total) : 0;
        const end = initial ? clamp(initial.end, start, total) : total;
        setSelection(end - start >= MIN_SELECTION ? { start, end } : { start: 0, end: total });
      })
      .catch((error) => {
        console.error('Failed to load audio preview:', error);
        if (!disposed) setLoadError(true);
      });
    return () => {
      disposed = true;
      audioRef.current?.pause();
      if (url) URL.revokeObjectURL(url);
    };
  }, [audioPath]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !preview) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Couleurs prises dans les tokens : suivent le thème clair / sombre.
    const styles = getComputedStyle(canvas);
    const active = `hsl(${styles.getPropertyValue('--primary').trim()})`;
    const inactive = `hsl(${styles.getPropertyValue('--muted-foreground').trim()} / 0.4)`;

    const { peaks } = preview;
    const step = BAR_WIDTH + BAR_GAP;
    const columns = Math.max(1, Math.floor(width / step));
    const middle = height / 2;
    for (let c = 0; c < columns; c++) {
      const from = Math.floor((c / columns) * peaks.length);
      const to = Math.max(from + 1, Math.floor(((c + 1) / columns) * peaks.length));
      let max = 0;
      for (let i = from; i < to; i++) if (peaks[i] > max) max = peaks[i];
      const x = c * step;
      const time = ((x + BAR_WIDTH / 2) / width) * preview.duration;
      ctx.fillStyle = time >= selection.start && time <= selection.end ? active : inactive;
      const barHeight = Math.max(1, max * (middle - 2));
      ctx.fillRect(x, middle - barHeight, BAR_WIDTH, barHeight * 2);
    }
  }, [preview, selection]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redessin au redimensionnement de la fenêtre et au changement de thème.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = new ResizeObserver(() => draw());
    resize.observe(canvas);
    const theme = new MutationObserver(() => draw());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, [draw]);

  // Tête de lecture : suivie image par image pendant la lecture.
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const until = playUntilRef.current;
        if (until !== null && audio.currentTime >= until) {
          audio.pause();
          audio.currentTime = until;
          playUntilRef.current = null;
        }
        setCurrentTime(audio.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  const seek = (time: number) => {
    const audio = audioRef.current;
    const target = clamp(time, 0, duration);
    playUntilRef.current = null;
    if (audio) audio.currentTime = target;
    setCurrentTime(target);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      return;
    }
    playUntilRef.current = null;
    void audio.play();
  };

  const playSelection = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = selection.start;
    setCurrentTime(selection.start);
    playUntilRef.current = selection.end;
    void audio.play();
  };

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const startX = (selection.start / duration) * rect.width;
    const endX = (selection.end / duration) * rect.width;
    const nearStart = Math.abs(x - startX) <= HANDLE_HIT_PX;
    const nearEnd = Math.abs(x - endX) <= HANDLE_HIT_PX;
    // Deux bords proches : on prend le plus près du pointeur.
    const mode =
      nearStart && nearEnd
        ? Math.abs(x - startX) < Math.abs(x - endX)
          ? 'start'
          : 'end'
        : nearStart
          ? 'start'
          : nearEnd
            ? 'end'
            : 'new';
    dragRef.current = { mode, anchor: timeAt(event.clientX), originX: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.originX) > 3) drag.moved = true;
    if (!drag.moved) return;
    const time = timeAt(event.clientX);
    if (drag.mode === 'new') {
      setSelection({ start: Math.min(drag.anchor, time), end: Math.max(drag.anchor, time) });
    } else if (drag.mode === 'start') {
      setSelection((s) => ({ start: clamp(time, 0, s.end - MIN_SELECTION), end: s.end }));
    } else {
      setSelection((s) => ({ start: s.start, end: clamp(time, s.start + MIN_SELECTION, duration) }));
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) {
      // Simple clic : déplace la tête de lecture.
      seek(timeAt(event.clientX));
      return;
    }
    setSelection((s) => {
      if (s.end - s.start >= MIN_SELECTION) return s;
      const start = Math.min(s.start, Math.max(0, duration - MIN_SELECTION));
      return { start, end: Math.min(duration, start + MIN_SELECTION) };
    });
  };

  const handleKey = (edge: 'start' | 'end') => (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    const current = edge === 'start' ? selection.start : selection.end;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - delta;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + delta;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = duration;
    if (next === null) return;
    event.preventDefault();
    const value = next;
    setSelection((s) =>
      edge === 'start'
        ? { start: clamp(value, 0, s.end - MIN_SELECTION), end: s.end }
        : { start: s.start, end: clamp(value, s.start + MIN_SELECTION, duration) }
    );
  };

  const isFullSelection = duration > 0 && selection.start <= 0.05 && selection.end >= duration - 0.05;
  const confirm = () => onConfirm(!preview || isFullSelection ? null : selection);
  const percent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div>
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <Scissors className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('range.title')}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">{t('range.hint')}</p>
      </div>

      {loadError ? (
        <Alert variant="destructive" className="flex-row items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <AlertDescription>{t('range.loadFailed')}</AlertDescription>
        </Alert>
      ) : !preview ? (
        <div role="status" className="flex h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('range.loading')}
        </div>
      ) : (
        <>
          <audio
            ref={audioRef}
            src={preview.url}
            preload="auto"
            onPlay={() => setIsPlaying(true)}
            onPause={() => {
              setIsPlaying(false);
              if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
            }}
            onEnded={() => setIsPlaying(false)}
          />

          <div
            ref={trackRef}
            className="relative h-28 cursor-crosshair touch-none select-none rounded-md bg-background"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => (dragRef.current = null)}
          >
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full"
              role="img"
              aria-label={t('range.waveform')}
            />

            {/* Sélection */}
            <div
              className="pointer-events-none absolute inset-y-0 border-x-2 border-primary bg-primary/10"
              style={{ left: `${percent(selection.start)}%`, width: `${percent(selection.end - selection.start)}%` }}
            />
            {(['start', 'end'] as const).map((edge) => {
              const value = edge === 'start' ? selection.start : selection.end;
              return (
                <div
                  key={edge}
                  role="slider"
                  tabIndex={0}
                  aria-label={t(edge === 'start' ? 'range.startHandle' : 'range.endHandle')}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(value)}
                  aria-valuetext={formatTime(value)}
                  onKeyDown={handleKey(edge)}
                  className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ left: `${percent(value)}%` }}
                >
                  <span className="h-8 w-1.5 rounded-full bg-primary shadow-card" aria-hidden="true" />
                </div>
              );
            })}

            {/* Tête de lecture */}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
              style={{ left: `${percent(currentTime)}%` }}
              aria-hidden="true"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={togglePlay}
                aria-label={t(isPlaying ? 'range.pause' : 'range.play')}
                title={t(isPlaying ? 'range.pause' : 'range.play')}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
              <Button variant="outline" size="sm" onClick={playSelection}>
                {t('range.playSelection')}
              </Button>
              <span className="font-mono text-xs text-muted-foreground">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelection({ start: 0, end: duration })}
              disabled={isFullSelection}
            >
              {t('range.selectAll')}
            </Button>
          </div>

          <dl className="grid grid-cols-3 gap-2 rounded-md bg-background p-3 text-xs">
            <div>
              <dt className="text-muted-foreground">{t('range.start')}</dt>
              <dd className="mt-0.5 font-mono font-medium">{formatTime(selection.start)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('range.end')}</dt>
              <dd className="mt-0.5 font-mono font-medium">{formatTime(selection.end)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('range.length')}</dt>
              <dd className="mt-0.5 font-mono font-medium">{formatTime(selection.end - selection.start)}</dd>
            </div>
          </dl>
        </>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button onClick={confirm} disabled={!preview && !loadError}>
          <Play className="mr-2 h-4 w-4" aria-hidden="true" />
          {t(!preview || isFullSelection ? 'range.transcribeAll' : 'range.transcribeSelection')}
        </Button>
      </div>
    </div>
  );
}
