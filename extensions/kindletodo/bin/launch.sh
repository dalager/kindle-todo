#!/bin/sh
# Kindle Todo — open the todo page fullscreen in the native browser.
#
# Server runs on the LAN machine at 192.168.1.88:8200. Change URL below if that
# machine's IP or port changes.

URL="http://192.168.1.88:8200/"

# Percent-encode the URL for the app:// launch parameter (: -> %3A, / -> %2F).
ENC_URL="http%3A%2F%2F192.168.1.88%3A8200%2F"

# Keep the screen awake so the display doesn't sleep while showing the list.
lipc-set-prop com.lab126.powerd preventScreenSaver 1

# Launch the native browser pointed at the page.
# Primary method (works on most firmware): tell appmgrd to start the browser
# with a url= parameter.
lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser?url=${ENC_URL}"

# --- Fallback, if the browser opens but does NOT navigate to the URL ---
# Uncomment the two lines below (they set the browser's current URL directly
# after it has started). Give the browser a moment to come up first.
#
# sleep 3
# lipc-set-prop com.lab126.browser currentURL "${URL}"
#
# If neither works on this firmware, discover the right property with:
#   lipc-probe -a
#   lipc-get-prop -a com.lab126.browser

exit 0
