/**
 * Prompts de résumé fournis avec l'application (modifiables dans l'onglet Prompts).
 * Une version par langue d'interface ; la langue de la réponse est imposée à part,
 * par le message système (voir `buildSystemPrompt`).
 */
import type { Locale } from '../i18n';

export type BuiltinPromptId = 'comprehensive' | 'bulletPoints' | 'executiveBrief' | 'actionItems';

export interface PromptDefinition {
  name: string;
  description: string;
  template: string;
}

export const BUILTIN_PROMPT_IDS: BuiltinPromptId[] = ['comprehensive', 'bulletPoints', 'executiveBrief', 'actionItems'];

const FR: Record<BuiltinPromptId, PromptDefinition> = {
  comprehensive: {
    name: 'Complet',
    description: 'Vue d’ensemble avec points clés, décisions et actions à mener',
    template: `Rédige un compte rendu complet de la réunion « {{title}} » du {{date}} à partir de sa transcription.

Inclus :
- les principaux sujets abordés ;
- les décisions prises ;
- les actions à mener, avec leur responsable s’il est mentionné ;
- les dates et échéances citées ;
- les risques ou points de vigilance soulevés.

Utilise des titres et des listes Markdown.

Transcription :
{{transcript}}`,
  },
  bulletPoints: {
    name: 'Liste à puces',
    description: 'Liste numérotée des principaux points abordés',
    template: `Résume la transcription de réunion ci-dessous sous forme de liste numérotée des points les plus importants.

- Une ou deux phrases maximum par point.
- Priorise les décisions, les actions à mener et les informations importantes.

Transcription :
{{transcript}}`,
  },
  executiveBrief: {
    name: 'Synthèse express',
    description: 'Résumé très court, en 2 ou 3 phrases',
    template: `Rédige une synthèse très courte de la réunion ci-dessous, pour un dirigeant pressé.

- Deux ou trois phrases au maximum.
- Uniquement le résultat ou la décision essentielle.

Transcription :
{{transcript}}`,
  },
  actionItems: {
    name: 'Actions à mener',
    description: 'Uniquement les tâches, responsables, échéances et décisions',
    template: `Extrais toutes les actions à mener de la transcription de réunion ci-dessous.

Pour chaque action, indique :
- la tâche à réaliser ;
- le responsable (s’il est mentionné) ;
- l’échéance (si elle est mentionnée) ;
- la priorité ou l’urgence (si elle est implicite).

Ajoute ensuite la liste des décisions prises.

Transcription :
{{transcript}}`,
  },
};

const EN: Record<BuiltinPromptId, PromptDefinition> = {
  comprehensive: {
    name: 'Comprehensive',
    description: 'Full overview with key points, decisions and action items',
    template: `Write comprehensive minutes of the meeting "{{title}}" held on {{date}}, based on its transcript.

Include:
- key discussion points;
- decisions made;
- action items, with owners if mentioned;
- dates and deadlines mentioned;
- risks or concerns raised.

Use Markdown headings and lists.

Transcript:
{{transcript}}`,
  },
  bulletPoints: {
    name: 'Bullet points',
    description: 'Numbered list of the main discussion points',
    template: `Summarize the meeting transcript below as a numbered list of the most important points.

- One or two sentences per point at most.
- Focus on decisions, action items and important information.

Transcript:
{{transcript}}`,
  },
  executiveBrief: {
    name: 'Executive brief',
    description: 'Very short summary in 2 or 3 sentences',
    template: `Write a very short executive summary of the meeting below, for a busy executive.

- Two or three sentences at most.
- Only the most critical outcome or decision.

Transcript:
{{transcript}}`,
  },
  actionItems: {
    name: 'Action items',
    description: 'Tasks, owners, deadlines and decisions only',
    template: `Extract all action items from the meeting transcript below.

For each action item, give:
- the task to be done;
- who is responsible (if mentioned);
- the deadline (if mentioned);
- the priority or urgency (if implied).

Then list the decisions that were made.

Transcript:
{{transcript}}`,
  },
};

export function getDefaultPrompt(id: BuiltinPromptId, locale: Locale): PromptDefinition {
  return (locale === 'fr' ? FR : EN)[id];
}
