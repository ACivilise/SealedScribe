---
name: release
description: Publie une version de SealedScribe. Met à jour CHANGELOG.md (affiché dans « Nouveautés »), monte la version, pousse le tag ; le workflow GitHub Actions construit l'installeur NSIS (signé par SignPath quand c'est configuré) et le paquet MSIX, publie la GitHub Release, puis le paquet est soumis au Microsoft Store. À utiliser pour « release », « publier une version », « mettre à jour le changelog », « builder l'installeur », « pousser l'exe sur GitHub », « publier sur le Store ». Argument facultatif : la version (ex. `0.2.0`).
---

# Release SealedScribe

Une release = une section du `CHANGELOG.md` + la même version dans les fichiers de version + un tag
`vX.Y.Z`. Le tag poussé lance `.github/workflows/release.yml`, qui construit l'installeur NSIS sur une
machine Windows de GitHub, le fait signer par SignPath Foundation (quand c'est configuré, voir
`.signpath/README.md`), le signe pour la mise à jour automatique et publie la GitHub Release (dépôt
public `ACivilise/SealedScribe`) avec `latest.json`. Le même run fabrique le paquet MSIX du Microsoft Store
(artefact du run), soumis ensuite dans l'Espace partenaires (étape 7).
`src/lib/releaseNotes.test.ts` est la **garde** : il échoue si le changelog sort du format ou si sa
dernière version diffère de celle des fichiers de version.

Commandes en Git Bash (pas de script PowerShell). Le commit et le tag sont au seul nom de l'utilisateur.
`gh` vise le compte perso avec `GH_TOKEN="$(gh auth token --user ACivilise)"` (un compte professionnel est
aussi connecté).

---

## Format du changelog

```markdown
## 0.2.0 — 2026-12-01 — Titre facultatif

### Nouveautés
- **Accroche en gras.** Ce que l'utilisateur y gagne, au présent.
  Continuation indentée de deux espaces.

### Améliorations
### Corrections
```

- Versions de la plus récente à la plus ancienne ; en-tête `## X.Y.Z — AAAA-MM-JJ` (tiret cadratin),
  ` — Titre` facultatif.
- Trois catégories, dans cet ordre, une catégorie vide est omise : `Nouveautés` (fonctionnalité
  nouvelle), `Améliorations` (existant rendu meilleur), `Corrections` (bug corrigé). Une nouvelle
  catégorie demande aussi une entrée dans `CATEGORY_STYLES` (`WhatsNewModal.tsx`) et une clé i18n.
- En ligne : seulement `**gras**` et `` `code` ``. Commentaires `<!-- -->` ignorés. Toute autre ligne fait
  échouer le parseur (`src/lib/changelog.ts`).

**Style** (lecteur : l'utilisateur de l'app, en français) :
- Le bénéfice d'abord, au présent ; accroche en gras de 2 à 6 mots terminée par un point.
- Les libellés tels qu'affichés à l'écran (`src/i18n/fr.ts`) : « Appliquer les lexiques », Paramètres > Général.
- Une puce par changement visible ; les détails internes (crates, DLL, noms de fichiers) restent dans les commits.
- Typographie de `fr.ts`, en caractères réels : espace insécable U+00A0 à l'intérieur de « » et avant `:`,
  espace fine insécable U+202F avant `;` `!` `?`, apostrophe `’`.

**Commits → catégories** : `feat` → Nouveautés ou Améliorations ; `fix` → Corrections. `chore`, `test`,
`docs`, `refactor`, CI et montées de dépendances restent hors du changelog, sauf effet visible (ex. une
montée de version qui corrige un bug ressenti).

---

## Procédure

### 1. Préconditions

```bash
git status --porcelain          # doit être vide
git branch --show-current       # main attendu
git fetch --tags origin
git tag --list 'v*' --sort=-v:refname | head -3
```

Arbre non vide : s'arrêter et lister les fichiers (une autre session travaille peut-être dans ce dossier).
Branche autre que `main` : demander confirmation avant de continuer.
**Fait quand** l'arbre est propre, la branche validée et les tags à jour.

### 2. Version

- Commits à couvrir : `git log <dernier tag>..HEAD --no-merges --format="%h %ad %s%n%b" --date=short`
  (sans tag : tout l'historique).
- Proposition semver : avant 1.0, un `feat` → mineur, des `fix` seuls → patch, `BREAKING` → mineur ;
  à partir de 1.0, règles semver standard.
- Version passée en argument : la prendre. Sinon la faire choisir avec `AskUserQuestion` (proposition en premier).
- Tag `vX.Y.Z` déjà présent localement ou sur `origin` : s'arrêter.

**Fait quand** la version est fixée et que son tag est libre.

### 3. Changelog et version

- Écrire la section `## X.Y.Z — $(date +%F)` en tête de `CHANGELOG.md`, sous le commentaire d'en-tête,
  en suivant le format et le style ci-dessus. Section déjà présente (préparée à l'avance, pas encore
  taguée) : la compléter avec les commits qu'elle ne couvre pas et mettre sa date à jour.
- Mettre `X.Y.Z` partout, fichiers de verrouillage compris (le CI construit avec `--locked`) :
  ```bash
  npm version X.Y.Z --no-git-tag-version          # package.json et package-lock.json
  # puis le champ `version` (ligne 3) de src-tauri/tauri.conf.json et src-tauri/Cargo.toml
  cargo update --workspace --offline --manifest-path src-tauri/Cargo.toml   # Cargo.lock
  ```
- Montrer la section à l'utilisateur.

**Fait quand** chaque commit `feat` / `fix` de la plage est couvert par une puce ou délibérément écarté.

### 4. Tests

`npm test` puis `npx tsc --noEmit`. **Fait quand** les deux passent (la garde valide format et versions).

### 5. Commit et tag

```bash
git add CHANGELOG.md package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "SealedScribe X.Y.Z"
```

Le message de commit tient en cette seule ligne.

### 6. Publication

Action visible hors du poste : obtenir d'abord une confirmation explicite (version, branche, notes, et si
la signature SignPath est active : les deux demandes à approuver). Vérifier avant :

```bash
export GH_TOKEN="$(gh auth token --user ACivilise)"
gh secret list --repo ACivilise/SealedScribe        # TAURI_SIGNING_PRIVATE_KEY obligatoire
gh variable list --repo ACivilise/SealedScribe      # SIGNPATH_ORGANIZATION_ID : signature Windows active
```

Sans le secret `TAURI_SIGNING_PRIVATE_KEY`, le workflow échoue sur un tag : passer par le secours
ci-dessous ou demander à l'utilisateur d'ajouter le secret. Puis :

```bash
git push origin "$(git branch --show-current)"
git push origin vX.Y.Z
gh run list --repo ACivilise/SealedScribe --workflow release.yml --limit 1   # id du run du tag
gh run watch <id> --repo ACivilise/SealedScribe --exit-status                 # avec run_in_background
```

Le build prend 20 à 40 min. Signature SignPath active : le run attend deux approbations sur
[app.signpath.io](https://app.signpath.io), l'exe puis l'installeur (une heure au plus chacune) ;
prévenir l'utilisateur quand le run atteint « Signer l'exe (SignPath) ».

Ne jamais pousser vers `origin` les tags ou l'historique du remote `archive` (ancien dépôt privé MeetScribe).

Échec du run : montrer l'étape en échec (`gh run view <id> --log-failed`), corriger, puis relancer le run
(`gh run rerun <id>`) ; ne pas déplacer un tag déjà publié.
**Fait quand** `gh release view vX.Y.Z --repo ACivilise/SealedScribe --json url,assets` montre l'exe et
`latest.json`, et que `curl -sL https://github.com/ACivilise/SealedScribe/releases/latest/download/latest.json`
renvoie la nouvelle version (c'est ce que lisent les applications installées).

### 7. Microsoft Store

Le run du tag garde le paquet dans ses artefacts. Le récupérer :

```bash
gh run download <id> --repo ACivilise/SealedScribe -n SealedScribe-X.Y.Z-msix -D "<scratchpad>/msix-X.Y.Z"
```

Puis, dans Chrome (Claude in Chrome), sur l'Espace partenaires. Le compte Microsoft perso de l'utilisateur
y est connecté par lui, jamais par Claude.
`https://partner.microsoft.com/dashboard/products/9PLMZ0VZGS28/overview` :
1. Mettre à jour la soumission en cours ou en créer une.
2. Dans Packages, retirer l'ancien paquet et déposer `SealedScribe_X.Y.Z.0_x64.msix`. Sa version `X.Y.Z.0`
   doit dépasser celle de la dernière soumission.
3. Dans la fiche du Store, mettre la section du changelog dans « Nouveautés de cette version ».
4. **L'utilisateur** clique sur « Soumettre au Store ». C'est une action publique.

La certification prend de quelques heures à 3 jours ouvrés.
**Fait quand** la soumission est « En certification ».

### 8. Rapport

- URL de la release ;
- version et taille de l'installeur. Le dépôt est public : l'installeur se télécharge sans compte GitHub ;
- installeur signé par SignPath ou non ;
- état de la soumission au Store.

---

## Secours : release construite sur le poste

Si GitHub Actions est indisponible. L'installeur n'a alors pas de signature Windows.

Le build signe pour la mise à jour avec la clé dont le chemin est dans la variable d'environnement
utilisateur `TAURI_SIGNING_PRIVATE_KEY` (sans mot de passe). **Ne jamais citer ni lire le fichier de clé**
dans une commande (le garde-fou `secret-guard` le refuse, à raison).

Après le commit et le tag (étape 5), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri:build` avec
`run_in_background`, **avant** de pousser quoi que ce soit. Puis, d'un seul enchaînement : pousser `main`
et le tag, publier à la main, et annuler le run du workflow que le tag a lancé s'il tourne
(`gh run cancel <id>`). Laissé seul, il échouerait de toute façon sur la release déjà publiée.

```bash
EXE="src-tauri/target/release/bundle/nsis/SealedScribe_X.Y.Z_x64-setup.exe"
ls -la "$EXE" "$EXE.sig"                       # tous deux datés de ce build
NOTES="<scratchpad>/release-notes-X.Y.Z.md"
sed -n '/^## X\.Y\.Z /,/^## /{/^## /!p}' CHANGELOG.md > "$NOTES"   # points échappés
# latest.json : lu par la mise à jour automatique des versions installées (endpoint de tauri.conf.json).
# La signature (.sig) est publique : c'est la clé privée qui ne doit jamais sortir du poste.
LATEST="<scratchpad>/latest.json"
python -I -c "
import json, sys, datetime
version, exe, notes, out = sys.argv[1:5]
json.dump({
  'version': version,
  'notes': open(notes, encoding='utf-8').read().strip(),
  'pub_date': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
  'platforms': {'windows-x86_64': {
    'signature': open(exe + '.sig', encoding='utf-8').read().strip(),
    'url': f'https://github.com/ACivilise/SealedScribe/releases/download/v{version}/' + exe.split('/')[-1],
  }},
}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
" X.Y.Z "$EXE" "$NOTES" "$LATEST"
git push origin "$(git branch --show-current)"
git push origin vX.Y.Z
GH_TOKEN="$(gh auth token --user ACivilise)" gh release create vX.Y.Z "$EXE" "$LATEST" \
  --repo ACivilise/SealedScribe --verify-tag --title "SealedScribe X.Y.Z" --notes-file "$NOTES"
```

Paquet du Store en secours : `bash packaging/msix/build-msix.sh X.Y.Z` après le build. Il réutilise
`src-tauri/target/release/meetscribe.exe`, puis on suit l'étape 7 avec `src-tauri/target/msix/`.
