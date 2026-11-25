#!/usr/bin/env bash
# Paquet MSIX de SealedScribe pour le Microsoft Store. Il n'est pas signé : le Store le signe à la
# publication. Utilisé en local et par .github/workflows/release.yml.
#
# Usage (Git Bash, après `npx tauri build --no-bundle`) : bash packaging/msix/build-msix.sh X.Y.Z
# Produit :
# - src-tauri/target/msix/SealedScribe_X.Y.Z.0_x64.msix, à envoyer dans l'Espace partenaires ;
# - src-tauri/target/msix/layout/, le paquet déplié. Avec le mode développeur de Windows, il s'installe
#   pour un test avec `Add-AppxPackage -Register <layout>\AppxManifest.xml`.
#
# Outils : makepri et makeappx du Windows SDK (présents avec les outils de build C++ et sur les
# machines Windows de GitHub).
set -euo pipefail

VERSION="${1:?Usage : build-msix.sh X.Y.Z}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version attendue au format X.Y.Z (reçu : $VERSION)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXE="$ROOT/src-tauri/target/release/meetscribe.exe"
ICONS="$ROOT/src-tauri/icons"
OUT="$ROOT/src-tauri/target/msix"
LAYOUT="$OUT/layout"
PACKAGE="$OUT/SealedScribe_${VERSION}.0_x64.msix"

if [ ! -f "$EXE" ]; then
  echo "Introuvable : $EXE (lancer d'abord npx tauri build --no-bundle)" >&2
  exit 1
fi

SDK_BIN="$(ls -d "/c/Program Files (x86)/Windows Kits/10/bin/"10.*/x64 2>/dev/null | sort -V | tail -1)"
MAKEPRI="$SDK_BIN/makepri.exe"
MAKEAPPX="$SDK_BIN/makeappx.exe"
if [ ! -x "$MAKEPRI" ] || [ ! -x "$MAKEAPPX" ]; then
  echo "makepri.exe ou makeappx.exe introuvable dans le Windows SDK" >&2
  exit 1
fi

rm -rf "$LAYOUT"
mkdir -p "$LAYOUT/Assets"
cp "$EXE" "$LAYOUT/"
sed "s/__VERSION__/${VERSION}.0/" "$ROOT/packaging/msix/AppxManifest.xml" > "$LAYOUT/AppxManifest.xml"

# Icônes générées par `tauri icon`. Les variantes « targetsize » sans fond (unplated) servent à la
# barre des tâches et au menu Démarrer ; sans elles, Windows pose l'icône sur un carré coloré.
cp "$ICONS/StoreLogo.png" "$LAYOUT/Assets/StoreLogo.png"
cp "$ICONS/Square150x150Logo.png" "$LAYOUT/Assets/Square150x150Logo.png"
cp "$ICONS/Square44x44Logo.png" "$LAYOUT/Assets/Square44x44Logo.png"
cp "$ICONS/32x32.png" "$LAYOUT/Assets/Square44x44Logo.targetsize-32_altform-unplated.png"
cp "$ICONS/128x128@2x.png" "$LAYOUT/Assets/Square44x44Logo.targetsize-256_altform-unplated.png"

# Les outils Windows attendent des chemins Windows, et des options en « /x » que Git Bash
# convertirait en chemins sans MSYS_NO_PATHCONV.
win() { cygpath -w "$1"; }
export MSYS_NO_PATHCONV=1

"$MAKEPRI" createconfig /cf "$(win "$OUT/priconfig.xml")" /dq en-US /pv 10.0.0 /o
"$MAKEPRI" new /pr "$(win "$LAYOUT")" /cf "$(win "$OUT/priconfig.xml")" \
  /mn "$(win "$LAYOUT/AppxManifest.xml")" /of "$(win "$LAYOUT/resources.pri")" /o
"$MAKEAPPX" pack /d "$(win "$LAYOUT")" /p "$(win "$PACKAGE")" /o

echo "Paquet MSIX : $PACKAGE"
