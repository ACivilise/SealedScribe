import raw from '../../DISCLAIMER.md?raw';

/** Avertissement et exclusion de responsabilité, tiré de DISCLAIMER.md (intégré au build). */
export interface Disclaimer {
  /** Titre (ligne `# …`). */
  title: string;
  /**
   * Date de la ligne « Dernière mise à jour », telle qu'écrite (« 16 novembre 2026 »).
   * Sert aussi de version : l'acceptation est redemandée quand elle change.
   */
  updated: string;
  /** Le reste du texte, en Markdown. */
  body: string;
}

const TITLE_LINE = /^# (.+)$/m;
const UPDATED_LINE = /^\*\*Dernière mise à jour\s*:\s*(.+?)\*\*[ \t]*$/m;

export function parseDisclaimer(markdown: string): Disclaimer {
  const text = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  return {
    title: TITLE_LINE.exec(text)?.[1].trim() ?? '',
    updated: UPDATED_LINE.exec(text)?.[1].trim() ?? '',
    body: text.replace(TITLE_LINE, '').replace(UPDATED_LINE, '').trim(),
  };
}

export const DISCLAIMER = parseDisclaimer(raw);
