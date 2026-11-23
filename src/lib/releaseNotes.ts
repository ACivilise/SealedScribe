import raw from '../../CHANGELOG.md?raw';
import { parseChangelog } from './changelog';

/** Versions publiées, de la plus récente à la plus ancienne (intégrées au build). */
export const RELEASES = parseChangelog(raw);

/**
 * Version de l'application : la plus récente du changelog. `releaseNotes.test.ts` garantit qu'elle est
 * égale à celle de package.json, tauri.conf.json et Cargo.toml (donc à celle de l'installeur).
 */
export const CURRENT_VERSION: string | undefined = RELEASES[0]?.version;
