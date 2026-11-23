/**
 * Service de résumé : génération en streaming via le backend Rust, avec le moteur choisi dans
 * Paramètres > Résumé IA (Azure, Mistral AI, ou un modèle déjà installé dans Ollama, LM Studio…).
 */

import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * `mistral` : Mistral AI en direct ; `ollama` : API native d'Ollama ; `openai` : serveur local
 * compatible OpenAI (LM Studio, llama-server…).
 */
export type SummaryEngine = 'azure' | 'mistral' | 'ollama' | 'openai';
/** Moteurs qui tournent sur ce PC. */
export type LocalSummaryEngine = Exclude<SummaryEngine, 'azure' | 'mistral'>;

/** Adresse utilisée quand le champ est vide (même valeur que `LocalServer::default_url` côté Rust). */
export const DEFAULT_LOCAL_LLM_URL: Record<LocalSummaryEngine, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'http://127.0.0.1:1234/v1',
};

/** Modèle proposé par un serveur local. */
export interface LocalLlmModel {
  name: string;
  /** Taille des poids (Ollama seulement). */
  sizeBytes: number | null;
  /** Les poids tiennent sur la carte NVIDIA, contexte non compris ; `null` : pas de carte NVIDIA ou taille inconnue. */
  fitsGpu: boolean | null;
}

/** Modèles déjà installés sur le serveur local ; `url` vide : adresse par défaut. */
export function listLocalModels(engine: LocalSummaryEngine, url: string): Promise<LocalLlmModel[]> {
  return invoke<LocalLlmModel[]>('list_local_llm_models', { engine, url });
}

export interface SummaryResult {
  summary: string;
  /** Nom du prompt utilisé (rempli côté front). */
  style: string;
  tokensUsed: number | null;
  model: string;
  /** Génération arrêtée : `summary` ne contient que le début. */
  cancelled?: boolean;
}

type SummaryStreamEvent = { event: 'delta'; data: { text: string } };

/**
 * Génère un résumé ; `onDelta` reçoit chaque morceau de texte au fil de l'eau.
 * La promesse se résout avec le texte complet (ou partiel si la génération a été arrêtée).
 */
export async function generateSummary(
  system: string,
  prompt: string,
  onDelta: (text: string) => void
): Promise<SummaryResult> {
  const onEvent = new Channel<SummaryStreamEvent>();
  onEvent.onmessage = (message) => {
    if (message.event === 'delta') onDelta(message.data.text);
  };
  return invoke<SummaryResult>('generate_summary', { system, prompt, onEvent });
}

/** Arrête la génération en cours. */
export async function cancelSummary(): Promise<void> {
  await invoke('cancel_summary');
}

/** Le moteur de résumé choisi est-il prêt (clés Azure, ou modèle local choisi) ? */
export async function isSummaryConfigured(): Promise<boolean> {
  return invoke<boolean>('is_summary_configured');
}
