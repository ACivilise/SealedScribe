import { invoke } from '@tauri-apps/api/core';

/**
 * Transcription segment representing a piece of transcribed text
 */
export interface TranscriptionSegment {
  text: string;
  speaker: number;
  startTime: number;
  endTime: number;
  confidence: number;
  language: string;
}

/**
 * Full transcription result from Azure Speech Service
 */
export interface TranscriptionResult {
  segments: TranscriptionSegment[];
  fullText: string;
  language: string;
  durationSeconds: number;
}

/**
 * Portion d'un enregistrement, en secondes depuis son début.
 */
export interface AudioRange {
  start: number;
  end: number;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/**
 * Traitement de fond suivi par le backend (transcription).
 */
export interface Job {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * Transcription interrompue, reprenable (point de reprise écrit par le backend).
 */
export interface TranscriptionCheckpoint {
  audioPath: string;
  startSeconds: number | null;
  endSeconds: number | null;
  engine: string;
  model: string;
  language: string;
  doneChunks: number;
  totalChunks: number;
  updatedAt: string;
}

/**
 * Transcription service for interacting with Azure Speech Service via Tauri backend
 */
class TranscriptionService {
  /**
   * Transcribe an audio file using pre-configured credentials
   * @param audioPath - Path to the WAV audio file
   * @param language - Language code (e.g., 'en-US', 'fr-FR')
   * @param jobId - Identifiant du job, utilisé pour suivre et annuler le traitement
   * @param range - Plage à transcrire (secondes) ; absente : tout l'enregistrement.
   *   Les horodatages renvoyés restent relatifs au début de l'enregistrement.
   * @param prompt - Indice donné au moteur local (termes des lexiques) ; ignoré par Azure.
   * @returns TranscriptionResult with segments and full text
   */
  async transcribe(
    audioPath: string,
    language: string,
    jobId: string,
    range?: AudioRange | null,
    prompt?: string
  ): Promise<TranscriptionResult> {
    const result = await invoke<{
      segments: Array<{
        text: string;
        speaker: number;
        start_time: number;
        end_time: number;
        confidence: number;
        language: string;
      }>;
      full_text: string;
      language: string;
      duration_seconds: number;
    }>('transcribe_audio', {
      audioPath,
      language,
      jobId,
      startSeconds: range?.start ?? null,
      endSeconds: range?.end ?? null,
      prompt: prompt || null,
    });

    return this.mapResult(result);
  }

  /**
   * Aperçu d'écoute : l'enregistrement décodé en WAV mono 16 kHz (octets bruts).
   */
  async loadAudioPreview(audioPath: string): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>('load_audio_preview', { audioPath });
  }

  /**
   * Demande l'annulation d'un traitement en cours.
   * @returns true si le job était encore en cours
   */
  async cancelJob(jobId: string): Promise<boolean> {
    return invoke<boolean>('cancel_job', { jobId });
  }

  /**
   * Arrête une transcription locale après la partie en cours ; les parties terminées
   * restent dans le point de reprise.
   */
  async stopJobAfterPart(jobId: string): Promise<boolean> {
    return invoke<boolean>('stop_job_after_part', { jobId });
  }

  /**
   * Liste les jobs connus du backend (plus récents en premier).
   */
  async listJobs(): Promise<Job[]> {
    return invoke<Job[]>('list_jobs');
  }

  /**
   * Transcriptions interrompues (PC éteint, application quittée, erreur réseau) :
   * les relancer avec la même plage reprend au premier morceau manquant.
   */
  async listCheckpoints(): Promise<TranscriptionCheckpoint[]> {
    return invoke<TranscriptionCheckpoint[]>('list_transcription_checkpoints');
  }

  /**
   * Abandonne les transcriptions interrompues d'un fichier audio.
   */
  async discardCheckpoints(audioPath: string): Promise<number> {
    return invoke<number>('discard_transcription_checkpoints', { audioPath });
  }

  /**
   * Map the Rust snake_case result to TypeScript camelCase
   */
  private mapResult(result: {
    segments: Array<{
      text: string;
      speaker: number;
      start_time: number;
      end_time: number;
      confidence: number;
      language: string;
    }>;
    full_text: string;
    language: string;
    duration_seconds: number;
  }): TranscriptionResult {
    return {
      segments: result.segments.map((segment) => ({
        text: segment.text,
        speaker: segment.speaker,
        startTime: segment.start_time,
        endTime: segment.end_time,
        confidence: segment.confidence,
        language: segment.language,
      })),
      fullText: result.full_text,
      language: result.language,
      durationSeconds: result.duration_seconds,
    };
  }

  /**
   * Format a timestamp in seconds to MM:SS format
   */
  formatTimestamp(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * Format transcription segments to a readable text with timestamps
   */
  formatTranscriptionWithTimestamps(segments: TranscriptionSegment[]): string {
    return segments
      .map(
        (segment) =>
          `[${this.formatTimestamp(segment.startTime)}] ${segment.text}`
      )
      .join('\n');
  }
}

// Export singleton instance
export const transcriptionService = new TranscriptionService();
export default transcriptionService;
