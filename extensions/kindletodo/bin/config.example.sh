# Device-local config for boot-image.sh — DO NOT commit real values.
#
# On the Kindle this lives at:
#   /mnt/us/extensions/kindletodo/bin/config.local
#
# You normally don't write it by hand: `scripts/kindle.sh deploy` (over SSH) or
# `scripts/stage-usb.sh` (over USB) generates config.local on the device from
# the repo .env (KINDLE_* variables). It is sourced — and exported — by
# boot-image.sh, so every setting here also reaches image-loop.sh.

# Access token gating the Worker (must match the deployed TODO_TOKEN secret).
TODO_TOKEN="your-token-here"

# Optional: override the Worker base URL (defaults to https://todo.dalagerlabs.com).
# BASE_URL="https://todo.dalagerlabs.com"

# Optional: daytime poll interval in seconds while on the charger (defaults to 15).
# INTERVAL=15

# Optional: frontlight brightness, 0=off .. 24=max (defaults to 0). e-ink is
# readable at 0 in a lit room; raise it for a dim hallway. Forced to 0 while
# discharging.
# FLINTENSITY=0

# --- Night window: one poll per hour, on the hour, suspended in between -----

# Local time zone as a POSIX TZ string (defaults to Copenhagen, CET/CEST).
# TZ="CET-1CEST,M3.5.0,M10.5.0/3"

# Window bounds, local "HH:MM" (defaults 22:30 -> 06:00; may wrap midnight).
# Same value for both disables the window.
# NIGHT_START="22:30"
# NIGHT_END="06:00"

# Seconds past the hour for the nightly poll (default 90). The Worker's midnight
# cron reopens the daily "*" tasks at the top of the hour; a small offset lets
# the 00:00 wake pick them up. 0 = exactly on the hour.
# NIGHT_OFFSET=90

# --- On battery (charger unplugged / dead), daytime -------------------------

# Poll interval in seconds while discharging (default 300), and once below
# BATT_THRESHOLD percent (default 20 -> 900). Suspended in between.
# BATTERY_INTERVAL=300
# BATTERY_LOW_INTERVAL=900
# BATT_THRESHOLD=20

# Clean power-off at or below this percent while discharging (default 5).
# BATT_CRITICAL=5

# --- Suspend mechanics ------------------------------------------------------

# 0 disables suspend-to-RAM entirely (the loop then sleeps awake between polls
# at the same cadences). Default 1. Note a suspended Kindle is unreachable over
# SSH, so with the defaults SSH only works by day while on the charger.
# SUSPEND=1

# RTC whose wakealarm resumes the device. Auto-detected (rtc1, then rtc0);
# set explicitly if the log says "no usable RTC wakealarm".
# RTC="/sys/class/rtc/rtc1"

# --- Wi-Fi recovery ---------------------------------------------------------
# The radio does not reliably reassociate after a resume, so image-loop.sh
# escalates: force-connect the saved profile (needs WIFI_SSID; no password —
# the profile you joined in Settings is reused), wpa_cli reassociate,
# disconnect/reconnect, radio off/on. Seconds to keep trying (default 60).
# WIFI_SSID="MyNetwork"
# WIFI_PSK="the-password"   # lets the loop re-create the profile wifid deletes after
#                           # a few failed handshakes ("Bad password"); without it a
#                           # human has to retype the password in Settings
# WIFI_WAIT=60

# Default gateway to restore when wifid says CONNECTED but the route is gone
# after a resume (a known Kindle quirk). Leave unset to skip.
# GATEWAY="192.168.1.1"

# Radio off before every suspend, on after wake (default 0 = OFF). Sounds right,
# and other Kindle dashboards do it, but on the PW4/5.18 the chip does not come
# back after the toggle around a suspend and wifid crash-loops for a day
# (2026-09-17). Leave off unless you have verified it on your device.
# WIFI_RADIO_OFF=0

# Never suspend while charging (default 0 = sleep awake on the charger). On the
# wall power is free and an associated radio that never resumes never fails.
# SUSPEND_ON_CHARGER=0

# Reboot after this many consecutive polls with the Wi-Fi stack provably down
# (default 0 = never). Warm reboots did not clear a wedged stack on the PW4.
# REBOOT_AFTER_FAILS=0
