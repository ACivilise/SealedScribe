import { describe, expect, it } from 'vitest';
import { parseAudioDevices, resolveDevice, type AudioDevice } from './audioDevices';

const device = (id: string, name = id, isDefault = false): AudioDevice => ({ id, name, isDefault });

describe('parseAudioDevices', () => {
  it('trie par nom en tenant compte des accents et de la casse', () => {
    const list = parseAudioDevices(
      { inputs: [], outputs: [device('3', 'Haut-parleurs'), device('1', 'Écouteurs'), device('2', 'casque Jabra')] },
      'fr',
    );
    expect(list.outputs.map((d) => d.name)).toEqual(['casque Jabra', 'Écouteurs', 'Haut-parleurs']);
  });

  it('ignore une réponse inattendue plutôt que de planter', () => {
    expect(parseAudioDevices([])).toEqual({ inputs: [], outputs: [] });
    expect(parseAudioDevices(undefined)).toEqual({ inputs: [], outputs: [] });
    expect(parseAudioDevices({ inputs: [{ id: 1 }, device('a')], outputs: 'x' })).toEqual({
      inputs: [device('a')],
      outputs: [],
    });
  });
});

describe('resolveDevice', () => {
  const devices = [device('mic-1', 'Micro USB'), device('mic-2', 'Micro intégré', true)];

  it('sans choix mémorisé : le périphérique par défaut', () => {
    expect(resolveDevice(null, devices)).toEqual({ id: null, missing: null });
  });

  it('garde le choix mémorisé quand il est branché', () => {
    expect(resolveDevice({ id: 'mic-1', name: 'Micro USB' }, devices)).toEqual({ id: 'mic-1', missing: null });
  });

  it('se rabat sur le périphérique par défaut et signale le choix débranché', () => {
    const saved = { id: 'casque', name: 'Casque Jabra' };
    expect(resolveDevice(saved, devices)).toEqual({ id: null, missing: saved });
  });

  it('tant que la liste n’est pas chargée, garde le choix mémorisé', () => {
    expect(resolveDevice({ id: 'casque', name: 'Casque Jabra' }, null)).toEqual({ id: 'casque', missing: null });
  });
});
