/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIN, SKINS, type Skin } from './skins';

// Garde sur les habillages d'index.css : blocs présents, tokens repris en sombre, contrastes WCAG AA.
// Vitest tourne à la racine du dépôt (sous jsdom, import.meta.url n'est pas un chemin de fichier).
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Tokens = Record<string, string>;
type Mode = 'light' | 'dark';

/** Déclarations `--x: valeur` du bloc dont le sélecteur est exactement `selector`, en début de ligne. */
function block(selector: string): Tokens | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) return undefined;
  const tokens: Tokens = {};
  for (const declaration of match[1].split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
    if (m) tokens[m[1]] = m[2];
  }
  return tokens;
}

const lightSelector = (skin: Skin) => `[data-skin='${skin}']`;
const darkSelector = (skin: Skin) => `[data-skin='${skin}'].dark`;

/** Tokens en vigueur sur <html>, dans l'ordre de la cascade : `:root`, `.dark`, `[data-skin]`, `[data-skin].dark`. */
function effectiveTokens(skin: Skin, mode: Mode): Tokens {
  const layers: (Tokens | undefined)[] = [block(':root')];
  if (mode === 'dark') layers.push(block('.dark'));
  if (skin !== DEFAULT_SKIN) {
    layers.push(block(lightSelector(skin)));
    if (mode === 'dark') layers.push(block(darkSelector(skin)));
  }
  return Object.assign({}, ...layers);
}

/** Valeur d'un token, `var(--y)` résolu. */
function tokenValue(tokens: Tokens, name: string, depth = 0): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`${name} absent`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref && depth < 5 ? tokenValue(tokens, ref[1], depth + 1) : value;
}

/** Luminance relative (WCAG 2) d'un triplet HSL « h s% l% ». */
function luminance(hsl: string): number {
  const m = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(hsl);
  if (!m) throw new Error(`triplet HSL illisible : ${hsl}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Couples texte / fond qui doivent atteindre 4,5:1 (WCAG AA, texte courant). */
const TEXT_PAIRS: [text: string, background: string][] = [
  ['--foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--accent-foreground', '--accent'],
  ['--destructive-foreground', '--destructive'],
  ['--success-foreground', '--success'],
  ['--warning-foreground', '--warning'],
  ['--record-foreground', '--record'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--muted'],
  ['--muted-foreground', '--card'],
  ['--brand-text', '--background'],
  ['--brand-text', '--card'],
  ['--destructive', '--background'],
  ['--destructive', '--card'],
  ['--success', '--card'],
  ['--warning', '--card'],
];

/** Tokens de forme qu'un bloc sombre peut laisser au bloc clair du même habillage. */
const SHARED_WITH_LIGHT = new Set([
  '--radius',
  '--radius-2xl',
  '--radius-button',
  '--font-body',
  '--font-heading',
  '--header-band',
]);

const OTHER_SKINS = SKINS.filter((skin) => skin !== DEFAULT_SKIN);

describe('habillages dans index.css', () => {
  it.each(OTHER_SKINS)('%s a un bloc clair et un bloc sombre', (skin) => {
    expect(block(lightSelector(skin))).toBeDefined();
    expect(block(darkSelector(skin))).toBeDefined();
  });

  // `[data-skin='x']` l'emporte sur `.dark` : un token du bloc clair absent du bloc sombre resterait clair.
  it.each(OTHER_SKINS)('%s redéfinit en sombre chaque couleur de son bloc clair', (skin) => {
    const light = Object.keys(block(lightSelector(skin)) ?? {});
    const dark = block(darkSelector(skin)) ?? {};
    const missing = light.filter((name) => !SHARED_WITH_LIGHT.has(name) && !(name in dark));
    expect(missing).toEqual([]);
  });

  const cases = SKINS.flatMap((skin) => (['light', 'dark'] as const).map((mode) => [skin, mode] as const));

  it.each(cases)('%s (%s) : textes à 4,5:1 au moins', (skin, mode) => {
    const tokens = effectiveTokens(skin, mode);
    const failures = TEXT_PAIRS.map(([text, background]) => ({
      pair: `${text} / ${background}`,
      ratio: contrast(tokenValue(tokens, text), tokenValue(tokens, background)),
    }))
      .filter(({ ratio }) => ratio < 4.5)
      .map(({ pair, ratio }) => `${pair} = ${ratio.toFixed(2)}`);
    expect(failures).toEqual([]);
  });
});
