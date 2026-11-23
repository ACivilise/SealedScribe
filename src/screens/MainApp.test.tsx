import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MainApp from './MainApp';
import { useLocaleStore } from '../i18n';
import { useOnboardingStore } from '../store/onboardingStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
// Fenêtre Paramètres simplifiée : la vraie interroge le backend, que ces tests ne simulent pas.
vi.mock('../components/modals/SettingsModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Settings" data-tour-container="">
      <button type="button" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
}));

// Absent de jsdom : lu par le bouton de thème de l'en-tête.
beforeEach(() => {
  // Visite guidée déjà faite : sinon elle ouvre les Paramètres au premier rendu.
  useOnboardingStore.setState({ completed: true, stepIndex: null });
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
});

describe('MainApp — onglets', () => {
  it('chaque onglet principal dit à quoi il sert', () => {
    render(<MainApp />);
    const hints = screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('title')]);
    expect(hints).toEqual([
      ['Record', "Record a meeting (your microphone and the computer's audio), then transcribe it"],
      ['Meetings', 'Find your meetings and import audio files: transcript, summary, tags and export'],
      ['Prompts', "Edit the summary types offered in a meeting's details"],
      ['Vocabulary', 'Fix how names and jargon are spelled in transcripts and summaries'],
    ]);
  });

  it('les infobulles suivent la langue de l’interface', () => {
    useLocaleStore.setState({ preference: 'fr', locale: 'fr' });
    render(<MainApp />);
    expect(screen.getByRole('tab', { name: 'Lexiques' })).toHaveAttribute(
      'title',
      'Corriger l’orthographe des noms propres et du jargon dans les transcriptions et les résumés'
    );
  });
});

describe('MainApp — premier lancement', () => {
  it('ouvre les Paramètres avec la visite guidée tant qu’elle n’a pas été faite', async () => {
    useLocaleStore.setState({ preference: 'en', locale: 'en' });
    useOnboardingStore.setState({ completed: false, stepIndex: null });
    render(<MainApp />);
    expect(await screen.findByRole('dialog', { name: 'Welcome to SealedScribe' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

    // Paramètres fermés : la visite continue sur l'onglet Enregistrer.
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Meeting language' })).toBeInTheDocument();
  });

  it('ne relance pas la visite une fois faite', () => {
    render(<MainApp />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useOnboardingStore.getState().stepIndex).toBeNull();
  });
});
