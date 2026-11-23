import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import DisclaimerScreen from './DisclaimerScreen';
import { DISCLAIMER } from '../lib/disclaimer';
import { useDisclaimerStore } from '../store/disclaimerStore';
import { useLocaleStore } from '../i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

beforeEach(() => {
  useDisclaimerStore.setState({ acceptedVersion: null, acceptedAt: null });
});

describe('DisclaimerScreen', () => {
  it('n’accepte qu’une fois la case cochée, et retient la version acceptée', async () => {
    render(<DisclaimerScreen />);
    expect(screen.getByRole('heading', { name: DISCLAIMER.title })).toBeInTheDocument();
    expect(screen.getByText('This notice is written in French, which is the version that applies.')).toBeInTheDocument();

    const accept = screen.getByRole('button', { name: 'Accept and continue' });
    expect(accept).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: /I have read this notice and accept it/ }));
    await userEvent.click(accept);

    const state = useDisclaimerStore.getState();
    expect(state.acceptedVersion).toBe(DISCLAIMER.updated);
    expect(state.acceptedAt).not.toBeNull();
  });

  it('« Refuser et quitter » ferme l’application', async () => {
    render(<DisclaimerScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Decline and quit' }));
    expect(invoke).toHaveBeenCalledWith('quit_app');
  });

  it('montre la fenêtre quand le tray demande un enregistrement', async () => {
    render(<DisclaimerScreen />);
    const handler = vi.mocked(listen).mock.calls.find(([event]) => event === 'tray-toggle-recording')?.[1];
    expect(handler).toBeDefined();
    await act(async () => handler?.({ event: 'tray-toggle-recording', id: 0, payload: undefined }));
    expect(invoke).toHaveBeenCalledWith('show_main_window');
  });

  it('en français, ne signale pas la langue du texte', () => {
    useLocaleStore.setState({ preference: 'fr', locale: 'fr' });
    render(<DisclaimerScreen />);
    expect(screen.getByRole('heading', { name: 'Avant de commencer' })).toBeInTheDocument();
    expect(screen.queryByText('Cet avertissement est rédigé en français.')).not.toBeInTheDocument();
  });
});
