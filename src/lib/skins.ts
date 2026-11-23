/**
 * Habillages de l'interface. Chacun redéfinit, en clair comme en sombre, les couleurs, la police,
 * les arrondis et le décor de l'en-tête (`index.css`, règles `[data-skin='…']`). Le thème
 * clair / sombre / système reste un réglage à part, valable pour tous les habillages.
 */
export const SKINS = ['cassette', 'terminal', 'journal', 'glacier'] as const;

export type Skin = (typeof SKINS)[number];

/** Habillage d'origine : ses valeurs sont celles de `:root` et `.dark` dans `index.css`. */
export const DEFAULT_SKIN: Skin = 'cassette';

export function isSkin(value: unknown): value is Skin {
  return typeof value === 'string' && (SKINS as readonly string[]).includes(value);
}

/** Pose l'habillage sur <html> ; les règles `[data-skin='…']` d'`index.css` font le reste. */
export function applySkin(skin: Skin): void {
  document.documentElement.dataset.skin = skin;
}
