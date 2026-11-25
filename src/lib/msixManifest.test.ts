/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Garde sur le manifeste du paquet Microsoft Store (packaging/msix/AppxManifest.xml).
// Vitest tourne à la racine du dépôt (sous jsdom, import.meta.url n'est pas un chemin de fichier).
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const manifest = new DOMParser().parseFromString(read('packaging/msix/AppxManifest.xml'), 'application/xml');
const element = (localName: string) => {
  const found = manifest.getElementsByTagNameNS('*', localName)[0];
  if (!found) throw new Error(`<${localName}> absent du manifeste`);
  return found;
};

describe('Manifeste MSIX (Microsoft Store)', () => {
  it('est un XML valide', () => {
    expect(manifest.getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('porte l’identité réservée dans l’Espace partenaires (produit 9PLMZ0VZGS28)', () => {
    // Le Store refuse un paquet dont l'identité diffère de celle du produit.
    const identity = element('Identity');
    expect(identity.getAttribute('Name')).toBe('ACivilise.SealedScribe');
    expect(identity.getAttribute('Publisher')).toBe('CN=66CDA9B1-2B15-4216-AC2A-715F732053D3');
    expect(identity.getAttribute('Version')).toBe('__VERSION__');
    expect(element('PublisherDisplayName').textContent).toBe('ACivilise');
  });

  it('lance meetscribe.exe en application de bureau', () => {
    const application = element('Application');
    expect(application.getAttribute('Executable')).toBe('meetscribe.exe');
    expect(application.getAttribute('EntryPoint')).toBe('Windows.FullTrustApplication');
    expect(element('Capability').getAttribute('Name')).toBe('runFullTrust');
    expect(element('DeviceCapability').getAttribute('Name')).toBe('microphone');
  });

  it('déclare la tâche de démarrage que le backend active (distribution.rs)', () => {
    const rust = read('src-tauri/src/distribution.rs');
    const taskId = /pub const STARTUP_TASK_ID: &str = "([^"]+)";/.exec(rust)?.[1];
    expect(taskId).toBeTruthy();
    expect(element('StartupTask').getAttribute('TaskId')).toBe(taskId);
  });

  it('ne référence que des icônes copiées par build-msix.sh', () => {
    const script = read('packaging/msix/build-msix.sh');
    const logos = [
      element('Logo').textContent,
      element('VisualElements').getAttribute('Square150x150Logo'),
      element('VisualElements').getAttribute('Square44x44Logo'),
    ];
    for (const logo of logos) {
      const file = logo?.replace('Assets\\', '');
      expect(script).toContain(`$LAYOUT/Assets/${file}`);
    }
  });
});
