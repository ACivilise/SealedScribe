import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SavedAudioDevice } from '../lib/audioDevices';

/**
 * Micro et sortie audio choisis dans l'onglet Enregistrer, gardés d'une session à l'autre.
 * `null` : le périphérique par défaut de Windows.
 */
interface AudioDeviceStore {
  input: SavedAudioDevice | null;
  output: SavedAudioDevice | null;
  setInput: (device: SavedAudioDevice | null) => void;
  setOutput: (device: SavedAudioDevice | null) => void;
}

export const useAudioDeviceStore = create<AudioDeviceStore>()(
  persist(
    (set) => ({
      input: null,
      output: null,
      setInput: (input) => set({ input }),
      setOutput: (output) => set({ output }),
    }),
    { name: 'audio-device-store' }
  )
);
