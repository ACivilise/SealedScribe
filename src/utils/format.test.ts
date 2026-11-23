import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration', () => {
  it('utilise mm:ss sous une heure', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(309)).toBe('05:09');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('utilise h:mm:ss à partir d’une heure', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('tronque les fractions et ramène les valeurs négatives à zéro', () => {
    expect(formatDuration(65.9)).toBe('01:05');
    expect(formatDuration(-12)).toBe('00:00');
  });
});
