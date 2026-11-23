import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { en, type MessageKey } from './en';
import { fr } from './fr';

export type { MessageKey } from './en';

/** Langues d'interface disponibles. */
export type Locale = 'fr' | 'en';
/** Choix de l'utilisateur : une langue précise, ou celle de Windows. */
export type LocalePreference = Locale | 'system';

export const AVAILABLE_LOCALES: { value: Locale; nativeName: string }[] = [
  { value: 'fr', nativeName: 'Français' },
  { value: 'en', nativeName: 'English' },
];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, fr };

/** Langue de l'OS (la WebView2 expose la langue d'affichage de Windows). Repli : anglais. */
export function getSystemLocale(): Locale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((lang) => lang?.toLowerCase().startsWith('fr')) ? 'fr' : 'en';
}

const resolveLocale = (preference: LocalePreference): Locale =>
  preference === 'system' ? getSystemLocale() : preference;

/** Code BCP 47 à passer aux API Intl (dates, noms de langues). */
const INTL_LOCALES: Record<Locale, string> = { fr: 'fr-FR', en: 'en-US' };

interface LocaleStore {
  preference: LocalePreference;
  locale: Locale;
  setPreference: (preference: LocalePreference) => void;
}

const applyDocumentLang = (locale: Locale) => {
  document.documentElement.lang = locale;
};

export const useLocaleStore = create<LocaleStore>()(
  persist(
    (set) => ({
      preference: 'system',
      locale: getSystemLocale(),
      setPreference: (preference) => {
        const locale = resolveLocale(preference);
        applyDocumentLang(locale);
        set({ preference, locale });
      },
    }),
    {
      name: 'locale-store',
      // Seul le choix est persisté : « system » est réévalué à chaque lancement.
      partialize: (state) => ({ preference: state.preference }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.locale = resolveLocale(state.preference);
          applyDocumentLang(state.locale);
        }
      },
    }
  )
);

applyDocumentLang(useLocaleStore.getState().locale);

export type TranslateParams = Record<string, string | number>;

function format(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const template = dictionaries[locale][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

/** Traduction hors composant React (hooks utilitaires, services). */
export function translate(key: MessageKey, params?: TranslateParams): string {
  return format(useLocaleStore.getState().locale, key, params);
}

/** Hook de traduction : le composant se re-rend quand la langue change. */
export function useT() {
  const locale = useLocaleStore((state) => state.locale);
  const intlLocale = INTL_LOCALES[locale];

  const t = (key: MessageKey, params?: TranslateParams) => format(locale, key, params);

  const formatDate = (date: Date | string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(intlLocale, options).format(new Date(date));

  /** Nom d'une langue de réunion (« fr-FR » → « Français (France) »), dans la langue de l'UI. */
  const languageName = (code: string) => {
    try {
      const name = new Intl.DisplayNames([intlLocale], { type: 'language' }).of(code) ?? code;
      return name.charAt(0).toLocaleUpperCase(intlLocale) + name.slice(1);
    } catch {
      return code;
    }
  };

  return { t, locale, intlLocale, formatDate, languageName };
}
