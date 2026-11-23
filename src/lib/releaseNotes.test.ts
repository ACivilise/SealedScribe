/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_CATEGORIES, compareVersions } from './changelog';
import { CURRENT_VERSION, RELEASES } from './releaseNotes';

// Garde sur le vrai CHANGELOG.md : un format qui dérive ou une version oubliée fait échouer les tests.
// Vitest tourne à la racine du dépôt (sous jsdom, import.meta.url n'est pas un chemin de fichier).
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('CHANGELOG.md', () => {
  it('contient au moins une version, et la version courante est la plus récente', () => {
    expect(RELEASES.length).toBeGreaterThan(0);
    expect(CURRENT_VERSION).toBe(RELEASES[0].version);
  });

  it('liste les versions de la plus récente à la plus ancienne, sans doublon', () => {
    for (let i = 1; i < RELEASES.length; i++) {
      expect(compareVersions(RELEASES[i - 1].version, RELEASES[i].version)).toBeGreaterThan(0);
      expect(RELEASES[i - 1].date >= RELEASES[i].date).toBe(true);
    }
  });

  it('range les catégories dans l’ordre canonique, sans doublon ni section vide', () => {
    for (const release of RELEASES) {
      const order = release.sections.map((s) => CHANGELOG_CATEGORIES.indexOf(s.category));
      expect(order).toEqual([...new Set(order)].sort((a, b) => a - b));
      for (const section of release.sections) expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('a pour dernière version celle de package.json, tauri.conf.json et Cargo.toml', () => {
    const packageVersion = JSON.parse(read('package.json')).version;
    const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;
    const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1];

    expect({ packageVersion, tauriVersion, cargoVersion }).toEqual({
      packageVersion: CURRENT_VERSION,
      tauriVersion: CURRENT_VERSION,
      cargoVersion: CURRENT_VERSION,
    });
  });
});
