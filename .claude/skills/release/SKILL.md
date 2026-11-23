---
name: release
description: Publie une version de SealedScribe. Met à jour CHANGELOG.md (affiché dans « Nouveautés »), monte la version, construit l'installeur NSIS et le pousse en GitHub Release. À utiliser pour « release », « publier une version », « mettre à jour le changelog », « builder l'installeur », « pousser l'exe sur GitHub ». Argument facultatif : la version (ex. `0.2.0`).
---

# Release SealedScribe

Une release = une section du `CHANGELOG.md` + la même version dans trois fichiers + un tag `vX.Y.Z`
+ une GitHub Release (dépôt public `ACivilise/SealedScribe`) portant l'installeur NSIS.
`src/lib/releaseNotes.test.ts` est la **garde** : il échoue si le changelog sort du format ou si sa
dernière version diffère de celle des fichiers de version.

Commandes en Git Bash (pas de script PowerShell). Le commit et le tag sont au seul nom de l'utilisateur.

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
- Mettre `X.Y.Z` dans `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`
  (champ `version` du paquet, ligne 3 de chacun). `Cargo.lock` et `package-lock.json` sont ignorés par git.
- Montrer la section à l'utilisateur.

**Fait quand** chaque commit `feat` / `fix` de la plage est couvert par une puce ou délibérément écarté.

### 4. Tests

`npm test` puis `npx tsc --noEmit`. **Fait quand** les deux passent (la garde valide format et versions).

### 5. Build

L'installeur est signé pour la mise à jour automatique (`bundle.createUpdaterArtifacts`, plugin updater) :
le build lit le chemin de la clé privée dans la variable d'environnement utilisateur
`TAURI_SIGNING_PRIVATE_KEY`, réglée une fois pour toutes par l'utilisateur. La clé n'a pas de mot de passe.
**Ne jamais citer ni lire le fichier de clé** dans une commande (le garde-fou `secret-guard` le refuse, à raison) :
si le build échoue faute de clé, demander à l'utilisateur de régler la variable puis de relancer Claude Code.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri:build` avec `run_in_background` (un build Rust release
dépasse souvent 10 min) ; attendre la notification de fin. Le nom de l'installeur suit la version de
`tauri.conf.json`, et sa signature est écrite à côté :

```bash
EXE="src-tauri/target/release/bundle/nsis/SealedScribe_X.Y.Z_x64-setup.exe"
ls -la "$EXE" "$EXE.sig"
```

Échec du build : s'arrêter, montrer l'erreur, ne rien committer.
**Fait quand** `$EXE` et `$EXE.sig` existent et datent de ce build.

### 6. Commit et tag

```bash
git add CHANGELOG.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "SealedScribe X.Y.Z"
```

Le message de commit tient en cette seule ligne.

### 7. Publication

Action visible hors du poste : obtenir d'abord une confirmation explicite (version, branche, chemin et
taille de l'exe, notes). Puis :

```bash
git push origin "$(git branch --show-current)"
git push origin vX.Y.Z
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
GH_TOKEN="$(gh auth token --user ACivilise)" gh release create vX.Y.Z "$EXE" "$LATEST" \
  --repo ACivilise/SealedScribe --verify-tag --title "SealedScribe X.Y.Z" --notes-file "$NOTES"
```

Ne jamais pousser vers `origin` les tags ou l'historique du remote `archive` (ancien dépôt privé MeetScribe).

`GH_TOKEN` cible le compte perso quel que soit le compte `gh` actif (un compte professionnel est aussi connecté).
**Fait quand** `gh release view vX.Y.Z --repo ACivilise/SealedScribe --json url,assets` montre l'exe et
`latest.json`, et que `curl -sL https://github.com/ACivilise/SealedScribe/releases/latest/download/latest.json`
renvoie la nouvelle version (c'est ce que lisent les applications installées).

### 8. Rapport

URL de la release, version et taille de l'installeur (dépôt public : téléchargeable sans compte GitHub).
