#!/usr/bin/env bash
#
# Stage everything file-based onto a Kindle mounted over USB, so a rebuild after
# a factory reset doesn't mean re-doing the fiddly copying by hand.
#
# What this DOES (all of it is just files on the user store):
#   extensions/kindletodo/      -> <KINDLE>/extensions/kindletodo/   (incl. the Upstart unit)
#   fbink                       -> <KINDLE>/libkh/bin/fbink          (image-loop.sh hardcodes this path)
#   usbnetlite installer (.bin) -> <KINDLE>/mrpackages/               (staged; INSTALL happens on-device)
#   bin/config.local            -> the token (+ frontlight) from .env, so the board
#                                  can draw WITHOUT SSH ever existing
#   install scriptlet           -> <KINDLE>/documents/KindleTodo-Install.sh — shows up
#                                  as a book; opening it installs the Upstart job
#                                  AS ROOT (hdnext scriptlets run as root — verified
#                                  on the PW4, 2026-09-12)
#   usbnetlite config           -> <KINDLE>/usbnetlite/etc/config (+ optional enable flag)
#   error screens               -> <KINDLE>/extensions/kindletodo/assets/err-*.png
#
# What this CANNOT do — these need the jailbreak's root hooks live on the device:
#   * run the jailbreak / install its persistence
#   * INSTALL usbnetlite (its installer symlinks dropbear into /usr and drops two
#     Upstart jobs into /etc — root filesystem, not exposed over USB)
#
# So a reset is: jailbreak -> stage this -> open the "Kindle Todo - install boot
# service" book -> reboot. SSH (usbnetlite) is maintenance, not a prerequisite.
# See docs/recovery-rebuild.md for the full runbook.
#
# Usage:
#   scripts/stage-usb.sh [/path/to/mounted/Kindle]
#
# With no argument it auto-detects a mounted volume labelled "Kindle".
# Third-party binaries are cached in vendor/ (gitignored — see VENDORING at the
# bottom).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"

# usbnetlite ships as an MRPI/hotfix update package, not a zip. Pinned on
# purpose: a silent "latest" is how a recovery path rots between the day you
# write it and the day you need it. The "_11thgenplus" variant is for newer
# devices; the PW4 (10th gen) wants the plain one.
USBNETLITE_VERSION="${USBNETLITE_VERSION:-1.0.M}"
USBNETLITE_BIN="${USBNETLITE_BIN:-Update_usbnetlite_${USBNETLITE_VERSION}_install_khf.bin}"
USBNETLITE_URL="https://github.com/notmarek/kindle-usbnetlite/releases/download/${USBNETLITE_VERSION}/${USBNETLITE_BIN}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok: %s\n' "$*"; }
warn() { printf '  WARN: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- locate the Kindle -------------------------------------------------------
detect_kindle() {
  local m
  for m in /run/media/"$USER"/Kindle /media/"$USER"/Kindle; do
    [ -d "$m" ] && { printf '%s' "$m"; return 0; }
  done
  m="$(lsblk -o LABEL,MOUNTPOINT -nr 2>/dev/null | awk '$1=="Kindle" && $2!="" {print $2; exit}' || true)"
  [ -n "$m" ] && { printf '%s' "$m"; return 0; }
  return 1
}

KINDLE="${1:-}"
if [ -z "$KINDLE" ]; then
  KINDLE="$(detect_kindle)" || die "no mounted Kindle found — plug it in, enter USB drive mode, mount it, or pass the path explicitly"
fi
[ -d "$KINDLE" ] || die "not a directory: $KINDLE"

# Guard against staging into the wrong place: a real Kindle user store has these.
# (Section 1 syncs with --delete, so this matters.)
if [ ! -d "$KINDLE/documents" ] || [ ! -d "$KINDLE/system" ]; then
  die "$KINDLE doesn't look like a Kindle user store (no documents/ + system/) — refusing to write"
fi
say "Staging to: $KINDLE"
say

# The ops .env (never committed) supplies the token for the error screens and
# the SSH password we pre-seed into usbnetlite's config. Optional: without it,
# those two steps are skipped with a warning and `deploy` covers them later.
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
BASE_URL="${BASE_URL:-https://todo.dalagerlabs.com}"

mkdir -p "$VENDOR"
fetch() {  # fetch <url> <dest>  — cached; no-op if already present
  local url="$1" dest="$2"
  [ -s "$dest" ] && return 0
  say "  fetching $(basename "$dest") ..."
  curl -fsSL "$url" -o "$dest.part" || { rm -f "$dest.part"; return 1; }
  mv "$dest.part" "$dest"
}

# --- 1. the extension --------------------------------------------------------
say "1. extension -> extensions/kindletodo/"
DEST="$KINDLE/extensions/kindletodo"
mkdir -p "$DEST"
# Sync the tracked extension, but never clobber device-local state: config.local
# (the token), the DISABLE kill-switch, assets/ (deploy fetches them) and the
# device's own image.log. --modify-window=2 because FAT stores mtimes at 2 s
# granularity; without it every run re-copies everything.
if command -v rsync >/dev/null 2>&1; then
  rsync -rt --modify-window=2 --delete \
    --exclude 'config.local' --exclude 'DISABLE' --exclude 'assets/' \
    --exclude 'image.log' --exclude 'image.log.*' \
    "$ROOT/extensions/kindletodo/" "$DEST/"
else
  warn "rsync not found — copying without --delete (stale files on the device are left alone)"
  ( cd "$ROOT/extensions/kindletodo" && find . -type f \
      ! -name config.local ! -name DISABLE ! -path './assets/*' ! -name 'image.log*' \
      -exec cp --parents {} "$DEST/" \; )
fi
chmod +x "$DEST/bin/"*.sh 2>/dev/null || true   # no-op on FAT, harmless
ok "extensions/kindletodo/ (incl. kindletodo.upstart.conf)"

# The device-local config `scripts/kindle.sh deploy` normally writes over SSH.
# Writing it here is what lets the board come up before SSH exists.
if [ -n "${TODO_TOKEN:-}" ]; then
  {
    printf 'TODO_TOKEN="%s"\n' "$TODO_TOKEN"
    [ -n "${KINDLE_FLINTENSITY:-}" ] && printf 'FLINTENSITY=%s\n' "$KINDLE_FLINTENSITY"
  } > "$DEST/bin/config.local"
  ok "bin/config.local (token from .env)"
else
  warn "TODO_TOKEN not set — no config.local; the kiosk will draw 'token mismatch' until deploy runs"
fi

# --- 1b. the install scriptlet ---------------------------------------------
# hdnext/KPM contract: a #!/bin/sh in documents/ with these header comments is
# listed as a book and executed (as root) when opened. This does the one step
# USB can't: put the Upstart job on the root filesystem. It logs to
# extensions/kindletodo/install-scriptlet.log so the result is readable over USB.
say "1b. install scriptlet -> documents/KindleTodo-Install.sh"
cat > "$KINDLE/documents/KindleTodo-Install.sh" <<'SCRIPTLET'
#!/bin/sh
# Name: Kindle Todo - install boot service
# Author: kindletodo
# DontUseFBInk
DIR=/mnt/us/extensions/kindletodo
LOG=$DIR/install-scriptlet.log
{
  echo "=== $(date) ==="
  echo "id: $(id)"
  if [ "$(id -u)" != "0" ]; then echo "NOT ROOT - aborting"; exit 0; fi
  mntroot rw && cp -f "$DIR/kindletodo.upstart.conf" /etc/upstart/kindletodo.conf && echo "upstart conf installed"
  mntroot ro
  # reload-configuration can time out on D-Bus and still take effect; status is the real check
  initctl reload-configuration 2>&1
  ls -la /etc/upstart/kindletodo.conf /mnt/us/libkh/bin/fbink "$DIR/bin/config.local" 2>&1
  initctl status kindletodo 2>&1
  echo "done - reboot to start the kiosk"
} >> "$LOG" 2>&1
SCRIPTLET
ok "documents/KindleTodo-Install.sh (open it on the device, then reboot)"

# --- 2. fbink (libkh) --------------------------------------------------------
# image-loop.sh has FBINK=/mnt/us/libkh/bin/fbink hardcoded. Without it the
# kiosk polls happily and draws NOTHING — draw_png sends stderr to /dev/null, so
# it fails silently and looks like a Worker problem.
#
# There is no prebuilt binary to download: FBInk's GitHub release is a source
# tarball. Two real sources, in order of preference:
#   a) vendor/fbink — harvested once from a working device (see VENDORING)
#   b) the KOReader install on this very drive: koreader/fbink (KOReader bundles
#      the fbink CLI; its launcher copies that file before use)
say "2. fbink -> libkh/bin/fbink"
FBINK_SRC=""
if   [ -s "$VENDOR/fbink" ];          then FBINK_SRC="$VENDOR/fbink"; FBINK_FROM="vendor/fbink"
elif [ -s "$KINDLE/koreader/fbink" ]; then FBINK_SRC="$KINDLE/koreader/fbink"; FBINK_FROM="koreader/fbink on the device"
fi
if [ -n "$FBINK_SRC" ]; then
  mkdir -p "$KINDLE/libkh/bin"
  cp "$FBINK_SRC" "$KINDLE/libkh/bin/fbink"
  ok "libkh/bin/fbink (from $FBINK_FROM)"
  # Harvest into vendor/ so the next rebuild doesn't depend on KOReader being there.
  if [ "$FBINK_SRC" != "$VENDOR/fbink" ]; then
    cp "$FBINK_SRC" "$VENDOR/fbink" && chmod +x "$VENDOR/fbink" && ok "harvested a copy into vendor/fbink"
  fi
else
  warn "no fbink staged — the kiosk will draw NOTHING and fail silently without it"
  warn "fix: install KOReader on the device (;kpm install koreader) and re-run this,"
  warn "     or  scripts/kindle.sh ssh 'cat /mnt/us/libkh/bin/fbink' > vendor/fbink  from a working unit"
fi

# --- 3. usbnetlite (staged for on-device install) ----------------------------
# The installer is an update package: on the device it goes into mrpackages/
# and is triggered from the search bar. Its install.sh needs root (dropbear
# symlinks in /usr, two Upstart jobs in /etc). We stage the package and pre-seed
# what lives on the user store:
#   usbnetlite/etc/config  — the installer PRESERVES a config whose md5 differs
#                            from its default, so seeding the password here means
#                            SSH comes up with KINDLE_SSH_PASS on first boot
#   usbnetlite/auto        — the enable flag its Upstart job checks
say "3. usbnetlite -> mrpackages/ (+ config, enable flag)"
if fetch "$USBNETLITE_URL" "$VENDOR/$USBNETLITE_BIN"; then
  mkdir -p "$KINDLE/mrpackages"
  cp "$VENDOR/$USBNETLITE_BIN" "$KINDLE/mrpackages/"
  ok "mrpackages/$USBNETLITE_BIN"
else
  warn "could not fetch $USBNETLITE_BIN — install usbnetlite on-device instead (check ;kpm)"
fi
if [ -n "${KINDLE_SSH_PASS:-}" ]; then
  mkdir -p "$KINDLE/usbnetlite/etc"
  # sh-sourced on the device: single-quote the password, escaping embedded quotes.
  pw_sq="$(printf '%s' "$KINDLE_SSH_PASS" | sed "s/'/'\\\\''/g")"
  cat > "$KINDLE/usbnetlite/etc/config" <<CFG
#!/bin/sh

# IPv4 only
KINDLE_IP=192.168.15.244

# Enable password override
PASSWORD_OVERRIDE_ENABLED="true"
PASSWORD='${pw_sq}'

# Disabling this will enforce private key login
ALLOW_PASSWORD_LOGIN="true"

# SSH port
PORT="22"

# Enable ssh over wifi
USE_WIFI="true"

TWEAK_MAC_ADDRESS="false"
CFG
  ok "usbnetlite/etc/config (password = KINDLE_SSH_PASS from .env)"
else
  warn "KINDLE_SSH_PASS not set — usbnetlite will come up with its default password 'kindle'; change it"
fi
# The enable flag is OPT-IN. With it present, USB comes up as a network gadget
# (RNDIS) at every boot, so USB DRIVE MODE IS UNAVAILABLE — and the drive is the
# one channel that survived the 2026-09-12 lockout. Create it only once the
# board is drawing and you want SSH:  STAGE_USBNET_AUTO=1 scripts/stage-usb.sh
if [ "${STAGE_USBNET_AUTO:-0}" = "1" ]; then
  mkdir -p "$KINDLE/usbnetlite"; : > "$KINDLE/usbnetlite/auto"
  ok "usbnetlite/auto (enable flag) — USB drive mode will be unavailable while it exists"
  say "     to get the drive back: scripts/kindle.sh ssh 'rm /mnt/us/usbnetlite/auto; reboot'"
else
  say "     enable flag NOT created (STAGE_USBNET_AUTO=1 to create usbnetlite/auto)"
fi

# --- 4. error screens --------------------------------------------------------
# Same PNGs `scripts/kindle.sh deploy` fetches; staging them means the device
# has its fallbacks even before it can reach the Worker.
say "4. error screens -> extensions/kindletodo/assets/"
if [ -n "${TODO_TOKEN:-}" ]; then
  mkdir -p "$DEST/assets"
  for kind in nowifi notfound unauthorized server battery; do
    if curl -fsS "$BASE_URL/error/$kind.png?t=$TODO_TOKEN" -o "$DEST/assets/err-$kind.png"; then
      ok "err-$kind.png"
    else
      warn "could not fetch err-$kind.png (deploy will retry later)"
    fi
  done
else
  warn "TODO_TOKEN not set (no .env?) — skipping; scripts/kindle.sh deploy fetches them"
fi

# --- done --------------------------------------------------------------------
sync
say
say "Staged. Eject the drive, then on the DEVICE:"
say "  1. if not jailbroken yet: run SpiderCat (open the spidercat book); root must be"
say "     live for step 2 — it does NOT survive a reboot until persistence is installed"
say "  2. open the book 'Kindle Todo - install boot service' (installs the Upstart job as root;"
say "     result in extensions/kindletodo/install-scriptlet.log)"
say "  3. reboot — the board should draw within ~1 min of the home screen"
say "  optional, for SSH later: install usbnetlite from mrpackages/ (;log mrpi — the"
say "     package's documented trigger; unverified on hdnext), then STAGE_USBNET_AUTO=1"
say "     and:  scripts/kindle.sh deploy && scripts/kindle.sh status"
say
say "Full runbook: docs/recovery-rebuild.md"

# --- VENDORING ---------------------------------------------------------------
# vendor/ is gitignored, so a fresh clone re-fetches the usbnetlite package from
# upstream and needs a fbink source (KOReader on the drive, or a harvested copy).
# For a recovery path that works offline and survives upstream going away,
# un-ignore vendor/ and commit the pinned files. FBInk is GPLv3 — if you commit
# the binary, record its version and where it came from alongside it.
