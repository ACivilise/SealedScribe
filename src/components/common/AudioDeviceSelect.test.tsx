import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioDeviceSelect } from './AudioDeviceSelect';
import { resolveDevice, type AudioDevice } from '../../lib/audioDevices';

const devices: AudioDevice[] = [
  { id: 'spk', name: 'Speakers (Realtek)', isDefault: true },
  { id: 'jabra', name: 'Headset (Jabra)', isDefault: false },
];

function renderSelect(saved: { id: string; name: string } | null, list: AudioDevice[] | null = devices) {
  render(
    <AudioDeviceSelect
      id="output"
      label="Audio output"
      devices={list}
      saved={saved}
      resolved={resolveDevice(saved, list)}
      onChange={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
}

describe('AudioDeviceSelect', () => {
  it('sans choix, affiche le périphérique par défaut de Windows par son nom', () => {
    renderSelect(null);
    expect(screen.getByLabelText('Audio output')).toHaveTextContent('Windows default (Speakers (Realtek))');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('affiche le périphérique choisi', () => {
    renderSelect({ id: 'jabra', name: 'Headset (Jabra)' });
    expect(screen.getByLabelText('Audio output')).toHaveTextContent('Headset (Jabra)');
  });

  it('signale un choix débranché et se rabat sur le périphérique par défaut', () => {
    renderSelect({ id: 'usb', name: 'USB headset' });
    expect(screen.getByLabelText('Audio output')).toHaveTextContent('Windows default');
    expect(screen.getByRole('status')).toHaveTextContent('“USB headset” is not connected');
  });

  it('tant que la liste n’est pas chargée, garde le choix mémorisé affiché', () => {
    renderSelect({ id: 'usb', name: 'USB headset' }, null);
    expect(screen.getByLabelText('Audio output')).toHaveTextContent('USB headset');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
