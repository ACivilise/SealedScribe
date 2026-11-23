import { describe, expect, it } from 'vitest';
import { addTags, collectTags, parseTags, removeTag, tagKey } from './tags';

describe('addTags', () => {
  it('ajoute une ou plusieurs étiquettes sans doublon', () => {
    expect(addTags('projet-x', 'hebdo, Projet-X ; client')).toBe('projet-x, hebdo, client');
    expect(addTags(undefined, 'hebdo')).toBe('hebdo');
  });

  it('reprend l’orthographe d’une étiquette déjà utilisée ailleurs', () => {
    expect(addTags(undefined, 'HEBDO', [{ key: 'hebdo', label: 'Hebdo' }])).toBe('Hebdo');
  });

  it('une saisie vide ne change rien (et une liste vide reste absente)', () => {
    expect(addTags('hebdo', ' , ')).toBe('hebdo');
    expect(addTags(undefined, '')).toBeUndefined();
  });
});

describe('removeTag', () => {
  it('retire l’étiquette par sa clé ; plus d’étiquette → champ absent', () => {
    expect(removeTag('projet-x, Hebdo', 'hebdo')).toBe('projet-x');
    expect(removeTag('hebdo', 'hebdo')).toBeUndefined();
  });
});

describe('parseTags', () => {
  it('découpe sur les virgules et points-virgules, sans vides ni espaces', () => {
    expect(parseTags(' projet-x, hebdo ;; entretien ,')).toEqual(['projet-x', 'hebdo', 'entretien']);
  });

  it('garde la première orthographe d’une étiquette répétée', () => {
    expect(parseTags('Hebdo, hebdo, HÉBDO')).toEqual(['Hebdo']);
  });

  it('renvoie une liste vide sans étiquette', () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('  ')).toEqual([]);
  });
});

describe('tagKey', () => {
  it('ignore la casse, les accents et les espaces autour', () => {
    expect(tagKey(' Réunion ')).toBe('reunion');
  });
});

describe('collectTags', () => {
  it('rassemble les étiquettes de toutes les réunions, sans doublon, triées', () => {
    const tags = collectTags([{ tag: 'hebdo, Projet-X' }, {}, { tag: 'entretien; Hebdo' }, { tag: 'été' }], 'fr');
    expect(tags).toEqual([
      { key: 'entretien', label: 'entretien' },
      { key: 'ete', label: 'été' },
      { key: 'hebdo', label: 'hebdo' },
      { key: 'projet-x', label: 'Projet-X' },
    ]);
  });
});
