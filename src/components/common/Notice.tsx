import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Mention discrète (responsabilité, contenu généré par l'IA, données envoyées) : une ligne d'aide
 * précédée d'une icône, sans la place d'une alerte.
 */
export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
