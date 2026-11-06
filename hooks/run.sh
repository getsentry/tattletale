#!/bin/sh
# Hooks run under GUI apps whose PATH often lacks node. Find one, then hand off. Never fail the agent.
root="$(cd "$(dirname "$0")/.." && pwd)"
node="${TATTLETALE_NODE:-}"
[ -z "$node" ] && [ -f "${TATTLETALE_HOME:-$HOME/.tattletale}/node-path" ] && node="$(cat "${TATTLETALE_HOME:-$HOME/.tattletale}/node-path")"
[ -x "$node" ] || node="$(command -v node 2>/dev/null)"
for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.volta/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$node" ] && break
  [ -x "$c" ] && node="$c"
done
[ -x "$node" ] || exit 0
cli="$root/dist/cli.js"
[ -f "$cli" ] || cli="$root/src/cli.ts"
exec "$node" --no-warnings "$cli" "$@" || exit 0
