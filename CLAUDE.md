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
- Pas besoin de compatibilité multi-OS ni de rétrocompatibilité des données.
- Signature Windows : uniquement des voies gratuites, pas de certificat payant. Voie retenue : la version
  Microsoft Store (paquet MSIX, signé par Microsoft à la publication). SignPath Foundation a refusé le
  2026-11-25 (projet trop jeune) : à redemander plus tard, mise en place dans `.signpath/README.md`.
- Deux distributions du même `meetscribe.exe`, distinguées à l'exécution (`src-tauri/src/distribution.rs`,
  identité de paquet) :
  - installeur NSIS des GitHub Releases : mise à jour par le bandeau, lancement au démarrage par la clé
    `Run` (plugin autostart) ;
  - paquet MSIX du Microsoft Store (produit `9PLMZ0VZGS28`, identité `ACivilise.SealedScribe`) : pas de
    mise à jour par GitHub (règle du Store), lancement au démarrage par la tâche de démarrage du
    manifeste `packaging/msix/AppxManifest.xml`, paquet fabriqué par `packaging/msix/build-msix.sh`.
    Windows isole ses écritures dans `%LOCALAPPDATA%` et le registre.
- Mise à jour automatique (version installeur seulement) : plugin updater de Tauri (`src-tauri/src/updates.rs`, bandeau `UpdateBanner`), qui
  lit `latest.json` dans la dernière GitHub Release et n'accepte qu'un installeur signé par la clé de mise à
  jour (clé publique dans `tauri.conf.json` ; clé privée sur le poste de l'auteur et dans le secret GitHub
  `TAURI_SIGNING_PRIVATE_KEY` du dépôt, pour le workflow de release).
- Privilégier la solution la plus simple qui marche sur ce poste plutôt que la plus « propre pour la prod ».

## Versions et releases

- `CHANGELOG.md` (français) est affiché dans l'app, bouton « Nouveautés » de l'en-tête. Format strict,
  gardé par `src/lib/releaseNotes.test.ts`, qui exige aussi que sa dernière version soit celle de
  `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
- Les releases sont construites par `.github/workflows/release.yml` à chaque tag `vX.Y.Z`, sur les machines
  Windows de GitHub (exigence de SignPath), et publiées dans les GitHub Releases du dépôt public (installeur
  NSIS, `latest.json`). Le paquet MSIX du même run reste dans ses artefacts : il est soumis à la main dans
  l'Espace partenaires, puis certifié par Microsoft (quelques heures à 3 jours ouvrés).
  `package-lock.json` et `src-tauri/Cargo.lock` sont versionnés : le build utilise `--locked`, donc une
  montée de version les met à jour aussi.
  Procédure complète : skill `/release`.
