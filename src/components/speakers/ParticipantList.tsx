import { useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useT } from '../../i18n';
import type { Speaker } from '../../store/meetingStore';
import { speakerName } from '../../utils/speakers';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface ParticipantListProps {
  /** Intervenants présents dans la transcription affichée. */
  labels: number[];
  /** Noms saisis pour la réunion. */
  speakers: Speaker[];
  colorOf: (label: number) => string;
  /** Nom vide : retour au nom par défaut (« Moi », « Intervenant 2 »…). */
  onRename: (label: number, name: string) => void;
}

/**
 * Intervenants de la transcription ; un clic ouvre un champ pour les nommer.
 * Entrée ou perte de focus enregistre, Échap annule. Dans une modale, Échap doit être
 * ignoré par la modale : repérer `data-speaker-input`.
 */
export function ParticipantList({ labels, speakers, colorOf, onRename }: ParticipantListProps) {
  const { t } = useT();
  const inputId = useId();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // Échap : le champ disparaît, sa perte de focus ne doit pas enregistrer le texte abandonné.
  const cancelled = useRef(false);

  const startEditing = (label: number) => {
    setEditing(label);
    setDraft(speakers.find((s) => s.label === label)?.name ?? '');
  };

  return (
    <ul className="flex flex-wrap gap-2">
      {labels.map((label) => {
        const name = speakerName(label, speakers);
        return (
          <li key={label}>
            {editing === label ? (
              <>
                <Label htmlFor={inputId} className="sr-only">
                  {t('detail.renameParticipant', { name })}
                </Label>
                <Input
                  id={inputId}
                  data-speaker-input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      cancelled.current = true;
                      setEditing(null);
                    }
                  }}
                  onBlur={() => {
                    if (!cancelled.current) onRename(label, draft.trim());
                    cancelled.current = false;
                    setEditing(null);
                  }}
                  placeholder={speakerName(label)}
                  className="h-8 w-48 rounded-full px-3 text-sm"
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => startEditing(label)}
                aria-label={t('detail.renameParticipant', { name })}
                title={t('detail.renameParticipant', { name })}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  colorOf(label)
                )}
              >
                {name}
                <Pencil className="h-3 w-3 opacity-60" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
