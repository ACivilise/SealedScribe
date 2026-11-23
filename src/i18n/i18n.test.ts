import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { en } from './en';
import { fr } from './fr';
import { getSystemLocale, translate, useLocaleStore, useT } from './index';

describe('dictionnaires', () => {
  it('le français couvre exactement les mêmes clés que l’anglais', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it('chaque traduction garde les mêmes paramètres {x} que l’anglais', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const mismatches = (Object.keys(en) as (keyof typeof en)[]).filter(
      (key) => params(en[key]).join() !== params(fr[key]).join()
    );
    expect(mismatches).toEqual([]);
  });
});

describe('translate', () => {
  it('suit la langue courante et insère les paramètres', () => {
    expect(translate('record.chunk', { current: 1, total: 3 })).toBe('Part 1 of 3');
    useLocaleStore.getState().setPreference('fr');
    expect(translate('record.chunk', { current: 1, total: 3 })).toBe(fr['record.chunk'].replace('{current}', '1').replace('{total}', '3'));
  });

  it('laisse un paramètre manquant tel quel', () => {
    expect(translate('record.chunk', { current: 1 })).toBe('Part 1 of {total}');
  });
});

describe('getSystemLocale', () => {
  it('choisit le français si une des langues du système est le français', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'fr-CA']);
    expect(getSystemLocale()).toBe('fr');
  });

  it('se rabat sur l’anglais sinon', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    expect(getSystemLocale()).toBe('en');
  });
});

describe('setPreference', () => {
  it('résout « system » et met à jour l’attribut lang du document', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR']);
    useLocaleStore.getState().setPreference('system');
    expect(useLocaleStore.getState()).toMatchObject({ preference: 'system', locale: 'fr' });
    expect(document.documentElement.lang).toBe('fr');
  });
});

describe('useT', () => {
  it('donne le nom d’une langue de réunion avec une majuscule', () => {
    const { result } = renderHook(() => useT());
    expect(result.current.languageName('fr-FR')).toBe('French (France)');
  });
});
