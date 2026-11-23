import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdateStore } from './updateStore';
import { updateService } from '../services/updateService';

vi.mock('../services/updateService', () => ({
  updateService: { check: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
}));

const UPDATE = { version: '0.5.0', currentVersion: '0.4.2', notes: 'Notes' };

beforeEach(() => {
  vi.mocked(updateService.check).mockReset();
  vi.mocked(updateService.install).mockReset();
  vi.mocked(updateService.onProgress).mockReset().mockResolvedValue(() => {});
  useUpdateStore.setState({
    status: 'idle',
    available: null,
    progress: null,
    error: null,
    dismissedVersion: null,
    checking: false,
  });
});

describe('updateStore — recherche', () => {
  it('retient la version trouvée', async () => {
    vi.mocked(updateService.check).mockResolvedValue(UPDATE);

    await expect(useUpdateStore.getState().check()).resolves.toBe('available');
    expect(useUpdateStore.getState()).toMatchObject({ status: 'available', available: UPDATE, checking: false });
  });

  it('dit que l’application est à jour', async () => {
    vi.mocked(updateService.check).mockResolvedValue(null);

    await expect(useUpdateStore.getState().check()).resolves.toBe('upToDate');
    expect(useUpdateStore.getState().available).toBeNull();
  });

  it('garde l’état précédent quand GitHub ne répond pas', async () => {
    useUpdateStore.setState({ status: 'available', available: UPDATE });
    vi.mocked(updateService.check).mockRejectedValue('network error');

    await expect(useUpdateStore.getState().check()).resolves.toBe('failed');
    expect(useUpdateStore.getState()).toMatchObject({ status: 'available', available: UPDATE, checking: false });
  });

  it('« Plus tard » tient jusqu’à une recherche demandée à la main', async () => {
    vi.mocked(updateService.check).mockResolvedValue(UPDATE);
    await useUpdateStore.getState().check();
    useUpdateStore.getState().dismiss();
    expect(useUpdateStore.getState().dismissedVersion).toBe('0.5.0');

    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().dismissedVersion).toBe('0.5.0');

    await useUpdateStore.getState().check({ manual: true });
    expect(useUpdateStore.getState().dismissedVersion).toBeNull();
  });
});

describe('updateStore — installation', () => {
  beforeEach(() => useUpdateStore.setState({ status: 'available', available: UPDATE }));

  it('passe en installation une fois l’installeur lancé, et suit la progression', async () => {
    let report: ((p: { downloaded: number; total: number | null }) => void) | undefined;
    vi.mocked(updateService.onProgress).mockImplementation(async (callback) => {
      report = callback;
      return () => {};
    });
    vi.mocked(updateService.install).mockImplementation(async () => {
      report?.({ downloaded: 50, total: 100 });
      expect(useUpdateStore.getState()).toMatchObject({ status: 'downloading', progress: { downloaded: 50, total: 100 } });
    });

    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState().status).toBe('installing');
  });

  it.each(['busy-recording', 'busy-job'])('refusée pendant une activité (%s) : erreur « busy »', async (code) => {
    vi.mocked(updateService.install).mockRejectedValue(code);

    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({ status: 'available', error: 'busy' });
  });

  it('tout autre échec : erreur « failed », et la mise à jour reste proposée', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(updateService.install).mockRejectedValue('signature invalide');

    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({ status: 'available', error: 'failed', available: UPDATE });
  });
});
