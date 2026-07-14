#!/bin/sh
# Kindle Todo — non-interactive image mode.
#
# Polls the PNG endpoint with a conditional request (ETag). The server returns
# a tiny 304 when nothing changed, so we ONLY download + redraw e-ink when the
# todo state actually changes. No idle redraws => no blinking when unchanged.
#
# When the Worker is UNREACHABLE (no Wi-Fi, wrong URL, auth mismatch, server
# error) there's no image to draw, so after a few consecutive failures we draw a
# local fallback PNG from assets/ (pre-downloaded by `scripts/kindle.sh deploy`).
# We draw it once and stay quiet until connectivity returns — no e-ink flashing.
#
# Usage: image-loop.sh <url> [interval_seconds]

URL="${1:?usage: image-loop.sh <url> [interval]}"
INTERVAL="${2:-15}"

FBINK=/mnt/us/libkh/bin/fbink
ETAG=/tmp/kindletodo.etag
PNG=/tmp/kindletodo.png
DIR=/mnt/us/extensions/kindletodo
ASSETS="$DIR/assets"
LOG="$DIR/image.log"

# Consecutive failures tolerated before we replace the (stale) list with an
# error screen. At INTERVAL=15s, 4 ≈ one minute of grace.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-4}"

# Battery telemetry (BD71827 PMIC). If the charger dies the board would drain
# silently for days and then just go dark — warn on the panel instead.
BATT=/sys/class/power_supply/bd71827_bat
BATT_THRESHOLD="${BATT_THRESHOLD:-20}"

# Keep the device awake so the screensaver doesn't paint over our image.
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

# Keep the log bounded: past ~256 KB, keep only the recent tail. (Appended to
# forever otherwise — hourly battery lines alone add up over months.)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null)" -gt 262144 ] 2>/dev/null; then
  tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

echo "$(date) image-loop start interval=${INTERVAL}s" >> "$LOG"

state=ok          # ok | nowifi | notfound | unauthorized | server
fails=0
batt_warned=0     # battery warning is separate from the network state machine
iter=0

draw_png() { "$FBINK" -f -W GC16 -g file="$1" >/dev/null 2>&1; }
draw_text() { "$FBINK" -c -m -y 20 "$1" >/dev/null 2>&1; }  # last-resort if asset missing

# A reset clock (RTC dies with the main battery) fails all TLS => curl 000
# forever. If the year is obviously wrong, resync from a plain-HTTP Date
# header. The year guard makes this a no-op on healthy systems.
fix_clock() {
  [ "$(date +%Y)" -ge 2024 ] && return 0
  d=$(curl -sI --max-time 5 http://cloudflare.com 2>/dev/null | tr -d '\r' | sed -n 's/^[Dd]ate: //p')
  set -- $d
  [ $# -ge 5 ] || return 1
  case "$3" in
    Jan) m=01;; Feb) m=02;; Mar) m=03;; Apr) m=04;; May) m=05;; Jun) m=06;;
    Jul) m=07;; Aug) m=08;; Sep) m=09;; Oct) m=10;; Nov) m=11;; Dec) m=12;;
    *) return 1;;
  esac
  date -u -s "$4.$m.$2-$5" >/dev/null 2>&1 || return 1
  hwclock -w 2>/dev/null
  echo "$(date) clock synced from HTTP Date header" >> "$LOG"
}

# Warn once when discharging below the threshold; when the charger returns,
# clear the ETag so the next poll returns a body and the list replaces the
# warning. Also logs an hourly battery trend line.
check_battery() {
  [ -r "$BATT/status" ] || return 0
  bstat=$(cat "$BATT/status" 2>/dev/null)
  bcap=$(cat "$BATT/capacity" 2>/dev/null || echo 100)
  iter=$((iter + 1))
  [ $((iter % 240)) -eq 0 ] && echo "$(date) battery ${bcap}% ${bstat}" >> "$LOG"
  if [ "$bstat" = "Discharging" ] && [ "$bcap" -lt "$BATT_THRESHOLD" ] 2>/dev/null; then
    if [ "$batt_warned" = 0 ]; then
      if [ -f "$ASSETS/err-battery.png" ]; then
        draw_png "$ASSETS/err-battery.png"
      else
        draw_text "Battery low (${bcap}%). Plug the Kindle in."
      fi
      batt_warned=1
      echo "$(date) battery warning drawn (${bcap}%)" >> "$LOG"
    fi
  elif [ "$batt_warned" = 1 ]; then
    batt_warned=0
    rm -f "$ETAG"  # force a 200 next poll so the list replaces the warning
    echo "$(date) battery recovered (${bcap}% ${bstat})" >> "$LOG"
  fi
}

# Draw an error screen once; do nothing if it's already on screen (no flashing).
show_error() {
  kind="$1"; msg="$2"
  [ "$state" = "$kind" ] && return
  if [ -f "$ASSETS/err-$kind.png" ]; then
    draw_png "$ASSETS/err-$kind.png"
  else
    draw_text "$msg"
  fi
  state="$kind"
  echo "$(date) error screen: $kind (code=$code)" >> "$LOG"
}

while true; do
  check_battery

  if [ "$state" = "ok" ]; then
    # Healthy: conditional GET (304 when unchanged).
    code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" \
           --etag-compare "$ETAG" --etag-save "$ETAG" "$URL" 2>/dev/null)
  else
    # Showing an error: force an unconditional GET so recovery always returns a
    # body to draw (a conditional 304 would otherwise strand us on the error).
    code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" \
           --etag-save "$ETAG" "$URL" 2>/dev/null)
  fi

  if [ "$code" = "200" ] && [ -s "${PNG}.tmp" ]; then
    mv "${PNG}.tmp" "$PNG"
    draw_png "$PNG"
    fails=0; state=ok
    echo "$(date) redraw (changed)" >> "$LOG"
  elif [ "$code" = "304" ]; then
    rm -f "${PNG}.tmp"
    fails=0            # unchanged and healthy
  else
    rm -f "${PNG}.tmp"
    fix_clock  # no-op unless the clock is obviously wrong (post-deep-discharge)
    fails=$((fails + 1))
    if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
      case "$code" in
        401|403) show_error unauthorized "Access token mismatch. Re-run kindle.sh deploy." ;;
        404)     show_error notfound "Server not found. Check the deploy." ;;
        5??)     show_error server "Server error. Retrying..." ;;
        200)     show_error server "Empty response. Retrying..." ;;  # 200 but no body
        *)       show_error nowifi "No Wi-Fi. See github.com/dalager/kindle-todo" ;;  # 000, DNS, TLS
      esac
    fi
  fi
  sleep "$INTERVAL"
done
