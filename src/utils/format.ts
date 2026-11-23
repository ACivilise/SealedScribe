/**
 * Formatage unique des durées dans toute l'UI.
 * - moins d'une heure : mm:ss (ex. 05:09)
 * - une heure ou plus : h:mm:ss (ex. 1:02:03)
 */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
