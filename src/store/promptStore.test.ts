import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_PROMPT_IDS, getDefaultPrompt } from '../lib/defaultPrompts';
import { useLocaleStore } from '../i18n';
import { isPromptModified, usePromptStore } from './promptStore';

const store = () => usePromptStore.getState();
const find = (id: string) => store().prompts.find((p) => p.id === id)!;

beforeEach(() => {
  usePromptStore.setState({
    prompts: BUILTIN_PROMPT_IDS.map((id) => ({ id, builtinId: id, ...getDefaultPrompt(id, 'en') })),
  });
});

describe('promptStore', () => {
  it('ajoute un prompt personnalisé avec un nouvel identifiant', () => {
    const id = store().addPrompt({ name: 'Perso', description: 'd', template: '{{transcript}}' });
    expect(find(id)).toEqual({ id, name: 'Perso', description: 'd', template: '{{transcript}}' });
  });

  it('duplique un prompt juste après l’original, sans le marquer comme fourni', () => {
    const copyId = store().duplicatePrompt('comprehensive', '(copy)')!;
    const ids = store().prompts.map((p) => p.id);
    expect(ids.indexOf(copyId)).toBe(ids.indexOf('comprehensive') + 1);
    expect(find(copyId).name).toBe(`${find('comprehensive').name} (copy)`);
    expect(find(copyId).builtinId).toBeUndefined();
  });

  it('ne duplique pas un prompt inconnu', () => {
    expect(store().duplicatePrompt('inconnu', '(copy)')).toBeNull();
  });

  it('rétablit le texte d’origine d’un prompt fourni dans la langue de l’interface', () => {
    store().updatePrompt('actionItems', { template: 'modifié' });
    expect(isPromptModified(find('actionItems'), 'en')).toBe(true);

    useLocaleStore.setState({ locale: 'fr' });
    store().restorePrompt('actionItems');
    expect(find('actionItems')).toMatchObject(getDefaultPrompt('actionItems', 'fr'));
    expect(isPromptModified(find('actionItems'), 'fr')).toBe(false);
  });

  it('ne restaure pas un prompt personnalisé', () => {
    const id = store().addPrompt({ name: 'Perso', description: '', template: 'x' });
    store().restorePrompt(id);
    expect(find(id).template).toBe('x');
  });

  it('recrée uniquement les prompts fournis supprimés', () => {
    store().removePrompt('bulletPoints');
    store().removePrompt('executiveBrief');
    store().restoreMissingDefaults();
    const builtins = store().prompts.map((p) => p.builtinId).filter(Boolean);
    expect(builtins.sort()).toEqual([...BUILTIN_PROMPT_IDS].sort());
    expect(store().prompts).toHaveLength(BUILTIN_PROMPT_IDS.length);
  });

  it('isPromptModified est faux pour un prompt personnalisé', () => {
    expect(isPromptModified({ id: 'x', name: 'a', description: 'b', template: 'c' }, 'en')).toBe(false);
  });
});

describe('defaultPrompts', () => {
  it('chaque prompt fourni existe en français et en anglais et place la transcription', () => {
    for (const id of BUILTIN_PROMPT_IDS) {
      for (const locale of ['fr', 'en'] as const) {
        const prompt = getDefaultPrompt(id, locale);
        expect(prompt.name).not.toBe('');
        expect(prompt.template).toMatch(/\{\{\s*transcript\s*\}\}/);
      }
    }
  });
});
