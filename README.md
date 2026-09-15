# kindle-todo

Show a shared **Microsoft To Do** list, full-screen, on a wall-mounted
**jailbroken Kindle Paperwhite** — a silent, always-on, e-ink family todo board.

The Kindle displays the list; People adds and completes tasks as usual in Microsoft ToDo; The wall updates within seconds.

<p align="center">
  <img src="docs/screen_todo.jpg" alt="Wall-mounted Kindle Paperwhite showing the Familietodo list" width="380">
  <br>
  <sub><em>The real thing: the hallway "Familietodo" on a wall-mounted Kindle.</em></sub>
</p>

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

## Daily use

- you do your thing
- the wall updates
- you use the simple webapp to pick which one of your lists that goes to the kindle

---

## Architecture

```mermaid
graph LR
    PHONE["📱 Phone / browser<br/>list picker + tasks"]
    KINDLE["🖼️ Kindle kiosk<br/>curl → fbink (e-ink)"]

    subgraph CF["☁️ Cloudflare"]
        WORKER["Worker (worker/)<br/>routes · PNG render"]
        KV[("KV<br/>selected list")]
    end

    GRAPH["📋 Microsoft To Do<br/>(Graph API)"]

    PHONE -->|"GET / , /api/* · HTTPS ?t="| WORKER
    KINDLE -->|"poll GET /todo.png · HTTPS ?t="| WORKER
    WORKER -->|"read / write selected list"| KV
    WORKER -->|"refresh-token grant · lists · tasks"| GRAPH
```

The Kindle just fetches an image and draws it; the phone picks which list is
served. All data + rendering logic lives in the Worker.

### The Worker (`worker/`)

TypeScript, deployed to Cloudflare. Zero runtime dependencies beyond the PNG
renderer.

- **Provider abstraction** (`src/providers/`) — the app depends on a small
  `TodoProvider` interface (`lists()`, `title(listId?)`, `list(listId?)`,
  `completed(listId?)`, `reopen(taskId, listId?)`); a
  `factory` picks the implementation from config. Microsoft To Do
  (`providers/microsoft/`) is the only backend today, wrapping a ported,
  zero-dependency Microsoft Graph client (refresh-token grant). Adding another
  source is a new class + one line in the factory.
- **Daily recurring tasks** (`src/recurring.ts`) — a task with a `*` in its
  title is a daily chore: tick it off and it leaves the wall, and at local
  midnight the Worker reopens it for the next day. See
  [Daily recurring tasks](#daily-recurring-tasks-).
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
- **Friendly errors** — when Graph fails, `/todo.png` first keeps serving the
  **last-known-good** list for a ~5-min grace window (rides out blips), then
  falls back to a rendered error screen — "sign-in expired 🔑", "list gone 🤔",
  or "not responding 😵" (`src/errors.ts`). Failures the Worker can't answer at
  all (no Wi-Fi, wrong URL) are handled on the device instead — see
  [Resilience & recovery](#resilience--recovery). `GET /error/<kind>.png` renders
  any screen, which is how the device pre-downloads its local fallbacks.
- **Access** — every data route (`/api/*`, `/todo.png`) requires
  `?t=<TODO_TOKEN>`, a shared secret in the URL (Cloudflare Access would break
  the unattended kiosk). The page shell at `/` is public and holds no data; it
  reads the token from the URL, else `localStorage`, else a prompt, then reuses
  it on the API calls.

**Inside the Worker** — router, provider, storage (KV + Cache API) and secrets:

```mermaid
graph TD
    REQ["HTTPS request<br/>?t=TODO_TOKEN"] --> ROUTER["fetch() router<br/>src/index.ts"]
    ROUTER --> AUTH{"token valid?<br/>(GET / is public)"}
    AUTH -- no --> R401["401 Unauthorized"]
    AUTH -- yes --> ROUTES["route handlers"]

    ROUTES --> OG["og.tsx<br/>PNG render (satori + resvg)"]
    ROUTES --> FACTORY["createProvider()"]
    FACTORY --> PROVIDER["MicrosoftTodoProvider"]
    PROVIDER --> CLIENT["Graph client<br/>+ TokenManager"]
    CLIENT -->|"Bearer token"| GRAPH["Microsoft Graph API"]

    ROUTES <--> CACHE[("Cache API<br/>list ~30s · PNG by ETag")]
    ROUTES <--> KVLIST[("KV LIST_STORE<br/>selected list id")]
    CLIENT <--> KVTOK[("KV MS_TOKEN_STORE<br/>rotating refresh token")]

    subgraph SECRETS["Secrets · wrangler secret put"]
        S1["TODO_TOKEN"]
        S2["MS_CLIENT_ID / _SECRET"]
        S3["MS_REFRESH_TOKEN"]
        S4["MS_DEFAULT_LIST_ID"]
    end
    S1 -.-> ROUTER
    S2 -.-> CLIENT
    S3 -.-> CLIENT
    S4 -.-> FACTORY
```

**Endpoints in action** — the phone drives the picker while the Kindle polls the
image independently:

```mermaid
sequenceDiagram
    autonumber
    participant B as 📱 Browser
    participant K as 🖼️ Kindle
    participant W as Worker
    participant C as Cache API
    participant KV as KV LIST_STORE
    participant G as Graph API

    Note over B,W: Web picker (GET / needs no token)
    B->>W: GET / (public shell)
    W-->>B: HTML + JS (reads/stores token)
    B->>W: GET /api/lists?t=
    W->>G: list all To Do lists
    W->>KV: get selected list id
    W-->>B: { lists, selected }
    B->>W: POST /api/selection?list=ID&t=
    W->>G: validate ID is a real list
    W->>KV: put selected list id
    W->>C: invalidate cached list
    W-->>B: { selected }
    B->>W: GET /api/todos?t=
    W-->>B: { title, todos }

    Note over K,W: Kindle image poll (~every 15s)
    K->>W: GET /todo.png?t= (If-None-Match: etag)
    alt Graph OK
        W->>C: store last-known-good (5-min TTL)
        alt list changed
            W-->>K: 200 image/png + ETag
        else unchanged
            W-->>K: 304 Not Modified (no redraw)
        end
    else Graph failing
        W->>C: read last-known-good
        alt within grace window
            W-->>K: 200 last-good list (stale, rides out the blip)
        else grace expired
            W-->>K: 200 error screen (sign-in 🔑 / list 🤔 / backend 😵)
        end
    end
```

### The Kindle (`extensions/kindletodo/`)

A jailbroken Kindle running a tiny KUAL extension plus an Upstart boot service.

- **`bin/boot-image.sh`** — on boot, stops the **entire X display stack** (the
  `x` Upstart job: lxinit + framework + pillow + the `blanket` screensaver) so
  nothing repaints over us, sets the frontlight, and launches the loop. Stopping
  `lab126_gui` alone is *not* enough — `blanket` keeps drawing the charge screen.
- **`bin/image-loop.sh`** — polls `/todo.png` with a conditional request
  (`curl --etag-compare/--etag-save`) and redraws e-ink with **`fbink`** only
  when the state changes (a `200`); `304`s cost nothing and cause no flashing.
  The cadence follows the clock and the charger: every 15 s by day on power;
  **once an hour, on the hour, from 22:30 to 06:00**; every 5 min on battery
  (15 min under 20 %). Between the slow polls it **suspends to RAM** with an
  RTC wake alarm, and at 5 % it powers off cleanly (see
  [Power & battery](#power--battery)).
- **`kindletodo.upstart.conf`** — the Upstart unit (installed to
  `/etc/upstart/kindletodo.conf`) that supervises `boot-image.sh` with `respawn`.

The Kindle is a dumb display: fetch image, draw, repeat. All appearance and data
logic lives in the Worker, so changing the look is a redeploy — no device access.

**Boot + poll loop** — Upstart supervises `boot-image.sh`, which takes over the
panel and hands off to the `image-loop.sh` redraw loop:

```mermaid
sequenceDiagram
    autonumber
    participant U as Upstart (respawn)
    participant B as boot-image.sh
    participant Cfg as config.local
    participant X as X display stack
    participant L as image-loop.sh
    participant W as Worker /todo.png
    participant FB as fbink (e-ink)

    U->>B: start on boot
    B->>Cfg: source + export config (TODO_TOKEN, FLINTENSITY, TZ, night/battery cadence)
    opt DISABLE flag present
        B-->>U: exit 0 — leave normal Kindle UI (USB escape hatch)
    end
    B->>B: sleep 20 (Wi-Fi settle)
    B->>X: stop x (lxinit / pillow / blanket)
    B->>B: wait for stack exit, sleep 3
    B->>B: preventScreenSaver=1, frontlight = FLINTENSITY (default 0)
    B->>L: exec image-loop.sh URL INTERVAL

    loop each poll
        L->>L: read battery (warn <20 %, clean power-off ≤5 %)
        L->>W: conditional GET (ETag)
        alt 200 — state changed
            W-->>L: PNG body + new ETag
            L->>FB: redraw e-ink (GC16)
        else 304 — unchanged
            W-->>L: 304, no redraw (no flashing)
        else unreachable (000 / 404 / 401 / 5xx)
            Note over L,W: after ~4 consecutive fails
            L->>FB: draw local error PNG once (nowifi / notfound / …)
        end
        alt daytime, on charger
            L->>L: sleep INTERVAL (~15 s), stay awake
        else night (22:30–06:00) / on battery
            L->>L: RTC wake alarm (next hour / 5–15 min) → suspend-to-RAM → wait for Wi-Fi
        end
    end
```

---

## Repository layout

```
worker/                         Cloudflare Worker
  src/
    index.ts                    routes: page, /api/lists, /api/selection, /api/todos,
                                /api/reset-recurring, /todo.png + nightly cron
    og.tsx                      PNG render: list + error screens (satori/resvg)
    errors.ts                   error-screen catalog + failure classifier
    recurring.ts                daily "*" tasks: marker rule + local-midnight reset
    providers/
      types.ts                  TodoProvider interface + Todo type
      factory.ts                createProvider(env)
      microsoft/                ported Graph client + MicrosoftTodoProvider
  test/                         client, error-classifier + recurring unit tests (vitest)
  wrangler.jsonc                Worker config
  .dev.vars.example             local Worker secrets template
extensions/kindletodo/          Kindle KUAL extension
  bin/boot-image.sh             boot: stop X stack, set light, run loop
  bin/image-loop.sh             poll /todo.png, fbink on change, error screens
  bin/config.example.sh         device-local config template (token)
  assets/                       error PNGs (downloaded by kindle.sh deploy)
  kindletodo.upstart.conf       Upstart service (-> /etc/upstart/)
  config.xml, menu.json         KUAL registration
scripts/kindle.sh               deploy to / ssh the Kindle using .env
.env.example                    ops env template (token, Kindle IP + SSH pass)
docs/devices/                   hardware spec of the target Kindle (PW4)
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
wrangler deploy        # -> https://<yourdomain>
```

`wrangler deploy` also registers the nightly cron triggers declared in
`wrangler.jsonc` (see [Daily recurring tasks](#daily-recurring-tasks-)). Cron
changes take **up to 15 minutes** to propagate across the network, so a schedule
added minutes before its firing time may miss that first night.

Your `<yourdomain>` can just be the free Cloudflare **`*.workers.dev`** URL you
get out of the box (e.g. `kindletodo.<your-subdomain>.workers.dev`) — no custom
domain or DNS needed. A custom domain (as configured in this repo's
`wrangler.jsonc`) is purely optional.

> **Heads-up:** the checked-in `wrangler.jsonc` declares a `custom_domain` route.
> If you keep a `custom_domain` route, it **disables the `*.workers.dev` URL**
> unless you also set `"workers_dev": true` — so the Worker becomes reachable
> *only* at that custom domain. If you just want the free `workers.dev` URL,
> **remove the `routes` line** from `wrangler.jsonc`. Either way, point the Kindle
> at whatever `<yourdomain>` you end up with (Part B).

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
   `extensions/kindletodo/` to `/mnt/us/extensions/kindletodo/`. The frontlight
   (`FLINTENSITY`, 0 = off … 24 = max, **default 0**), poll `INTERVAL`, time
   zone, night window and battery cadence all have defaults in the scripts but
   are overridable per-device in `bin/config.local` (see `bin/config.example.sh`);
   the **token is not committed** — it's provisioned separately (step 4).

2. **Enable SSH.** In KUAL, enable **USBNetLite** (over Wi-Fi). Change its
   default password (`/mnt/us/usbnetlite/etc/config`) from `kindle`.

3. **Install the boot service** (needs a one-time root shell). Over SSH:
   ```sh
   mntroot rw
   cp /mnt/us/extensions/kindletodo/kindletodo.upstart.conf /etc/upstart/kindletodo.conf
   mntroot ro
   initctl reload-configuration
   ```

4. **Provision the token + push updates from your laptop.** Create the ops
   `.env` (see [Secrets & the `.env`](#secrets--the-env) below), then:
   ```sh
   cp .env.example .env      # fill in TODO_TOKEN, KINDLE_IP, KINDLE_SSH_PASS
   scripts/kindle.sh deploy  # copies bin/*.sh, writes the token, restarts service
   ```
   `deploy` writes `bin/config.local` on the device (the token — never committed)
   and restarts the kiosk. Re-run it any time you change the scripts or rotate the
   token. Handy: `scripts/kindle.sh logs`, `scripts/kindle.sh status`,
   `scripts/kindle.sh ssh`.

5. **Reboot.** The Kindle boots, stops the display stack, and comes up to the
   full-screen list. It now updates itself forever.

> **Power:** run it from a **wall charger**, not a computer's USB port
> (a USB-data connection interferes with Wi-Fi SSH). By day on the charger the
> device stays awake to poll every 15 s; at night and on battery it sleeps
> between polls — see [Power & battery](#power--battery).

**Revert to a normal Kindle:** the quick escape hatch is the `DISABLE` flag
(drop a file over USB — no shell needed); to remove it for good, delete the boot
service. See [Resilience & recovery](#resilience--recovery).

---

## Using it

- **See it:** the Kindle shows the list; it redraws within ~15 s of a change by
  day. Between 22:30 and 06:00 it only checks once an hour, on the hour.
- **Choose the list:** open `https://<yourdomain>/?t=<TODO_TOKEN>`
  on any device and pick which To Do list the Kindle serves; the wall follows on
  its next poll.
- **Tick items off:** complete tasks in Microsoft To Do itself — the wall follows.
- **Make a task daily:** put a `*` in its title — see below.
- **Change the look:** edit `worker/src/og.tsx` and `wrangler deploy`. No device
  access needed; the Kindle picks it up on its next poll.
- **Adjust brightness:** the frontlight defaults to **off**. Easiest: set
  `KINDLE_FLINTENSITY=<0-24>` in `.env` and run `scripts/kindle.sh deploy`.
  Live (no redeploy): `scripts/kindle.sh ssh 'lipc-set-prop com.lab126.powerd flIntensity <0-24>'`.

### Power & battery

An awake i.MX6 with an associated radio empties the 1500 mAh cell in about a
day. Suspended to RAM it draws a few mA, so `image-loop.sh` picks a cadence from
the clock and the PMIC's charger state and **suspends between the slow polls**,
waking on an RTC alarm:

| When | Poll cadence | Between polls |
|------|--------------|---------------|
| Daytime, on the charger | every 15 s (`INTERVAL`) | awake |
| **Night, 22:30 → 06:00** (any power state) | **hourly, on the hour** (+90 s, `NIGHT_OFFSET`) | suspended |
| Daytime, discharging | every 5 min (`BATTERY_INTERVAL`) | suspended |
| Discharging below 20 % (`BATT_THRESHOLD`) | every 15 min (`BATTERY_LOW_INTERVAL`); "battery low" screen; frontlight forced off | suspended |
| Discharging at 5 % (`BATT_CRITICAL`) | `sync`, user store read-only, clean power-off | off |

Night times are local (`TZ`, default Copenhagen). The +90 s offset lets the
00:00 wake see the daily `*` tasks the Worker's midnight cron reopens; set
`NIGHT_OFFSET=0` for exactly on the hour. All of it is per-device config
(`bin/config.example.sh`), or `KINDLE_<NAME>` in `.env` for `deploy`/`stage-usb`.

Two things to know:

- **A suspended Kindle has no SSH.** With the defaults that means no
  `scripts/kindle.sh` at night or on battery. `SUSPEND=0` keeps the same
  cadences but never sleeps, if you'd rather trade battery for access.
- **Suspend degrades safely.** If the RTC alarm or `/sys/power/state` isn't
  usable the loop logs it once and sleeps awake instead — the old behaviour.
  The hourly `battery N% <status> <µA>` line in `image.log` is the discharge
  meter: unplug for a few hours and read the slope.

Rough expectations on a full cell: about a day always-awake, 1–2 weeks
suspending at the 5-minute cadence, 2–3 weeks at 15 minutes. Measure — the
suspend path was written against the kernel interfaces, not yet timed on the
wall unit.

---

## Daily recurring tasks (`*`)

Some chores come back every day — the dishwasher, the bins, watering the plants.
Put a **`*` anywhere in the task's title** and the Worker treats it as a daily
task:

| | |
|---|---|
| `* Opvask` | ticked off → leaves the wall → **back tomorrow morning** |
| `Book tandlæge` | ticked off → gone for good, as usual |

At **local midnight** the Worker finds every *completed* `*` task in the list
currently served to the Kindle and reopens it (back to "not started") in
Microsoft To Do. The wall picks it up on its next poll. Nothing is created or
deleted — it's the same task, so its notes and due date survive.

**Marking:** the `*` can sit anywhere in the title, and it stays visible on the
wall — that's the cue that it's a daily one. Only the **served** list is reset;
tasks in other lists are untouched until you select that list.

**Timezone.** Cloudflare Cron Triggers fire on UTC only, so `wrangler.jsonc`
registers *both* hours that can be Copenhagen midnight — `22:00` UTC (summer,
CEST) and `23:00` UTC (winter, CET) — and the Worker runs the reset only on
whichever one is genuinely local midnight that day. So it stays right across the
DST switch with no seasonal edit. To move it, change **both**:

```jsonc
// worker/wrangler.jsonc
"triggers": { "crons": ["0 22 * * *", "0 23 * * *"] },  // the two candidate UTC hours
"vars":     { "RESET_TIMEZONE": "Europe/Copenhagen" }   // the zone that decides
```

Walking all 800 firings over the next 400 days gives **exactly one run per local
day** — no doubled runs, no gaps, and the handover lands on the DST changeover
day itself (25 Oct 2026 → `23:00Z`, 28 Mar 2027 → back to `22:00Z`).

> **If you move `RESET_TIMEZONE`,** check that the zone's DST switch doesn't
> happen *at* midnight. The EU shifts at 02:00/03:00 local, so the midnight hour
> is never skipped or repeated — but a zone that transitions at midnight can lose
> hour 0 for a day, and that night's reset would silently not run.

**Testing it without waiting for midnight:**

```bash
# against the deployed Worker — runs the reset immediately
curl -X POST "https://<yourdomain>/api/reset-recurring?t=<TODO_TOKEN>"
# -> {"scanned":42,"reopened":["* Opvask"],"failed":[]}

# or locally, driving the cron itself
cd worker && npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+22+*+*+*"
```

Note the curl above exercises the *reset*, not the *schedule* — it bypasses the
cron entirely. To confirm the schedule itself is registered on the deployed
Worker:

```bash
npx wrangler deployments list          # did the deploy land?
# and watch the real thing fire at local midnight:
npx wrangler tail --format pretty      # or dashboard -> Worker -> Logs -> Cron Events
```

Each run logs a `recurring reset` line (Workers Logs is enabled), and a task
Graph refuses is reported in `failed` without stopping the rest — it just gets
picked up by the next night's run.

---

## Notes & gotchas (learned the hard way)

- **The charge-screen "bar":** stopping only `lab126_gui` leaves the `blanket`
  screensaver running under `x`; while charging it paints the battery graphic
  over the image. Stop the whole **`x`** job (as `boot-image.sh` does).
- **HTTPS on the old browser:** the Kindle's `curl`/OpenSSL do modern TLS fine,
  so it reaches the Cloudflare edge (custom domain or `workers.dev`) over HTTPS
  without trouble.
- **Blinking:** e-ink redraws flash, so the loop redraws **only on change**.
- **Security:** the token is kept out of git — it lives in the deployed
  Cloudflare secret, the git-ignored `worker/.dev.vars` and `.env`, and the
  device's uncommitted `config.local`. Rotate it (below) if it ever leaks.

## Error screens

When something breaks, the wall shows a friendly full-screen message instead of
a silently stale (or frozen) list. They fall into two groups by *where* they're
drawn — because a screen can only be rendered while the Worker is reachable.

**Rendered by the Worker** — served in place of the list when Microsoft Graph
fails, after a ~5-min last-known-good grace window:

| Screen | Means | What to do |
|:------:|-------|------------|
| <img src="docs/errorpages/backend.png" width="120" alt="Microsoft To Do isn't responding"> | **Microsoft To Do isn't responding** — Graph is down, timing out, or rate-limiting. | Nothing — transient, clears itself. |
| <img src="docs/errorpages/auth.png" width="120" alt="Microsoft sign-in expired"> | **Sign-in expired** — the refresh token was revoked or expired. | Mint a new refresh token and update the `MS_REFRESH_TOKEN` secret. |
| <img src="docs/errorpages/list.png" width="120" alt="That list is gone"> | **List gone** — the selected list was deleted in To Do. | Pick another list in the web app. |

**Drawn on the Kindle** — the Worker is unreachable, so the device draws a local
PNG (pre-downloaded by `scripts/kindle.sh deploy`) after ~1 min of failed polls:

| Screen | Means | What to do |
|:------:|-------|------------|
| <img src="docs/errorpages/nowifi.png" width="120" alt="No Wi-Fi"> | **No Wi-Fi** — no network, DNS, or TLS (or the device clock is wrong). | Check Wi-Fi; if it changed, use the `DISABLE` escape hatch below. |
| <img src="docs/errorpages/notfound.png" width="120" alt="Server not found"> | **Server not found** (404) — wrong URL, route disabled, or not deployed. | Check the deploy / the `BASE_URL`. |
| <img src="docs/errorpages/unauthorized.png" width="120" alt="Access token mismatch"> | **Token mismatch** (401) — the device token ≠ the deployed secret. | Re-run `scripts/kindle.sh deploy`. |
| <img src="docs/errorpages/server.png" width="120" alt="Server error"> | **Server error** (5xx) — the Worker crashed. | Usually transient; check `wrangler tail` if it persists. |
| <img src="docs/errorpages/battery.png" width="120" alt="Battery low"> | **Battery low** — discharging below ~20 % (charger off/unplugged). | Restore power; the list returns on the next change. |

> Colors dither to grayscale on the Kindle's e-ink panel; the emoji and text stay
> perfectly legible. Preview any screen live at `/error/<kind>.png?t=<TODO_TOKEN>`.

## Resilience & recovery

The kiosk stops the whole `x` stack (no on-device UI) and redraws **only on
change**. That makes it robust to *content* failures but brittle to *access*
failures. How the common scenarios play out:

| Scenario | What happens | What to do |
|----------|--------------|------------|
| **Charger unplugged / power cut** | The loop notices `Discharging`, slows to 5-min polls and suspends between them (days, not a day — see [Power & battery](#power--battery)). Under 20 % it draws **"Battery low 🔌"**; at 5 % it syncs and powers off cleanly, leaving that screen on the panel. On re-plugging it boots and redraws itself. | Nothing — it self-heals. Run it off a wall charger. |
| **Frontlight annoying** | It's the light, not the silent image. | Default is already **off** (`FLINTENSITY=0`). Set it live or in `config.local`. Or shut down — e-ink keeps the image. **Avoid a short power-press (sleep):** an unchanged list returns `304`, so the loop won't repair a cleared/sleep screen until the todos actually change. (The loop's own night/battery suspend doesn't touch the panel.) |
| **Microsoft/Graph down** | Worker keeps serving the last-good list for ~5 min, then renders a "not responding 😵" / "sign-in expired 🔑" screen. | Usually self-heals. "Sign-in expired" needs a new refresh token (see decommission/setup). |
| **Wi-Fi changes** (new password / router / house) | No network → after ~1 min the device draws its local **"No Wi-Fi 😢"** screen (instead of freezing silently). X is stopped, so there's no UI to rejoin, and SSH runs over Wi-Fi. | Easiest: keep the **same SSID + password** when swapping routers and it just reconnects. Otherwise use the **`DISABLE` escape hatch** below to get the normal UI back and rejoin Wi-Fi. |
| **Wi-Fi gone but nothing changed** | Same "No Wi-Fi 😢" screen, but the network is fine. Almost always the post-suspend handshake race described in [Wi-Fi after suspend](#wi-fi-after-suspend--a-failure-class-every-kindle-dashboard-hits): the router deauthed the Kindle and `wifid` deleted the saved profile. (Sanity-check from a laptop that the **2.4 GHz** band is visible — Kindles can't see 5 GHz-only networks.) | Self-heals when `WIFI_SSID`/`WIFI_PSK` are in `config.local`: the loop re-creates the profile and joins; `image.log` shows `wifi: no profile ... recreating` then `wifi up after Ns`. If it is still stuck after `REBOOT_AFTER_FAILS` failed joins it reboots itself; last resort, hard-restart (hold power ~40 s) and rejoin in Settings via the `DISABLE` flag. |
| **Bad deploy / wrong token** | Device draws **"Server not found 🧭"** (404) or **"token mismatch 🔒"** (401) after ~1 min. | Fix the deploy / re-run `scripts/kindle.sh deploy`. |
| **Boots to the stock home screen** (no board, KUAL *and* KOReader open blank, SSH refused) | `/mnt/us` is not mounting, so every part of the kiosk is gone at once. Tell-tale: Settings → Device Info shows **`0.02 GB of 0.48 GB`** — that's the ~493 MB *root* partition, not the ~6.2 GB user store. Usually ext3 damage from an unclean power loss. | In-place repair is blocked (KUAL blank, no SSH, usbnet holds the USB gadget so no drive appears). See [Recovery — rebuilding the Kindle](docs/recovery-rebuild.md). |

### Wi-Fi after suspend — a failure class every Kindle dashboard hits

If you suspend-to-RAM (`echo mem > /sys/power/state`) with the radio **associated**,
the Broadcom driver fast-reassociates on resume before it has told wpa_supplicant.
The router's first 4-way-handshake frame arrives too early, the Kindle's ancient
supplicant drops it (upstream fixed this in 2017 — hostap "Fix delayed EAPOL RX
frames" — Amazon never shipped the fix), and the router deauthenticates with reason
15, "4-way handshake timeout". Amazon's `wifid` reads reason 15 as **"Bad password"**,
lowers the saved network's priority on each occurrence, and after about three
**deletes the profile outright**. From then on nothing reconnects until a human
retypes the password in Settings. Retrying harder (`wpa_cli reassociate`,
`disconnect`/`reconnect`, `wifid enable 0/1`) makes it worse: every extra attempt
inside the bad window is another strike.

What works, and what every long-running battery dashboard does:

- **Radio off before suspend, on after wake**, then wait for
  `lipc-get-prop com.lab126.wifid cmState` to read `CONNECTED`, so every wake is a
  clean, supplicant-driven join (`WIFI_RADIO_OFF=1`, the default).
- **Never suspend on the charger** at all (`SUSPEND_ON_CHARGER=0`, the default). An
  associated radio that never resumes never fails.
- Keep the SSID and password on the device (`WIFI_SSID` / `WIFI_PSK` in
  `config.local`). If `cmState` ever sits in `READY` (enabled, idle = no profile),
  re-create it with `lipc-hash-prop com.lab126.wifid createProfile` and
  `lipc-set-prop com.lab126.cmd ensureConnection wifi:<SSID>` — the same calls the
  Settings screen makes. `image-loop.sh` does this after 8 s of `READY`.
- Airplane mode (`com.lab126.cmd wirelessEnable`) **persists across reboots**, so
  `boot-image.sh` forces it back to 1 unconditionally.
- Router side, if you control it: turn off "Roaming Assistant" (it kicks weak
  clients mid-handshake) and consider disabling 802.11ax on 2.4 GHz. Verify with the
  router's own log: no new "4-way handshake timeout" lines for the Kindle's MAC.
- Reading the device's logs without SSH: drop the `DISABLE` flag (below), boot to the
  normal UI, type `;dm` in the home-screen search box; the syslog, netlog and
  wpa_supplicant logs land in `documents/`.

### The `DISABLE` escape hatch

If `boot-image.sh` finds a file named `DISABLE` in `extensions/kindletodo/` (or
in `bin/`), it exits **before** stopping `x`, leaving the normal Kindle UI — KUAL,
Wi-Fi settings, KOReader — fully usable. Create it any way you can reach the
device:

- **Over USB** (no shell, no Wi-Fi needed): plug into a computer, and on the
  Kindle's USB drive create an empty file at
  `extensions/kindletodo/DISABLE`, then eject and reboot.
- **Over SSH:** `scripts/kindle.sh ssh 'touch /mnt/us/extensions/kindletodo/DISABLE'` then reboot.

Delete the file (and reboot) to hand the panel back to the kiosk.

### Repurposing the Kindle later (e.g. back to plain KOReader)

You don't need this repo or any secret for this — the goal is just to stop the
kiosk:

1. **Best:** drop the `DISABLE` flag (above), reboot → normal Kindle. To remove
   it permanently, over SSH: `mntroot rw; rm /etc/upstart/kindletodo.conf; mntroot ro`,
   then `rm -rf /mnt/us/extensions/kindletodo`.
2. **If you've lost the SSH password and Wi-Fi:** the `DISABLE`-over-USB route
   still works. Failing that, **factory-reset and re-jailbreak** — that needs no
   secrets and no repo, and gives you a clean KOReader install.

### Decommissioning the cloud side (don't skip this)

Reclaiming the Kindle does **not** stop the Worker — it keeps running and **keeps
a live refresh token to your Microsoft account**, readable by anyone who still
has the token URL. When you retire the board:

- `cd worker && wrangler delete` (or at least
  `wrangler secret delete MS_REFRESH_TOKEN`) to take the Worker offline.
- **Revoke** the Azure app registration / the refresh token in your Microsoft
  account, so nothing can read your To Do lists afterward.

### Keep these outside the repo

The repo deliberately excludes every secret, so save these in a password manager
— without them, recovery falls back to a factory reset:

- **Cloudflare** account (to tear down / rotate the Worker + token)
- **Azure app** registration + **MS refresh token** (to revoke access)
- **`KINDLE_SSH_PASS`** + **Wi-Fi** SSID/password (for graceful device recovery)
- **`TODO_TOKEN`** (minor — rotatable via Cloudflare)

## Secrets & the `.env`

Two git-ignored env files, plus the device's own config — all excluded by
`.gitignore` (`.env`, `.dev.vars`, `*.local`):

| File | Where | Holds |
|------|-------|-------|
| `worker/.dev.vars` | laptop | Worker dev secrets: `TODO_TOKEN` + MS credentials (for `wrangler dev` and `wrangler secret put`) |
| `.env` | laptop | Ops/deploy: `TODO_TOKEN`, `KINDLE_IP`, `KINDLE_SSH_PASS`, `KINDLE_FLINTENSITY` (used by `scripts/kindle.sh`, so you never re-scan for the device) |
| `bin/config.local` | Kindle | just `TODO_TOKEN` — written by `scripts/kindle.sh deploy`, sourced by `boot-image.sh` |

`TODO_TOKEN` must be identical across all three **and** the deployed Cloudflare
secret.

**Finding `KINDLE_IP`:** the device runs a Dropbear SSH server on port 22 —
`nmap -p22 --open 192.168.1.0/24`, or check your router's DHCP leases. Save it in
`.env` once. **`KINDLE_SSH_PASS`** is the USBNetLite root password
(`/mnt/us/usbnetlite/etc/config` on the device).

**Rotating the token** (do all four so nothing 401s for long):

```sh
NEW=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)
sed -i -E "s/^TODO_TOKEN=.*/TODO_TOKEN=$NEW/"   worker/.dev.vars   # 1. Worker dev
sed -i -E "s/^TODO_TOKEN=.*/TODO_TOKEN=\"$NEW\"/" .env             # 2. ops env
cd worker && printf '%s' "$NEW" | wrangler secret put TODO_TOKEN && cd ..   # 3. prod
scripts/kindle.sh deploy                                          # 4. the Kindle
```

## Credits

- Microsoft Graph client ported from **microsoft-todo-cli**.
- PNG rendering by **[@cf-wasm/og](https://github.com/fineshopdesign/cf-wasm)**
  (satori + resvg).
- Kindle jailbreak, **fbink**, **KUAL**, **USBNetLite** from the
  [kindlemodding.org](https://kindlemodding.org) / MobileRead communities.

## License

[MIT](LICENSE) © Christian Dalager
