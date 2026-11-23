/**
 * Préparation des messages envoyés au modèle de résumé.
 */
import type { Locale } from '../i18n';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { glossaryInstruction, type LexiconTerm } from './lexicon';

/** Variables utilisables dans un prompt. */
export const PROMPT_VARIABLES = ['transcript', 'title', 'date'] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

/**
 * Remplace `{{variable}}` (espaces tolérés) par sa valeur. Sans `{{transcript}}`,
 * la transcription est ajoutée à la fin : un prompt ne part jamais sans elle.
 */
export function renderPrompt(template: string, values: Record<PromptVariable, string>): string {
  const hasTranscript = /\{\{\s*transcript\s*\}\}/.test(template);
  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in values ? values[name as PromptVariable] : match
  );
  return hasTranscript ? rendered : `${rendered.trimEnd()}\n\n---\n${values.transcript}`;
}

/** Nom anglais de la langue : les consignes au modèle sont plus fiables en anglais. */
const LANGUAGE_NAMES: Record<Locale, string> = { fr: 'French', en: 'English' };

/**
 * Message système : impose la langue de l'interface pour la réponse, quelle que soit celle de la réunion.
 * `terms` (lexiques actifs) : orthographe à respecter pour les noms propres et le jargon.
 */
export function buildSystemPrompt(locale: Locale, terms: LexiconTerm[] = []): string {
  const language = LANGUAGE_NAMES[locale];
  // Mêmes libellés que ceux qui préfixent les lignes (utils/speakers), dans la langue de l'interface.
  const labels = { fr, en }[locale];
  const base = [
    'You summarize meeting transcripts.',
    `Always write your entire answer in ${language}, whatever the language of the transcript or of the instructions.`,
    'Use Markdown. Do not invent information that is not in the transcript.',
    `Lines may start with "${labels['speaker.me']}:" (the person who recorded the meeting),` +
      ` "${labels['speaker.others']}:" (the other participants, heard through the computer)` +
      ` or "${labels['speaker.remote'].replace('{number}', '1')}:", "${labels['speaker.remote'].replace('{number}', '2')}:"…` +
      ' (remote participants told apart by their voice; they may also have been given a name).',
  ].join(' ');
  const glossary = glossaryInstruction(terms);
  return glossary ? `${base}\n\n${glossary}` : base;
}
