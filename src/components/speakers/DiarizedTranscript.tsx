import React, { useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import { MessageSquare } from 'lucide-react';
import { DiarizedSegment } from '../../services/diarizationService';
import { Badge } from '@/components/ui/badge';

export interface DiarizedTranscriptProps {
  /**
   * Diarized segments to display
   */
  segments: DiarizedSegment[];
  /**
   * Get color for a speaker
   */
  getSpeakerColor: (speakerId: string) => string;
  /**
   * Current playback time in seconds (for highlighting)
   */
  currentTime?: number;
  /**
   * Callback when a segment is clicked
   */
  onSegmentClick?: (segment: DiarizedSegment) => void;
  /**
   * Maximum height for the transcript container
   */
  maxHeight?: string;
  /**
   * Whether to auto-scroll to follow playback
   */
  autoScroll?: boolean;
}

/**
 * Display diarized transcript with speaker colors and timestamps
 */
export const DiarizedTranscript: React.FC<DiarizedTranscriptProps> = ({
  segments,
  getSpeakerColor,
  currentTime,
  onSegmentClick,
  maxHeight = '400px',
  autoScroll = true,
}) => {
  const containerRef = useRef<HTMLOListElement>(null);
  const activeSegmentRef = useRef<HTMLLIElement>(null);

  const formatTimestamp = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const isActiveSegment = (segment: DiarizedSegment): boolean => {
    if (currentTime === undefined) return false;
    return currentTime >= segment.startTime && currentTime < segment.endTime;
  };

  // Auto-scroll to active segment
  useEffect(() => {
    if (autoScroll && activeSegmentRef.current && containerRef.current) {
      const container = containerRef.current;
      const activeElement = activeSegmentRef.current;

      const containerRect = container.getBoundingClientRect();
      const elementRect = activeElement.getBoundingClientRect();

      if (elementRect.top < containerRect.top || elementRect.bottom > containerRect.bottom) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [currentTime, autoScroll]);

  if (segments.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        <MessageSquare className="mx-auto mb-3 h-12 w-12 opacity-50" aria-hidden="true" />
        <p>No transcript available</p>
        <p className="mt-1 text-sm">Record and transcribe audio to see the transcript here</p>
      </div>
    );
  }

  return (
    <ol ref={containerRef} className="space-y-3 overflow-y-auto pr-2" style={{ maxHeight }}>
      {segments.map((segment, index) => {
        const isActive = isActiveSegment(segment);
        const speakerColor = getSpeakerColor(segment.speakerId);
        const interactive = Boolean(onSegmentClick);

        return (
          <motion.li
            key={`${segment.speakerId}-${segment.startTime}-${index}`}
            ref={isActive ? activeSegmentRef : undefined}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index * 0.02, 0.5) }}
            onClick={() => onSegmentClick?.(segment)}
            className={`relative rounded-lg p-3 transition-all duration-200 ${interactive ? 'cursor-pointer hover:shadow-md' : ''} ${
              isActive ? 'bg-primary/10 ring-2 ring-primary' : 'bg-muted/50 hover:bg-muted'
            }`}
          >
            {/* Speaker color indicator */}
            <div className="absolute bottom-0 left-0 top-0 w-1 rounded-l-lg" style={{ backgroundColor: speakerColor }} aria-hidden="true" />

            <div className="mb-1.5 flex items-center justify-between pl-2">
              <span className="text-sm font-medium" style={{ color: speakerColor }}>
                {segment.speakerName}
              </span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <time className="font-mono">{formatTimestamp(segment.startTime)}</time>
                {segment.confidence < 0.8 && (
                  <Badge variant="warning" title={`Confidence: ${Math.round(segment.confidence * 100)}%`}>
                    Low confidence
                  </Badge>
                )}
              </div>
            </div>

            <p className="pl-2 leading-relaxed">{segment.text}</p>
          </motion.li>
        );
      })}
    </ol>
  );
};

export default DiarizedTranscript;
