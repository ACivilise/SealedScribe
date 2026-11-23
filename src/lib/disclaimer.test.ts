import { describe, expect, it } from 'vitest';
import { DISCLAIMER, parseDisclaimer } from './disclaimer';

describe('DISCLAIMER.md embarqué', () => {
  // Garde : sans titre ni date, l'écran d'acceptation serait vide ou ne serait jamais redemandé.
  it('a un titre, une date de mise à jour et un corps sans les lignes déjà affichées', () => {
    expect(DISCLAIMER.title).toBe('Avertissement et exclusion de responsabilité');
    expect(DISCLAIMER.updated).toMatch(/^\d{1,2} \p{L}+ \d{4}$/u);
    expect(DISCLAIMER.body).not.toMatch(/^# /m);
    expect(DISCLAIMER.body).not.toContain('Dernière mise à jour');
    expect(DISCLAIMER.body).not.toContain('<!--');
    expect(DISCLAIMER.body).toContain('226-1');
  });
});

describe('parseDisclaimer', () => {
  it('extrait titre et date, retire commentaires et retours chariot', () => {
    const parsed = parseDisclaimer(
      '# Titre\r\n\r\n<!--\r\nnote\r\n-->\r\n\r\n**Dernière mise à jour : 1 décembre 2026**\r\n\r\n## Section\r\n\r\nTexte.\r\n'
    );
    expect(parsed).toEqual({ title: 'Titre', updated: '1 décembre 2026', body: '## Section\n\nTexte.' });
  });

  it('laisse la date vide quand la ligne manque', () => {
    expect(parseDisclaimer('# Titre\n\nTexte.').updated).toBe('');
  });
});
