import { useEffect } from 'react';
import { Sparkles, TrendingUp, Wrench, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChangelogCategory, InlineSegment, Release } from '../../lib/changelog';
import { RELEASES } from '../../lib/releaseNotes';
import { useWhatsNewStore } from '../../store/whatsNewStore';
import { useT, type MessageKey } from '../../i18n';

// Une entrée par catégorie du changelog : ajouter une catégorie sans style fait échouer tsc.
const CATEGORY_STYLES: Record<ChangelogCategory, { icon: LucideIcon; color: string; label: MessageKey }> = {
  Nouveautés: { icon: Sparkles, color: 'text-primary', label: 'whatsNew.category.features' },
  Améliorations: { icon: TrendingUp, color: 'text-success', label: 'whatsNew.category.improvements' },
  Corrections: { icon: Wrench, color: 'text-muted-foreground', label: 'whatsNew.category.fixes' },
};

function Inline({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'strong') return <strong key={index} className="font-semibold">{segment.text}</strong>;
        if (segment.kind === 'code') {
          return (
            <code key={index} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
              {segment.text}
            </code>
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </>
  );
}

interface WhatsNewModalProps {
  onClose: () => void;
  /** Versions à afficher (par défaut celles du CHANGELOG.md embarqué) ; injectables pour les tests. */
  releases?: Release[];
}

/** « Nouveautés » : contenu de chaque version, la plus récente en tête. */
export default function WhatsNewModal({ onClose, releases = RELEASES }: WhatsNewModalProps) {
  const { t, formatDate } = useT();
  const markSeen = useWhatsNewStore((state) => state.markSeen);
  const latest = releases[0]?.version;

  // Ouvrir la fenêtre vaut consultation : la pastille de l'en-tête disparaît.
  useEffect(() => {
    markSeen(latest);
  }, [latest, markSeen]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b p-6 pr-12">
          <DialogTitle>{t('whatsNew.title')}</DialogTitle>
          {latest ? (
            <DialogDescription>{t('whatsNew.description', { version: latest })}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{t('whatsNew.title')}</DialogDescription>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {releases.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('whatsNew.empty')}</p>
          ) : (
            <div className="space-y-8">
              {releases.map((release, index) => (
                <article key={release.version} aria-labelledby={`release-${release.version}`} className="space-y-4">
                  <header className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 id={`release-${release.version}`} className="text-lg font-semibold tracking-tight">
                        {release.version}
                      </h3>
                      {index === 0 && <Badge variant="default">{t('whatsNew.latest')}</Badge>}
                      <time dateTime={release.date} className="text-sm text-muted-foreground">
                        {formatDate(release.date, { dateStyle: 'long', timeZone: 'UTC' })}
                      </time>
                    </div>
                    {release.title && <p className="text-sm font-medium">{release.title}</p>}
                  </header>

                  {release.sections.map((section) => {
                    const { icon: Icon, color, label } = CATEGORY_STYLES[section.category];
                    return (
                      <section key={section.category} className="space-y-2">
                        <h4 className="flex items-center gap-2 text-sm font-semibold">
                          <Icon className={cn('h-4 w-4', color)} aria-hidden="true" />
                          {t(label)}
                        </h4>
                        <ul className="list-disc space-y-1.5 pl-6 text-sm leading-relaxed marker:text-muted-foreground">
                          {section.items.map((item, itemIndex) => (
                            <li key={itemIndex}>
                              <Inline segments={item} />
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </article>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
