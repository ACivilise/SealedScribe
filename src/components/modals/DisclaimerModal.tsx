import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DisclaimerText } from '../common/DisclaimerText';
import { DISCLAIMER } from '../../lib/disclaimer';
import { useT } from '../../i18n';

/** Relecture de l'avertissement déjà accepté (Paramètres > Général > À propos). */
export default function DisclaimerModal({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b p-6 pr-12">
          <DialogTitle lang="fr">{DISCLAIMER.title}</DialogTitle>
          <DialogDescription>{t('disclaimer.updated', { date: DISCLAIMER.updated })}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <DisclaimerText />
        </div>
      </DialogContent>
    </Dialog>
  );
}
