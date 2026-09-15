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
# Poll cadence depends on the time of day and on power (see choose_mode):
#
#   awake    charger present, daytime      every INTERVAL (15 s), never sleeps
#   battery  discharging, daytime          every BATTERY_INTERVAL (5 min), suspended between polls
#   low      discharging < BATT_THRESHOLD  every BATTERY_LOW_INTERVAL (15 min), suspended between polls
#   night    NIGHT_START..NIGHT_END        once an hour, on the hour (+NIGHT_OFFSET s), suspended between polls
#
# "Suspended" is suspend-to-RAM with an RTC wake alarm — an awake i.MX6 with an
# associated radio is what empties the 1500 mAh cell in about a day; asleep it
# draws a few mA. If the RTC alarm or /sys/power/state isn't usable we fall back
# to sleeping awake, i.e. exactly the old behaviour. Discharging below
# BATT_CRITICAL we sync and power off cleanly instead of letting the PMIC cut
# power mid-write (ext3 on the user store — see docs/recovery-rebuild.md); the
# e-ink keeps the "battery low" screen visible while off.
#
# Usage: image-loop.sh <url> [interval_seconds]
# Everything else is read from the environment (boot-image.sh exports config.local).

URL="${1:?usage: image-loop.sh <url> [interval]}"
INTERVAL="${2:-15}"

FBINK=/mnt/us/libkh/bin/fbink
ETAG=/tmp/kindletodo.etag
PNG=/tmp/kindletodo.png
DIR=/mnt/us/extensions/kindletodo
ASSETS="$DIR/assets"
LOG="$DIR/image.log"

# Consecutive failed polls tolerated before we replace the (stale) list with an
# error screen. Counted in polls, not seconds: ~1 min awake, 4 h at night.
FAIL_THRESHOLD="${FAIL_THRESHOLD:-4}"

# Battery telemetry (BD71827 PMIC). If the charger dies the board would drain
# silently for days and then just go dark — warn on the panel instead.
BATT=/sys/class/power_supply/bd71827_bat
BATT_THRESHOLD="${BATT_THRESHOLD:-20}"   # warn + stretch the cadence below this
BATT_CRITICAL="${BATT_CRITICAL:-5}"      # clean power-off at or below this

# Night window in LOCAL time. busybox `date` honours a POSIX TZ string; the
# default is Copenhagen (CET/CEST). The device clock itself stays UTC.
export TZ="${TZ:-CET-1CEST,M3.5.0,M10.5.0/3}"
NIGHT_START="${NIGHT_START:-22:30}"
NIGHT_END="${NIGHT_END:-06:00}"
# Seconds past the hour for the nightly poll. The Worker's midnight cron reopens
# the daily "*" tasks at the top of the hour; polling a little later means the
# 00:00 wake sees them instead of catching up at 01:00. 0 = exactly on the hour.
NIGHT_OFFSET="${NIGHT_OFFSET:-90}"

BATTERY_INTERVAL="${BATTERY_INTERVAL:-300}"
BATTERY_LOW_INTERVAL="${BATTERY_LOW_INTERVAL:-900}"

SUSPEND="${SUSPEND:-1}"    # 0 = never suspend, just sleep awake between polls
RTC="${RTC:-}"             # e.g. /sys/class/rtc/rtc1; auto-detected when empty
SUSPEND_MIN=45             # naps shorter than this aren't worth a resume + Wi-Fi reassociation
WIFI_WAIT="${WIFI_WAIT:-60}"  # seconds to wait for Wi-Fi after a resume (a fresh join takes 5-20)
WIFI_RADIO_OFF="${WIFI_RADIO_OFF:-1}"   # 1 = radio off across every suspend, fresh join after wake (see wait_wifi)
SUSPEND_ON_CHARGER="${SUSPEND_ON_CHARGER:-0}"  # 0 = never suspend while charging; sleep awake instead
WIFI_SSID="${WIFI_SSID:-}"    # network to (re)join; set in config.local
WIFI_PSK="${WIFI_PSK:-}"      # its password. wifid DELETES the saved profile after ~3 failed 4-way
                              # handshakes ("Bad password"), which this router produces routinely
                              # right after a resume; with the PSK here the loop re-creates it.
GATEWAY="${GATEWAY:-}"        # default route to restore if wifid says CONNECTED but the route is gone
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"
# Consecutive polls with the Wi-Fi stack provably down (not CONNECTED after a
# full wait_wifi) before a reboot. Upstream/Worker outages never count: the
# Kindle can't fix those by rebooting. 0 disables.
REBOOT_AFTER_FAILS="${REBOOT_AFTER_FAILS:-6}"
FLINTENSITY="${FLINTENSITY:-0}"

log() { echo "$(date) $*" >> "$LOG"; }

# Keep powerd's own screensaver/auto-suspend off; this loop decides when to sleep.
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

# Keep the log bounded: past ~256 KB, keep only the recent tail. (Appended to
# forever otherwise — hourly battery lines alone add up over months.)
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null)" -gt 262144 ] 2>/dev/null; then
  tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

log "image-loop start interval=${INTERVAL}s night=${NIGHT_START}-${NIGHT_END}(+${NIGHT_OFFSET}s) battery=${BATTERY_INTERVAL}/${BATTERY_LOW_INTERVAL}s suspend=${SUSPEND} radio_off=${WIFI_RADIO_OFF} suspend_on_charger=${SUSPEND_ON_CHARGER} tz=${TZ} ssid=${WIFI_SSID:-?} psk=${WIFI_PSK:+set} gw=${GATEWAY:-?} reboot_after=${REBOOT_AFTER_FAILS}"

state=ok          # ok | nowifi | notfound | unauthorized | server
fails=0
net_fails=0       # consecutive curl-000 polls (reboot trigger)
batt_warned=0     # battery warning is separate from the network state machine
bstat=""; bcap=100
fl_off=0          # frontlight forced off while discharging
last_batt_log=0
last_mode=""
warned_nosuspend=0

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
  log "clock synced from HTTP Date header"
}

# ---- time of day ------------------------------------------------------------

# "HH:MM" -> minutes since local midnight (leading zeros are not octal here).
hhmm_to_min() {
  h=${1%%:*}; m=${1#*:}
  h=${h#0}; m=${m#0}
  echo $(( ${h:-0} * 60 + ${m:-0} ))
}

# True inside the night window. The window may wrap midnight (22:30-06:00).
# Optional argument "HH:MM" overrides "now" (used by tests).
is_night() {
  now=$(hhmm_to_min "${1:-$(date +%H:%M)}")
  s=$(hhmm_to_min "$NIGHT_START"); e=$(hhmm_to_min "$NIGHT_END")
  [ "$s" -eq "$e" ] && return 1                       # empty window = disabled
  if [ "$s" -gt "$e" ]; then
    [ "$now" -ge "$s" ] || [ "$now" -lt "$e" ]
  else
    [ "$now" -ge "$s" ] && [ "$now" -lt "$e" ]
  fi
}

# Seconds until the NEXT hour boundary plus NIGHT_OFFSET. Always the next hour,
# never "later this hour", so a wake at hh:01:30 can't schedule hh:01:30 again.
# Optional argument "MM:SS" overrides "now" (used by tests).
secs_to_next_hour() {
  ms="${1:-$(date +%M:%S)}"
  m=${ms%%:*}; s=${ms#*:}
  m=${m#0}; s=${s#0}
  echo $(( 3600 - ${m:-0} * 60 - ${s:-0} + NIGHT_OFFSET ))
}

# ---- Wi-Fi ------------------------------------------------------------------
#
# Failure class (README "Wi-Fi after suspend"): suspending with the radio
# ASSOCIATED races the router's 4-way handshake on resume; the Kindle's old
# supplicant drops the early frame, the router deauths (reason 15), and wifid
# counts that as "Bad password" - deleting the profile after ~3 strikes. Every
# extra reconnect attempt is another strike. So: radio OFF before suspend, ON
# after wake, plain wait for a clean join; never poke the stack while PENDING;
# if cmState sits in READY (idle = no profile) re-create it from WIFI_SSID/PSK.

has_route() { route -n 2>/dev/null | grep -q '^0\.0\.0\.0'; }

# Run a command with a hard cap in seconds. lipc calls into a wedged wifid have
# been seen to block for ~25 s and ignore SIGTERM; the loop must not. (No
# busybox `timeout`: its syntax varies across the versions Amazon ships.)
with_timeout() {
  t=$1; shift
  "$@" & p=$!
  ( sleep "$t"; kill -9 "$p" 2>/dev/null ) >/dev/null 2>&1 & w=$!
  wait "$p"; r=$?
  kill "$w" 2>/dev/null
  return $r
}
lipc_get() { with_timeout 5 lipc-get-prop "$@" 2>/dev/null; }
lipc_set() { with_timeout 25 lipc-set-prop "$@" >/dev/null 2>&1; }
# Airplane-mode flag. NOTE it PERSISTS across reboots, so boot-image.sh and
# power_off_clean force it back to 1; never leave the device off with radio 0.
radio() { lipc_set com.lab126.cmd wirelessEnable "$1"; }

# "Up" = wifid says CONNECTED (when it answers at all) AND there is a default
# route. The Kindle is known to come back from suspend associated but with the
# gateway route gone; if GATEWAY is configured we put it back. Sets $st.
wifi_up() {
  st=$(lipc_get com.lab126.wifid cmState)
  [ -n "$st" ] && [ "$st" != "CONNECTED" ] && return 1
  has_route && return 0
  if [ "$st" = "CONNECTED" ] && [ -n "$GATEWAY" ]; then
    route add default gw "$GATEWAY" wlan0 2>/dev/null
    has_route && { log "restored default route via $GATEWAY"; return 0; }
  fi
  return 1
}

# One line of what the Wi-Fi stack reports, for image.log, so the USB-mounted
# log can localise an outage (radio off? no profile? associated but no IP?)
# without a shell. Runs detached. Only scans when the radio is idle: a scan
# takes the single radio off-channel and can abort a join in progress.
wifi_diag() {
  w=$(lipc_get com.lab126.cmd wirelessEnable)
  e=$(lipc_get com.lab126.wifid enable)
  st=$(lipc_get com.lab126.wifid cmState)
  ess=$(lipc_get com.lab126.wifid currentEssid)
  sig=$(lipc_get com.lab126.wifid signalStrength)
  ip=$(ifconfig wlan0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p')
  gw=$(route -n 2>/dev/null | awk '$1=="0.0.0.0"{print $2; exit}')
  op=$(cat /sys/class/net/wlan0/operstate 2>/dev/null)
  case "$st" in READY|NA|"") lipc_set com.lab126.wifid scan ""; sleep 8 ;; esac
  scan=$(with_timeout 5 lipc-get-prop -s com.lab126.wifid scanList 2>/dev/null | tr -d '\n' | cut -c1-400)
  log "wifi diag: wirelessEnable=$w enable=$e cmState=$st essid=$ess signal=$sig wlan0=$op ip=$ip gw=$gw scan=$scan"
}

# Re-create the saved profile (idempotent: wifid replaces one with the same
# essid, and the re-creation resets the priority wifid has been lowering), then
# ask the connection manager for it. Detached and capped; the hash goes in on
# stdin so it lives in a script file.
wifi_recreate_profile() {
  cat > /tmp/kindletodo-wifi.sh <<EOS
echo '{essid="$WIFI_SSID", smethod="wpa2", secured="yes", psk="$WIFI_PSK"}' | lipc-hash-prop com.lab126.wifid createProfile
lipc-set-prop com.lab126.cmd ensureConnection "wifi:$WIFI_SSID"
EOS
  ( with_timeout 25 sh /tmp/kindletodo-wifi.sh ) >/dev/null 2>&1 &
}

# Wait up to WIFI_WAIT s for a join, watching wifid's state rather than poking
# it on a timer: PENDING = a join is in progress, leave it alone; READY for 8 s
# = nothing to join, re-create the profile once; at 30 s still not up, one
# radio off/on for a fresh join. Logs what it did and how long it took.
wifi_fail_streak=0
wait_wifi() {
  i=0; ready=0; recreated=""; cycled=""
  while [ "$i" -lt "$WIFI_WAIT" ]; do
    if wifi_up; then
      [ "$i" -gt 0 ] && log "wifi up after ${i}s${recreated:+ (profile recreated)}${cycled:+ (radio cycled)}"
      wifi_fail_streak=0; return 0
    fi
    if [ "$st" = "READY" ]; then ready=$((ready + 1)); else ready=0; fi
    if [ "$ready" -ge 8 ] && [ -z "$recreated" ] && [ -n "$WIFI_SSID" ] && [ -n "$WIFI_PSK" ]; then
      log "wifi: no profile (cmState READY for ${ready}s) - recreating $WIFI_SSID"
      wifi_recreate_profile; recreated=" "; ready=0
    fi
    if [ "$i" -eq 30 ] && [ -z "$cycled" ]; then
      log "wifi: not up at 30s (cmState=${st:-?}) - radio off/on"
      radio 0; sleep 3; radio 1; cycled=" "
    fi
    i=$((i + 1)); sleep 1
  done
  log "wifi not up after ${WIFI_WAIT}s (cmState=${st:-?})"
  wifi_fail_streak=$((wifi_fail_streak + 1))
  [ "$wifi_fail_streak" -eq 1 ] || [ $((wifi_fail_streak % 10)) -eq 0 ] && { ( wifi_diag ) & }
  return 1
}

# ---- suspend-to-RAM ---------------------------------------------------------

# Arm an RTC wake alarm <secs> from now. Tries the configured RTC, then rtc1
# and rtc0; the kernel echoes the alarm back from `wakealarm` when it took.
# Relative form ("+N") so a skew between system clock and RTC can't bite.
arm_alarm() {
  secs=$1
  for r in $RTC /sys/class/rtc/rtc1 /sys/class/rtc/rtc0; do
    [ -w "$r/wakealarm" ] || continue
    echo enabled 2>/dev/null > "$r/device/power/wakeup"
    echo 0 2>/dev/null > "$r/wakealarm"           # clear a pending alarm (EBUSY otherwise)
    echo "+$secs" 2>/dev/null > "$r/wakealarm" || continue
    if [ -n "$(cat "$r/wakealarm" 2>/dev/null)" ]; then
      [ "$RTC" = "$r" ] || log "wake alarm via $r"
      RTC=$r
      return 0
    fi
  done
  return 1
}

# Sleep <secs> as cheaply as possible: suspend-to-RAM with an RTC wake, in
# rounds (a power-button / charger event can wake us early). Any failure
# degrades to an ordinary `sleep`, i.e. the old always-awake behaviour.
suspend_for() {
  secs=$1
  if [ "$SUSPEND" != 1 ] || [ "$secs" -lt "$SUSPEND_MIN" ] \
     || ! grep -qw mem /sys/power/state 2>/dev/null; then
    sleep "$secs"; return
  fi
  # On the charger power is free: sleep awake with the radio associated and
  # never enter the resume/reassociate path at all (night cadence unchanged).
  if [ "$bstat" != "Discharging" ] && [ "$SUSPEND_ON_CHARGER" != 1 ]; then
    sleep "$secs"; return
  fi
  deadline=$(( $(date +%s) + secs ))
  rounds=0; suspended=0; radio_off=0
  while :; do
    left=$(( deadline - $(date +%s) ))
    [ "$left" -gt 0 ] || break
    if [ "$left" -lt "$SUSPEND_MIN" ] || [ "$rounds" -ge 5 ]; then
      sleep "$left"; break
    fi
    if ! arm_alarm "$left"; then
      [ "$warned_nosuspend" = 1 ] || { log "no usable RTC wakealarm - sleeping awake"; warned_nosuspend=1; }
      sleep "$left"; break
    fi
    rounds=$((rounds + 1))
    if [ "$WIFI_RADIO_OFF" = 1 ] && [ "$radio_off" = 0 ]; then
      radio 0; radio_off=1; sleep 2
    fi
    sync
    t0=$(date +%s)
    echo mem 2>/dev/null > /sys/power/state
    if [ $(( $(date +%s) - t0 )) -lt 5 ]; then
      # Returned immediately: the kernel refused (or a wake source is stuck).
      [ "$warned_nosuspend" = 1 ] || { log "suspend refused - sleeping awake"; warned_nosuspend=1; }
      echo 0 2>/dev/null > "$RTC/wakealarm"
      left=$(( deadline - $(date +%s) ))
      [ "$left" -gt 0 ] && sleep "$left"
      break
    fi
    suspended=1
    # Woken early by the charger/USB? Stop sleeping: the caller re-polls and
    # choose_mode switches to awake. (Previously we re-armed and slept on.)
    if [ "$(cat "$BATT/status" 2>/dev/null)" != "Discharging" ] && [ "$SUSPEND_ON_CHARGER" != 1 ]; then
      break
    fi
  done
  [ -n "$RTC" ] && echo 0 2>/dev/null > "$RTC/wakealarm"
  [ "$radio_off" = 1 ] && radio 1
  { [ "$suspended" = 1 ] || [ "$radio_off" = 1 ]; } && wait_wifi
  return 0
}

# ---- battery ----------------------------------------------------------------

draw_battery_warning() {
  if [ -f "$ASSETS/err-battery.png" ]; then
    draw_png "$ASSETS/err-battery.png"
  else
    draw_text "Battery low (${bcap}%). Plug the Kindle in."
  fi
  batt_warned=1
  log "battery warning drawn (${bcap}%)"
}

# Last act before the PMIC does it for us: leave the warning on the panel (e-ink
# holds it unpowered), flush and freeze the user store, power off. Plugging the
# charger back in boots the kiosk. If the shutdown doesn't take we return and
# the next poll tries again.
power_off_clean() {
  log "battery critical (${bcap}%) - powering off to protect the user store"
  [ "$batt_warned" = 1 ] || draw_battery_warning
  radio 1   # the airplane flag persists; don't boot back up with the radio off
  sync
  mount -o remount,ro /mnt/us 2>/dev/null
  shutdown -h now 2>/dev/null || poweroff 2>/dev/null || halt 2>/dev/null
  sleep 60
}

# Warn once when discharging below the threshold; when the charger returns,
# clear the ETag so the next poll returns a body and the list replaces the
# warning. Also logs an hourly battery trend line and forces the frontlight
# off while on battery.
check_battery() {
  [ -r "$BATT/status" ] || return 0
  bstat=$(cat "$BATT/status" 2>/dev/null)
  bcap=$(cat "$BATT/capacity" 2>/dev/null || echo 100)
  now=$(date +%s)
  if [ $(( now - last_batt_log )) -ge 3600 ]; then
    cur=$(cat "$BATT/current_now" 2>/dev/null)
    log "battery ${bcap}% ${bstat}${cur:+ ${cur}uA}"
    last_batt_log=$now
  fi
  if [ "$bstat" = "Discharging" ]; then
    if [ "$fl_off" = 0 ] && [ "$FLINTENSITY" -gt 0 ] 2>/dev/null; then
      lipc-set-prop com.lab126.powerd flIntensity 0 2>/dev/null; fl_off=1
    fi
    [ "$bcap" -le "$BATT_CRITICAL" ] 2>/dev/null && power_off_clean
    if [ "$bcap" -lt "$BATT_THRESHOLD" ] 2>/dev/null && [ "$batt_warned" = 0 ]; then
      draw_battery_warning
    fi
  else
    if [ "$fl_off" = 1 ]; then
      lipc-set-prop com.lab126.powerd flIntensity "$FLINTENSITY" 2>/dev/null; fl_off=0
    fi
    if [ "$batt_warned" = 1 ]; then
      batt_warned=0
      rm -f "$ETAG"  # force a 200 next poll so the list replaces the warning
      log "battery recovered (${bcap}% ${bstat})"
    fi
  fi
}

# ---- polling ----------------------------------------------------------------

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
  log "error screen: $kind (code=$code)"
}

poll() {
  if [ "$state" = "ok" ]; then
    # Healthy: conditional GET (304 when unchanged).
    code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" --max-time "$CURL_TIMEOUT" \
           --etag-compare "$ETAG" --etag-save "$ETAG" "$URL" 2>/dev/null)
  else
    # Showing an error: force an unconditional GET so recovery always returns a
    # body to draw (a conditional 304 would otherwise strand us on the error).
    code=$(curl -s -o "${PNG}.tmp" -w "%{http_code}" --max-time "$CURL_TIMEOUT" \
           --etag-save "$ETAG" "$URL" 2>/dev/null)
  fi

  if [ "$code" = "200" ] && [ -s "${PNG}.tmp" ]; then
    mv "${PNG}.tmp" "$PNG"
    draw_png "$PNG"
    fails=0; net_fails=0; state=ok
    log "redraw (changed)"
  elif [ "$code" = "304" ]; then
    rm -f "${PNG}.tmp"
    fails=0; net_fails=0   # unchanged and healthy
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
    if [ "$code" = "000" ]; then
      # Awake mode never suspends, so this is the only place a dropped
      # association gets retried; wait_wifi returns at once if Wi-Fi is fine.
      # (After a suspend, suspend_for already ran it.)
      [ "$last_mode" = "awake" ] || [ -z "$last_mode" ] && wait_wifi
      if wifi_up; then
        net_fails=0   # stack is fine: upstream/Worker/ISP problem, not ours to reboot for
      else
        net_fails=$((net_fails + 1))
        fails=$FAIL_THRESHOLD   # Wi-Fi provably down: show it now, don't wait 4 polls
        show_error nowifi "No Wi-Fi. See github.com/dalager/kindle-todo"
        if [ "$REBOOT_AFTER_FAILS" -gt 0 ] 2>/dev/null && [ "$net_fails" -ge "$REBOOT_AFTER_FAILS" ]; then
          log "wifi stack down for $net_fails polls - rebooting"
          radio 1; sync; sleep 2; reboot 2>/dev/null
          sleep 60; net_fails=0
        fi
      fi
    fi
  fi
}

# Pick the cadence for the coming gap: sets MODE and WAIT (seconds).
choose_mode() {
  if is_night; then
    MODE=night; WAIT=$(secs_to_next_hour)
  elif [ "$bstat" = "Discharging" ]; then
    if [ "$bcap" -lt "$BATT_THRESHOLD" ] 2>/dev/null; then
      MODE=low; WAIT=$BATTERY_LOW_INTERVAL
    else
      MODE=battery; WAIT=$BATTERY_INTERVAL
    fi
  else
    MODE=awake; WAIT=$INTERVAL
  fi
  if [ "$MODE" != "$last_mode" ]; then
    log "mode $MODE (next poll in ${WAIT}s, ${bcap}% ${bstat:-no battery info})"
    last_mode=$MODE
  fi
}

diag_at_start=1
while true; do
  if [ "$diag_at_start" = 1 ]; then
    diag_at_start=0
    if wifi_up; then log "wifi up at start (cmState=$st)"; else ( wifi_diag ) & fi
  fi
  check_battery
  poll
  choose_mode
  if [ "$MODE" = "awake" ]; then
    sleep "$WAIT"
  else
    suspend_for "$WAIT"
  fi
done
