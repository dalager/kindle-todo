#!/bin/sh
# Kindle Todo — boot-time launcher.
# Called by the Upstart job (/etc/upstart/kindletodo.conf) once the framework is
# up. Waits for Wi-Fi + the LAN server to be reachable, then reuses the same
# launch.sh as the KUAL tap-launch. Bounded retries: it NEVER loops forever, so
# it can never hold up or bootloop the device.

LOGF=/mnt/us/extensions/kindletodo/boot.log
SERVER="http://192.168.1.88:8200/"

echo "$(date) boot-launch: start" >> "$LOGF" 2>&1

# Let the framework/UI settle after boot before we throw an app on top.
sleep 25

# Best-effort wait for the server to answer (~2 min max). If wget is missing or
# the server never comes up, we fall through and launch anyway (the page will
# just show a load error until the server is reachable).
i=0
while [ $i -lt 24 ]; do
    if wget -q -T 5 -O /dev/null "$SERVER" 2>/dev/null; then
        echo "$(date) boot-launch: server reachable" >> "$LOGF" 2>&1
        break
    fi
    i=$((i + 1))
    sleep 5
done

echo "$(date) boot-launch: launching browser" >> "$LOGF" 2>&1
exec /mnt/us/extensions/kindletodo/bin/launch.sh
