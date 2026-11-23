import { describe, expect, it } from 'vitest';
import { cudaGpu, formatBytes, formatMemory, type HardwareProfile } from './localWhisperService';

const hardware = (gpus: HardwareProfile['gpus']): HardwareProfile => ({
  gpus,
  totalMemoryBytes: 34_065_952_768,
  physicalCores: 8,
  logicalCores: 16,
  avx2: true,
});

describe('cudaGpu', () => {
  it('garde la carte NVIDIA qui a le plus de mémoire et ignore les autres marques', () => {
    const hw = hardware([
      { name: 'Intel(R) UHD Graphics', vendor: 'intel', memoryBytes: 134_217_728 },
      { name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU', vendor: 'nvidia', memoryBytes: 4_157_603_840 },
      { name: 'NVIDIA eGPU', vendor: 'nvidia', memoryBytes: 12_000_000_000 },
    ]);
    expect(cudaGpu(hw)?.name).toBe('NVIDIA eGPU');
  });

  it('ne renvoie rien sans carte NVIDIA', () => {
    expect(cudaGpu(hardware([{ name: 'AMD Radeon', vendor: 'amd', memoryBytes: 8e9 }]))).toBeUndefined();
  });
});

describe('formatMemory', () => {
  it('arrondit au Go binaire, comme Windows', () => {
    // Espace insécable entre le nombre et l'unité, comme formatBytes.
    expect(formatMemory(34_065_952_768, 'en-US')).toBe('32 GB');
    expect(formatMemory(4_157_603_840, 'fr-FR')).toBe('4 Go');
    expect(formatMemory(0, 'en-US')).toBe('1 GB');
  });

  it('reste distinct de formatBytes (tailles de téléchargement en Go décimaux)', () => {
    expect(formatBytes(4_157_603_840, 'en-US')).toBe('4.2 GB');
  });
});
