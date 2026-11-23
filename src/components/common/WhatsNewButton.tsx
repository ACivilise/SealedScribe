import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import WhatsNewModal from '../modals/WhatsNewModal';
import { hasUnseenRelease } from '../../lib/changelog';
import { CURRENT_VERSION } from '../../lib/releaseNotes';
import { useWhatsNewStore } from '../../store/whatsNewStore';
import { useT } from '../../i18n';

/** Bouton « Nouveautés » de l'en-tête : pastille tant que la dernière version n'a pas été consultée. */
export function WhatsNewButton({ latestVersion = CURRENT_VERSION }: { latestVersion?: string }) {
  const [open, setOpen] = useState(false);
  const lastSeenVersion = useWhatsNewStore((state) => state.lastSeenVersion);
  const { t } = useT();
  const unseen = hasUnseenRelease(latestVersion, lastSeenVersion);
  const label = unseen ? t('header.whatsNewUnseen') : t('header.whatsNew');

  return (
    <>
      <Button variant="ghost" size="icon" className="relative" aria-label={label} title={label} onClick={() => setOpen(true)}>
        <Sparkles className="h-5 w-5" />
        {unseen && (
          <span
            data-testid="whats-new-dot"
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
          />
        )}
      </Button>
      {open && <WhatsNewModal onClose={() => setOpen(false)} />}
    </>
  );
}
