import { create } from 'zustand';
import { updateService, type AvailableUpdate, type Distribution, type UpdateProgress } from '../services/updateService';

/**
 * `available` : une version plus récente attend ; `downloading` puis `installing` : l'installation
 * est lancée (l'application va se fermer, l'installeur la relance).
 */
export type UpdateStatus = 'idle' | 'available' | 'downloading' | 'installing';

/** `busy` : refusée pendant un enregistrement ou une tâche de fond ; `failed` : tout autre échec. */
export type UpdateError = 'busy' | 'failed';

/** Résultat d'une recherche, affiché seulement quand l'utilisateur l'a demandée (Paramètres). */
export type CheckOutcome = 'upToDate' | 'available' | 'failed';

interface UpdateStore {
  /**
   * Version du Microsoft Store : le Store fait les mises à jour, l'application n'en cherche pas.
   * `null` tant que le backend n'a pas répondu.
   */
  distribution: Distribution | null;
  loadDistribution: () => Promise<void>;
  status: UpdateStatus;
  available: AvailableUpdate | null;
  progress: UpdateProgress | null;
  error: UpdateError | null;
  /** Version écartée par « Plus tard » : son bandeau ne revient pas avant le prochain lancement. */
  dismissedVersion: string | null;
  checking: boolean;
  /** `manual` (bouton des Paramètres) : le bandeau réapparaît même après « Plus tard ». */
  check: (options?: { manual?: boolean }) => Promise<CheckOutcome>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  distribution: null,
  status: 'idle',
  available: null,
  progress: null,
  error: null,
  dismissedVersion: null,
  checking: false,

  loadDistribution: async () => {
    if (get().distribution) return;
    try {
      const distribution = await updateService.distribution();
      set({ distribution: distribution === 'store' ? 'store' : 'installer' });
    } catch (error) {
      console.warn('Distribution inconnue, mises à jour par GitHub :', error);
      set({ distribution: 'installer' });
    }
  },

  check: async ({ manual = false } = {}) => {
    const { status } = get();
    // Installation lancée : la recherche n'a plus d'objet.
    if (status === 'downloading' || status === 'installing') return 'available';
    set({ checking: true });
    try {
      const update = await updateService.check();
      set({
        available: update,
        status: update ? 'available' : 'idle',
        checking: false,
        ...(manual ? { dismissedVersion: null, error: null } : {}),
      });
      return update ? 'available' : 'upToDate';
    } catch (error) {
      // Pas de connexion, GitHub injoignable : on réessaiera à la prochaine vérification.
      console.warn('Recherche de mise à jour impossible :', error);
      set({ checking: false });
      return 'failed';
    }
  },

  install: async () => {
    set({ status: 'downloading', progress: null, error: null });
    const unlisten = await updateService.onProgress((progress) => set({ progress }));
    try {
      await updateService.install();
      set({ status: 'installing' });
    } catch (error) {
      const code = String(error);
      set({ status: 'available', error: code === 'busy-recording' || code === 'busy-job' ? 'busy' : 'failed' });
      if (code !== 'busy-recording' && code !== 'busy-job') console.error('Mise à jour impossible :', error);
    } finally {
      unlisten();
    }
  },

  dismiss: () => set((state) => ({ dismissedVersion: state.available?.version ?? null, error: null })),
}));
