import { useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useT } from '../../i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface TagEditorProps {
  tags: string[];
  /** Étiquettes existantes proposées pendant la saisie. */
  suggestions: string[];
  /** Texte saisi (plusieurs étiquettes possibles, séparées par des virgules). */
  onAdd: (input: string) => void;
  onRemove: (tag: string) => void;
}

/**
 * Étiquettes modifiables : une croix par étiquette, « Ajouter une étiquette » ouvre un champ.
 * Entrée ajoute (le champ reste ouvert pour la suivante), quitter le champ ajoute aussi ce qui est saisi,
 * Échap annule. Dans une modale, Échap doit être ignoré par la modale : repérer `data-tag-input`.
 */
export function TagEditor({ tags, suggestions, onAdd, onRemove }: TagEditorProps) {
  const { t } = useT();
  const inputId = useId();
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  // Échap : le champ disparaît, sa perte de focus ne doit pas ajouter le texte abandonné.
  const cancelled = useRef(false);

  const commit = () => {
    if (draft.trim()) onAdd(draft);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} variant="outline" className="gap-1 pr-1">
          {tag}
          <button
            type="button"
            onClick={() => onRemove(tag)}
            aria-label={t('detail.removeTag', { tag })}
            title={t('detail.removeTag', { tag })}
            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </Badge>
      ))}

      {adding ? (
        <>
          <Label htmlFor={inputId} className="sr-only">
            {t('detail.newTag')}
          </Label>
          <Input
            id={inputId}
            data-tag-input
            list={listId}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                cancelled.current = true;
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (!cancelled.current) commit();
              cancelled.current = false;
              setAdding(false);
            }}
            placeholder={t('detail.newTagPlaceholder')}
            className="h-7 w-48 rounded-full px-3 text-xs"
          />
          <datalist id={listId}>
            {suggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </>
      ) : (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('detail.addTag')}
        </Button>
      )}
    </div>
  );
}
