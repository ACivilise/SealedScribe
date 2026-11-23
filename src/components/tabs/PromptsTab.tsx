import { useEffect, useState } from 'react';
import { Copy, FileText, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { isPromptModified, usePromptStore, type SummaryPrompt } from '../../store/promptStore';
import { BUILTIN_PROMPT_IDS } from '../../lib/defaultPrompts';
import { PROMPT_VARIABLES } from '../../lib/renderPrompt';
import { useT } from '../../i18n';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface PromptsTabProps {
  /** Prompt à afficher à l'ouverture (lien « Modifier les prompts » de la fiche d'une réunion). */
  focusPromptId?: string | null;
}

/** Onglet Prompts : liste des types de résumé et édition (enregistrement automatique). */
export default function PromptsTab({ focusPromptId }: PromptsTabProps) {
  const { t, locale } = useT();
  const prompts = usePromptStore((s) => s.prompts);
  const { addPrompt, duplicatePrompt, updatePrompt, removePrompt, restorePrompt, restoreMissingDefaults } =
    usePromptStore.getState();

  const [selectedId, setSelectedId] = useState<string | null>(focusPromptId ?? prompts[0]?.id ?? null);
  const [pendingDelete, setPendingDelete] = useState<SummaryPrompt | null>(null);

  useEffect(() => {
    if (focusPromptId) setSelectedId(focusPromptId);
  }, [focusPromptId]);

  // Sélection toujours valide (après suppression par exemple).
  const selected = prompts.find((p) => p.id === selectedId) ?? prompts[0] ?? null;
  const missingDefaults = BUILTIN_PROMPT_IDS.some((id) => !prompts.some((p) => p.builtinId === id));

  const handleAdd = () =>
    setSelectedId(
      addPrompt({ name: t('prompts.newName'), description: '', template: t('prompts.newTemplate') })
    );

  const handleDelete = () => {
    if (!pendingDelete) return;
    const index = prompts.findIndex((p) => p.id === pendingDelete.id);
    removePrompt(pendingDelete.id);
    const next = prompts.filter((p) => p.id !== pendingDelete.id);
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
    setPendingDelete(null);
  };

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_minmax(0,1fr)]">
      {/* Liste */}
      <Card className="flex flex-col gap-3 p-4 shadow-soft">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('prompts.listTitle')}</h2>
          <Button size="sm" variant="outline" onClick={handleAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('prompts.new')}
          </Button>
        </div>
        <ul className="space-y-1" aria-label={t('prompts.listTitle')}>
          {prompts.map((prompt) => (
            <li key={prompt.id}>
              <button
                type="button"
                onClick={() => setSelectedId(prompt.id)}
                aria-current={prompt.id === selected?.id ? 'true' : undefined}
                className={cn(
                  'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  prompt.id === selected?.id && 'bg-accent font-medium'
                )}
              >
                <span className="block truncate" title={prompt.name}>
                  {prompt.name || t('prompts.untitled')}
                </span>
                {prompt.description && (
                  <span className="block truncate text-xs text-muted-foreground" title={prompt.description}>
                    {prompt.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {missingDefaults && (
          <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={restoreMissingDefaults}>
            {t('prompts.restoreMissing')}
          </Button>
        )}
      </Card>

      {/* Édition */}
      {selected ? (
        <Card className="space-y-4 p-6 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{t('prompts.editTitle')}</h2>
              {selected.builtinId && (
                <Badge variant="secondary">
                  {isPromptModified(selected, locale) ? t('prompts.builtinModified') : t('prompts.builtin')}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {selected.builtinId && isPromptModified(selected, locale) && (
                <Button size="sm" variant="outline" onClick={() => restorePrompt(selected.id)}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  {t('prompts.restore')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelectedId(duplicatePrompt(selected.id, t('prompts.copySuffix')))}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                {t('prompts.duplicate')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingDelete(selected)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('prompts.delete')}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="prompt-name">{t('prompts.name')}</Label>
              <Input
                id="prompt-name"
                value={selected.name}
                onChange={(e) => updatePrompt(selected.id, { name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-description">{t('prompts.description')}</Label>
              <Input
                id="prompt-description"
                value={selected.description}
                onChange={(e) => updatePrompt(selected.id, { description: e.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-template">{t('prompts.template')}</Label>
            <Textarea
              id="prompt-template"
              value={selected.template}
              onChange={(e) => updatePrompt(selected.id, { template: e.target.value })}
              rows={18}
              spellCheck={false}
              className="font-mono text-xs leading-relaxed"
              aria-describedby="prompt-template-help"
            />
            <div id="prompt-template-help" className="space-y-1 text-xs text-muted-foreground">
              <p>
                {t('prompts.variables')}{' '}
                {PROMPT_VARIABLES.map((v) => (
                  <code key={v} className="mr-2 rounded bg-muted px-1 py-0.5 font-mono">{`{{${v}}}`}</code>
                ))}
              </p>
              <p>{t('prompts.variablesHelp')}</p>
              <p>{t('prompts.autosave')}</p>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-12 text-center shadow-soft">
          <div className="mb-4 inline-flex rounded-full bg-muted p-4 text-muted-foreground">
            <FileText className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="mb-2 text-lg font-semibold">{t('prompts.emptyTitle')}</h2>
          <p className="text-muted-foreground">{t('prompts.emptyText')}</p>
        </Card>
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('prompts.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('prompts.deleteDescription', { name: pendingDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={handleDelete}>
              {t('prompts.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
