#!/usr/bin/env bash
# Vendors the third-party runtime the bridge needs into node_modules/.
#
# The bridge is not a fork of oh-my-openagent: it loads the published engine and
# translates its V1 plugin surface to the V2 plugin API. The engine is vendored
# rather than committed so this repository contains only bridge code.
#
# Usage: scripts/vendor.sh [engine-version]
set -euo pipefail

VERSION="${1:-5.1.33}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT/node_modules"

# Preferred source: the copy OpenCode already downloaded for the V1 config.
CACHE_HIT="$(ls -d "$HOME"/.cache/opencode/npm/oh-my-opencode@*/**/node_modules/oh-my-opencode 2>/dev/null | head -1 || true)"

if [ -n "$CACHE_HIT" ]; then
  echo "vendoring oh-my-opencode from OpenCode's npm cache: $CACHE_HIT"
  rm -rf "$ROOT/node_modules/oh-my-opencode"
  cp -R "$CACHE_HIT" "$ROOT/node_modules/oh-my-opencode"
else
  echo "no cache hit; installing oh-my-opencode@$VERSION from the registry"
  npm install --prefix "$ROOT" --no-save "oh-my-opencode@$VERSION"
fi

if [ ! -d "$ROOT/node_modules/zod" ]; then
  ZOD_SOURCE="$HOME/.opencode/node_modules/zod"
  if [ -d "$ZOD_SOURCE" ]; then
    echo "vendoring zod from $ZOD_SOURCE"
    cp -R "$ZOD_SOURCE" "$ROOT/node_modules/zod"
  else
    npm install --prefix "$ROOT" --no-save zod@^4
  fi
fi

node -e "const p=require('$ROOT/node_modules/oh-my-opencode/package.json'); console.log('engine:', p.name, p.version)"
node -e "const p=require('$ROOT/node_modules/zod/package.json'); console.log('zod:', p.version)"
