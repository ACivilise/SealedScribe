import { create } from 'zustand';

/**
 * Erreur globale affichée dans le bandeau sous la navigation (MainApp).
 * Remplace les alert() natifs : toute erreur d'action passe par ici ou par un encart local.
 */
export interface AppError {
  title: string;
  message: string;
}

interface NotificationStore {
  error: AppError | null;
  setError: (error: AppError) => void;
  clearError: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  error: null,
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
}));
