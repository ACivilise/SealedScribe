import { beforeEach, describe, expect, it } from 'vitest';
import { currentLexiconTerms, useLexiconStore } from './lexiconStore';

beforeEach(() => {
  useLexiconStore.setState({ lexicons: [] });
});

describe('lexiconStore', () => {
  it('crée un lexique actif avec une ligne vide, puis la remplit', () => {
    const store = useLexiconStore.getState();
    const id = store.addLexicon('Travail');
    const [lexicon] = useLexiconStore.getState().lexicons;
    expect(lexicon).toMatchObject({ id, name: 'Travail', enabled: true });
    expect(lexicon.entries).toHaveLength(1);

    store.updateEntry(id, lexicon.entries[0].id, { term: 'Zentra', variants: 'sentra, sen tra' });
    expect(currentLexiconTerms()).toEqual([{ term: 'Zentra', variants: ['sentra', 'sen tra'] }]);
  });

  it('ajoute, supprime des lignes et désactive un lexique', () => {
    const store = useLexiconStore.getState();
    const id = store.addLexicon('Travail');
    const first = useLexiconStore.getState().lexicons[0].entries[0].id;
    store.updateEntry(id, first, { term: 'ACME' });
    const second = store.addEntry(id);
    store.updateEntry(id, second, { term: 'Zentra' });
    store.removeEntry(id, first);
    expect(currentLexiconTerms().map((t) => t.term)).toEqual(['Zentra']);

    store.updateLexicon(id, { enabled: false });
    expect(currentLexiconTerms()).toEqual([]);
  });

  it('supprime un lexique sans toucher aux autres', () => {
    const store = useLexiconStore.getState();
    const a = store.addLexicon('A');
    store.addLexicon('B');
    store.removeLexicon(a);
    expect(useLexiconStore.getState().lexicons.map((l) => l.name)).toEqual(['B']);
  });
});
