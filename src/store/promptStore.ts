/**
 * Prompts de résumé (types de résumé), modifiables dans l'onglet Prompts et choisis dans la fiche d'une réunion.
 * Persistés dans le localStorage de la WebView. Au premier lancement, les prompts fournis
 * sont créés dans la langue de l'interface.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { useLocaleStore, type Locale } from '../i18n';
import { BUILTIN_PROMPT_IDS, getDefaultPrompt, type BuiltinPromptId } from '../lib/defaultPrompts';

export interface SummaryPrompt {
  id: string;
  name: string;
  description: string;
  template: string;
  /** Prompt fourni avec l'app : son texte d'origine peut être rétabli. */
  builtinId?: BuiltinPromptId;
}

type PromptFields = Pick<SummaryPrompt, 'name' | 'description' | 'template'>;

interface PromptStore {
  prompts: SummaryPrompt[];
  /** Dernier prompt choisi dans une fiche : proposé par défaut pour le résumé suivant. */
  selectedPromptId: string | null;
  selectPrompt: (id: string) => void;
  addPrompt: (fields: PromptFields) => string;
  duplicatePrompt: (id: string, copySuffix: string) => string | null;
  updatePrompt: (id: string, fields: Partial<PromptFields>) => void;
  removePrompt: (id: string) => void;
  /** Rétablit le texte d'origine d'un prompt fourni, dans la langue de l'interface. */
  restorePrompt: (id: string) => void;
  /** Recrée les prompts fournis qui ont été supprimés. */
  restoreMissingDefaults: () => void;
}

const currentLocale = (): Locale => useLocaleStore.getState().locale;

const builtinPrompt = (builtinId: BuiltinPromptId, locale: Locale): SummaryPrompt => ({
  id: builtinId,
  builtinId,
  ...getDefaultPrompt(builtinId, locale),
});

export const usePromptStore = create<PromptStore>()(
  persist(
    (set, get) => ({
      prompts: BUILTIN_PROMPT_IDS.map((id) => builtinPrompt(id, currentLocale())),
      selectedPromptId: null,

      selectPrompt: (id) => set({ selectedPromptId: id }),
      addPrompt: (fields) => {
        const id = uuidv4();
        set((state) => ({ prompts: [...state.prompts, { id, ...fields }] }));
        return id;
      },
      duplicatePrompt: (id, copySuffix) => {
        const source = get().prompts.find((p) => p.id === id);
        if (!source) return null;
        const copyId = uuidv4();
        const copy: SummaryPrompt = {
          id: copyId,
          name: `${source.name} ${copySuffix}`,
          description: source.description,
          template: source.template,
        };
        set((state) => {
          const index = state.prompts.findIndex((p) => p.id === id);
          const prompts = [...state.prompts];
          prompts.splice(index + 1, 0, copy);
          return { prompts };
        });
        return copyId;
      },
      updatePrompt: (id, fields) =>
        set((state) => ({
          prompts: state.prompts.map((p) => (p.id === id ? { ...p, ...fields } : p)),
        })),
      removePrompt: (id) => set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) })),
      restorePrompt: (id) =>
        set((state) => ({
          prompts: state.prompts.map((p) =>
            p.id === id && p.builtinId ? builtinPrompt(p.builtinId, currentLocale()) : p
          ),
        })),
      restoreMissingDefaults: () =>
        set((state) => {
          const present = new Set(state.prompts.map((p) => p.builtinId).filter(Boolean));
          const missing = BUILTIN_PROMPT_IDS.filter((id) => !present.has(id)).map((id) =>
            builtinPrompt(id, currentLocale())
          );
          return { prompts: [...state.prompts, ...missing] };
        }),
    }),
    {
      name: 'meetscribe-prompts',
      partialize: (state) => ({ prompts: state.prompts, selectedPromptId: state.selectedPromptId }),
    }
  )
);

/** Texte d'origine d'un prompt fourni (pour savoir s'il a été modifié). */
export function isPromptModified(prompt: SummaryPrompt, locale: Locale): boolean {
  if (!prompt.builtinId) return false;
  const original = getDefaultPrompt(prompt.builtinId, locale);
  return (
    original.name !== prompt.name ||
    original.description !== prompt.description ||
    original.template !== prompt.template
  );
}
