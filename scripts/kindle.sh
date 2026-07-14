#!/usr/bin/env bash
#
# Kindle helper — uses the repo .env so you never scan the LAN for the device
# again. Password auth is handled via SSH_ASKPASS (no sshpass needed).
#
# Usage:
#   scripts/kindle.sh ssh [command...]   SSH in (interactive shell, or run a command)
#   scripts/kindle.sh deploy             push bin/*.sh + write the token, restart service
#   scripts/kindle.sh logs               tail the device image log
#   scripts/kindle.sh status             show service + a live /todo.png fetch code
#
# Reads from .env:  KINDLE_IP, KINDLE_SSH_PASS, TODO_TOKEN
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy .env.example to .env and fill it in." >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

: "${KINDLE_IP:?set KINDLE_IP in .env}"
: "${KINDLE_SSH_PASS:?set KINDLE_SSH_PASS in .env}"

DEVDIR=/mnt/us/extensions/kindletodo

# --- password auth without sshpass: a tiny askpass that echoes $KPW ---
ASK="$(mktemp)"; trap 'rm -f "$ASK"' EXIT
printf '#!/bin/sh\nprintf "%%s" "$KPW"\n' > "$ASK"; chmod +x "$ASK"
_ssh_env() { KPW="$KINDLE_SSH_PASS" SSH_ASKPASS="$ASK" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 setsid -w "$@"; }
kssh() { _ssh_env ssh -o StrictHostKeyChecking=accept-new "root@$KINDLE_IP" "$@"; }
kscp() { _ssh_env scp -o StrictHostKeyChecking=accept-new "$@"; }

cmd="${1:-}"; [ $# -gt 0 ] && shift || true
case "$cmd" in
  ssh)
    kssh "$@"
    ;;
  deploy)
    : "${TODO_TOKEN:?set TODO_TOKEN in .env}"
    BASE_URL="${BASE_URL:-https://todo.dalagerlabs.com}"
    echo "Copying scripts to $KINDLE_IP:$DEVDIR/bin/ ..."
    kscp "$ROOT"/extensions/kindletodo/bin/*.sh "root@$KINDLE_IP:$DEVDIR/bin/"
    echo "Writing device config (token) ..."
    printf 'TODO_TOKEN="%s"\n' "$TODO_TOKEN" | kssh "cat > $DEVDIR/bin/config.local && chmod 600 $DEVDIR/bin/config.local"
    # Pre-download the error screens the device draws when the Worker is
    # unreachable (rendered by the Worker so they match the real look).
    echo "Fetching error screens from $BASE_URL ..."
    ADIR="$(mktemp -d)"
    for kind in nowifi notfound unauthorized server; do
      if curl -fsS "$BASE_URL/error/$kind.png?t=$TODO_TOKEN" -o "$ADIR/err-$kind.png"; then
        echo "  ok: err-$kind.png"
      else
        echo "  WARN: could not fetch err-$kind.png (device keeps a text fallback)"
      fi
    done
    if ls "$ADIR"/err-*.png >/dev/null 2>&1; then
      kssh "mkdir -p $DEVDIR/assets"
      kscp "$ADIR"/err-*.png "root@$KINDLE_IP:$DEVDIR/assets/"
    fi
    rm -rf "$ADIR"
    echo "Restarting service ..."
    kssh "chmod +x $DEVDIR/bin/*.sh; restart kindletodo 2>/dev/null || start kindletodo; sleep 1; initctl status kindletodo"
    echo "Done. Give it ~25s (boot settle) then check: scripts/kindle.sh logs"
    ;;
  logs)
    kssh "tail -n ${1:-20} $DEVDIR/image.log"
    ;;
  status)
    kssh 'initctl status kindletodo; . '"$DEVDIR"'/bin/config.local 2>/dev/null; curl -s -o /dev/null -w "todo.png -> code=%{http_code}\n" "${BASE_URL:-https://todo.dalagerlabs.com}/todo.png?t=$TODO_TOKEN"'
    ;;
  *)
    echo "usage: scripts/kindle.sh {ssh [cmd]|deploy|logs [n]|status}" >&2
    exit 2
    ;;
esac
