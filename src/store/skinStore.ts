import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applySkin, DEFAULT_SKIN, isSkin, type Skin } from '../lib/skins';

interface SkinStore {
  skin: Skin;
  setSkin: (skin: Skin) => void;
}

/** Habillage choisi dans Paramètres > Général > Apparence, mémorisé dans le localStorage. */
export const useSkinStore = create<SkinStore>()(
  persist(
    (set) => ({
      skin: DEFAULT_SKIN,
      setSkin: (skin) => {
        applySkin(skin);
        set({ skin });
      },
    }),
    {
      name: 'skin-store',
      // Valeur inconnue (habillage retiré depuis) : retour à l'habillage d'origine.
      merge: (persisted, current) => {
        const skin = (persisted as Partial<SkinStore> | undefined)?.skin;
        return { ...current, skin: isSkin(skin) ? skin : DEFAULT_SKIN };
      },
    }
  )
);
