import { useMemo, useState } from 'react';
import { BookA, Plus, Trash2 } from 'lucide-react';
import { useLexiconStore } from '../../store/lexiconStore';
import { activeTerms, whisperTerms, type Lexicon } from '../../lib/lexicon';
import { useT } from '../../i18n';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const termCount = (lexicon: Lexicon) => lexicon.entries.filter((e) => e.term.trim()).length;

/**
 * Onglet Lexiques : orthographe des noms propres et du jargon mal reconnus.
 * Les lexiques cochés servent à chaque transcription et à chaque résumé (enregistrement automatique).
 */
export default function LexiconsTab() {
  const { t } = useT();
  const lexicons = useLexiconStore((s) => s.lexicons);
  const { addLexicon, updateLexicon, removeLexicon, addEntry, updateEntry, removeEntry } =
    useLexiconStore.getState();

  const [selectedId, setSelectedId] = useState<string | null>(lexicons[0]?.id ?? null);
  const [pendingDelete, setPendingDelete] = useState<Lexicon | null>(null);
  // Champ à placer sous le curseur après une création (nom du lexique ou nouvelle ligne).
  const [focusId, setFocusId] = useState<string | null>(null);

  // Sélection toujours valide (après suppression par exemple).
  const selected = lexicons.find((l) => l.id === selectedId) ?? lexicons[0] ?? null;

  // Le moteur local ne reçoit qu'un indice de longueur limitée.
  const terms = useMemo(() => activeTerms(lexicons), [lexicons]);
  const sentToWhisper = whisperTerms(terms).length;

  const handleAdd = () => {
    const id = addLexicon(t('lexicons.newName'));
    setSelectedId(id);
    setFocusId(id);
  };

  const handleAddEntry = (lexiconId: string) => setFocusId(addEntry(lexiconId));

  const handleDelete = () => {
    if (!pendingDelete) return;
    const index = lexicons.findIndex((l) => l.id === pendingDelete.id);
    removeLexicon(pendingDelete.id);
    const next = lexicons.filter((l) => l.id !== pendingDelete.id);
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
    setPendingDelete(null);
  };

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Liste */}
      <Card className="flex flex-col gap-3 p-4 shadow-soft">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('lexicons.listTitle')}</h2>
          <Button size="sm" variant="outline" onClick={handleAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('lexicons.new')}
          </Button>
        </div>
        <ul className="space-y-1" aria-label={t('lexicons.listTitle')}>
          {lexicons.map((lexicon) => {
            const name = lexicon.name || t('lexicons.untitled');
            return (
              <li
                key={lexicon.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg pl-3 transition-colors hover:bg-accent',
                  lexicon.id === selected?.id && 'bg-accent'
                )}
              >
                <Checkbox
                  checked={lexicon.enabled}
                  onCheckedChange={(v) => updateLexicon(lexicon.id, { enabled: v === true })}
                  aria-label={t('lexicons.enable', { name })}
                />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(lexicon.id);
                    setFocusId(null);
                  }}
                  aria-current={lexicon.id === selected?.id ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 rounded-lg py-2 pr-3 text-left text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    lexicon.id === selected?.id && 'font-medium',
                    !lexicon.enabled && 'text-muted-foreground'
                  )}
                >
                  <span className="block truncate" title={name}>
                    {name}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t('lexicons.termCount', { count: termCount(lexicon) })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Édition */}
      {selected ? (
        <Card key={selected.id} className="space-y-5 p-6 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('lexicons.editTitle')}</h2>
            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(selected)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t('lexicons.delete')}
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="lexicon-name">{t('lexicons.name')}</Label>
              <Input
                id="lexicon-name"
                value={selected.name}
                autoFocus={focusId === selected.id}
                onFocus={(e) => focusId === selected.id && e.currentTarget.select()}
                onChange={(e) => updateLexicon(selected.id, { name: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 sm:pb-3">
              <Checkbox
                id="lexicon-enabled"
                checked={selected.enabled}
                onCheckedChange={(v) => updateLexicon(selected.id, { enabled: v === true })}
              />
              <Label htmlFor="lexicon-enabled" className="font-normal">
                {t('lexicons.enabled')}
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            {selected.entries.length > 0 && (
              <div
                className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_2.25rem] gap-2 sm:grid"
                aria-hidden="true"
              >
                <span className="text-sm font-medium">{t('lexicons.term')}</span>
                <span className="text-sm font-medium">{t('lexicons.variants')}</span>
              </div>
            )}
            <ul className="space-y-2" aria-label={t('lexicons.editTitle')}>
              {selected.entries.map((entry, index) => {
                const isLast = index === selected.entries.length - 1;
                const term = entry.term.trim();
                return (
                  <li
                    key={entry.id}
                    className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_2.25rem]"
                  >
                    <Input
                      value={entry.term}
                      placeholder={t('lexicons.termPlaceholder')}
                      aria-label={t('lexicons.term')}
                      autoFocus={focusId === entry.id}
                      spellCheck={false}
                      onChange={(e) => updateEntry(selected.id, entry.id, { term: e.target.value })}
                    />
                    <Input
                      value={entry.variants}
                      placeholder={t('lexicons.variantsPlaceholder')}
                      aria-label={term ? t('lexicons.variantsOf', { term }) : t('lexicons.variants')}
                      spellCheck={false}
                      className="order-last col-span-2 sm:order-none sm:col-span-1"
                      onChange={(e) => updateEntry(selected.id, entry.id, { variants: e.target.value })}
                      // Saisie au clavier : Entrée sur la dernière ligne en ajoute une.
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isLast) {
                          e.preventDefault();
                          handleAddEntry(selected.id);
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEntry(selected.id, entry.id)}
                      aria-label={term ? t('lexicons.removeTerm', { term }) : t('lexicons.removeRow')}
                      title={term ? t('lexicons.removeTerm', { term }) : t('lexicons.removeRow')}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Button size="sm" variant="outline" onClick={() => handleAddEntry(selected.id)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('lexicons.addTerm')}
            </Button>
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{t('lexicons.variantsHelp')}</p>
            <p>{t('lexicons.usageHelp')}</p>
            {sentToWhisper < terms.length && (
              <p className="text-warning">
                {t('lexicons.whisperLimit', { sent: sentToWhisper, total: terms.length })}
              </p>
            )}
            <p>{t('lexicons.autosave')}</p>
          </div>
        </Card>
      ) : (
        <Card className="p-12 text-center shadow-soft">
          <div className="mb-4 inline-flex rounded-full bg-muted p-4 text-muted-foreground">
            <BookA className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="mb-2 text-lg font-semibold">{t('lexicons.emptyTitle')}</h2>
          <p className="text-muted-foreground">{t('lexicons.emptyText')}</p>
        </Card>
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('lexicons.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('lexicons.deleteDescription', { name: pendingDelete?.name || t('lexicons.untitled') })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={handleDelete}>
              {t('lexicons.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
