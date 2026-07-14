#!/bin/sh
# Kindle Todo — boot entry for non-interactive image mode (kiosk).
# Launched by the Upstart job (/etc/upstart/kindletodo.conf) after boot.
#
# Stops the ENTIRE display stack (the `x` Upstart job: lxinit + framework +
# pillow + the `blanket` screensaver), so nothing repaints over our fbink image.
# Stopping `lab126_gui` alone is NOT enough — `blanket` keeps running under `x`
# and, while charging, paints the battery/charge screen over us. `x_monitor`
# only restarts `x` on failure, so a clean `stop x` stays down.
#
# Revert to a normal Kindle: remove /etc/upstart/kindletodo.conf and `start x`
# (or just reboot after removing).

# Kill switch / escape hatch. If this file exists we do NOT take over the panel,
# leaving the normal Kindle UI (KUAL, Wi-Fi settings, KOReader) reachable. Drop
# it over USB — no shell or Wi-Fi needed — to recover when the kiosk has locked
# you out (e.g. the Wi-Fi changed and you can't SSH in). `touch DISABLE`.
DIR="$(dirname "$0")"
if [ -f "$DIR/../DISABLE" ] || [ -f "$DIR/DISABLE" ]; then
  echo "$(date) DISABLE flag present — not starting kiosk" >> "$DIR/../image.log" 2>/dev/null
  exit 0
fi

# The access token is NOT committed. It lives in an uncommitted device-local
# config next to this script (config.local), provisioned by `scripts/kindle.sh
# deploy` from the repo .env. See config.example.sh for the format.
CONF="$DIR/config.local"
[ -f "$CONF" ] && . "$CONF"
BASE_URL="${BASE_URL:-https://todo.dalagerlabs.com}"
URL="${BASE_URL}/todo.png?t=${TODO_TOKEN}"
INTERVAL="${INTERVAL:-15}"
# Frontlight 0=off .. 24=max. e-ink is readable in a lit room with 0; raise it
# in config.local (FLINTENSITY=...) if the spot is dim.
FLINTENSITY="${FLINTENSITY:-0}"

# Let boot + Wi-Fi settle (Wi-Fi associates during startup).
sleep 20

# Clock sanity. The RTC lives in the BD71827 PMIC and is backed by the MAIN
# battery (no coin cell), so a full discharge resets the clock — and a wrong
# clock fails every TLS cert check, which looks exactly like "no Wi-Fi" and
# never self-heals. The stock NTP sync lives in the framework we stop, so fix
# it ourselves from a plain-HTTP Date header (no TLS, no chicken-and-egg).
fix_clock() {
  [ "$(date +%Y)" -ge 2024 ] && return 0
  d=$(curl -sI --max-time 5 http://cloudflare.com 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p')
  # "Tue, 14 Jul 2026 10:28:56 GMT" -> busybox "YYYY.MM.DD-hh:mm:ss"
  set -- $d
  [ $# -ge 5 ] || return 1
  case "$3" in
    Jan) m=01;; Feb) m=02;; Mar) m=03;; Apr) m=04;; May) m=05;; Jun) m=06;;
    Jul) m=07;; Aug) m=08;; Sep) m=09;; Oct) m=10;; Nov) m=11;; Dec) m=12;;
    *) return 1;;
  esac
  date -u -s "$4.$m.$2-$5" >/dev/null 2>&1 || return 1
  hwclock -w 2>/dev/null
  echo "$(date) clock synced from HTTP Date header" >> "$DIR/../image.log" 2>/dev/null
}
fix_clock

# Take over the panel: stop the whole X/display stack.
stop x 2>/dev/null

# Wait for the stack to fully exit before the first draw, so a dying frame
# (charge/screensaver) can't land on top of our image.
i=0
while [ $i -lt 20 ]; do
  ps -ef 2>/dev/null | grep -qE "[p]illow|[b]lanket|[a]wesome|[l]xinit" || break
  i=$((i + 1))
  sleep 1
done
sleep 3

# Keep the panel awake and set the frontlight (FLINTENSITY, default 0=off).
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
lipc-set-prop com.lab126.powerd flIntensity "$FLINTENSITY" 2>/dev/null

# The i.MX6SLL has two P-states (396/996 MHz) and boots pinned to
# `performance`. The kiosk is one curl + occasional fbink per 15s — 396 MHz
# is ample (e-ink refresh is EPDC-bound, not CPU-bound). Less heat, and
# longer battery ride-through during a power cut.
echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null

exec /bin/sh /mnt/us/extensions/kindletodo/bin/image-loop.sh "$URL" "$INTERVAL"
