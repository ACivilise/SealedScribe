import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuidedTour } from './GuidedTour';
import { TOUR_STEPS } from '../../lib/onboarding';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useLocaleStore } from '../../i18n';

const at = (id: string) => TOUR_STEPS.findIndex((step) => step.id === id);

beforeEach(() => {
  localStorage.clear();
  useLocaleStore.setState({ preference: 'en', locale: 'en' });
  useOnboardingStore.setState({ completed: false, stepIndex: null });
});

describe('GuidedTour', () => {
  it('n’affiche rien hors visite', () => {
    render(<GuidedTour />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('affiche l’étape et passe à la suivante', async () => {
    useOnboardingStore.setState({ stepIndex: at('meeting-language') });
    render(
      <>
        <div data-tour="meeting-language">Language</div>
        <GuidedTour />
      </>
    );
    expect(await screen.findByRole('dialog', { name: 'Meeting language' })).toBeInTheDocument();
    expect(screen.getByText(`Step ${at('meeting-language') + 1} of ${TOUR_STEPS.length}`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: 'Microphone and audio output' })).toBeInTheDocument();
    // Précédent : même écran, l'étape d'avant n'attend pas d'action.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('dialog', { name: 'Meeting language' })).toBeInTheDocument();
  });

  it('une étape qui attend une action n’a pas de bouton Suivant et met le focus sur le bouton visé', async () => {
    useOnboardingStore.setState({ stepIndex: at('start') });
    render(
      <>
        <button type="button" data-tour="record-start">
          Start
        </button>
        <GuidedTour />
      </>
    );
    await screen.findByRole('dialog', { name: 'Your first recording' });
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toHaveFocus();
  });

  it('Passer la visite la termine pour de bon', async () => {
    useOnboardingStore.setState({ stepIndex: at('devices') });
    render(<GuidedTour />);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useOnboardingStore.getState()).toMatchObject({ completed: true, stepIndex: null });
  });

  it('dans les Paramètres, s’affiche dans leur fenêtre et adapte le texte au moteur choisi', async () => {
    useOnboardingStore.setState({ stepIndex: at('transcription-setup') });
    render(
      <>
        <div data-tour-container="" data-testid="settings">
          <div data-tour="transcription-setup" data-tour-variant="azure" />
        </div>
        <GuidedTour />
      </>
    );
    const bubble = await screen.findByRole('dialog', { name: 'Get the engine ready' });
    expect(screen.getByTestId('settings')).toContainElement(bubble);
    expect(bubble).toHaveTextContent('Paste your Azure Speech key and region.');
  });
});
