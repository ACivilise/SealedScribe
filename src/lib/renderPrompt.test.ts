import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, renderPrompt } from './renderPrompt';

const values = { transcript: 'Bonjour à tous.', title: 'Point hebdo', date: '12/11/2026' };

describe('renderPrompt', () => {
  it('remplace les variables, espaces tolérés', () => {
    expect(renderPrompt('Réunion {{title}} du {{ date }} :\n{{  transcript }}', values)).toBe(
      'Réunion Point hebdo du 12/11/2026 :\nBonjour à tous.'
    );
  });

  it('remplace toutes les occurrences d’une variable', () => {
    expect(renderPrompt('{{title}} / {{title}} {{transcript}}', values)).toBe(
      'Point hebdo / Point hebdo Bonjour à tous.'
    );
  });

  it('laisse intactes les variables inconnues', () => {
    expect(renderPrompt('{{inconnue}} {{transcript}}', values)).toBe('{{inconnue}} Bonjour à tous.');
  });

  it('ajoute la transcription à la fin si le prompt ne la cite pas', () => {
    expect(renderPrompt('Résume « {{title}} ».   \n', values)).toBe(
      'Résume « Point hebdo ».\n\n---\nBonjour à tous.'
    );
  });
});

describe('buildSystemPrompt', () => {
  it('impose la langue de l’interface', () => {
    expect(buildSystemPrompt('fr')).toContain('in French');
    expect(buildSystemPrompt('en')).toContain('in English');
  });

  it('explique les préfixes d’intervenant dans la langue de l’interface', () => {
    expect(buildSystemPrompt('fr')).toContain('"Moi:"');
    expect(buildSystemPrompt('fr')).toContain('"Autres:"');
    expect(buildSystemPrompt('en')).toContain('"Me:"');
    expect(buildSystemPrompt('fr')).toContain('"Intervenant 1:"');
  });

  it('ajoute le glossaire des lexiques actifs, et rien sans lexique', () => {
    const system = buildSystemPrompt('fr', [{ term: 'Zentra', variants: ['sentra', 'sen-tra'] }, { term: 'ACME', variants: [] }]);
    expect(system).toContain('- Zentra (may appear as: sentra, sen-tra)');
    expect(system).toContain('- ACME');
    expect(buildSystemPrompt('fr', [])).toBe(buildSystemPrompt('fr'));
    expect(buildSystemPrompt('fr')).not.toContain('speech recognition');
  });
});
