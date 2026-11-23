import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { useShutdownStore } from '../../store/shutdownStore';
import { ShutdownWhenDoneCheckbox, TranscriptionStopButton } from './TranscriptionStopControls';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const props = {
  engine: 'local',
  currentChunk: 2,
  totalChunks: 5,
  stopAfterPartRequested: false,
};

describe('TranscriptionStopButton', () => {
  it('annule directement une transcription Azure', async () => {
    const onCancel = vi.fn();
    render(<TranscriptionStopButton {...props} engine="azure" onCancel={onCancel} onStopAfterPart={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel transcription' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('moteur local : propose l’arrêt après la partie en cours, avec son numéro', async () => {
    const onCancel = vi.fn();
    const onStopAfterPart = vi.fn();
    render(<TranscriptionStopButton {...props} onCancel={onCancel} onStopAfterPart={onStopAfterPart} />);

    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop after the current part (2 of 5)' }));

    expect(onStopAfterPart).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('moteur Mistral (parties de 10 min) : propose aussi l’arrêt après la partie en cours', async () => {
    const onStopAfterPart = vi.fn();
    render(<TranscriptionStopButton {...props} engine="mistral" onCancel={vi.fn()} onStopAfterPart={onStopAfterPart} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop after the current part (2 of 5)' }));
    expect(onStopAfterPart).toHaveBeenCalledOnce();
  });

  it('moteur local : « Continuer » ferme la boîte sans rien arrêter', async () => {
    const onCancel = vi.fn();
    const onStopAfterPart = vi.fn();
    render(
      <TranscriptionStopButton {...props} currentChunk={null} onCancel={onCancel} onStopAfterPart={onStopAfterPart} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    expect(screen.getByRole('button', { name: 'Stop after the current part' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onStopAfterPart).not.toHaveBeenCalled();
  });

  it('arrêt différé déjà demandé : n’offre plus que l’arrêt immédiat', async () => {
    const onCancel = vi.fn();
    render(<TranscriptionStopButton {...props} stopAfterPartRequested onCancel={onCancel} onStopAfterPart={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stopping after the current part…');
    await userEvent.click(screen.getByRole('button', { name: 'Stop now' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('ShutdownWhenDoneCheckbox', () => {
  beforeEach(() => {
    useShutdownStore.setState({ armed: false });
  });

  it('arme l’extinction et prévient le backend', async () => {
    render(<ShutdownWhenDoneCheckbox id="shutdown" />);
    const checkbox = screen.getByRole('checkbox', { name: 'Shut down the computer when processing is finished' });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(useShutdownStore.getState().armed).toBe(true);
    expect(invoke).toHaveBeenCalledWith('set_shutdown_armed', { armed: true });
  });
});
