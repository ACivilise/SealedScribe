/**
 * Étiquettes d'une réunion. Stockées dans le champ texte `tag`, saisi à l'enregistrement :
 * plusieurs étiquettes y sont séparées par des virgules (ou des points-virgules).
 */

/** Minuscules sans accents : « reunion » trouve « Réunion ». */
export const normalizeText = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Clé de comparaison : « Hebdo » et « hebdo » sont la même étiquette. */
export const tagKey = (tag: string) => normalizeText(tag.trim());

/** Étiquettes distinctes du champ `tag`, dans l'ordre de saisie. */
export function parseTags(tag: string | undefined): string[] {
  if (!tag) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of tag.split(/[,;]/)) {
    const label = raw.trim();
    const key = tagKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(label);
  }
  return tags;
}

export interface TagOption {
  key: string;
  /** Première orthographe rencontrée. */
  label: string;
}

/** Valeur du champ `tag` pour une liste d'étiquettes (absente si la liste est vide). */
export const formatTags = (tags: string[]): string | undefined => (tags.length ? tags.join(', ') : undefined);

/**
 * Ajoute à `current` les étiquettes saisies dans `input` (séparées par des virgules).
 * Une étiquette déjà utilisée ailleurs reprend son orthographe (`known`) : « hebdo » → « Hebdo ».
 */
export function addTags(current: string | undefined, input: string, known: TagOption[] = []): string | undefined {
  const spelling = new Map(known.map((tag) => [tag.key, tag.label]));
  const added = parseTags(input).map((label) => spelling.get(tagKey(label)) ?? label);
  return formatTags(parseTags([current ?? '', ...added].join(',')));
}

/** Retire de `current` l'étiquette de clé `key`. */
export const removeTag = (current: string | undefined, key: string): string | undefined =>
  formatTags(parseTags(current).filter((label) => tagKey(label) !== key));

/** Toutes les étiquettes des réunions, sans doublon, triées par ordre alphabétique. */
export function collectTags(meetings: { tag?: string }[], locale?: string): TagOption[] {
  const byKey = new Map<string, string>();
  for (const meeting of meetings) {
    for (const label of parseTags(meeting.tag)) {
      const key = tagKey(label);
      if (!byKey.has(key)) byKey.set(key, label);
    }
  }
  return [...byKey]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label, locale, { sensitivity: 'base' }));
}
