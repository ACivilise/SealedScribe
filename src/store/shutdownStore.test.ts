import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useShutdownStore } from './shutdownStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  useShutdownStore.setState({ armed: false });
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

describe('shutdownStore', () => {
  it('prévient le backend quand la case change', () => {
    useShutdownStore.getState().setArmed(true);
    expect(useShutdownStore.getState().armed).toBe(true);
    expect(invoke).toHaveBeenCalledWith('set_shutdown_armed', { armed: true });
  });

  it('n’appelle pas le backend si l’état ne change pas', () => {
    useShutdownStore.getState().setArmed(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignore l’erreur du backend (hors Tauri)', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('pas de Tauri'));
    expect(() => useShutdownStore.getState().setArmed(true)).not.toThrow();
    await Promise.resolve();
    expect(useShutdownStore.getState().armed).toBe(true);
  });
});
