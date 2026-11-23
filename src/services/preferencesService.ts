import { invoke } from '@tauri-apps/api/core';
import type { TranscriptionEngine } from './localWhisperService';
import type { SummaryEngine } from './summaryService';

/** Préférences persistées par le backend (`preferences.json`, champs en snake_case). */
export interface UserPreferences {
  default_language: string;
  auto_summary: boolean;
  save_locally: boolean;
  theme: string;
  recordings_directory: string;
  transcription_engine: TranscriptionEngine;
  local_model: string;
  /** Moteur de résumé : Azure, ou un serveur local où le modèle est déjà installé. */
  summary_engine: SummaryEngine;
  /** Adresse du serveur local ; vide : adresse par défaut du moteur. */
  local_llm_url: string;
  /** Modèle déjà installé dans le serveur local (ex. `qwen3:4b`). */
  local_llm_model: string;
  /** Modèle Voxtral ; vide : `voxtral-mini-latest`. */
  mistral_transcription_model: string;
  /** Modèle de chat Mistral pour le résumé ; vide : `mistral-medium-latest`. */
  mistral_summary_model: string;
  /** Connexion Microsoft exigée au démarrage (contrôle d'accès à l'interface uniquement). */
  auth_enabled: boolean;
  azure_ad_client_id: string;
  azure_ad_tenant_id: string;
}

export const loadPreferences = () => invoke<UserPreferences>('load_preferences');

export const savePreferences = (preferences: UserPreferences) =>
  invoke<void>('save_preferences', { preferences });
