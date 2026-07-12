#!/bin/sh
# Kindle Todo — non-interactive image mode.
#
# Polls the PNG endpoint with a conditional request (ETag). The server returns
# a tiny 304 when nothing changed, so we ONLY download + redraw e-ink when the
# todo state actually changes. No idle redraws => no blinking when unchanged.
#
# (boot-image.sh stops the whole display stack, so nothing repaints over us and
# no periodic "settle" redraws are needed.)
#
# Usage: image-loop.sh <url> [interval_seconds]

URL="${1:?usage: image-loop.sh <url> [interval]}"
INTERVAL="${2:-15}"

FBINK=/mnt/us/libkh/bin/fbink
ETAG=/tmp/kindletodo.etag
PNG=/tmp/kindletodo.png
LOG=/mnt/us/extensions/kindletodo/image.log

# Keep the device awake so the screensaver doesn't paint over our image.
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

echo "$(date) image-loop start interval=${INTERVAL}s" >> "$LOG"

while true; do
  code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" \
         --etag-compare "$ETAG" --etag-save "$ETAG" "$URL" 2>/dev/null)
  if [ "$code" = "200" ] && [ -s "${PNG}.tmp" ]; then
    mv "${PNG}.tmp" "$PNG"
    "$FBINK" -f -W GC16 -g file="$PNG" >/dev/null 2>&1
    echo "$(date) redraw (changed)" >> "$LOG"
  fi
  rm -f "${PNG}.tmp"
  sleep "$INTERVAL"
done
