import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { diarizationService, type DiarizationResult } from './diarizationService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const result: DiarizationResult = {
  segments: [
    { text: 'Bonjour', speakerId: 'Speaker1', speakerName: 'Speaker1', startTime: 0, endTime: 2, confidence: 1, language: 'fr' },
    { text: 'Salut', speakerId: 'Speaker2', speakerName: 'Bob', startTime: 62, endTime: 70, confidence: 1, language: 'fr' },
  ],
  speakers: [
    { speakerId: 'Speaker1', displayName: 'Speaker1', totalSpeakingTime: 2, segmentCount: 1 },
    { speakerId: 'Speaker2', displayName: 'Bob', totalSpeakingTime: 8, segmentCount: 1 },
  ],
  fullText: 'Bonjour Salut',
  language: 'fr',
  durationSeconds: 70,
};

const raw = {
  segments: [
    { text: 'Bonjour', speaker_id: 'Speaker1', speaker_name: 'Speaker1', start_time: 0, end_time: 2, confidence: 1, language: 'fr' },
    { text: 'Salut', speaker_id: 'Speaker2', speaker_name: 'Bob', start_time: 62, end_time: 70, confidence: 1, language: 'fr' },
  ],
  speakers: [
    { speaker_id: 'Speaker1', display_name: 'Speaker1', total_speaking_time: 2, segment_count: 1 },
    { speaker_id: 'Speaker2', display_name: 'Bob', total_speaking_time: 8, segment_count: 1 },
  ],
  full_text: 'Bonjour Salut',
  language: 'fr',
  duration_seconds: 70,
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('diarizationService', () => {
  it('fait l’aller-retour camelCase ↔ snake_case avec le backend', async () => {
    vi.mocked(invoke).mockResolvedValue(raw);
    const mapped = await diarizationService.applySpeakerMappings(result, [{ speakerId: 'Speaker2', assignedName: 'Bob' }]);
    expect(invoke).toHaveBeenCalledWith('apply_speaker_mappings', {
      result: raw,
      mappings: [{ speaker_id: 'Speaker2', assigned_name: 'Bob' }],
    });
    expect(mapped).toEqual(result);
  });

  it('formate le texte avec locuteur et horodatage', () => {
    expect(diarizationService.formatAsText(result)).toBe('**Speaker1** [00:00]\nBonjour\n\n**Bob** [01:02]\nSalut');
  });

  it('trie les locuteurs par temps de parole décroissant sans modifier l’original', () => {
    expect(diarizationService.getSpeakersByTime(result).map((s) => s.speakerId)).toEqual(['Speaker2', 'Speaker1']);
    expect(result.speakers[0].speakerId).toBe('Speaker1');
  });

  it('attribue une couleur stable par numéro de locuteur, en bouclant sur la palette', () => {
    expect(diarizationService.getSpeakerColor('Speaker1')).toBe('#3B82F6');
    expect(diarizationService.getSpeakerColor('Speaker2')).toBe('#10B981');
    expect(diarizationService.getSpeakerColor('Speaker11')).toBe('#3B82F6');
    expect(diarizationService.getSpeakerColor('Inconnu')).toBe('#3B82F6');
  });
});
