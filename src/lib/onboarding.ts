import type { MessageKey } from '../i18n';

/**
 * Visite guidée du premier lancement : des Paramètres jusqu'au premier enregistrement.
 * Données et calculs purs ; l'affichage est dans `components/onboarding/GuidedTour.tsx`,
 * l'état dans `store/onboardingStore.ts`.
 */

/** Où vit l'étape : dans la fenêtre Paramètres ou sur l'écran principal. */
export type TourScope = 'settings' | 'main';
export type TourSettingsTab = 'general' | 'transcription' | 'ai';
export type TourMainTab = 'recording' | 'recordings';

/** Actions de l'utilisateur qui font avancer la visite à la place du bouton « Suivant ». */
export type TourEvent =
  | 'settings-closed'
  | 'recording-started'
  | 'recording-stopped'
  | 'meeting-saved'
  | 'meeting-discarded';

export interface TourStep {
  id: string;
  scope: TourScope;
  /** Valeur de l'attribut `data-tour` de l'élément mis en valeur ; absent : bulle centrée. */
  target?: string;
  /** Onglet des Paramètres ou de l'écran principal à afficher en arrivant sur l'étape. */
  settingsTab?: TourSettingsTab;
  mainTab?: TourMainTab;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  /** Texte selon l'attribut `data-tour-variant` de la cible (ex. le moteur choisi). */
  variantBodyKeys?: Partial<Record<string, MessageKey>>;
  /** L'étape attend cette action ; sans elle, bouton « Suivant ». */
  advanceOn?: TourEvent;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'welcome', scope: 'settings', settingsTab: 'general', titleKey: 'tour.welcomeTitle', bodyKey: 'tour.welcomeBody' },
  {
    id: 'appearance',
    scope: 'settings',
    settingsTab: 'general',
    target: 'settings-appearance',
    titleKey: 'tour.appearanceTitle',
    bodyKey: 'tour.appearanceBody',
  },
  {
    id: 'engine',
    scope: 'settings',
    settingsTab: 'transcription',
    target: 'transcription-engine',
    titleKey: 'tour.engineTitle',
    bodyKey: 'tour.engineBody',
  },
  {
    id: 'transcription-setup',
    scope: 'settings',
    settingsTab: 'transcription',
    target: 'transcription-setup',
    titleKey: 'tour.setupTitle',
    bodyKey: 'tour.setupLocalBody',
    variantBodyKeys: { local: 'tour.setupLocalBody', azure: 'tour.setupAzureBody', mistral: 'tour.setupMistralBody' },
  },
  {
    id: 'summary',
    scope: 'settings',
    settingsTab: 'ai',
    target: 'summary-engine',
    titleKey: 'tour.summaryTitle',
    bodyKey: 'tour.summaryBody',
  },
  {
    id: 'save-settings',
    scope: 'settings',
    target: 'settings-actions',
    titleKey: 'tour.saveSettingsTitle',
    bodyKey: 'tour.saveSettingsBody',
    advanceOn: 'settings-closed',
  },
  {
    id: 'meeting-language',
    scope: 'main',
    mainTab: 'recording',
    target: 'meeting-language',
    titleKey: 'tour.meetingLanguageTitle',
    bodyKey: 'tour.meetingLanguageBody',
  },
  {
    id: 'devices',
    scope: 'main',
    mainTab: 'recording',
    target: 'audio-devices',
    titleKey: 'tour.devicesTitle',
    bodyKey: 'tour.devicesBody',
  },
  {
    id: 'start',
    scope: 'main',
    mainTab: 'recording',
    target: 'record-start',
    titleKey: 'tour.startTitle',
    bodyKey: 'tour.startBody',
    advanceOn: 'recording-started',
  },
  {
    id: 'stop',
    scope: 'main',
    mainTab: 'recording',
    target: 'record-stop',
    titleKey: 'tour.stopTitle',
    bodyKey: 'tour.stopBody',
    advanceOn: 'recording-stopped',
  },
  {
    id: 'save-meeting',
    scope: 'main',
    mainTab: 'recording',
    target: 'meeting-save',
    titleKey: 'tour.saveMeetingTitle',
    bodyKey: 'tour.saveMeetingBody',
    advanceOn: 'meeting-saved',
  },
  {
    id: 'meetings',
    scope: 'main',
    mainTab: 'recordings',
    target: 'meetings-tab',
    titleKey: 'tour.meetingsTitle',
    bodyKey: 'tour.meetingsBody',
  },
];

const indexOfStep = (id: string) => TOUR_STEPS.findIndex((step) => step.id === id);

/**
 * Étape à afficher après l'action `event`, `TOUR_STEPS.length` si la visite est finie,
 * `undefined` si l'action ne la concerne pas.
 */
export function stepAfterEvent(index: number, event: TourEvent): number | undefined {
  if (event === 'meeting-discarded') {
    // Réunion jetée : on repart du bouton Démarrer.
    return TOUR_STEPS[index]?.id === 'save-meeting' ? indexOfStep('start') : undefined;
  }
  // Une action peut devancer la visite (Démarrer avant d'avoir lu l'étape des micros, Paramètres
  // fermés avant la fin) : on passe à l'étape qui suit cette action.
  const awaiting = TOUR_STEPS.findIndex((step, i) => i >= index && step.advanceOn === event);
  return awaiting === -1 ? undefined : awaiting + 1;
}

/** « Précédent » : seulement vers une étape du même écran qui n'attend pas d'action. */
export function canGoBack(index: number): boolean {
  const previous = TOUR_STEPS[index - 1];
  return Boolean(previous && previous.scope === TOUR_STEPS[index]?.scope && !previous.advanceOn);
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 12;
const MARGIN = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Position de la bulle (coordonnées de la fenêtre) : sous la cible, sinon au-dessus, sinon en bas de
 * la zone ; centrée dans la zone sans cible. Toujours gardée dans `bounds`.
 */
export function placeBubble(
  target: Box | null,
  bubble: { width: number; height: number },
  bounds: Box
): { left: number; top: number } {
  const right = bounds.left + bounds.width;
  const bottom = bounds.top + bounds.height;
  const maxLeft = right - bubble.width - MARGIN;
  const maxTop = bottom - bubble.height - MARGIN;

  if (!target) {
    return {
      left: clamp(bounds.left + (bounds.width - bubble.width) / 2, bounds.left + MARGIN, maxLeft),
      top: clamp(bounds.top + (bounds.height - bubble.height) / 2, bounds.top + MARGIN, maxTop),
    };
  }

  const targetBottom = target.top + target.height;
  let top: number;
  if (bottom - targetBottom >= bubble.height + GAP + MARGIN) {
    top = targetBottom + GAP;
  } else if (target.top - bounds.top >= bubble.height + GAP + MARGIN) {
    top = target.top - GAP - bubble.height;
  } else {
    // Pas de place autour de la cible : en bas de la zone, quitte à la recouvrir en partie.
    top = maxTop;
  }

  return {
    left: clamp(target.left + target.width / 2 - bubble.width / 2, bounds.left + MARGIN, maxLeft),
    top: clamp(top, bounds.top + MARGIN, maxTop),
  };
}

/** Partie visible de la cible dans la zone (le halo ne déborde pas sur l'en-tête des Paramètres). */
export function clipBox(box: Box, bounds: Box): Box | null {
  const left = Math.max(box.left, bounds.left);
  const top = Math.max(box.top, bounds.top);
  const right = Math.min(box.left + box.width, bounds.left + bounds.width);
  const bottom = Math.min(box.top + box.height, bounds.top + bounds.height);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}
