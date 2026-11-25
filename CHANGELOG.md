# Historique des versions

<!--
Affiché dans SealedScribe : bouton « Nouveautés » de l'en-tête (src/components/modals/WhatsNewModal.tsx).
Tenu à jour par la skill .claude/skills/release/SKILL.md, qui documente le format ;
src/lib/releaseNotes.test.ts fait échouer les tests s'il dérive ou si la dernière version ne correspond
pas à package.json, src-tauri/tauri.conf.json et src-tauri/Cargo.toml.
-->

## 0.6.0 — 2026-11-25 — Microsoft Store

### Nouveautés
- **SealedScribe arrive sur le Microsoft Store.** Signée par Microsoft, cette version s’installe sans
  l’avertissement de Windows SmartScreen, et le Store la tient à jour : Paramètres > Général > À propos
  l’indique à la place du bouton « Rechercher une mise à jour ». Le lancement au démarrage y
  fonctionne aussi ; s’il a été coupé dans les paramètres de Windows, SealedScribe indique où le
  réactiver. L’installeur des GitHub Releases reste disponible et se met toujours à jour par le bandeau.

## 0.5.3 — 2026-11-24 — Nouveaux habillages

### Nouveautés
- **Cinq nouveaux habillages.** Dans Paramètres > Général > Apparence > Habillage, chacun en thème
  clair et sombre : Classique, le premier style de l’app ; Ardoise, en bleu ardoise, orange et
  pervenche ; Néon, un coucher de soleil le jour et des néons la nuit ; Pirate, parchemin, encre
  sépia et or ; Monochrome, en noir et blanc, où seuls « Démarrer » et les boutons
  « Enregistrer… » sont en rouge.

## 0.5.2 — 2026-11-24

### Corrections
- **Mises à jour automatiques rétablies.** SealedScribe recherche à nouveau les mises à jour tout seul,
  15 secondes après le lancement puis toutes les 6 heures ; les versions 0.5.0 et 0.5.1 ne le faisaient pas.

## 0.5.1 — 2026-11-23 — Visite guidée

### Nouveautés
- **Visite guidée au premier lancement.** Les Paramètres s’ouvrent et une visite vous accompagne
  jusqu’à votre premier enregistrement : langue et apparence, moteur de transcription, résumé,
  puis micro, sortie audio, « Démarrer », « Arrêter » et « Enregistrer la réunion ».
  Elle avance quand vous faites ce qu’elle indique ; « Passer la visite » l’arrête,
  et « Revoir la visite guidée », dans Paramètres > Général > À propos, la relance.

### Améliorations
- **Transcription locale par défaut.** Une nouvelle installation transcrit avec le modèle local,
  sur ce PC, sans compte ni clé à saisir. Les réglages existants ne changent pas.

## 0.5.0 — 2026-11-23 — MeetScribe devient SealedScribe

### Nouveautés
- **SealedScribe, logiciel libre.** MeetScribe s’appelle désormais SealedScribe, et son code est
  publié sur GitHub sous licence libre GPL-3.0. Vos réunions, prompts, lexiques et clés sont
  conservés.
- **Mises à jour depuis l’app.** Quand une nouvelle version sort, un bandeau la signale en haut de
  la fenêtre : « Installer » la télécharge, puis SealedScribe se ferme et redémarre à jour.
  L’installation attend la fin d’un enregistrement ou d’un traitement en cours. Pour vérifier à la
  demande : « Rechercher une mise à jour », dans Paramètres > Général > À propos.
- **Quatre habillages.** Dans Paramètres > Général > Apparence > Habillage : Cassette, inspiré des
  platines des années 80 (par défaut), Terminal, Journal et Glacier, chacun en thème clair et
  sombre. Le passage au thème clair ou sombre se déroule comme une bande qui avance.
- **Choix du micro et de la sortie audio.** L’onglet Enregistrer liste les micros et les sorties
  audio branchés ; le son de la réunion est capté sur la sortie choisie. Le choix est mémorisé ;
  un périphérique débranché est remplacé par celui de Windows, avec un avertissement.

### Corrections
- **Plus d’intervenant muet.** Un passage sans parole ne crée plus d’intervenant qui ne dit rien ;
  les transcriptions déjà enregistrées sont nettoyées à l’ouverture.
- **Intervenants de même nom réunis.** Donner à un intervenant le nom d’un autre les regroupe sous un
  seul numéro, dans la transcription affichée et dans toutes ses versions.
- **Jauge d’enregistrement stable.** Pendant l’enregistrement, la forme d’onde garde sa hauteur : la
  fenêtre ne tremble plus. Le pourcentage du niveau audio disparaît, et un son faible reste visible.

## 0.4.2 — 2026-11-18 — Séparation des voix toujours à jour

### Améliorations
- **Participants non séparés signalés.** Quand tous les participants distants d’une réunion sont
  restés sous « Autres », la fiche le signale et indique quoi faire : cliquer sur
  « Séparer les voix », ou d’abord télécharger « Intervenants distants » dans Paramètres >
  Transcription.

### Corrections
- **Séparation des voix mise à jour seule.** Après une mise à jour de SealedScribe, il n’est plus
  nécessaire de retélécharger « Intervenants distants » à la main : une version précédente se met
  à jour d’elle-même avant de séparer les voix, en fin de transcription ou avec
  « Séparer les voix ». Les participants distants ne restent plus tous sous « Autres » sans
  explication.

## 0.4.1 — 2026-11-18 — Un numéro par participant

### Corrections
- **Un numéro par participant distant.** Dans les enregistrements « micro + son du PC », un même
  participant n’apparaît plus sous deux ou trois numéros d’intervenant au fil d’une longue réunion :
  ses passages sont regroupés par voix sur toute la réunion, et le nombre de participants est mieux
  estimé. Après la mise à jour, retéléchargez « Intervenants distants » dans Paramètres >
  Transcription ; dans la fiche d’une réunion déjà transcrite, « Séparer les voix » refait la
  séparation.

## 0.4.0 — 2026-11-17 — Azure Speech au palier gratuit

### Améliorations
- **La transcription d’abord.** Dans la fiche d’une réunion, l’onglet Transcription précède désormais
  l’onglet Résumé.

### Corrections
- **Azure Speech au palier gratuit.** Avec une ressource Azure Speech gratuite (F0), qui n’accepte
  qu’une requête à la fois, la transcription ne s’arrête plus sur l’erreur « Too Many Requests » :
  SealedScribe envoie alors les morceaux un par un, et s’en souvient jusqu’au changement de clé.

## 0.3.0 — 2026-11-16 — Résumés et transcription au choix

### Nouveautés
- **Résumé par un modèle local.** Dans Paramètres > Résumé IA, choisissez « Ollama (sur ce PC) » ou
  « Serveur local compatible OpenAI (LM Studio, llama.cpp…) » pour résumer avec un modèle déjà
  installé : la transcription ne quitte pas le PC. SealedScribe liste les modèles présents, indique
  s’ils tiennent sur la carte graphique et, avec Ollama, adapte la taille du contexte à la longueur
  de la réunion pour ne rien couper.
- **Mistral AI pour transcrire et résumer.** Nouveaux moteurs « Mistral AI (Voxtral, cloud) » dans
  Paramètres > Transcription et « Mistral AI (cloud) » dans Paramètres > Résumé IA, avec une seule clé
  API pour les deux. La transcription avance par parties d’environ 10 minutes, peut s’arrêter après
  la partie en cours, reprend après une interruption et tient compte des lexiques.

### Améliorations
- **Azure Speech dans l’onglet Transcription.** La clé et la région Azure Speech se saisissent sous le
  choix du moteur quand « Azure Speech (cloud) » est choisi ; l’onglet Azure Speech disparaît des
  Paramètres.
- **Arrêter un résumé à tout moment.** « Arrêter » interrompt aussi le résumé pendant que le modèle
  se charge, avant que le texte n’apparaisse.

## 0.2.0 — 2026-11-16 — Avertissement de responsabilité

### Nouveautés
- **Avertissement à accepter.** Au premier lancement, SealedScribe présente son avertissement et
  exclusion de responsabilité : cochez la case puis « Accepter et continuer », ou choisissez
  « Refuser et quitter ». Il est de nouveau présenté s’il change, et se relit dans
  Paramètres > Général > À propos.
- **Rappels au bon endroit.** Sous « Démarrer », un rappel invite à prévenir les participants et
  à obtenir leur accord. La transcription et le résumé signalent qu’ils sont générés automatiquement
  et peuvent contenir des erreurs, et les onglets Résumé IA et Azure Speech des Paramètres disent ce
  qui est envoyé à Azure.

## 0.1.0 — 2026-11-16 — Première version publiée

### Nouveautés
- **Enregistrement des réunions.** Le micro, le son du PC ou les deux à la fois, depuis la fenêtre ou
  depuis l’icône de la zone de notification. L’enregistrement s’arrête seul après 5 minutes de silence
  ou à la mise en veille du PC.
- **Transcription locale ou Azure.** Le moteur local s’installe depuis les Paramètres et choisit
  la carte graphique ou le processeur, et le modèle, selon le matériel du PC. Azure Speech reste disponible.
- **Qui parle.** Dans un enregistrement combiné, chaque passage est attribué à « Moi » ou « Autres »,
  et la séparation des locuteurs distingue chaque participant distant. Les noms se modifient dans la
  fiche de la réunion et se retrouvent dans la transcription, le résumé et l’export.
- **Transcription d’un passage choisi.** Sélectionnez une portion sur la forme d’onde, écoutez-la,
  puis transcrivez-la. Chaque transcription est conservée comme une version de la réunion.
- **Résumés par l’IA.** Générés depuis l’onglet Résumé de la fiche, affichés au fil de l’écriture dans la
  langue de l’application, mis en forme, avec des prompts modifiables dans l’onglet Prompts.
- **Lexiques.** Les noms propres et le jargon mal compris (« cube ernetes » au lieu de « Kubernetes ») sont corrigés
  dans les transcriptions et les résumés. « Appliquer les lexiques » corrige une réunion déjà transcrite.
- **Réunions faciles à retrouver.** Recherche par titre, étiquette ou contenu de la transcription,
  étiquettes modifiables et filtrables, et pastilles Transcription et Résumé pour voir d’un coup d’œil
  ce qui est prêt.
- **Import et export.** « Importer un audio » dans l’onglet Réunions ; « Copier » ou « Enregistrer sous… »
  le résumé ou la transcription affichés.
- **Traitements en arrière-plan.** Une transcription continue fenêtre fermée, reprend après une
  interruption, garde le PC éveillé (capot fermé compris) et peut éteindre l’ordinateur à la fin.
- **Nouveautés.** Ce bouton de l’en-tête présente le contenu de chaque version, avec une pastille
  tant que la dernière n’a pas été consultée.

### Améliorations
- **Interface en français ou en anglais.** Selon la langue de Windows ou au choix, avec un thème clair
  ou sombre.
- **Connexion Microsoft facultative.** Connexion automatique avec le compte Windows quand elle est
  activée, désactivable dans Paramètres > Général.
- **Paramètres en onglets.** Ce qui manque est signalé, et un seul bouton Enregistrer valide toute la fenêtre.
- **Lancement au démarrage de Windows.** En option, SealedScribe démarre réduit dans la zone de notification.
- **Onglets expliqués.** Une infobulle dit à quoi sert chaque onglet principal.
- **Sécurité renforcée.** Les clés Azure ne sont plus embarquées dans l’interface, les chemins de
  fichiers sont vérifiés et le jeton Microsoft n’est plus conservé.
