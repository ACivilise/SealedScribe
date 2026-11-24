# Signature Windows par SignPath Foundation

SealedScribe demande la signature gratuite des projets libres de [SignPath Foundation](https://signpath.org).
La politique publique est dans le README, section « Code signing policy ». Ce dossier contient ce qu'il
faut recopier dans SignPath ; le build et l'envoi des fichiers à signer sont dans
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Circuit d'une release

1. La skill `/release` pousse le tag `vX.Y.Z`.
2. Le workflow construit l'exe sur une machine Windows de GitHub et l'envoie à SignPath
   (configuration `app`). **Approuver la demande** sur [app.signpath.io](https://app.signpath.io).
3. Il construit l'installeur NSIS autour de l'exe signé et l'envoie à son tour (configuration
   `installer`). **Approuver la seconde demande.**
4. Il vérifie les deux signatures Windows, signe l'installeur pour la mise à jour automatique, puis
   publie la GitHub Release avec `latest.json`.

Chaque demande attend son approbation une heure au plus ; au-delà, le run échoue et se relance depuis
l'onglet Actions.

## Mise en place (une fois)

1. **Double authentification** active sur GitHub et sur SignPath (exigée par SignPath Foundation).
2. **Candidature** sur [signpath.org/apply](https://signpath.org/apply) : dépôt
   `https://github.com/ACivilise/SealedScribe`, licence GPL-3.0-or-later, politique de signature
   `https://github.com/ACivilise/SealedScribe#code-signing-policy`.
3. **Dans SignPath**, une fois le projet accepté :
   - lier le système de build de confiance prédéfini « GitHub.com » au projet ;
   - créer deux configurations d'artefact, de slugs `app` et `installer`, avec le contenu de
     [`artifact-configurations/app.xml`](artifact-configurations/app.xml) et
     [`artifact-configurations/installer.xml`](artifact-configurations/installer.xml) ;
   - dans la politique de signature (certificat de SignPath Foundation), restreindre l'origine au dépôt
     ci-dessus et aux tags `v*`, avec approbation manuelle ;
   - créer un utilisateur CI avec le rôle « Submitter » et générer son jeton d'API.
4. **Dans GitHub**, Settings > Secrets and variables > Actions du dépôt :
   - variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG` ;
   - secret `SIGNPATH_API_TOKEN` (le jeton ci-dessus).

   Tant que `SIGNPATH_ORGANIZATION_ID` est vide, le workflow saute la signature Windows et publie un
   installeur non signé, comme avant.

Le secret `TAURI_SIGNING_PRIVATE_KEY` (contenu de la clé privée de mise à jour) est exigé pour toute
release faite par le workflow, signée par SignPath ou non.
