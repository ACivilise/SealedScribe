import { invoke } from '@tauri-apps/api/core';

/**
 * Speaker identified in the diarization process
 */
export interface IdentifiedSpeaker {
  /** Unique speaker ID from diarization (e.g., "Speaker1") */
  speakerId: string;
  /** Display name (initially same as speakerId, can be mapped by user) */
  displayName: string;
  /** Total speaking time in seconds */
  totalSpeakingTime: number;
  /** Number of segments spoken by this speaker */
  segmentCount: number;
}

/**
 * A transcription segment with speaker attribution
 */
export interface DiarizedSegment {
  /** The transcribed text */
  text: string;
  /** Speaker ID (e.g., "Speaker1", "Speaker2") */
  speakerId: string;
  /** Speaker display name (may be user-mapped) */
  speakerName: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Confidence score (0.0 to 1.0) */
  confidence: number;
  /** Language code */
  language: string;
}

/**
 * Full diarization result with speakers and segments
 */
export interface DiarizationResult {
  /** Transcription segments with speaker information */
  segments: DiarizedSegment[];
  /** List of identified speakers */
  speakers: IdentifiedSpeaker[];
  /** Full transcription text */
  fullText: string;
  /** Language of the transcription */
  language: string;
  /** Total duration in seconds */
  durationSeconds: number;
}

/**
 * Mapping to rename a speaker
 */
export interface SpeakerMapping {
  /** Speaker ID from diarization */
  speakerId: string;
  /** User-assigned name for this speaker */
  assignedName: string;
}

/**
 * Raw result from Rust backend (snake_case)
 */
interface RawDiarizationResult {
  segments: Array<{
    text: string;
    speaker_id: string;
    speaker_name: string;
    start_time: number;
    end_time: number;
    confidence: number;
    language: string;
  }>;
  speakers: Array<{
    speaker_id: string;
    display_name: string;
    total_speaking_time: number;
    segment_count: number;
  }>;
  full_text: string;
  language: string;
  duration_seconds: number;
}

/**
 * Diarization service for speaker identification and transcription
 */
class DiarizationService {
  /**
   * Transcribe audio with speaker diarization using pre-configured credentials
   */
  async transcribeWithDiarization(
    audioPath: string,
    language: string
  ): Promise<DiarizationResult> {
    const result = await invoke<RawDiarizationResult>('transcribe_with_diarization', {
      audioPath,
      language,
    });
    return this.mapResult(result);
  }

  /**
   * Apply speaker name mappings to rename speakers
   */
  async applySpeakerMappings(
    result: DiarizationResult,
    mappings: SpeakerMapping[]
  ): Promise<DiarizationResult> {
    // Convert to snake_case for Rust
    const rawResult = this.toRawResult(result);
    const rawMappings = mappings.map((m) => ({
      speaker_id: m.speakerId,
      assigned_name: m.assignedName,
    }));

    const mapped = await invoke<RawDiarizationResult>('apply_speaker_mappings', {
      result: rawResult,
      mappings: rawMappings,
    });

    return this.mapResult(mapped);
  }

  /**
   * Format diarization result as Markdown
   */
  async formatAsMarkdown(result: DiarizationResult, title: string): Promise<string> {
    const rawResult = this.toRawResult(result);
    return invoke<string>('format_diarization_markdown', {
      result: rawResult,
      title,
    });
  }

  /**
   * Check if the diarization service is configured
   */
  async checkConfigured(): Promise<boolean> {
    return invoke<boolean>('is_diarization_configured');
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
   * Format diarization result as plain text with speaker labels
   */
  formatAsText(result: DiarizationResult): string {
    return result.segments
      .map(
        (segment) =>
          `**${segment.speakerName}** [${this.formatTimestamp(segment.startTime)}]\n${segment.text}`
      )
      .join('\n\n');
  }

  /**
   * Get unique speakers sorted by speaking time
   */
  getSpeakersByTime(result: DiarizationResult): IdentifiedSpeaker[] {
    return [...result.speakers].sort((a, b) => b.totalSpeakingTime - a.totalSpeakingTime);
  }

  /**
   * Get speaker color for UI visualization
   */
  getSpeakerColor(speakerId: string): string {
    const colors = [
      '#3B82F6', // Blue
      '#10B981', // Green
      '#F59E0B', // Amber
      '#EF4444', // Red
      '#8B5CF6', // Purple
      '#EC4899', // Pink
      '#06B6D4', // Cyan
      '#84CC16', // Lime
      '#F97316', // Orange
      '#6366F1', // Indigo
    ];

    // Extract speaker number and use as index
    const match = speakerId.match(/Speaker(\d+)/);
    if (match) {
      const index = (parseInt(match[1], 10) - 1) % colors.length;
      return colors[index];
    }
    return colors[0];
  }

  /**
   * Map raw snake_case result to camelCase
   */
  private mapResult(raw: RawDiarizationResult): DiarizationResult {
    return {
      segments: raw.segments.map((s) => ({
        text: s.text,
        speakerId: s.speaker_id,
        speakerName: s.speaker_name,
        startTime: s.start_time,
        endTime: s.end_time,
        confidence: s.confidence,
        language: s.language,
      })),
      speakers: raw.speakers.map((s) => ({
        speakerId: s.speaker_id,
        displayName: s.display_name,
        totalSpeakingTime: s.total_speaking_time,
        segmentCount: s.segment_count,
      })),
      fullText: raw.full_text,
      language: raw.language,
      durationSeconds: raw.duration_seconds,
    };
  }

  /**
   * Convert camelCase result back to snake_case for Rust
   */
  private toRawResult(result: DiarizationResult): RawDiarizationResult {
    return {
      segments: result.segments.map((s) => ({
        text: s.text,
        speaker_id: s.speakerId,
        speaker_name: s.speakerName,
        start_time: s.startTime,
        end_time: s.endTime,
        confidence: s.confidence,
        language: s.language,
      })),
      speakers: result.speakers.map((s) => ({
        speaker_id: s.speakerId,
        display_name: s.displayName,
        total_speaking_time: s.totalSpeakingTime,
        segment_count: s.segmentCount,
      })),
      full_text: result.fullText,
      language: result.language,
      duration_seconds: result.durationSeconds,
    };
  }
}

// Export singleton instance
export const diarizationService = new DiarizationService();
export default diarizationService;
