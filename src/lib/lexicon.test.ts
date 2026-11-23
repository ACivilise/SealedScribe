import { describe, expect, it } from 'vitest';
import {
  activeTerms,
  correctSegments,
  correctText,
  glossaryInstruction,
  parseVariants,
  whisperPrompt,
  whisperTerms,
  type Lexicon,
} from './lexicon';

const lexicon = (name: string, entries: [string, string][], enabled = true): Lexicon => ({
  id: name,
  name,
  enabled,
  entries: entries.map(([term, variants], i) => ({ id: `${name}-${i}`, term, variants })),
});

const zentra = [{ term: 'Zentra', variants: ['sentra', 'sen tra'] }];

describe('parseVariants', () => {
  it('sépare sur les virgules, points-virgules et retours à la ligne, sans vide ni doublon', () => {
    expect(parseVariants(' sentra, sen  tra ;\nSentra,, zen-tra ')).toEqual(['sentra', 'sen tra', 'zen-tra']);
    expect(parseVariants('')).toEqual([]);
  });
});

describe('activeTerms', () => {
  it('ne garde que les lexiques actifs et les lignes avec un terme', () => {
    const terms = activeTerms([
      lexicon('Travail', [['Zentra', 'sentra'], ['  ', 'perdu'], ['ACME', '']]),
      lexicon('Inactif', [['Snowflake', 'snow flake']], false),
    ]);
    expect(terms).toEqual([
      { term: 'Zentra', variants: ['sentra'] },
      { term: 'ACME', variants: [] },
    ]);
  });

  it('réunit un même terme présent dans deux lexiques et retire la variante identique au terme', () => {
    const terms = activeTerms([
      lexicon('A', [['Zentra', 'sentra, zentra']]),
      lexicon('B', [['zentra', 'Sentra, zen tra']]),
    ]);
    expect(terms).toEqual([{ term: 'Zentra', variants: ['sentra', 'zen tra'] }]);
  });
});

describe('correctText', () => {
  it('remplace les variantes par le terme, casse ignorée, et compte les corrections', () => {
    expect(correctText('On en parle dans sentra, puis Sentra revient.', zentra)).toEqual({
      text: 'On en parle dans Zentra, puis Zentra revient.',
      count: 2,
    });
  });

  it('tolère espaces et traits d’union entre les morceaux d’une variante', () => {
    expect(correctText('sen-tra, sen tra et Sen  tra', zentra).text).toBe('Zentra, Zentra et Zentra');
  });

  it('corrige la casse du terme sans compter ce qui est déjà juste', () => {
    expect(correctText('zentra et Zentra', zentra)).toEqual({ text: 'Zentra et Zentra', count: 1 });
  });

  it('ne touche pas une variante incluse dans un autre mot', () => {
    expect(correctText('msentrait et sentras', zentra)).toEqual({ text: 'msentrait et sentras', count: 0 });
  });

  it('respecte les limites de mot avec les lettres accentuées', () => {
    const terms = [{ term: 'Kéa', variants: ['ké a'] }];
    expect(correctText('ké a, piqué ké a', terms).text).toBe('Kéa, piqué Kéa');
    expect(correctText('créké ab', terms).text).toBe('créké ab');
  });

  it('traite les caractères spéciaux des variantes comme du texte', () => {
    const terms = [{ term: 'C#', variants: ['c sharp', 'c.sharp'] }];
    expect(correctText('du c.sharp ou du c sharp, pas du cXsharp', terms).text).toBe('du C# ou du C#, pas du cXsharp');
  });
});

describe('correctSegments', () => {
  const segments = [
    { text: 'Bonjour', speaker: 0 },
    { text: 'Le projet sentra avance', speaker: 1 },
  ];

  it('corrige le texte des segments et garde les autres champs', () => {
    const result = correctSegments(segments, zentra);
    expect(result.count).toBe(1);
    expect(result.segments[1]).toEqual({ text: 'Le projet Zentra avance', speaker: 1 });
    expect(result.segments[0]).toBe(segments[0]);
  });

  it('renvoie le même tableau sans terme ou sans correction', () => {
    expect(correctSegments(segments, []).segments).toBe(segments);
    expect(correctSegments(segments, [{ term: 'ACME', variants: [] }]).segments).toBe(segments);
  });
});

describe('indice whisper', () => {
  it('liste les termes en une phrase, vide sans terme', () => {
    expect(whisperPrompt([{ term: 'Zentra', variants: ['sentra'] }, { term: 'ACME', variants: [] }])).toBe(
      'Zentra, ACME.'
    );
    expect(whisperPrompt([])).toBe('');
  });

  it('s’arrête avant de dépasser la longueur maximale', () => {
    const terms = ['Alpha', 'Bravo', 'Charlie'].map((term) => ({ term, variants: [] }));
    // « Alpha, Bravo. » fait 13 caractères ; « , Charlie » ne tient plus.
    expect(whisperTerms(terms, 14)).toEqual(['Alpha', 'Bravo']);
    expect(whisperPrompt(terms, 14)).toBe('Alpha, Bravo.');
    expect(whisperPrompt(terms, 3)).toBe('');
  });
});

describe('glossaryInstruction', () => {
  it('donne l’orthographe et les variantes de chaque terme', () => {
    const text = glossaryInstruction([...zentra, { term: 'ACME', variants: [] }]);
    expect(text).toContain('- Zentra (may appear as: sentra, sen tra)');
    expect(text).toContain('\n- ACME');
  });

  it('est vide sans terme', () => {
    expect(glossaryInstruction([])).toBe('');
  });
});
