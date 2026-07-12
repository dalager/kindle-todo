#!/bin/sh
# Kindle Todo — non-interactive image mode.
#
# Polls the PNG endpoint with a conditional request (ETag). The server returns
# a tiny 304 when nothing changed, so we ONLY download + redraw e-ink when the
# todo state actually changes. No idle redraws => no blinking when unchanged.
#
# Exception: a few one-shot "settle" redraws in the first minutes after start,
# to clear any boot-time artifact (the framework/charge indicator that can paint
# over our first image). After that, redraws happen only on change.
#
# Usage: image-loop.sh <url> [interval_seconds]

URL="${1:?usage: image-loop.sh <url> [interval]}"
INTERVAL="${2:-15}"

FBINK=/mnt/us/libkh/bin/fbink
ETAG=/tmp/kindletodo.etag
PNG=/tmp/kindletodo.png
LOG=/mnt/us/extensions/kindletodo/image.log

# Poll numbers at which to force a redraw once, to reclaim the screen from any
# post-boot artifact (~30s, 90s, 180s at a 15s interval).
SETTLE_AT=" 2 6 12 "
count=0

draw() { "$FBINK" -f -W GC16 -g file="$PNG" >/dev/null 2>&1; }

# Keep the device awake so the screensaver doesn't paint over our image.
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

echo "$(date) image-loop start interval=${INTERVAL}s" >> "$LOG"

while true; do
  count=$((count + 1))
  code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" \
         --etag-compare "$ETAG" --etag-save "$ETAG" "$URL" 2>/dev/null)
  if [ "$code" = "200" ] && [ -s "${PNG}.tmp" ]; then
    mv "${PNG}.tmp" "$PNG"
    draw
    echo "$(date) redraw (changed)" >> "$LOG"
  elif [ -f "$PNG" ]; then
    # one-shot settle redraws early on to clear boot artifacts
    case "$SETTLE_AT" in
      *" $count "*) draw; echo "$(date) settle redraw" >> "$LOG" ;;
    esac
  fi
  rm -f "${PNG}.tmp"
  sleep "$INTERVAL"
done
