export const appConfig = {
  recordingsFolder: 'Recordings',
  defaultLanguage: 'fr-FR',
  // Langues de réunion (reconnaissance vocale). Les noms affichés viennent d'Intl.DisplayNames,
  // dans la langue de l'interface (voir `languageName` dans src/i18n).
  supportedLanguages: [
    { code: 'en-US' },
    { code: 'fr-FR' },
    { code: 'de-DE' },
    { code: 'es-ES' },
    { code: 'it-IT' },
    { code: 'pt-BR' },
    { code: 'nl-NL' },
    { code: 'ru-RU' },
    { code: 'zh-CN' },
  ],
};
