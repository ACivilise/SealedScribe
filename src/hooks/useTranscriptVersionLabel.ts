import { useCallback } from 'react';
import { useT } from '../i18n';
import { formatDuration } from '../utils/format';
import type { TranscriptionVersion } from '../store/meetingStore';

/** Libellé d'une version de transcription : « V2 · 10/11/2026 14:32 · 02:10 → 05:40 ». */
export function useTranscriptVersionLabel() {
  const { t, formatDate } = useT();
  return useCallback(
    (version: TranscriptionVersion) =>
      t('detail.versionLabel', {
        number: version.number,
        date: formatDate(new Date(version.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
        range: version.range
          ? t('detail.versionRange', {
              start: formatDuration(version.range.start),
              end: formatDuration(version.range.end),
            })
          : t('detail.versionFull'),
      }),
    [t, formatDate]
  );
}
