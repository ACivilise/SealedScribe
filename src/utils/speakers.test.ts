import { describe, expect, it } from 'vitest';
import { useLocaleStore } from '../i18n';
import type { TranscriptionSegment } from '../store/meetingStore';
import {
  REMOTE_SPEAKER_BASE,
  SPEAKER_ME,
  SPEAKER_OTHERS,
  hasSpeakerAttribution,
  remotesNotSeparated,
  sameNameMerges,
  speakerLabels,
  speakerName,
  transcriptForSummary,
} from './speakers';

const segment = (speaker: number, text: string): TranscriptionSegment => ({
  text,
  speaker,
  startTime: 0,
  endTime: 1,
  confidence: 1,
  language: 'fr-FR',
});

describe('speakerName', () => {
  it('nomme le micro et le son du PC', () => {
    expect(speakerName(SPEAKER_ME)).toBe('Me');
    expect(speakerName(SPEAKER_OTHERS)).toBe('Others');
    useLocaleStore.setState({ preference: 'fr', locale: 'fr' });
    expect(speakerName(SPEAKER_ME)).toBe('Moi');
    expect(speakerName(SPEAKER_OTHERS)).toBe('Autres');
  });

  it('numérote les participants distants séparés par leur voix', () => {
    expect(speakerName(REMOTE_SPEAKER_BASE + 1)).toBe('Speaker 1');
    expect(speakerName(REMOTE_SPEAKER_BASE + 3)).toBe('Speaker 3');
  });

  it('garde « Intervenant N » pour les autres numéros', () => {
    expect(speakerName(0)).toBe('Speaker 0');
    expect(speakerName(3)).toBe('Speaker 3');
  });

  it('préfère le nom saisi pour la réunion', () => {
    expect(speakerName(SPEAKER_OTHERS, [{ label: SPEAKER_OTHERS, name: 'Client' }])).toBe('Client');
  });
});

describe('transcriptForSummary', () => {
  it('préfixe chaque ligne de son intervenant quand la transcription est attribuée', () => {
    const text = transcriptForSummary([segment(SPEAKER_ME, 'Bonjour.'), segment(SPEAKER_OTHERS, 'Salut.')]);
    expect(text).toBe('Me: Bonjour.\nOthers: Salut.');
  });

  it('laisse le texte brut sans attribution', () => {
    expect(transcriptForSummary([segment(0, 'Bonjour.'), segment(0, 'Salut.')])).toBe('Bonjour.\nSalut.');
  });
});

describe('speakerLabels', () => {
  it('liste chaque intervenant une fois, par numéro', () => {
    const segments = [segment(12, 'a'), segment(SPEAKER_ME, 'b'), segment(11, 'c'), segment(12, 'd')];
    expect(speakerLabels(segments)).toEqual([SPEAKER_ME, 11, 12]);
    expect(hasSpeakerAttribution(segments)).toBe(true);
    expect(hasSpeakerAttribution([segment(0, 'x')])).toBe(false);
  });
});

describe('sameNameMerges', () => {
  it('rattache les intervenants de même nom au plus petit numéro, casse, accents et espaces ignorés', () => {
    const speakers = [
      { label: 15, name: 'GIRAUD, Gilles' },
      { label: 13, name: 'Giraud, Gilles' },
      { label: 17, name: ' giraud,  gillés ' },
      { label: 14, name: 'MARTIN, Anne' },
    ];
    const merges = sameNameMerges([SPEAKER_ME, 11, 13, 14, 15, 17], speakers);
    expect([...merges.entries()].sort()).toEqual([
      [15, 13],
      [17, 13],
    ]);
  });

  it('rattache aussi un intervenant nommé comme un autre l’est par défaut', () => {
    useLocaleStore.setState({ preference: 'en', locale: 'en' });
    expect([...sameNameMerges([11, 12], [{ label: 12, name: 'Speaker 1' }])]).toEqual([[12, 11]]);
  });

  it('ne fusionne rien quand les noms diffèrent', () => {
    expect(sameNameMerges([11, 12, 13], [{ label: 12, name: 'Anne' }]).size).toBe(0);
  });
});

describe('remotesNotSeparated', () => {
  it('signale des participants distants tous restés sous « Autres »', () => {
    expect(remotesNotSeparated([segment(SPEAKER_ME, 'a'), segment(SPEAKER_OTHERS, 'b')])).toBe(true);
  });

  it('ne signale rien une fois les voix séparées, même s’il reste un segment « Autres »', () => {
    const segments = [segment(SPEAKER_ME, 'a'), segment(11, 'b'), segment(SPEAKER_OTHERS, 'c')];
    expect(remotesNotSeparated(segments)).toBe(false);
  });

  it('ne signale rien sans son du PC ni attribution', () => {
    expect(remotesNotSeparated([segment(SPEAKER_ME, 'a')])).toBe(false);
    expect(remotesNotSeparated([segment(0, 'a')])).toBe(false);
  });
});
