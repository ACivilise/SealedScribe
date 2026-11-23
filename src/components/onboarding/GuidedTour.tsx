import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import { canGoBack, clipBox, placeBubble, TOUR_STEPS, type Box } from '../../lib/onboarding';
import { useOnboardingStore, useTourStep } from '../../store/onboardingStore';

/** Taille de la bulle avant sa première mesure (largeur de `w-72`). */
const BUBBLE_FALLBACK = { width: 288, height: 180 };
/** Marge du halo autour de l'élément visé. */
const SPOT_PADDING = 6;

interface Layout {
  /** Élément qui reçoit la visite : la fenêtre Paramètres (sa bulle reste dans son piège à focus) ou le body. */
  host: HTMLElement;
  /** Coin haut gauche du bloc conteneur de la racine `fixed` (la fenêtre Paramètres est translatée). */
  origin: { left: number; top: number };
  bounds: Box;
  radius: string;
  spot: Box | null;
  bubble: { left: number; top: number };
  variant?: string;
}

const toBox = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

const schedule = (callback: () => void): number =>
  typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);

const unschedule = (id: number) =>
  typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame(id) : window.clearTimeout(id);

/**
 * Visite guidée du premier lancement : halo sur l'élément visé et bulle d'explication.
 * La position est recalculée à chaque image : la cible peut défiler, changer de taille ou
 * apparaître après un changement d'onglet. Rien ne bloque l'interface (pointer-events: none
 * sauf sur la bulle) : l'utilisateur agit sur l'élément mis en valeur.
 */
export function GuidedTour() {
  const { t } = useT();
  const step = useTourStep();
  const stepIndex = useOnboardingStore((state) => state.stepIndex);
  const next = useOnboardingStore((state) => state.next);
  const back = useOnboardingStore((state) => state.back);
  const skip = useOnboardingStore((state) => state.skip);
  const [layout, setLayout] = useState<Layout | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setLayout(null);
    if (!step) return;

    let frame = 0;
    let lastKey = '';
    let lastHost: HTMLElement | null = null;
    let scrolled = false;

    const tick = () => {
      frame = schedule(tick);

      const host =
        step.scope === 'settings' ? document.querySelector<HTMLElement>('[data-tour-container]') : document.body;
      if (!host) {
        // Fenêtre Paramètres pas encore ouverte.
        if (lastHost) {
          lastHost = null;
          lastKey = '';
          setLayout(null);
        }
        return;
      }

      const isBody = host === document.body;
      const bounds: Box = isBody
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : toBox(host.getBoundingClientRect());

      const target = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
      const rect = target?.getBoundingClientRect();
      const visible = Boolean(rect && (rect.width > 0 || rect.height > 0));
      if (target && visible && !scrolled) {
        scrolled = true;
        target.scrollIntoView?.({ block: 'nearest' });
      }
      const spot =
        rect && visible
          ? clipBox(
              {
                left: rect.left - SPOT_PADDING,
                top: rect.top - SPOT_PADDING,
                width: rect.width + 2 * SPOT_PADDING,
                height: rect.height + 2 * SPOT_PADDING,
              },
              bounds
            )
          : null;

      const bubbleEl = bubbleRef.current;
      const size =
        bubbleEl && bubbleEl.offsetWidth > 0
          ? { width: bubbleEl.offsetWidth, height: bubbleEl.offsetHeight }
          : BUBBLE_FALLBACK;
      const bubble = placeBubble(spot, size, bounds);

      const originRect = rootRef.current?.getBoundingClientRect();
      const origin = { left: originRect?.left ?? 0, top: originRect?.top ?? 0 };
      const radius = isBody ? '0px' : getComputedStyle(host).borderRadius;
      const variant = target?.dataset.tourVariant;

      const key = JSON.stringify([bounds, spot, bubble, origin, radius, variant], (_k, v) =>
        typeof v === 'number' ? Math.round(v) : v
      );
      if (key !== lastKey || host !== lastHost) {
        lastKey = key;
        lastHost = host;
        setLayout({ host, origin, bounds, radius, spot, bubble, variant });
      }
    };

    frame = schedule(tick);
    return () => unschedule(frame);
  }, [step]);

  const ready = layout !== null;
  useEffect(() => {
    if (!ready || !step) return;
    if (primaryRef.current) {
      primaryRef.current.focus({ preventScroll: true });
      return;
    }
    // Étape qui attend une action (Démarrer, Arrêter) : le focus va sur le bouton visé.
    const target = step.target ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`) : null;
    if (target?.matches('button')) target.focus({ preventScroll: true });
  }, [step, ready]);

  if (!step || stepIndex === null || !layout) return null;

  const { origin, bounds, spot } = layout;
  const at = (box: { left: number; top: number }) => ({ left: box.left - origin.left, top: box.top - origin.top });
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === TOUR_STEPS.length - 1;
  const bodyKey = (layout.variant && step.variantBodyKeys?.[layout.variant]) || step.bodyKey;

  return createPortal(
    <div ref={rootRef} data-tour-root="" className="pointer-events-none fixed left-0 top-0 z-40">
      {/* Voile limité à la zone de la visite (la fenêtre Paramètres ou l'écran) : le halo n'en déborde pas. */}
      <div
        aria-hidden="true"
        className="absolute overflow-hidden"
        style={{ ...at(bounds), width: bounds.width, height: bounds.height, borderRadius: layout.radius }}
      >
        {!step.target && <div className="absolute inset-0" style={{ background: 'var(--surface-overlay)' }} />}
        {spot && (
          <div
            className="absolute rounded-[var(--radius)] ring-2 ring-primary"
            style={{
              left: spot.left - bounds.left,
              top: spot.top - bounds.top,
              width: spot.width,
              height: spot.height,
              boxShadow: '0 0 0 9999px var(--surface-overlay)',
            }}
          />
        )}
      </div>

      <div
        ref={bubbleRef}
        key={step.id}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="pointer-events-auto absolute w-72 max-w-[calc(100vw-2rem)] rounded-2xl border bg-card p-4 text-card-foreground shadow-soft animate-in fade-in-0 zoom-in-95 duration-200"
        style={at(layout.bubble)}
      >
        <p className="text-xs font-medium text-muted-foreground">
          {t('tour.progress', { current: stepIndex + 1, total: TOUR_STEPS.length })}
        </p>
        <h2 id="tour-title" className="mt-1 text-base font-semibold">
          {t(step.titleKey)}
        </h2>
        <p id="tour-body" className="mt-1 text-sm text-muted-foreground">
          {t(bodyKey)}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={skip}>
            {t('tour.skip')}
          </Button>
          <div className="flex gap-2">
            {canGoBack(stepIndex) && (
              <Button variant="outline" size="sm" onClick={back}>
                {t('tour.back')}
              </Button>
            )}
            {!step.advanceOn && (
              <Button ref={primaryRef} size="sm" onClick={next}>
                {isFirst ? t('tour.begin') : isLast ? t('tour.finish') : t('tour.next')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    layout.host
  );
}
