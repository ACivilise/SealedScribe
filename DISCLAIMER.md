# Avertissement et exclusion de responsabilité

<!--
Affiché dans SealedScribe (src/lib/disclaimer.ts) : écran d'acceptation au premier lancement, puis
Paramètres > Général > À propos. Changer la date de « Dernière mise à jour » redemande l'acceptation.
src/lib/disclaimer.test.ts vérifie le titre et cette ligne.
-->

**Dernière mise à jour : 16 novembre 2026**

En installant, en lançant ou en utilisant SealedScribe (« l’application »), vous reconnaissez avoir lu
le présent avertissement et l’accepter sans réserve. Si vous ne l’acceptez pas, n’installez pas et
n’utilisez pas l’application.

## 1. Un outil personnel, fourni « en l’état »

SealedScribe est un projet personnel, développé sur le temps libre de son auteur pour son propre usage.
Ce n’est pas un produit commercial. Il n’engage aucun employeur, client ou organisation auquel l’auteur
est ou a été lié, et n’est ni affilié à Microsoft, OpenAI ou aux autres éditeurs cités, ni approuvé par eux.

L’application est fournie **« en l’état » et « selon disponibilité »**, sans aucune garantie, expresse ou
implicite, notamment de bon fonctionnement, de qualité, d’exactitude, de sécurité, de compatibilité,
d’adéquation à un usage particulier, d’absence d’erreur ou de continuité de service. Elle repose sur
des composants en version alpha (Tauri 3) et sur des options expérimentales du navigateur intégré
(WebView2) : elle peut cesser de fonctionner, perdre des données ou se comporter de façon inattendue.

Aucune maintenance, aucun support et aucune mise à jour ne sont promis.

## 2. Enregistrer des personnes : votre responsabilité

L’application enregistre le son du microphone et le son de l’ordinateur, donc la voix des participants
à une réunion. **Vous êtes seul responsable de la licéité de chaque enregistrement**, et en particulier :

- **du consentement des personnes enregistrées.** En France, enregistrer ou transmettre sans son
  consentement les paroles prononcées à titre privé ou confidentiel par une personne est puni par
  l’article 226-1 du Code pénal, et la diffusion d’un tel enregistrement par l’article 226-2. D’autres
  pays imposent l’accord de toutes les parties. Informez les participants avant d’enregistrer et
  recueillez leur accord ;
- **du respect du RGPD et de la loi Informatique et Libertés.** La voix, les transcriptions et les
  résumés d’une réunion sont des données à caractère personnel. En les traitant, vous en êtes
  responsable : information des personnes, base légale, durée de conservation, sécurité, réponse aux
  demandes d’accès ou d’effacement. La séparation des intervenants calcule des empreintes vocales,
  qui peuvent relever des données sensibles ;
- **des règles de votre employeur, de vos clients et des outils de réunion** (Teams, Zoom, etc.) :
  politique interne, clauses de confidentialité, secret des affaires, secret professionnel, accords de
  non-divulgation, interdiction d’envoyer certaines informations vers des services en ligne.

L’auteur ne vérifie pas et ne peut pas vérifier l’usage qui est fait de l’application, et décline toute
responsabilité en cas d’enregistrement, de conservation, de transmission ou de diffusion illicite.

## 3. Services tiers et envoi de données

Selon les réglages choisis, l’application envoie des données à des services tiers, avec **vos propres
comptes, clés et abonnements** :

- **Azure Speech** (moteur de transcription Azure) : l’audio des réunions ;
- **le point de terminaison Azure configuré pour le résumé IA** : le texte des transcriptions et les
  prompts ;
- **Mistral AI** (moteur de transcription Mistral, résumé par Mistral AI) : l’audio des réunions, le texte
  des transcriptions, les prompts et les termes des lexiques ;
- **Microsoft Entra ID** (connexion Microsoft, si elle est activée) : votre identité ;
- **GitHub et Hugging Face** : téléchargement du moteur de transcription locale et des modèles ;
- **Google Fonts** : chargement de la police de l’interface.

Ces services sont régis par leurs propres conditions et politiques de confidentialité, sur lesquelles
l’auteur n’a aucun contrôle. Vous êtes seul responsable du choix d’y envoyer des données, de leur
localisation, de leur conservation par ces services, et **des coûts facturés** par Microsoft, Mistral AI
ou tout autre fournisseur pour les appels effectués depuis l’application.

Les moteurs et modèles téléchargés (whisper.cpp, sherpa-onnx, modèles Whisper, pyannote, WeSpeaker)
sont des logiciels tiers soumis à leurs propres licences, qu’il vous appartient de respecter.

## 4. Contenu produit par l’intelligence artificielle

Les transcriptions, l’attribution des paroles aux intervenants, les corrections des lexiques et les
résumés sont générés automatiquement. **Ils peuvent être faux, incomplets ou inventés** : mots mal
compris, phrases attribuées à la mauvaise personne, passages omis, décisions ou chiffres qui n’ont
jamais été prononcés.

Ils ne constituent ni un compte rendu fidèle, ni une preuve, ni un conseil juridique, médical,
financier ou autre. Relisez-les et vérifiez-les avant de les diffuser ou de prendre la moindre décision
sur leur fondement. Toute conséquence de leur utilisation relève de votre seule responsabilité.

## 5. Vos données et votre ordinateur

- **Pas de sauvegarde.** Les enregistrements, transcriptions et résumés sont stockés uniquement sur
  votre ordinateur. Une désinstallation, une réinitialisation des données du navigateur intégré, une
  panne ou une erreur de l’application peut les faire disparaître définitivement. Sauvegardez-les
  vous-même.
- **Sécurité du poste.** La confidentialité des fichiers audio, des transcriptions et des clés
  stockées dépend de la sécurité de votre session Windows, dont vous êtes responsable.
- **Alimentation de l’ordinateur.** Pendant un traitement en arrière-plan, l’application peut empêcher
  la mise en veille, y compris capot fermé, en modifiant temporairement l’action de fermeture du capot
  dans les réglages d’alimentation de Windows, et peut éteindre l’ordinateur à la fin si vous l’avez
  demandé. Un ordinateur qui reste allumé dans un sac peut chauffer et vider sa batterie ; une
  extinction ferme les autres applications sans enregistrer leur travail. Ces options s’utilisent à
  vos risques.
- **Arrêt automatique.** L’enregistrement s’arrête seul après un long silence ou à la mise en veille :
  une partie de réunion peut ne pas être enregistrée.

## 6. Limitation de responsabilité

Dans toute la mesure permise par la loi applicable, l’auteur et les éventuels contributeurs ne pourront
en aucun cas être tenus responsables d’un dommage, direct ou indirect, matériel ou immatériel, résultant
de l’installation, de l’utilisation ou de l’impossibilité d’utiliser l’application, notamment : perte ou
corruption de données, fuite d’informations confidentielles, atteinte à la vie privée ou aux droits de
tiers, sanction administrative ou pénale, réclamation d’un employeur, d’un client ou d’un participant,
coûts de services en ligne, perte de chiffre d’affaires, d’opportunité ou de temps, ou dommage causé
à votre ordinateur.

Lorsque la loi applicable interdit tout ou partie de cette exclusion, la responsabilité est limitée au
minimum qu’elle autorise.

## 7. Garantie contre les réclamations

Vous vous engagez à garantir l’auteur et les éventuels contributeurs contre toute réclamation, action ou
demande de tiers (participants enregistrés, employeur, client, autorité de contrôle, etc.) résultant de
votre utilisation de l’application ou du non-respect du présent avertissement, et à les indemniser des
frais et condamnations qui en découleraient.

## 8. Droit applicable

Le présent avertissement est régi par le droit français. Il peut être modifié à tout moment ; la version
applicable est celle du dépôt au moment de votre utilisation.
