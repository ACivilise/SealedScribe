import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Users, Lightbulb } from 'lucide-react';
import { IdentifiedSpeaker, SpeakerMapping } from '../../services/diarizationService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export interface SpeakerMappingPanelProps {
  /**
   * List of identified speakers from diarization
   */
  speakers: IdentifiedSpeaker[];
  /**
   * Current speaker mappings
   */
  mappings: SpeakerMapping[];
  /**
   * Callback when a speaker name is updated
   */
  onUpdateSpeakerName: (speakerId: string, newName: string) => void;
  /**
   * Callback when mappings should be applied
   */
  onApplyMappings: () => void;
  /**
   * Get color for a speaker
   */
  getSpeakerColor: (speakerId: string) => string;
  /**
   * Whether the panel is in a loading state
   */
  isLoading?: boolean;
}

/**
 * Panel for mapping speaker IDs to real names
 */
export const SpeakerMappingPanel: React.FC<SpeakerMappingPanelProps> = ({
  speakers,
  mappings,
  onUpdateSpeakerName,
  onApplyMappings,
  getSpeakerColor,
  isLoading = false,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const getCurrentName = (speakerId: string): string => {
    const mapping = mappings.find((m) => m.speakerId === speakerId);
    return mapping?.assignedName ?? speakerId;
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const handleStartEdit = (speaker: IdentifiedSpeaker) => {
    setEditingId(speaker.speakerId);
    setEditValue(getCurrentName(speaker.speakerId));
  };

  const handleSaveEdit = () => {
    if (editingId && editValue.trim()) {
      onUpdateSpeakerName(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      setEditingId(null);
      setEditValue('');
    }
  };

  if (speakers.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        No speakers identified yet. Transcribe audio with diarization to see speakers.
      </div>
    );
  }

  const maxSpeakingTime = Math.max(...speakers.map((s) => s.totalSpeakingTime));

  return (
    <Card className="p-4 shadow-md">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-5 w-5" aria-hidden="true" />
          Speakers ({speakers.length})
        </h3>
        <Button size="sm" onClick={onApplyMappings} disabled={isLoading}>
          Apply names
        </Button>
      </div>

      <ul className="space-y-3">
        {speakers.map((speaker, index) => (
          <motion.li
            key={speaker.speakerId}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(index * 0.1, 0.5) }}
            className="flex items-center gap-3 rounded-lg bg-muted/50 p-3"
          >
            <div
              className="h-4 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: getSpeakerColor(speaker.speakerId) }}
              aria-hidden="true"
            />

            <div className="min-w-0 flex-1">
              {editingId === speaker.speakerId ? (
                <Input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleSaveEdit}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  aria-label="Speaker name"
                  placeholder="Enter speaker name"
                  className="h-8 text-sm"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => handleStartEdit(speaker)}
                  className="group w-full text-left focus-visible:outline-hidden"
                >
                  <span className="font-medium group-hover:text-primary group-focus-visible:text-primary">
                    {getCurrentName(speaker.speakerId)}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    (click to edit)
                  </span>
                </button>
              )}
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span>{speaker.segmentCount} segments</span>
                <span aria-hidden="true">•</span>
                <span>{formatDuration(speaker.totalSpeakingTime)} speaking</span>
              </div>
            </div>

            <div
              className="h-2 w-20 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`Speaking share of ${getCurrentName(speaker.speakerId)}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(maxSpeakingTime > 0 ? (speaker.totalSpeakingTime / maxSpeakingTime) * 100 : 0)}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  backgroundColor: getSpeakerColor(speaker.speakerId),
                  width: `${Math.min(100, maxSpeakingTime > 0 ? (speaker.totalSpeakingTime / maxSpeakingTime) * 100 : 0)}%`,
                }}
              />
            </div>
          </motion.li>
        ))}
      </ul>

      <p className="mt-4 flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
        <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Click a speaker name to rename it. Changes appear in the transcript and exports.</span>
      </p>
    </Card>
  );
};

export default SpeakerMappingPanel;
