/**
 * Lecture du `CHANGELOG.md` affiché dans « Nouveautés » (format documenté dans la skill
 * `.claude/skills/release/SKILL.md`). Toute ligne hors format lève une erreur qui cite son
 * numéro : la garde `releaseNotes.test.ts` échoue au lieu d'afficher des notes tronquées.
 */

export const CHANGELOG_CATEGORIES = ['Nouveautés', 'Améliorations', 'Corrections'] as const;

export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export type InlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string };

export interface ReleaseSection {
  category: ChangelogCategory;
  items: InlineSegment[][];
}

export interface Release {
  version: string;
  date: string;
  title?: string;
  sections: ReleaseSection[];
}

/** Compare deux versions X.Y.Z composante par composante : négatif, zéro ou positif. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Vrai tant que `latest` n'a pas été ouverte : jamais rien consulté, ou une version plus ancienne. */
export function hasUnseenRelease(latest: string | undefined, lastSeen: string | null): boolean {
  if (!latest) return false;
  return lastSeen === null || compareVersions(latest, lastSeen) > 0;
}

// `**gras**` ou `code` ; tout le reste est du texte simple.
const INLINE_MARKUP = /\*\*(.+?)\*\*|`([^`]+)`/g;

/** Découpe une puce en segments de texte simple, de gras et de code. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const addText = (value: string) => {
    if (value) segments.push({ kind: 'text', text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(INLINE_MARKUP)) {
    addText(text.slice(cursor, match.index));
    segments.push(match[1] !== undefined ? { kind: 'strong', text: match[1] } : { kind: 'code', text: match[2] });
    cursor = match.index + match[0].length;
  }
  addText(text.slice(cursor));
  return segments;
}

/**
 * Efface les commentaires `<!-- … -->` en gardant leurs sauts de ligne (les numéros de ligne des
 * erreurs restent justes), puis les ouvertures orphelines. On recommence jusqu'à stabilité, car
 * retirer un morceau peut en recoller un autre : « <!<!-- a -->-- » redonne « <!-- ».
 */
function withoutComments(markdown: string): string {
  let text = markdown;
  for (;;) {
    const next = text
      .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))
      .replace(/<!--/g, '');
    if (next === text) return text;
    text = next;
  }
}

// En-tête de version : « ## 1.2.3 — 2026-11-16 », suivi ou non de « — Titre ».
// Séparateur : tiret cadratin, demi-cadratin ou trait d'union.
const RELEASE_HEADING = /^##\s+(\d+\.\d+\.\d+)\s+[—–-]\s+(\d{4}-\d{2}-\d{2})(?:\s+[—–-]\s+(.*\S))?\s*$/;

/** Une date AAAA-MM-JJ qui existe au calendrier (pas de 30 février). */
function isCalendarDate(iso: string): boolean {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isCategory(name: string): name is ChangelogCategory {
  return (CHANGELOG_CATEGORIES as readonly string[]).includes(name);
}

interface DraftRelease {
  version: string;
  date: string;
  title?: string;
  sections: { category: ChangelogCategory; bullets: string[] }[];
}

/** Lit le changelog, de la version la plus récente (en tête du fichier) à la plus ancienne. */
export function parseChangelog(markdown: string): Release[] {
  const drafts: DraftRelease[] = [];

  withoutComments(markdown)
    .split(/\r?\n/)
    .forEach((rawLine, index) => {
      const invalid = (reason: string) => new Error(`CHANGELOG.md, line ${index + 1}: ${reason}`);
      const line = rawLine.trimEnd();
      const release = drafts[drafts.length - 1];
      const section = release?.sections[release.sections.length - 1];

      // Ligne vide ou titre du document.
      if (line.trim() === '' || /^#\s/.test(line)) return;

      if (line.startsWith('###')) {
        const name = line.replace(/^###\s*/, '').trim();
        if (!release) throw invalid('category before any release');
        if (!isCategory(name)) throw invalid(`unknown category "${name}"`);
        release.sections.push({ category: name, bullets: [] });
        return;
      }

      if (line.startsWith('##')) {
        const heading = RELEASE_HEADING.exec(line);
        if (!heading || !isCalendarDate(heading[2])) throw invalid('expected "## X.Y.Z — YYYY-MM-DD"');
        drafts.push({ version: heading[1], date: heading[2], title: heading[3], sections: [] });
        return;
      }

      if (line.startsWith('- ')) {
        if (!section) throw invalid('bullet outside a category');
        section.bullets.push(line.slice(2).trim());
        return;
      }

      // Continuation indentée de la puce précédente.
      if (/^\s/.test(line) && section && section.bullets.length > 0) {
        section.bullets[section.bullets.length - 1] += ` ${line.trim()}`;
        return;
      }

      throw invalid('unexpected line');
    });

  return drafts.map(({ sections, ...release }) => ({
    ...release,
    sections: sections.map(({ category, bullets }) => ({ category, items: bullets.map(parseInline) })),
  }));
}
