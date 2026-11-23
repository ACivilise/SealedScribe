import { beforeEach, describe, expect, it } from 'vitest';
import { TOUR_STEPS } from '../lib/onboarding';
import { useOnboardingStore } from './onboardingStore';

const at = (id: string) => TOUR_STEPS.findIndex((step) => step.id === id);
const state = () => useOnboardingStore.getState();

beforeEach(() => {
  localStorage.clear();
  useOnboardingStore.setState({ completed: false, stepIndex: null });
});

describe('onboardingStore', () => {
  it('démarre au premier lancement, pas une fois la visite faite', () => {
    state().startIfNew();
    expect(state().stepIndex).toBe(0);

    useOnboardingStore.setState({ completed: true, stepIndex: null });
    state().startIfNew();
    expect(state().stepIndex).toBeNull();
  });

  it('« Revoir la visite guidée » repart du début même après l’avoir faite', () => {
    useOnboardingStore.setState({ completed: true, stepIndex: null });
    state().start();
    expect(state().stepIndex).toBe(0);
  });

  it('Suivant après la dernière étape : visite terminée et mémorisée', () => {
    useOnboardingStore.setState({ stepIndex: TOUR_STEPS.length - 1 });
    state().next();
    expect(state()).toMatchObject({ stepIndex: null, completed: true });
    expect(JSON.parse(localStorage.getItem('onboarding-store') ?? '{}').state).toEqual({ completed: true });
  });

  it('Passer la visite : terminée, elle ne revient pas', () => {
    state().start();
    state().skip();
    expect(state()).toMatchObject({ stepIndex: null, completed: true });
  });

  it('Précédent reste sur le même écran', () => {
    useOnboardingStore.setState({ stepIndex: at('engine') });
    state().back();
    expect(state().stepIndex).toBe(at('appearance'));

    useOnboardingStore.setState({ stepIndex: at('meeting-language') });
    state().back();
    expect(state().stepIndex).toBe(at('meeting-language'));
  });

  it('les actions de l’utilisateur font avancer la visite jusqu’au bout', () => {
    state().start();
    state().notify('settings-closed');
    expect(state().stepIndex).toBe(at('meeting-language'));
    state().notify('recording-started');
    state().notify('recording-stopped');
    state().notify('meeting-saved');
    expect(state().stepIndex).toBe(at('meetings'));
    state().next();
    expect(state().completed).toBe(true);
  });

  it('hors visite, les actions sont ignorées', () => {
    state().notify('recording-started');
    expect(state()).toMatchObject({ stepIndex: null, completed: false });
  });
});
