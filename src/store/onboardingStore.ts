import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { canGoBack, stepAfterEvent, TOUR_STEPS, type TourEvent, type TourStep } from '../lib/onboarding';

interface OnboardingStore {
  /** Visite terminée ou passée : elle ne se relance plus d'elle-même. Seul champ mémorisé. */
  completed: boolean;
  /** Étape affichée (index dans `TOUR_STEPS`), `null` hors visite. */
  stepIndex: number | null;
  /** Premier lancement (visite jamais faite) : démarre la visite. */
  startIfNew: () => void;
  /** « Revoir la visite guidée » des Paramètres. */
  start: () => void;
  next: () => void;
  back: () => void;
  skip: () => void;
  /** Action de l'utilisateur (Paramètres fermés, enregistrement démarré…) : avance la visite si elle l'attendait. */
  notify: (event: TourEvent) => void;
}

export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set, get) => {
      const goTo = (index: number) =>
        set(index >= TOUR_STEPS.length ? { stepIndex: null, completed: true } : { stepIndex: index });

      return {
        completed: false,
        stepIndex: null,
        startIfNew: () => {
          const { completed, stepIndex } = get();
          if (!completed && stepIndex === null) set({ stepIndex: 0 });
        },
        start: () => set({ stepIndex: 0 }),
        next: () => {
          const { stepIndex } = get();
          if (stepIndex !== null) goTo(stepIndex + 1);
        },
        back: () => {
          const { stepIndex } = get();
          if (stepIndex !== null && canGoBack(stepIndex)) set({ stepIndex: stepIndex - 1 });
        },
        skip: () => set({ stepIndex: null, completed: true }),
        notify: (event) => {
          const { stepIndex } = get();
          if (stepIndex === null) return;
          const target = stepAfterEvent(stepIndex, event);
          if (target !== undefined) goTo(target);
        },
      };
    },
    {
      name: 'onboarding-store',
      // Une visite interrompue (app fermée) reprend du début au lancement suivant.
      partialize: (state) => ({ completed: state.completed }),
    }
  )
);

/** Étape affichée, `null` hors visite. */
export const useTourStep = (): TourStep | null =>
  useOnboardingStore((state) => (state.stepIndex === null ? null : TOUR_STEPS[state.stepIndex] ?? null));
