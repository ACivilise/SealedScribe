import { beforeEach, describe, expect, it } from 'vitest';
import { useSkinStore } from './skinStore';
import { DEFAULT_SKIN, isSkin, SKINS } from '../lib/skins';

beforeEach(() => {
  useSkinStore.setState({ skin: DEFAULT_SKIN });
  delete document.documentElement.dataset.skin;
});

describe('skinStore', () => {
  it('part de l’habillage Cassette', () => {
    expect(DEFAULT_SKIN).toBe('cassette');
    expect(useSkinStore.getState().skin).toBe('cassette');
  });

  it('pose l’habillage choisi sur <html> et le mémorise', () => {
    useSkinStore.getState().setSkin('journal');

    expect(document.documentElement.dataset.skin).toBe('journal');
    expect(useSkinStore.getState().skin).toBe('journal');
  });

  it('revient à Cassette quand le localStorage contient un habillage inconnu', async () => {
    localStorage.setItem('skin-store', JSON.stringify({ state: { skin: 'disparu' }, version: 0 }));
    await useSkinStore.persist.rehydrate();

    expect(useSkinStore.getState().skin).toBe('cassette');
  });
});

describe('isSkin', () => {
  it('reconnaît les quatre habillages et rien d’autre', () => {
    expect(SKINS).toEqual(['cassette', 'terminal', 'journal', 'glacier']);
    expect(SKINS.every(isSkin)).toBe(true);
    expect(isSkin('dark')).toBe(false);
    expect(isSkin(undefined)).toBe(false);
  });
});
