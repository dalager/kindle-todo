# Device-local config for boot-image.sh — DO NOT commit real values.
#
# On the Kindle this lives at:
#   /mnt/us/extensions/kindletodo/bin/config.local
#
# You normally don't write it by hand: `scripts/kindle.sh deploy` (run from the
# repo on your laptop) generates config.local on the device from the repo .env.
# It is sourced by boot-image.sh to build the /todo.png URL.

# Access token gating the Worker (must match the deployed TODO_TOKEN secret).
TODO_TOKEN="your-token-here"

# Optional: override the Worker base URL (defaults to https://todo.dalagerlabs.com).
# BASE_URL="https://todo.dalagerlabs.com"

# Optional: poll interval in seconds (defaults to 15).
# INTERVAL=15

# Optional: frontlight brightness, 0=off .. 24=max (defaults to 0). e-ink is
# readable at 0 in a lit room; raise it for a dim hallway.
# FLINTENSITY=0
