import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhatsNewButton } from './WhatsNewButton';
import WhatsNewModal from '../modals/WhatsNewModal';
import { parseChangelog } from '../../lib/changelog';
import { CURRENT_VERSION } from '../../lib/releaseNotes';
import { useWhatsNewStore } from '../../store/whatsNewStore';

beforeEach(() => {
  useWhatsNewStore.setState({ lastSeenVersion: null });
});

describe('WhatsNewButton', () => {
  it('signale une version non consultée, puis plus du tout une fois la fenêtre ouverte', async () => {
    render(<WhatsNewButton />);
    expect(screen.getByTestId('whats-new-dot')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: "See what's new (new version)" }));
    const dialog = screen.getByRole('dialog', { name: "What's new" });
    expect(within(dialog).getByText(`SealedScribe version ${CURRENT_VERSION}`)).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-dot')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "See what's new" })).toBeInTheDocument();
    expect(useWhatsNewStore.getState().lastSeenVersion).toBe(CURRENT_VERSION);
  });

  it('signale de nouveau la pastille quand une version plus récente arrive', () => {
    useWhatsNewStore.setState({ lastSeenVersion: '0.1.0' });
    render(<WhatsNewButton latestVersion="0.2.0" />);
    expect(screen.getByTestId('whats-new-dot')).toBeInTheDocument();
  });
});

describe('WhatsNewModal', () => {
  const releases = parseChangelog(`## 0.2.0 — 2026-12-01 — Lexiques

### Nouveautés
- **Lexiques.** Corrige le \`jargon\`.

### Corrections
- Boutons entiers.

## 0.1.0 — 2026-11-16

### Améliorations
- Plus rapide.
`);

  it('affiche chaque version, la plus récente marquée, avec ses catégories traduites', () => {
    render(<WhatsNewModal onClose={vi.fn()} releases={releases} />);

    const latest = screen.getByRole('article', { name: '0.2.0' });
    expect(within(latest).getByText('Latest')).toBeInTheDocument();
    expect(within(latest).getByText('Lexiques', { selector: 'p' })).toBeInTheDocument();
    expect(within(latest).getByRole('heading', { name: 'New features' })).toBeInTheDocument();
    expect(within(latest).getByRole('heading', { name: 'Fixes' })).toBeInTheDocument();
    expect(within(latest).getByText('Lexiques.', { selector: 'strong' })).toBeInTheDocument();
    expect(within(latest).getByText('jargon', { selector: 'code' })).toBeInTheDocument();

    const previous = screen.getByRole('article', { name: '0.1.0' });
    expect(within(previous).queryByText('Latest')).not.toBeInTheDocument();
    expect(within(previous).getByRole('heading', { name: 'Improvements' })).toBeInTheDocument();
    expect(useWhatsNewStore.getState().lastSeenVersion).toBe('0.2.0');
  });

  it('affiche un état vide sans version', () => {
    render(<WhatsNewModal onClose={vi.fn()} releases={[]} />);
    expect(screen.getByText('Nothing to report yet.')).toBeInTheDocument();
    expect(useWhatsNewStore.getState().lastSeenVersion).toBeNull();
  });
});
