/**
 * Lexiques (onglet Lexiques), persistés dans le localStorage de la WebView comme les prompts.
 * Les lexiques actifs servent à toutes les transcriptions et à tous les résumés.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { activeTerms, type Lexicon, type LexiconEntry, type LexiconTerm } from '../lib/lexicon';

type LexiconFields = Pick<Lexicon, 'name' | 'enabled'>;
type EntryFields = Pick<LexiconEntry, 'term' | 'variants'>;

interface LexiconStore {
  lexicons: Lexicon[];
  /** Crée un lexique actif, avec une première ligne vide à remplir. */
  addLexicon: (name: string) => string;
  updateLexicon: (id: string, fields: Partial<LexiconFields>) => void;
  removeLexicon: (id: string) => void;
  addEntry: (lexiconId: string) => string;
  updateEntry: (lexiconId: string, entryId: string, fields: Partial<EntryFields>) => void;
  removeEntry: (lexiconId: string, entryId: string) => void;
}

const emptyEntry = (): LexiconEntry => ({ id: uuidv4(), term: '', variants: '' });

export const useLexiconStore = create<LexiconStore>()(
  persist(
    (set) => {
      const mapLexicon = (id: string, update: (lexicon: Lexicon) => Lexicon) =>
        set((state) => ({ lexicons: state.lexicons.map((l) => (l.id === id ? update(l) : l)) }));

      return {
        lexicons: [],

        addLexicon: (name) => {
          const id = uuidv4();
          set((state) => ({ lexicons: [...state.lexicons, { id, name, enabled: true, entries: [emptyEntry()] }] }));
          return id;
        },
        updateLexicon: (id, fields) => mapLexicon(id, (l) => ({ ...l, ...fields })),
        removeLexicon: (id) => set((state) => ({ lexicons: state.lexicons.filter((l) => l.id !== id) })),

        addEntry: (lexiconId) => {
          const entry = emptyEntry();
          mapLexicon(lexiconId, (l) => ({ ...l, entries: [...l.entries, entry] }));
          return entry.id;
        },
        updateEntry: (lexiconId, entryId, fields) =>
          mapLexicon(lexiconId, (l) => ({
            ...l,
            entries: l.entries.map((e) => (e.id === entryId ? { ...e, ...fields } : e)),
          })),
        removeEntry: (lexiconId, entryId) =>
          mapLexicon(lexiconId, (l) => ({ ...l, entries: l.entries.filter((e) => e.id !== entryId) })),
      };
    },
    { name: 'meetscribe-lexicons' }
  )
);

/** Termes des lexiques actifs, lus au moment d'une transcription ou d'un résumé. */
export function currentLexiconTerms(): LexiconTerm[] {
  return activeTerms(useLexiconStore.getState().lexicons);
}
