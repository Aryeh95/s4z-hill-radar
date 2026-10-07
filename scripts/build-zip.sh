#!/bin/sh
# Build the release zip for the Sauce mod store: dist/hill-radar-<version>.zip
# containing a single hill-radar/ folder with only the files Sauce needs.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/hill-radar-$version.zip"
tmp=$(mktemp -d)
mkdir -p "$tmp/hill-radar" dist
cp -r manifest.json pages LICENSE README.md CHANGELOG.md logo.png "$tmp/hill-radar/"
rm -f "$out"
(cd "$tmp" && zip -qrX "$OLDPWD/$out" hill-radar)
rm -rf "$tmp"
echo "$out"
