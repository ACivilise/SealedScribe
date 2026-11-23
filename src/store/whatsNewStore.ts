import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Dernière version dont l'utilisateur a ouvert les « Nouveautés » (pastille de l'en-tête). */
interface WhatsNewStore {
  lastSeenVersion: string | null;
  markSeen: (version: string | undefined) => void;
}

export const useWhatsNewStore = create<WhatsNewStore>()(
  persist(
    (set) => ({
      lastSeenVersion: null,
      markSeen: (version) => {
        if (version) set({ lastSeenVersion: version });
      },
    }),
    { name: 'whats-new-store' }
  )
);
