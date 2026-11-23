import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DISCLAIMER } from '../lib/disclaimer';

/** Acceptation de l'avertissement (DISCLAIMER.md) : sans elle, App n'affiche que l'écran d'acceptation. */
interface DisclaimerStore {
  /** Version acceptée : date « Dernière mise à jour » de l'avertissement lu. */
  acceptedVersion: string | null;
  /** Date ISO de l'acceptation. */
  acceptedAt: string | null;
  accept: (version: string) => void;
}

export const useDisclaimerStore = create<DisclaimerStore>()(
  persist(
    (set) => ({
      acceptedVersion: null,
      acceptedAt: null,
      accept: (version) => set({ acceptedVersion: version, acceptedAt: new Date().toISOString() }),
    }),
    { name: 'disclaimer-store' }
  )
);

/** Vrai quand la version en vigueur de l'avertissement a été acceptée. */
export const useDisclaimerAccepted = (version: string = DISCLAIMER.updated) =>
  useDisclaimerStore((state) => state.acceptedVersion === version);
