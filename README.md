# kindle-todo

Show a shared **Microsoft To Do** list, full-screen, on a wall-mounted
**jailbroken Kindle Paperwhite** — a silent, always-on, e-ink family todo board.

The Kindle displays the list; anyone can tick items off from their phone (or
from Microsoft To Do directly) and the wall updates within seconds.

---

## Why

We wanted the household "Familietodo" list visible in the hallway without a
glowing tablet or a browser tab left open somewhere. An old Kindle Paperwhite is
perfect for this: e-ink is easy on the eyes, sips power, and holds its image with
zero backlight. Jailbroken, it can be turned into a dedicated display.

The catch: a Kindle can't natively talk to the Microsoft Graph API, its 2018-era
browser is rough, and its UI wants to draw a home screen / screensaver over
anything you put up. So all the real work happens in a **Cloudflare Worker**, and
the Kindle becomes a thin client that just fetches an image and draws it.

---

## Architecture

```
  Microsoft To Do (Graph API)
          │  refresh-token grant
          ▼
  ┌──────────────────────────────────────────┐
  │  Cloudflare Worker (worker/)              │
  │                                           │
  │  TodoProvider  ◀── factory ◀── env        │   pluggable backend
  │    └ MicrosoftTodoProvider (Graph client) │   (MS To Do today)
  │                                           │
  │  Routes (all gated by ?t=<TODO_TOKEN>):   │
  │   GET  /              picker + tasks       │
  │   GET  /api/lists     { lists, selected }  │
  │   POST /api/selection ?list=<id>           │
  │   GET  /api/todos     { title, todos }     │
  │   GET  /todo.png      1072×1448 PNG        │   satori + resvg, no browser
  │                                           │
  │  served list in KV · cached ~30s · ETag   │   cheap polling
  └──────────────────────────────────────────┘
          ▲ HTTPS                    ▲ HTTPS
          │ curl (poll + redraw      │ pick which list
          │       only on change)    │ to serve
  ┌───────────────────┐      ┌───────────────────┐
  │ Kindle (kiosk)    │      │ Any phone/browser │
  │  boot-image.sh    │      │  the page at /    │
  │   stop X stack    │      └───────────────────┘
  │   image-loop.sh   │
  │   curl → fbink    │
  └───────────────────┘
```

### The Worker (`worker/`)

TypeScript, deployed to Cloudflare. Zero runtime dependencies beyond the PNG
renderer.

- **Provider abstraction** (`src/providers/`) — the app depends on a small
  `TodoProvider` interface (`lists()`, `title(listId?)`, `list(listId?)`); a
  `factory` picks the implementation from config. Microsoft To Do
  (`providers/microsoft/`) is the only backend today, wrapping a ported,
  zero-dependency Microsoft Graph client (refresh-token grant). Adding another
  source is a new class + one line in the factory.
- **List picker** — the web page lists every To Do list and lets you choose
  which one is served to the Kindle. The choice is persisted in the `LIST_STORE`
  KV namespace (falling back to `MS_DEFAULT_LIST_ID`), so the Kindle's next poll
  picks it up. Tasks are completed in the upstream To Do app, not here.
- **`/todo.png`** — the list rendered to a 1072×1448 grayscale PNG using
  [`@cf-wasm/og`](https://github.com/fineshopdesign/cf-wasm) (satori + resvg) —
  **no headless browser**, so it's fast and free.
- **Efficiency** — the provider list is cached ~30s (so the Kindle's 15s polling
  doesn't hammer Graph); `/todo.png` returns an `ETag` and answers conditional
  requests with a tiny `304`, and a Cache API layer means the image is
  rasterized at most once per change. Switching the served list invalidates the
  cache for an immediate refresh.
- **Access** — every route requires `?t=<TODO_TOKEN>`, a shared secret in the
  URL (Cloudflare Access would break the unattended kiosk).

### The Kindle (`extensions/kindletodo/`)

A jailbroken Kindle running a tiny KUAL extension plus an Upstart boot service.

- **`bin/boot-image.sh`** — on boot, stops the **entire X display stack** (the
  `x` Upstart job: lxinit + framework + pillow + the `blanket` screensaver) so
  nothing repaints over us, sets the frontlight, and launches the loop. Stopping
  `lab126_gui` alone is *not* enough — `blanket` keeps drawing the charge screen.
- **`bin/image-loop.sh`** — polls `/todo.png` with a conditional request
  (`curl --etag-compare/--etag-save`) and redraws e-ink with **`fbink`** only
  when the state changes (a `200`); `304`s cost nothing and cause no flashing.
- **`kindletodo.upstart.conf`** — the Upstart unit (installed to
  `/etc/upstart/kindletodo.conf`) that supervises `boot-image.sh` with `respawn`.

The Kindle is a dumb display: fetch image, draw, repeat. All appearance and data
logic lives in the Worker, so changing the look is a redeploy — no device access.

---

## Repository layout

```
worker/                         Cloudflare Worker
  src/
    index.ts                    routes: page, /api/lists, /api/selection, /api/todos, /todo.png
    og.tsx                      PNG render (satori/resvg)
    providers/
      types.ts                  TodoProvider interface + Todo type
      factory.ts                createProvider(env)
      microsoft/                ported Graph client + MicrosoftTodoProvider
  test/                         provider client unit tests (vitest)
  wrangler.jsonc                Worker config
  .dev.vars.example             local secrets template
extensions/kindletodo/          Kindle KUAL extension
  bin/boot-image.sh             boot: stop X stack, set light, run loop
  bin/image-loop.sh             poll /todo.png, fbink on change
  kindletodo.upstart.conf       Upstart service (-> /etc/upstart/)
  config.xml, menu.json         KUAL registration
```

---

## Getting it running on a fresh Kindle

### Prerequisites

- A **jailbroken Kindle Paperwhite** (tested on PW4 / 10th gen; any 1072×1448
  300 ppi panel — PW3/Voyage — should work). Jailbreak + tooling via
  [kindlemodding.org](https://kindlemodding.org): install **KUAL**, **fbink**
  (bundled with KOReader / the `libkh` helpers), and **USBNetLite** for SSH.
- A **Cloudflare account** (free tier is enough).
- **Node + npm** and **wrangler** on your computer.
- **Microsoft Graph access to To Do**: an Azure app registration
  (`client_id` / `client_secret`, scope
  `offline_access https://graph.microsoft.com/Tasks.ReadWrite`) and a
  **refresh token** obtained once via an interactive OAuth login. The
  [`microsoft-todo-cli`](https://github.com/) this Worker's client is ported from
  can produce one, or use any authorization-code flow.

### Part A — Deploy the Worker

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars     # then fill in real values
```

Fill `.dev.vars`:

| Var | What |
|-----|------|
| `TODO_TOKEN` | a long random string; the access gate for every URL |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | your Azure app registration |
| `MS_REFRESH_TOKEN` | Microsoft refresh token (obtained once) |
| `MS_DEFAULT_LIST_ID` | the To Do list to show (see below) |

Test locally (uses `.dev.vars`), then deploy:

```bash
npm run dev            # http://localhost:8787/?t=<TODO_TOKEN>
wrangler login
# push each secret to production:
for k in TODO_TOKEN MS_CLIENT_ID MS_CLIENT_SECRET MS_REFRESH_TOKEN MS_DEFAULT_LIST_ID; do
  printf '%s' "$(grep "^$k=" .dev.vars | cut -d= -f2- | tr -d '"')" | wrangler secret put "$k"
done
wrangler deploy        # -> https://<name>.<subdomain>.workers.dev
```

**Finding your list id:** list your To Do lists via the Graph explorer
(`GET /me/todo/lists`) or a small script, and copy the `id` of the list you want
into `MS_DEFAULT_LIST_ID`.

**Optional (recommended for 24/7):** Microsoft rotates the refresh token on each
use. Persist it so it survives cold starts:

```bash
wrangler kv namespace create MS_TOKEN_STORE   # add the id to wrangler.jsonc, uncomment the binding
```

### Part B — Set up the Kindle

1. **Install the extension.** Mount the Kindle over USB and copy
   `extensions/kindletodo/` to `/mnt/us/extensions/kindletodo/`. Edit
   `bin/boot-image.sh`:
   - `URL=` → your `https://…workers.dev/todo.png?t=<TODO_TOKEN>`
   - `INTERVAL=` → poll seconds (15 is a good default)
   - `flIntensity` → frontlight 0 (off) … 24 (max)

2. **Enable SSH.** In KUAL, enable **USBNetLite** (over Wi-Fi). Change its
   default password (`/mnt/us/usbnetlite/etc/config`) from `kindle`.

3. **Install the boot service** (needs a one-time root shell). Over SSH:
   ```sh
   mntroot rw
   cp /mnt/us/extensions/kindletodo/kindletodo.upstart.conf /etc/upstart/kindletodo.conf
   mntroot ro
   initctl reload-configuration
   ```

4. **Reboot.** The Kindle boots, stops the display stack, and comes up to the
   full-screen list. It now updates itself forever.

> **Power:** run it from a **wall charger**, not a computer's USB port
> (a USB-data connection interferes with Wi-Fi SSH). In kiosk mode the device
> stays awake to poll, so keep it powered.

**Revert to a normal Kindle:** remove `/etc/upstart/kindletodo.conf` and
`start x` (or just reboot after removing).

---

## Using it

- **See it:** the Kindle shows the list; it redraws within ~15 s of a change.
- **Choose the list:** open `https://<name>.<subdomain>.workers.dev/?t=<TODO_TOKEN>`
  on any device and pick which To Do list the Kindle serves; the wall follows on
  its next poll.
- **Tick items off:** complete tasks in Microsoft To Do itself — the wall follows.
- **Change the look:** edit `worker/src/og.tsx` and `wrangler deploy`. No device
  access needed; the Kindle picks it up on its next poll.
- **Adjust brightness live:** `ssh root@<kindle-ip>` then
  `lipc-set-prop com.lab126.powerd flIntensity <0-24>`.

---

## Notes & gotchas (learned the hard way)

- **The charge-screen "bar":** stopping only `lab126_gui` leaves the `blanket`
  screensaver running under `x`; while charging it paints the battery graphic
  over the image. Stop the whole **`x`** job (as `boot-image.sh` does).
- **HTTPS on the old browser:** the Kindle's `curl`/OpenSSL do modern TLS fine,
  so it reaches `workers.dev` over HTTPS without trouble.
- **Blinking:** e-ink redraws flash, so the loop redraws **only on change**.
- **Security:** the access token lives in `boot-image.sh` on the device and, if
  you commit it, in the repo — keep the repo private and rotate the token / MS
  credentials if they leak.

## Credits

- Microsoft Graph client ported from **microsoft-todo-cli**.
- PNG rendering by **[@cf-wasm/og](https://github.com/fineshopdesign/cf-wasm)**
  (satori + resvg).
- Kindle jailbreak, **fbink**, **KUAL**, **USBNetLite** from the
  [kindlemodding.org](https://kindlemodding.org) / MobileRead communities.
