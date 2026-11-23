# SealedScribe

App desktop (Tauri + React + Tailwind) d'enregistrement et de transcription de réunions.

Anciennement **MeetScribe**. Les noms internes gardent l'ancien nom pour ne pas perdre les données déjà sur
le poste ; ne pas les renommer : identifiant `com.meetscribe.app` (`tauri.conf.json`, porte les données de
WebView2), dossiers `%LOCALAPPDATA%\MeetScribe`, coffre des clés `MeetScribe` (`secrets.rs`), clés du
localStorage `meetscribe-*`, marqueur des WAV micro + son du PC (`dual_channel.rs`), paquets `meetscribe`.

## Contexte d'usage

**Logiciel libre (GPL-3.0-or-later), dépôt public `ACivilise/SealedScribe`, mais conçu d'abord pour son
auteur, sur son propre poste Windows.** Aucun engagement envers d'autres utilisateurs : pas de contraintes
de production. L'historique jusqu'à la v0.4.2 est dans le dépôt privé archivé `ACivilise/MeetScribe`.

Conséquences pour les choix techniques :
- Versions alpha / beta / `next` acceptées (ex. Tauri 3 alpha) si elles apportent quelque chose.
- Drapeaux expérimentaux ou non supportés acceptés (ex. arguments WebView2 `--enable-features=...`).
- Pas besoin de compatibilité multi-OS, de rétrocompatibilité des données, de signature, d'installeur
  ou de stratégie de mise à jour.
- Privilégier la solution la plus simple qui marche sur ce poste plutôt que la plus « propre pour la prod ».

## Versions et releases

- `CHANGELOG.md` (français) est affiché dans l'app, bouton « Nouveautés » de l'en-tête. Format strict,
  gardé par `src/lib/releaseNotes.test.ts`, qui exige aussi que sa dernière version soit celle de
  `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
- Les releases (installeur NSIS seul, non signé) vont dans les GitHub Releases du dépôt public.
  Procédure complète : skill `/release`.
