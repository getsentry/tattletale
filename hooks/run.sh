#!/bin/sh
# Hooks run under GUI apps whose PATH often lacks node. Find one new enough, then hand off. Never fail the agent.
root="$(cd "$(dirname "$0")/.." && pwd)"
home="${TATTLETALE_HOME:-$HOME/.tattletale}"
min=22018000 # Node 22.18, as in package.json engines
ver() { "$1" --version 2>/dev/null | awk -F'[v.]' '{ print $2 * 1000000 + $3 * 1000 + $4 }'; }
ok() { [ -n "$1" ] && [ -x "$1" ] && [ "$(ver "$1")" -ge "$min" ] 2>/dev/null; }

node=""
for c in "${TATTLETALE_NODE:-}" "$(cat "$home/node-path" 2>/dev/null)" "$(command -v node 2>/dev/null)"; do
  ok "$c" && node="$c" && break
done
if [ -z "$node" ]; then
  # Version managers list installs alphabetically (v18 before v24): take the newest.
  best=0
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.volta/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node "$HOME"/.local/share/mise/installs/node/*/bin/node; do
    [ -x "$c" ] || continue
    v="$(ver "$c")"
    [ "${v:-0}" -gt "$best" ] && best="$v" && node="$c"
  done
  [ "$best" -ge "$min" ] || node=""
fi
if [ -z "$node" ]; then
  mkdir -p "$home" && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [run.sh] no Node >= 22.18 found; install one or set TATTLETALE_NODE" >>"$home/tattletale.log"
  exit 0
fi
cli="$root/dist/cli.js"
[ -f "$cli" ] || cli="$root/src/cli.ts"
exec "$node" --no-warnings "$cli" "$@" || exit 0
