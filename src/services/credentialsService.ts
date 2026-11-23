/**
 * Credentials Service
 *
 * Les clés Azure sont stockées côté Rust (Gestionnaire d'identifiants Windows).
 * Le front ne reçoit jamais leur valeur : uniquement l'état « configuré ou non ».
 */

import { invoke } from '@tauri-apps/api/core';

export interface CredentialsStatus {
  speechConfigured: boolean;
  aiInferenceConfigured: boolean;
  aiEndpointConfigured: boolean;
  aiKeyConfigured: boolean;
  speechRegion: string;
  /** Nom du déploiement utilisé pour les résumés (pas un secret). */
  aiModel?: string | null;
  /** Clé Mistral AI (transcription Voxtral et résumé). */
  mistralConfigured: boolean;
}

/**
 * Pour chaque champ : undefined = inchangé, chaîne vide = supprimer, valeur = remplacer.
 */
export interface AzureCredentialsInput {
  speechKey?: string;
  speechRegion?: string;
  aiEndpoint?: string;
  aiKey?: string;
  aiModel?: string;
  mistralKey?: string;
}

export function getCredentialsStatus(): Promise<CredentialsStatus> {
  return invoke<CredentialsStatus>('get_credentials_status');
}

export function saveAzureCredentials(input: AzureCredentialsInput): Promise<CredentialsStatus> {
  return invoke<CredentialsStatus>('save_azure_credentials', { ...input });
}
