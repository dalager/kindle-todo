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

# The access token is NOT committed. It lives in an uncommitted device-local
# config next to this script (config.local), provisioned by `scripts/kindle.sh
# deploy` from the repo .env. See config.example.sh for the format.
CONF="$(dirname "$0")/config.local"
[ -f "$CONF" ] && . "$CONF"
BASE_URL="${BASE_URL:-https://todo.dalagerlabs.com}"
URL="${BASE_URL}/todo.png?t=${TODO_TOKEN}"
INTERVAL="${INTERVAL:-15}"

# Let boot + Wi-Fi settle (Wi-Fi associates during startup).
sleep 20

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

# Keep the panel awake and set frontlight (0=off .. 24=max).
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
lipc-set-prop com.lab126.powerd flIntensity 5 2>/dev/null

exec /bin/sh /mnt/us/extensions/kindletodo/bin/image-loop.sh "$URL" "$INTERVAL"
