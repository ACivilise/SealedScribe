/**
 * Moteur de transcription local (whisper.cpp) : sur la carte NVIDIA si le modèle y tient,
 * sinon sur le processeur.
 *
 * Les fichiers (programme, modèle, VAD) se téléchargent depuis les Paramètres ;
 * le modèle n'est chargé en mémoire qu'au moment d'une transcription.
 */

import { invoke } from '@tauri-apps/api/core';

/** `local` : whisper.cpp sur ce PC ; `mistral` : Voxtral chez Mistral AI. */
export type TranscriptionEngine = 'azure' | 'local' | 'mistral';

/** Appareil qui exécute un modèle. */
export type ComputeDevice = 'gpu' | 'cpu';

/** Le modèle tient-il dans la mémoire de l'appareil qui l'exécute ? */
export type MemoryFit = 'ok' | 'tight' | 'tooBig';

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  /** Mémoire graphique dédiée. */
  memoryBytes: number;
}

/** Capacités de ce PC (détectées par le backend : DXGI, mémoire vive, cœurs). */
export interface HardwareProfile {
  gpus: GpuInfo[];
  /** 0 si inconnue. */
  totalMemoryBytes: number;
  physicalCores: number;
  logicalCores: number;
  avx2: boolean;
}

export interface LocalModelStatus {
  id: string;
  label: string;
  /** Programme, VAD et modèle présents : prêt à transcrire. */
  installed: boolean;
  sizeBytes: number;
  /** Octets restant à télécharger pour utiliser ce modèle. */
  missingBytes: number;
  /** Mémoire nécessaire une fois chargé. */
  memoryBytes: number;
  /** Appareil prévu sur ce PC. */
  device: ComputeDevice;
  fit: MemoryFit;
  /** Modèle conseillé pour ce PC. */
  recommended: boolean;
}

/** Composant optionnel (séparation des intervenants). */
export interface ComponentStatus {
  installed: boolean;
  /** Une version précédente est installée : elle se met à jour d'elle-même à la prochaine séparation. */
  outdated: boolean;
  sizeBytes: number;
  missingBytes: number;
}

export interface LocalWhisperStatus {
  models: LocalModelStatus[];
  /** Modèle chargé en mémoire, s'il y en a un. */
  loadedModel: string | null;
  /** Appareil réellement utilisé par le modèle chargé (lu dans le journal de whisper-server). */
  loadedDevice: ComputeDevice | null;
  hardware: HardwareProfile;
  diarization: ComponentStatus;
}

/** Carte NVIDIA qui a le plus de mémoire : la seule que le moteur local sait utiliser. */
export function cudaGpu(hardware: HardwareProfile): GpuInfo | undefined {
  return hardware.gpus
    .filter((gpu) => gpu.vendor === 'nvidia')
    .reduce<GpuInfo | undefined>((best, gpu) => (!best || gpu.memoryBytes > best.memoryBytes ? gpu : best), undefined);
}

/**
 * Séparation des intervenants (sherpa-onnx) : s'installe et se supprime comme un modèle,
 * sous cet identifiant (`DIARIZATION_ID` côté Rust).
 */
export const DIARIZATION_ID = 'diarization';

export const SPEAKER_SEPARATION_PROGRESS_EVENT = 'speaker-separation-progress';

/**
 * Relance la séparation des intervenants d'une transcription : renvoie l'intervenant de
 * chaque intervalle [début, fin] (secondes). `numSpeakers` : participants distants, si connu.
 */
export function separateSpeakers(
  audioPath: string,
  spans: [number, number][],
  numSpeakers: number | null,
  jobId: string
): Promise<number[]> {
  return invoke<number[]>('separate_speakers', { audioPath, spans, numSpeakers, jobId });
}

export interface InstallProgressEvent {
  modelId: string;
  file: string;
  fileIndex: number;
  fileCount: number;
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  phase: 'downloading' | 'extracting' | 'completed';
}

export const INSTALL_PROGRESS_EVENT = 'local-whisper-install-progress';

export function getLocalWhisperStatus(): Promise<LocalWhisperStatus> {
  return invoke<LocalWhisperStatus>('get_local_whisper_status');
}

export function installLocalWhisper(model: string, jobId: string): Promise<void> {
  return invoke('install_local_whisper', { model, jobId });
}

export function unloadLocalWhisper(): Promise<void> {
  return invoke('unload_local_whisper');
}

export function deleteLocalModel(model: string): Promise<void> {
  return invoke('delete_local_model', { model });
}

export function cancelInstall(jobId: string): Promise<boolean> {
  return invoke<boolean>('cancel_job', { jobId });
}

/** Taille lisible en Mo / Go (séparateur décimal selon la langue). */
export function formatBytes(bytes: number, locale: string): string {
  const format = (value: number, unit: string) =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
  if (bytes >= 1e9) return format(bytes / 1e9, locale.startsWith('fr') ? 'Go' : 'GB');
  return format(bytes / 1e6, locale.startsWith('fr') ? 'Mo' : 'MB');
}

/**
 * Mémoire d'un composant (RAM, carte graphique) arrondie au Go binaire, comme l'affiche
 * Windows : 34 065 952 768 octets → « 32 Go ».
 */
export function formatMemory(bytes: number, locale: string): string {
  const gib = Math.max(1, Math.round(bytes / 2 ** 30));
  return `${new Intl.NumberFormat(locale).format(gib)} ${locale.startsWith('fr') ? 'Go' : 'GB'}`;
}
