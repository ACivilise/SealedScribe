# SealedScribe

[English](README.md) · **Français**

Application de bureau Windows pour enregistrer ses réunions, les transcrire sur le PC ou avec Azure,
savoir qui a dit quoi et en tirer un résumé par l’IA.

> [!WARNING]
> **SealedScribe est fourni « en l’état », sans aucune garantie, et l’auteur décline toute responsabilité
> quant à son usage.** Vous seul répondez de ce que vous enregistrez : consentement des participants,
> respect du RGPD et des règles de votre employeur ou de vos clients, données envoyées aux services
> Azure et vérification des transcriptions et résumés générés par l’IA, qui peuvent être faux.
> Lisez l’[avertissement complet](DISCLAIMER.md) avant d’installer ou d’utiliser l’application :
> l’utiliser vaut acceptation. L’application le présente au premier lancement, et de nouveau à chaque
> modification, et reste inaccessible tant qu’il n’est pas accepté ; il se relit dans Paramètres > Général > À propos.

Logiciel libre (GPL-3.0), conçu d’abord pour le poste Windows de son auteur ; anciennement MeetScribe.
Interface React + Tailwind, backend Rust, le tout assemblé par Tauri 3 (version alpha).

## Fonctionnalités

- **Enregistrement** du micro, du son du PC ou des deux à la fois, depuis la fenêtre ou depuis l’icône de
  la zone de notification. Arrêt automatique après 5 minutes de silence ou à la mise en veille.
- **Transcription locale** avec whisper.cpp, sur la carte graphique NVIDIA (CUDA) ou sur le processeur,
  avec un modèle choisi selon le matériel. L’audio ne quitte pas le PC. **Transcription Azure Speech** ou
  **Mistral AI (Voxtral)** en alternative.
- **Qui parle.** Dans un enregistrement combiné, chaque passage est attribué à « Moi » ou « Autres » ; la
  séparation des intervenants (sherpa-onnx) distingue chaque participant distant. Les noms se modifient
  dans la fiche de la réunion.
- **Transcription d’un passage** sélectionné sur la forme d’onde. Chaque transcription est conservée comme
  une version de la réunion.
- **Résumés par l’IA** affichés au fil de l’écriture, à partir de prompts modifiables (onglet Prompts),
  avec Azure AI, Mistral AI ou un modèle déjà installé sur le PC (Ollama, LM Studio, llama.cpp).
- **Lexiques** qui corrigent les noms propres et le jargon mal compris (« cube ernetes » → « Kubernetes »).
- **Réunions faciles à retrouver** : recherche dans les titres, étiquettes et transcriptions ; pastilles
  Transcription et Résumé.
- **Import** d’un audio (WAV, MP3, M4A) et **export** du résumé ou de la transcription.
- **Traitements en arrière-plan** : une transcription continue fenêtre fermée, reprend après une
  interruption, garde le PC éveillé et peut l’éteindre à la fin.
- Interface en français ou en anglais, neuf habillages (Cassette, Classique, Terminal, Journal, Glacier,
  Ardoise, Néon, Pirate, Monochrome) en thème clair ou sombre, lancement au démarrage de Windows,
  connexion Microsoft facultative.

Le détail de chaque version est dans le [CHANGELOG](CHANGELOG.md), aussi affiché dans l’application
(bouton « Nouveautés » de l’en-tête).

## Installation

L’installeur `SealedScribe_X.Y.Z_x64-setup.exe` est publié dans les
[GitHub Releases](https://github.com/ACivilise/SealedScribe/releases) du dépôt.
Il n’a pas encore de signature Windows (voir [Politique de signature du code](#politique-de-signature-du-code-code-signing-policy)) :
au premier lancement, Windows SmartScreen affiche un avertissement (« Informations complémentaires » puis
« Exécuter quand même »). Les versions installées se mettent à jour seules : un bandeau propose chaque
nouvelle version, et n’installe qu’une mise à jour signée avec la clé de mise à jour du projet.

Prérequis :

- Windows 10 ou 11, 64 bits, avec le runtime WebView2 (inclus dans Windows 11) ;
- pour la transcription locale sur carte graphique : une carte NVIDIA avec un pilote 527 ou plus récent.
  Sans elle, la transcription locale utilise le processeur, plus lentement ;
- pour les fonctions Azure : vos propres ressources Azure Speech et Azure AI (Foundry) ;
- pour Mistral AI : une clé API créée sur `console.mistral.ai` (une seule pour la transcription et le
  résumé) ;
- pour le résumé sur le PC : Ollama (ou LM Studio, llama-server) avec un modèle déjà installé,
  par exemple `ollama pull qwen3:4b`. SealedScribe ne télécharge pas ces modèles.

## Politique de signature du code (Code signing policy)

> [!NOTE]
> Les installeurs n’ont pas encore de signature Windows. Une version Microsoft Store, signée par
> Microsoft, est en préparation, et la signature gratuite des projets libres sera redemandée quand le
> projet sera mieux établi.

- **Ce qui sera signé :** uniquement les fichiers construits à partir du code de ce dépôt, l’application
  (`meetscribe.exe`) et son installeur. Les moteurs de transcription et de séparation des voix et les
  modèles que l’app télécharge à la demande (whisper.cpp, sherpa-onnx, modèles hébergés sur Hugging Face)
  viennent de leurs propres projets et ne sont pas signés par SealedScribe.
- **Comment :** chaque version est construite à partir d’un tag par le
  [workflow Release](.github/workflows/release.yml), sur les machines de GitHub.
- **Équipe et rôles :**
  - Committers and reviewers : [ACivilise](https://github.com/ACivilise)
  - Approvers : [ACivilise](https://github.com/ACivilise)
- **Confidentialité :** SealedScribe n’a pas de télémétrie et n’envoie rien à son auteur. Tout ce qu’elle
  envoie, où et quand, est listé dans [Où vont vos données](#où-vont-vos-données).

## Configuration

Tout se règle dans la fenêtre **Paramètres**, et rien n’est obligatoire pour enregistrer.

| Onglet | Contenu |
|---|---|
| Général | Dossier des enregistrements (par défaut `Documents\Enregistrements audio`), lancement au démarrage, connexion Microsoft, langue, thème et habillage |
| Transcription | Moteur (modèle local, Azure Speech ou Mistral AI) ; en local : choix du modèle et installation du moteur ; avec Azure Speech : clé et région ; avec Mistral : clé et modèle Voxtral ; séparation des intervenants |
| Résumé IA | Moteur (Azure AI, Mistral AI, Ollama ou serveur local compatible OpenAI) ; pour Azure : point de terminaison, nom du déploiement et clé ; pour Mistral : clé et modèle ; en local : adresse du serveur et modèle |

- **Les clés Azure et Mistral** sont stockées dans le Gestionnaire d’identifiants Windows et lues
  uniquement par le backend Rust ; elles ne sont jamais compilées dans l’interface. La clé Mistral sert à
  la fois à la transcription et au résumé.
- **Mistral AI** est appelé en direct (`https://api.mistral.ai/v1`). Transcription : `voxtral-mini-latest`
  par défaut, audio envoyé par parties d’environ 10 minutes (progression, reprise et arrêt après la
  partie en cours, comme le moteur local), termes des lexiques transmis comme vocabulaire à privilégier.
  Résumé : `mistral-medium-latest` par défaut.
- **Le résumé IA** accepte l’API OpenAI v1 d’une ressource Foundry
  (`https://<ressource>.services.ai.azure.com/openai/v1`, le nom du déploiement est alors obligatoire)
  ou un point de terminaison Azure AI Inference historique. HTTPS obligatoire.
- **Le résumé en local** utilise un modèle déjà installé dans un serveur qui tourne sur ce PC (adresse
  `localhost` ou `127.0.0.1` uniquement) ; Paramètres liste les modèles présents et indique s’ils tiennent
  sur la carte NVIDIA.
  - **Ollama** (`http://127.0.0.1:11434` par défaut) : SealedScribe passe par son API native pour fixer
    la taille du contexte selon la longueur de la transcription (par son API compatible OpenAI, Ollama
    s’en tient à 4 096 jetons sous 24 Go de mémoire graphique et tronque sans prévenir).
  - **Serveur compatible OpenAI** (LM Studio `http://127.0.0.1:1234/v1` par défaut, llama-server…) :
    réglez la longueur de contexte dans le serveur, au moins 32 768 jetons pour une réunion d’une heure.
  - Avant un résumé local, le modèle Whisper local est déchargé s’il est inactif, pour libérer la carte
    graphique.
- **La connexion Microsoft** est désactivée par défaut. Pour l’activer, saisissez l’ID d’application et
  l’ID d’annuaire d’une inscription d’application Entra ID, et déclarez l’URI de redirection affichée
  comme « Application monopage » (SPA). Elle contrôle seulement l’accès à l’application : les services
  Azure utilisent les clés.

## Où vont vos données

**Sur le PC** (aucune sauvegarde automatique, à vous de sauvegarder ces dossiers) :

| Données | Emplacement |
|---|---|
| Fichiers audio | Dossier choisi dans Paramètres > Général |
| Réunions, transcriptions, résumés, étiquettes, prompts, lexiques | Stockage du navigateur intégré : `%LOCALAPPDATA%\com.meetscribe.app\EBWebView` |
| Préférences | `%APPDATA%\meetscribe\preferences.json` |
| Moteur de transcription locale et modèles | `%LOCALAPPDATA%\MeetScribe\whisper` |
| Clés Azure et Mistral | Gestionnaire d’identifiants Windows |

**Hors du PC**, selon les réglages :

| Destination | Ce qui est envoyé | Quand |
|---|---|---|
| Azure Speech (`<région>.stt.speech.microsoft.com`) | L’audio | Moteur de transcription Azure |
| Point de terminaison Azure du résumé | La transcription et le prompt | Génération d’un résumé avec Azure AI |
| Mistral AI (`api.mistral.ai`) | L’audio et les termes des lexiques ; la transcription et le prompt | Moteur de transcription Mistral ; résumé avec Mistral AI |
| Microsoft Entra ID (`login.microsoftonline.com`) | Votre identité | Connexion Microsoft activée |
| GitHub et Hugging Face | Rien (téléchargement, vérifié par empreinte SHA-256) | Installation du moteur local |
| GitHub (`github.com`) | Rien (vérification de version ; téléchargement de l’installeur si vous acceptez la mise à jour) | Recherche de mise à jour (version installeur seulement, la version Microsoft Store est mise à jour par le Store) : 15 secondes après le lancement, puis toutes les 6 heures, et « Rechercher une mise à jour » |
| Google Fonts | Rien (téléchargement de la police) | Affichage de l’interface |

Avec le moteur de transcription local et un résumé local (ou sans résumé), ni l’audio ni le texte des
réunions ne quittent le PC.

## Développement

Prérequis : Node.js 20.19+ ou 22.12+, Rust stable avec la chaîne MSVC (Visual Studio Build Tools,
charge de travail C++).

```bash
npm install
npm run tauri:dev            # interface (http://localhost:1430) + backend Rust, rechargement à chaud de l’interface
npm test                     # tests de l’interface (Vitest)
cd src-tauri && cargo test   # tests du backend
npm run tauri:build          # installeur dans src-tauri/target/release/bundle/nsis/
```

En développement seulement, le backend lit aussi les clés Azure dans un fichier `.env` (modèle :
[`.env.example`](.env.example)). Ces variables, sans préfixe `VITE_`, priment sur le Gestionnaire
d’identifiants.

### Structure

```
src/                    Interface React
  components/           Onglets, fenêtres, composants communs
  store/                États Zustand (réunions, prompts, lexiques…)
  i18n/                 Textes français et anglais
src-tauri/src/          Backend Rust
  commands.rs           Commandes appelées par l’interface
  services/             Capture audio (WASAPI), transcription locale et Azure, séparation des
                        intervenants, résumé, tâches de fond, alimentation
  tray.rs               Icône de la zone de notification
CHANGELOG.md            Historique des versions, affiché dans l’application
SPECIFICATIONS.md       Spécifications fonctionnelles
```

### Versions et publication

`CHANGELOG.md` suit un format strict, vérifié par `src/lib/releaseNotes.test.ts`, qui exige aussi que sa
dernière version soit celle de `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
Une version se prépare avec la skill Claude Code `/release` (changelog, numéro de version, tag) ; le tag
poussé lance le [workflow Release](.github/workflows/release.yml), qui construit et signe l’installeur et
publie la GitHub Release avec le fichier `latest.json` lu par la mise à jour automatique
([`.signpath/`](.signpath/README.md) décrit la mise en place de la signature).

## Licence

© 2026 les contributeurs de SealedScribe. SealedScribe est un logiciel libre : vous pouvez le
redistribuer et le modifier selon les termes de la GNU General Public License, version 3 ou (à votre
choix) toute version ultérieure ([LICENSE](LICENSE)). Toute version modifiée et distribuée doit rester
sous cette licence, avec son code source.

Les composants tiers (whisper.cpp, sherpa-onnx, modèles Whisper, pyannote et WeSpeaker, dépendances npm
et Cargo) restent soumis à leurs propres licences.

L’utilisation de l’application est soumise à l’[avertissement et exclusion de responsabilité](DISCLAIMER.md).
