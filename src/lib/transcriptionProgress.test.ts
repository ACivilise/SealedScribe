import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import {
  describeTranscriptionProgress,
  isLoadingModel,
  modelLoadPercent,
  type TranscriptionProgressState,
} from './transcriptionProgress';

const base: TranscriptionProgressState = {
  phase: null,
  currentChunk: null,
  totalChunks: null,
  processedSeconds: null,
  totalSeconds: null,
};

describe('isLoadingModel', () => {
  it('ne vaut vrai que pendant le chargement du modèle', () => {
    expect(isLoadingModel({ phase: 'loading-model' })).toBe(true);
    expect(isLoadingModel({ phase: 'transcribing' })).toBe(false);
    expect(isLoadingModel({ phase: null })).toBe(false);
  });
});

describe('modelLoadPercent', () => {
  it('calcule le pourcentage à partir de la durée attendue', () => {
    expect(modelLoadPercent({ phase: 'loading-model', modelLoadSeconds: 10, modelLoadExpectedSeconds: 40 })).toBe(25);
  });

  it('plafonne à 95 % même si le chargement dépasse la durée attendue', () => {
    expect(modelLoadPercent({ phase: 'loading-model', modelLoadSeconds: 100, modelLoadExpectedSeconds: 40 })).toBe(95);
  });

  it('renvoie null sans durée attendue exploitable (barre indéterminée)', () => {
    expect(modelLoadPercent({ phase: 'loading-model', modelLoadSeconds: 10, modelLoadExpectedSeconds: null })).toBeNull();
    expect(modelLoadPercent({ phase: 'loading-model', modelLoadSeconds: 10, modelLoadExpectedSeconds: 0 })).toBeNull();
    expect(modelLoadPercent({ phase: 'loading-model', modelLoadSeconds: null, modelLoadExpectedSeconds: 40 })).toBeNull();
  });

  it('renvoie null hors de la phase de chargement', () => {
    expect(modelLoadPercent({ phase: 'transcribing', modelLoadSeconds: 10, modelLoadExpectedSeconds: 40 })).toBeNull();
  });
});

describe('describeTranscriptionProgress', () => {
  const describe_ = (state: Partial<TranscriptionProgressState>) =>
    describeTranscriptionProgress(translate, { ...base, ...state });

  it('traduit les phases simples', () => {
    expect(describe_({ phase: 'queued' })).toBe('Waiting for the current transcription…');
    expect(describe_({ phase: 'completed' })).toBe('Transcription finished');
  });

  it('affiche l’avancement de la séparation des intervenants', () => {
    expect(describe_({ phase: 'diarizing', progress: 42.4 })).toBe('Separating speakers… 42%');
  });

  it('affiche la mise à jour automatique de la séparation des intervenants', () => {
    expect(describe_({ phase: 'updating-diarization', progress: 7 })).toBe('Updating speaker separation… 7%');
  });

  it('affiche les minutes traitées quand les durées sont connues', () => {
    expect(describe_({ phase: 'transcribing', processedSeconds: 150, totalSeconds: 601 })).toBe(
      '2 of 11 min transcribed'
    );
  });

  it('affiche au moins 1 minute au total pour un enregistrement très court', () => {
    expect(describe_({ phase: 'transcribing', processedSeconds: 0, totalSeconds: 20 })).toBe(
      '0 of 1 min transcribed'
    );
  });

  it('se rabat sur le numéro de partie sans durées', () => {
    expect(describe_({ phase: 'transcribing', currentChunk: 2, totalChunks: 5 })).toBe('Part 2 of 5');
  });

  it('renvoie null quand il n’y a rien à afficher', () => {
    expect(describe_({ phase: 'transcribing' })).toBeNull();
    expect(describe_({ phase: 'inconnue' })).toBeNull();
    expect(describe_({ phase: null })).toBeNull();
  });
});
