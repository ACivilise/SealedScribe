import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Version plus récente publiée dans les GitHub Releases du dépôt public. */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** Notes de la release (section du changelog). */
  notes?: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Taille de l'installeur, si le serveur l'annonce. */
  total: number | null;
}

/** Codes d'erreur de `install_update` (backend `updates.rs`). */
export type UpdateErrorCode = 'busy-recording' | 'busy-job' | 'no-update';

export const updateService = {
  /** `null` : l'application est à jour. */
  check: () => invoke<AvailableUpdate | null>('check_for_update'),
  /** Télécharge, vérifie la signature et lance l'installeur ; l'application se ferme ensuite. */
  install: () => invoke<void>('install_update'),
  onProgress: (callback: (progress: UpdateProgress) => void): Promise<UnlistenFn> =>
    listen<UpdateProgress>('update-progress', (event) => callback(event.payload)),
};
