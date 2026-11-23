import { describe, expect, it } from 'vitest';
import { compareVersions, hasUnseenRelease, parseChangelog, parseInline } from './changelog';

const SAMPLE = `# Historique des versions

<!-- notes de rédaction
## 9.9.9 — 1999-99-99 est ignoré dans un commentaire -->

## 0.2.0 — 2026-12-01 — Lexiques

### Nouveautés
- **Lexiques.** Les termes métier sont
  corrigés dans les transcriptions.
- Tri des réunions.

### Corrections
- Les boutons ne sont plus coupés.

## 0.1.0 — 2026-11-16

### Améliorations
- \`whisper\` choisit le GPU.
`;

describe('parseChangelog', () => {
  it('ne laisse aucune ouverture de commentaire, même recollée en retirant une autre', () => {
    const md = `# Historique

<!<!-- a -->--

<!--

## 0.1.0 — 2026-11-16

### Nouveautés
- Fonctionne.
`;
    const releases = parseChangelog(md);

    expect(releases.map((r) => r.version)).toEqual(['0.1.0']);
    expect(JSON.stringify(releases)).not.toContain('<!--');
  });

  it('lit versions, dates, titres facultatifs, catégories et puces dans l’ordre du fichier', () => {
    const releases = parseChangelog(SAMPLE);

    expect(releases.map((r) => [r.version, r.date, r.title])).toEqual([
      ['0.2.0', '2026-12-01', 'Lexiques'],
      ['0.1.0', '2026-11-16', undefined],
    ]);
    expect(releases[0].sections.map((s) => [s.category, s.items.length])).toEqual([
      ['Nouveautés', 2],
      ['Corrections', 1],
    ]);
    expect(releases[1].sections[0].category).toBe('Améliorations');
  });

  it('accepte un tiret demi-cadratin ou un trait d’union comme séparateur', () => {
    const md = '## 1.0.0 – 2026-11-16 - Titre\n\n### Nouveautés\n- x\n';
    expect(parseChangelog(md)[0]).toMatchObject({ version: '1.0.0', date: '2026-11-16', title: 'Titre' });
  });

  it('rattache les lignes de continuation indentées à la puce précédente', () => {
    const [release] = parseChangelog(SAMPLE);

    expect(release.sections[0].items[0]).toEqual([
      { kind: 'strong', text: 'Lexiques.' },
      { kind: 'text', text: ' Les termes métier sont corrigés dans les transcriptions.' },
    ]);
  });

  it('accepte les fins de ligne CRLF', () => {
    expect(parseChangelog(SAMPLE.replace(/\n/g, '\r\n'))).toHaveLength(2);
  });

  it('ne renvoie aucune version pour un changelog vide', () => {
    expect(parseChangelog('# Historique des versions\n')).toEqual([]);
  });

  it.each([
    ['une catégorie inconnue', '## 0.1.0 — 2026-11-16\n\n### Added\n- x\n', /unknown category "Added"/],
    ['un en-tête sans version', '## 2026-11-16\n\n### Corrections\n- x\n', /expected "## X.Y.Z — YYYY-MM-DD"/],
    ['un en-tête sans date', '## 0.1.0\n\n### Corrections\n- x\n', /expected "## X.Y.Z — YYYY-MM-DD"/],
    ['une version incomplète', '## 0.1 — 2026-11-16\n\n### Corrections\n- x\n', /expected "## X.Y.Z — YYYY-MM-DD"/],
    ['une date impossible', '## 0.1.0 — 2026-02-30\n\n### Corrections\n- x\n', /expected "## X.Y.Z — YYYY-MM-DD"/],
    ['une puce hors catégorie', '## 0.1.0 — 2026-11-16\n- x\n', /bullet outside a category/],
    ['une catégorie avant toute version', '### Corrections\n- x\n', /category before any release/],
    ['du texte libre', '## 0.1.0 — 2026-11-16\n\n### Corrections\nde la prose\n', /unexpected line/],
  ])('rejette %s en citant le numéro de ligne', (_label, markdown, message) => {
    expect(() => parseChangelog(markdown)).toThrow(message);
    expect(() => parseChangelog(markdown)).toThrow(/line \d+/);
  });
});

describe('parseInline', () => {
  it('sépare le gras et le code du texte simple', () => {
    expect(parseInline('Réglez `model` pour obtenir **le GPU** désormais')).toEqual([
      { kind: 'text', text: 'Réglez ' },
      { kind: 'code', text: 'model' },
      { kind: 'text', text: ' pour obtenir ' },
      { kind: 'strong', text: 'le GPU' },
      { kind: 'text', text: ' désormais' },
    ]);
  });

  it('garde un texte sans balisage en un seul segment', () => {
    expect(parseInline('simple')).toEqual([{ kind: 'text', text: 'simple' }]);
  });
});

describe('compareVersions', () => {
  it('compare numériquement chaque composante', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
  });
});

describe('hasUnseenRelease', () => {
  it('signale une version jamais consultée', () => {
    expect(hasUnseenRelease('0.1.0', null)).toBe(true);
  });

  it('ne signale plus une version déjà consultée, mais signale la suivante', () => {
    expect(hasUnseenRelease('0.1.0', '0.1.0')).toBe(false);
    expect(hasUnseenRelease('0.2.0', '0.1.0')).toBe(true);
  });

  it('ne signale rien sans aucune version', () => {
    expect(hasUnseenRelease(undefined, null)).toBe(false);
  });
});
