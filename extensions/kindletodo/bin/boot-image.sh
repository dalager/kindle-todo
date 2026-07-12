#!/bin/sh
# Kindle Todo — boot entry for non-interactive image mode (kiosk).
# Launched by the Upstart job (/etc/upstart/kindletodo.conf) after boot.
# Stops the reader GUI, waits for it to fully die (so its last frame can't land
# on top of our image), then hands off to the polling loop.
#
# Revert to a normal Kindle: remove /etc/upstart/kindletodo.conf and
# `start lab126_gui` (or reboot after removing).

URL="https://kindletodo.christian-b8a.workers.dev/todo.png?t=QKycWamyZC8vRdYsnYKA1v7u"
INTERVAL=15

# Let boot + Wi-Fi settle (Wi-Fi associates during framework startup).
sleep 20

# Stop the reader GUI so nothing repaints over fbink.
stop lab126_gui 2>/dev/null

# Wait for the compositor (pillow) to actually exit, so its final frame (the
# boot/battery bar) doesn't get drawn AFTER our first image.
i=0
while [ $i -lt 15 ]; do
  ps -ef 2>/dev/null | grep -q "[p]illow" || break
  i=$((i + 1))
  sleep 1
done
sleep 3   # let the last framebuffer write flush

# Keep the panel awake (powerd runs independently of the GUI).
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

# Frontlight brightness (0 = off, 24 = max). Adjust to taste.
lipc-set-prop com.lab126.powerd flIntensity 5 2>/dev/null

exec /bin/sh /mnt/us/extensions/kindletodo/bin/image-loop.sh "$URL" "$INTERVAL"
