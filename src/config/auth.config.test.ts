import { describe, expect, it } from 'vitest';
import { isAuthActive, isValidClientId, isValidTenantId } from './auth.config';

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('isValidClientId', () => {
  it('accepte un GUID, quelle que soit la casse ou les espaces autour', () => {
    expect(isValidClientId(GUID)).toBe(true);
    expect(isValidClientId(` ${GUID.toUpperCase()} `)).toBe(true);
  });

  it('refuse le vide, un alias ou un GUID tronqué', () => {
    expect(isValidClientId('')).toBe(false);
    expect(isValidClientId('common')).toBe(false);
    expect(isValidClientId(GUID.slice(0, -1))).toBe(false);
  });
});

describe('isValidTenantId', () => {
  it('accepte un GUID, un domaine et les alias multi-locataires', () => {
    expect(isValidTenantId(GUID)).toBe(true);
    expect(isValidTenantId('contoso.onmicrosoft.com')).toBe(true);
    expect(isValidTenantId('common')).toBe(true);
    expect(isValidTenantId('Organizations')).toBe(true);
  });

  it('refuse le vide et tout ce qui changerait l’URL d’autorité', () => {
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId('contoso')).toBe(false);
    expect(isValidTenantId('a/b?c')).toBe(false);
    expect(isValidTenantId('evil.com/x')).toBe(false);
    expect(isValidTenantId('contoso.com#frag')).toBe(false);
  });
});

describe('isAuthActive', () => {
  it('exige la connexion seulement si elle est activée avec des IDs valides', () => {
    expect(isAuthActive({ enabled: true, clientId: GUID, tenantId: 'organizations' })).toBe(true);
    expect(isAuthActive({ enabled: false, clientId: GUID, tenantId: 'organizations' })).toBe(false);
    expect(isAuthActive({ enabled: true, clientId: '', tenantId: 'organizations' })).toBe(false);
    expect(isAuthActive({ enabled: true, clientId: GUID, tenantId: '' })).toBe(false);
    expect(isAuthActive(null)).toBe(false);
  });
});
