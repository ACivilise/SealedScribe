import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';

/** Durée du défilement : la règle de l'app plafonne les transitions à 0,3 s. */
const TAPE_WIPE_MS = 280;

/** Thème réellement affiché : « system » suit le réglage de Windows. */
function showsDark(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches;
  return theme === 'dark';
}

/**
 * Applique le thème en le faisant défiler de gauche à droite, comme une bande qui avance
 * (View Transitions API). Sans cette API, ou si Windows demande de réduire les animations,
 * le thème change d'un coup. Les règles `::view-transition-*` d'`index.css` coupent le fondu
 * par défaut du navigateur pour que seul le défilement se voie.
 */
function applyWithTapeWipe(apply: () => void) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || typeof document.startViewTransition !== 'function') {
    apply();
    return;
  }
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: ['inset(0 100% 0 0)', 'inset(0 0 0 0)'] },
        { duration: TAPE_WIPE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    // Transition sautée (onglet masqué, autre transition en cours) : le thème est déjà appliqué.
    .catch(() => undefined);
}

/** Bouton de l'en-tête qui bascule entre thème clair et thème sombre. */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { t } = useT();
  const dark = showsDark(theme);
  const label = dark ? t('theme.toLight') : t('theme.toDark');

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => applyWithTapeWipe(() => setTheme(dark ? 'light' : 'dark'))}
    >
      {dark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </Button>
  );
}
