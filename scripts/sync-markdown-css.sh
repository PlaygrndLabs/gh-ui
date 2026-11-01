#!/bin/sh
# Rebuilds src/styles/markdown.css from github-markdown-css, dropping the package's
# color-variable blocks so Primer's theme variables apply instead.
set -e
cd "$(dirname "$0")/.."
SRC=node_modules/github-markdown-css/github-markdown.css
START=$(grep -n '^\.markdown-body {' "$SRC" | sed -n 2p | cut -d: -f1)
{
  echo "/* Structural rules from github-markdown-css (MIT, Sindre Sorhus). Color variables come from the active Primer theme instead of the package's own media-query palettes, so markdown follows the app theme. Regenerate with scripts/sync-markdown-css.sh */"
  sed -n "${START},\$p" "$SRC"
  echo
  echo ".markdown-body { background-color: transparent; font-size: 14px; }"
} > src/styles/markdown.css
