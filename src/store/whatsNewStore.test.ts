import { beforeEach, describe, expect, it } from 'vitest';
import { useWhatsNewStore } from './whatsNewStore';

beforeEach(() => {
  useWhatsNewStore.setState({ lastSeenVersion: null });
});

describe('whatsNewStore', () => {
  it('ne connaît aucune version vue au départ', () => {
    expect(useWhatsNewStore.getState().lastSeenVersion).toBeNull();
  });

  it('mémorise la version consultée et la persiste', () => {
    useWhatsNewStore.getState().markSeen('0.1.0');
    expect(useWhatsNewStore.getState().lastSeenVersion).toBe('0.1.0');
    expect(JSON.parse(localStorage.getItem('whats-new-store') ?? '{}').state.lastSeenVersion).toBe('0.1.0');
  });

  it('ignore une version absente (changelog vide)', () => {
    useWhatsNewStore.getState().markSeen('0.1.0');
    useWhatsNewStore.getState().markSeen(undefined);
    expect(useWhatsNewStore.getState().lastSeenVersion).toBe('0.1.0');
  });
});
