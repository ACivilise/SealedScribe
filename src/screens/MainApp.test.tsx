import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MainApp from './MainApp';
import { useLocaleStore } from '../i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));

// Absent de jsdom : lu par le bouton de thème de l'en-tête.
beforeEach(() => {
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
