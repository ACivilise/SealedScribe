import { Markdown } from '@/components/ui/markdown';
import { DISCLAIMER, type Disclaimer } from '../../lib/disclaimer';
import { useT } from '../../i18n';

/** Corps de l'avertissement (DISCLAIMER.md), rédigé en français quelle que soit la langue de l'interface. */
export function DisclaimerText({ disclaimer = DISCLAIMER }: { disclaimer?: Disclaimer }) {
  const { t, locale } = useT();
  return (
    <div className="space-y-4">
      {locale !== 'fr' && <p className="text-sm text-muted-foreground">{t('disclaimer.frenchOnly')}</p>}
      <div lang="fr">
        <Markdown>{disclaimer.body}</Markdown>
      </div>
    </div>
  );
}
