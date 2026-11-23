/**
 * Lexiques : orthographe des noms propres et du jargon que la reconnaissance vocale écorche
 * (« cube ernetes » au lieu de « Kubernetes »). Ils servent à trois moments :
 * - indice donné au moteur local (paramètre `prompt` de whisper) pendant la transcription ;
 * - correction du texte transcrit (les deux moteurs) : variantes remplacées par le terme ;
 * - glossaire ajouté au message système du résumé.
 */

export interface LexiconEntry {
  id: string;
  /** Orthographe correcte. */
  term: string;
  /** Transcriptions erronées, telles que saisies (séparées par des virgules ou des points-virgules). */
  variants: string;
}

export interface Lexicon {
  id: string;
  name: string;
  /** Utilisé pour les transcriptions et les résumés. */
  enabled: boolean;
  entries: LexiconEntry[];
}

/** Terme prêt à l'emploi : orthographe correcte et variantes nettoyées. */
export interface LexiconTerm {
  term: string;
  variants: string[];
}

/** Longueur maximale de l'indice envoyé à whisper (il n'en garde qu'environ 220 jetons). */
export const WHISPER_PROMPT_MAX_CHARS = 600;

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const keyOf = (s: string) => collapse(s).toLocaleLowerCase();

/** Variantes saisies : séparées par `,` `;` ou un retour à la ligne, sans doublon (casse ignorée). */
export function parseVariants(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[,;\n]/)) {
    const variant = collapse(raw);
    const key = variant.toLocaleLowerCase();
    if (variant && !seen.has(key)) {
      seen.add(key);
      result.push(variant);
    }
  }
  return result;
}

/**
 * Termes des lexiques actifs, dans l'ordre d'affichage. Un terme présent dans plusieurs lexiques
 * n'apparaît qu'une fois (variantes réunies) ; une ligne sans terme est ignorée.
 */
export function activeTerms(lexicons: Lexicon[]): LexiconTerm[] {
  const byKey = new Map<string, LexiconTerm>();
  for (const lexicon of lexicons) {
    if (!lexicon.enabled) continue;
    for (const entry of lexicon.entries) {
      const term = collapse(entry.term);
      if (!term) continue;
      const key = term.toLocaleLowerCase();
      const variants = parseVariants(entry.variants).filter((v) => keyOf(v) !== key);
      const existing = byKey.get(key);
      if (existing) {
        const known = new Set(existing.variants.map(keyOf));
        existing.variants.push(...variants.filter((v) => !known.has(keyOf(v))));
      } else {
        byKey.set(key, { term, variants });
      }
    }
  }
  return [...byKey.values()];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Motif d'une forme : casse ignorée, et les espaces ou traits d'union qui séparent ses morceaux
 * sont facultatifs (« open ai » reconnaît aussi « open-ai » et « openai »).
 */
function formPattern(form: string): string {
  return form
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join('[\\s-]*');
}

/**
 * Expression qui trouve le terme (pour corriger sa casse) et ses variantes, en mots entiers.
 * Les formes les plus longues passent d'abord.
 */
function termRegExp(term: LexiconTerm): RegExp {
  const forms = [term.term, ...term.variants].sort((a, b) => b.length - a.length).map(formPattern);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Remplace dans `text` les variantes (et le terme mal capitalisé) par l'orthographe correcte. */
export function correctText(text: string, terms: LexiconTerm[]): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const term of terms) {
    result = result.replace(termRegExp(term), (match) => {
      if (match !== term.term) count += 1;
      return term.term;
    });
  }
  return { text: result, count };
}

/** Corrige chaque segment ; renvoie les mêmes objets quand rien ne change. */
export function correctSegments<T extends { text: string }>(
  segments: T[],
  terms: LexiconTerm[]
): { segments: T[]; count: number } {
  if (terms.length === 0) return { segments, count: 0 };
  let count = 0;
  const corrected = segments.map((segment) => {
    const result = correctText(segment.text, terms);
    count += result.count;
    return result.count > 0 ? { ...segment, text: result.text } : segment;
  });
  return { segments: count > 0 ? corrected : segments, count };
}

/** Termes qui tiennent dans l'indice envoyé à whisper (les premiers, dans l'ordre des lexiques). */
export function whisperTerms(terms: LexiconTerm[], maxChars = WHISPER_PROMPT_MAX_CHARS): string[] {
  const kept: string[] = [];
  let length = 0;
  for (const { term } of terms) {
    const added = (kept.length > 0 ? 2 : 0) + term.length;
    if (length + added + 1 > maxChars) break;
    kept.push(term);
    length += added;
  }
  return kept;
}

/**
 * Indice donné au moteur local : la liste des termes, comme une phrase déjà « entendue ».
 * Whisper reprend alors leur orthographe. Vide s'il n'y a aucun terme.
 */
export function whisperPrompt(terms: LexiconTerm[], maxChars = WHISPER_PROMPT_MAX_CHARS): string {
  const kept = whisperTerms(terms, maxChars);
  return kept.length > 0 ? `${kept.join(', ')}.` : '';
}

/** Consigne ajoutée au message système du résumé (en anglais, comme le reste de ce message). */
export function glossaryInstruction(terms: LexiconTerm[]): string {
  if (terms.length === 0) return '';
  const lines = terms.map(({ term, variants }) =>
    variants.length > 0 ? `- ${term} (may appear as: ${variants.join(', ')})` : `- ${term}`
  );
  return [
    'The transcript comes from speech recognition, which may misspell names and jargon.',
    'Always write these terms exactly as spelled below, and read their misspellings as these terms:',
    ...lines,
  ].join('\n');
}
