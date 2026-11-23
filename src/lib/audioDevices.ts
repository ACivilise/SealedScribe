/**
 * Périphériques proposés à l'enregistrement (commande `list_audio_devices`) : les micros et les
 * sorties audio dont on capte le son. L'identifiant est celui du point de terminaison Windows,
 * stable quand on débranche puis rebranche le périphérique.
 */
export interface AudioDevice {
  id: string;
  name: string;
  /** Périphérique par défaut de Windows au moment de la liste. */
  isDefault: boolean;
}

export interface AudioDeviceList {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

/** Choix mémorisé : l'identifiant, et le nom pour le citer quand le périphérique est débranché. */
export interface SavedAudioDevice {
  id: string;
  name: string;
}

/** Valeur du choix « périphérique par défaut de Windows » dans les listes (jamais un identifiant Windows). */
export const DEFAULT_DEVICE = 'default';

const isDevice = (value: unknown): value is AudioDevice =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as AudioDevice).id === 'string' &&
  typeof (value as AudioDevice).name === 'string';

/** Liste reçue du backend, triée par nom dans la langue de l'interface (accents compris). */
export function parseAudioDevices(raw: unknown, locale?: string): AudioDeviceList {
  const pick = (value: unknown) =>
    (Array.isArray(value) ? value.filter(isDevice) : [])
      .map((device) => ({ ...device, isDefault: device.isDefault === true }))
      .sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }));
  const list = (raw ?? {}) as Partial<Record<keyof AudioDeviceList, unknown>>;
  return { inputs: pick(list.inputs), outputs: pick(list.outputs) };
}

export interface ResolvedDevice {
  /** Identifiant à transmettre à l'enregistrement ; `null` : le périphérique par défaut. */
  id: string | null;
  /** Périphérique choisi mais débranché : on se rabat sur celui par défaut. */
  missing: SavedAudioDevice | null;
}

/**
 * Périphérique à utiliser : le choix mémorisé s'il est branché, sinon celui par défaut.
 * Tant que la liste n'est pas connue (`devices` à `null`), le choix mémorisé est gardé tel quel :
 * le backend refusera de démarrer s'il est débranché.
 */
export function resolveDevice(saved: SavedAudioDevice | null, devices: AudioDevice[] | null): ResolvedDevice {
  if (!saved) {
    return { id: null, missing: null };
  }
  if (devices === null || devices.some((device) => device.id === saved.id)) {
    return { id: saved.id, missing: null };
  }
  return { id: null, missing: saved };
}
