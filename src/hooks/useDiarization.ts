import { useState, useCallback } from 'react';
import diarizationService, {
  DiarizationResult,
  DiarizedSegment,
  IdentifiedSpeaker,
  SpeakerMapping,
} from '../services/diarizationService';

export interface UseDiarizationOptions {
  /**
   * Callback when diarization starts
   */
  onStart?: () => void;
  /**
   * Callback when diarization completes successfully
   */
  onSuccess?: (result: DiarizationResult) => void;
  /**
   * Callback when diarization fails
   */
  onError?: (error: Error) => void;
}

export interface UseDiarizationReturn {
  /**
   * Whether diarization is in progress
   */
  isProcessing: boolean;
  /**
   * The diarization result (null if not yet processed)
   */
  result: DiarizationResult | null;
  /**
   * The diarized segments with speaker information
   */
  segments: DiarizedSegment[];
  /**
   * List of identified speakers
   */
  speakers: IdentifiedSpeaker[];
  /**
   * The full transcription text
   */
  fullText: string;
  /**
   * Error message if diarization failed
   */
  error: string | null;
  /**
   * Progress percentage (0-100, approximated)
   */
  progress: number;
  /**
   * Speaker name mappings applied by user
   */
  speakerMappings: SpeakerMapping[];
  /**
   * Start diarization of an audio file
   */
  transcribe: (audioPath: string, language: string) => Promise<DiarizationResult | null>;
  /**
   * Update a speaker's display name
   */
  updateSpeakerName: (speakerId: string, newName: string) => void;
  /**
   * Apply all speaker mappings to the result
   */
  applyMappings: () => Promise<void>;
  /**
   * Get color for a speaker (for UI visualization)
   */
  getSpeakerColor: (speakerId: string) => string;
  /**
   * Format result as markdown
   */
  formatAsMarkdown: (title: string) => Promise<string>;
  /**
   * Reset the diarization state
   */
  reset: () => void;
}

/**
 * React hook for transcribing audio with speaker diarization
 *
 * @example
 * ```tsx
 * const { transcribe, isProcessing, result, speakers, updateSpeakerName } = useDiarization({
 *   onSuccess: (result) => console.log('Speakers:', result.speakers),
 *   onError: (error) => console.error('Failed:', error),
 * });
 *
 * // Start transcription with diarization
 * await transcribe('/path/to/audio.wav', 'en-US');
 *
 * // Rename a speaker
 * updateSpeakerName('Speaker1', 'Alice');
 * ```
 */
export function useDiarization(
  options: UseDiarizationOptions = {}
): UseDiarizationReturn {
  const { onStart, onSuccess, onError } = options;

  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<DiarizationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [speakerMappings, setSpeakerMappings] = useState<SpeakerMapping[]>([]);

  const transcribe = useCallback(
    async (audioPath: string, language: string): Promise<DiarizationResult | null> => {
      setIsProcessing(true);
      setError(null);
      setProgress(0);
      setSpeakerMappings([]);
      onStart?.();

      try {
        // Start progress simulation
        const progressInterval = setInterval(() => {
          setProgress((prev) => Math.min(prev + 3, 90));
        }, 500);

        let diarizationResult: DiarizationResult;

        diarizationResult = await diarizationService.transcribeWithDiarization(
          audioPath,
          language
        );

        clearInterval(progressInterval);
        setProgress(100);
        setResult(diarizationResult);

        // Initialize speaker mappings with current names
        const initialMappings = diarizationResult.speakers.map((s) => ({
          speakerId: s.speakerId,
          assignedName: s.displayName,
        }));
        setSpeakerMappings(initialMappings);

        onSuccess?.(diarizationResult);
        return diarizationResult;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        onError?.(err instanceof Error ? err : new Error(errorMessage));
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [onStart, onSuccess, onError]
  );

  const updateSpeakerName = useCallback((speakerId: string, newName: string) => {
    setSpeakerMappings((prev) => {
      const existing = prev.findIndex((m) => m.speakerId === speakerId);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = { speakerId, assignedName: newName };
        return updated;
      }
      return [...prev, { speakerId, assignedName: newName }];
    });
  }, []);

  const applyMappings = useCallback(async () => {
    if (!result || speakerMappings.length === 0) return;

    try {
      const mapped = await diarizationService.applySpeakerMappings(result, speakerMappings);
      setResult(mapped);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    }
  }, [result, speakerMappings]);

  const getSpeakerColor = useCallback((speakerId: string) => {
    return diarizationService.getSpeakerColor(speakerId);
  }, []);

  const formatAsMarkdown = useCallback(
    async (title: string): Promise<string> => {
      if (!result) return '';
      return diarizationService.formatAsMarkdown(result, title);
    },
    [result]
  );

  const reset = useCallback(() => {
    setIsProcessing(false);
    setResult(null);
    setError(null);
    setProgress(0);
    setSpeakerMappings([]);
  }, []);

  return {
    isProcessing,
    result,
    segments: result?.segments ?? [],
    speakers: result?.speakers ?? [],
    fullText: result?.fullText ?? '',
    error,
    progress,
    speakerMappings,
    transcribe,
    updateSpeakerName,
    applyMappings,
    getSpeakerColor,
    formatAsMarkdown,
    reset,
  };
}

export default useDiarization;
