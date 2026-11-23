import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

/**
 * « Éteindre l'ordinateur à la fin du traitement ». Valable pour la session en cours
 * seulement (non persisté) : une case oubliée cochée n'éteindra pas le PC un autre jour.
 * Tant qu'elle est cochée, le backend garde le PC éveillé (voir `ShutdownWatcher`).
 */
interface ShutdownStore {
  armed: boolean;
  setArmed: (armed: boolean) => void;
}

export const useShutdownStore = create<ShutdownStore>((set, get) => ({
  armed: false,
  setArmed: (armed) => {
    if (get().armed === armed) return;
    set({ armed });
    invoke('set_shutdown_armed', { armed }).catch(() => {
      // Hors Tauri : sans effet.
    });
  },
}));
