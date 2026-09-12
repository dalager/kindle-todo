# Recovery — rebuilding the Kindle after an unmountable user store

Written 2026-09-12, after the wall unit dropped to the stock home screen and
could not be recovered in place. This is the runbook for the worst realistic
device failure: **`/mnt/us` stops mounting**, which kills every part of the
kiosk at once and locks you out of all the usual repair routes.

The Worker is not involved in any of this. Throughout the 2026-09-12 incident
`/todo.png` kept returning `200` — the cloud half never noticed.

---

## 1. Recognising the failure

The giveaway is a single number. **Settings → Device Info → storage** reported:

```
0.02 GB of 0.48 GB
```

`0.48 GB` is the **~493 MB root partition**, not the ~6.2 GB user store (see
[the device spec](devices/paperwhite_10gen.md#memory--storage)). The framework
is reporting root as the whole device because **`/mnt/us` is not mounted**. On a
healthy unit this figure is in gigabytes.

Everything else follows from that one fault:

| Symptom | Why |
|---|---|
| Boots to the stock home screen, no todo board | Upstart execs `/mnt/us/extensions/kindletodo/bin/boot-image.sh`; no mount → no file → exec fails → `respawn limit 10 120` gives up → `x` is never stopped |
| **KUAL opens blank** | KUAL builds its menu by scanning `/mnt/us/extensions/` |
| **KOReader opens blank** | Same — `/mnt/us/koreader/` |
| **SSH refused** on port 22 over Wi-Fi | USBNetLite's scripts live on the user store too |
| Library still lists KUAL, KOReader, JAILBROKEN | That index is cached in the framework DB **on root**, so the entries render but launching finds nothing |
| Wi-Fi fine, framework boots, USB gadget enumerates | All root-fs side — untouched |

### Don't be misled by these

Two observations cost real time during the incident:

- **The library listing is not proof the user store is mounted.** It is a cached
  index on root. Seeing KUAL/KOReader/JAILBROKEN there says nothing about
  `/mnt/us`.
- **A dropped ping is not proof Wi-Fi is down.** The Kindle does not answer
  ICMP here. Test TCP instead — an active `connection refused` on port 22 means
  the stack is **alive** and only `sshd` is missing:

  ```sh
  timeout 3 bash -c 'cat </dev/null >/dev/tcp/<KINDLE_IP>/22'
  # "Connection refused"  -> host alive, dropbear not running
  # timeout / no response -> genuinely unreachable
  ```

### Triage from the laptop

```sh
# Is the device on Wi-Fi at all? (ARP works even when ICMP is dropped)
ip neigh | grep <KINDLE_IP>            # Amazon OUI, e.g. 44:00:49:...

# What does it present over USB?
lsusb | grep -i netchip                # 0525:a4a2 = usbnet gadget (RNDIS)
lsblk                                  # a block device = USB drive mode
journalctl -k -b | grep -iE 'usb .*new|Gadget|cdc_'
```

> **A charge-only micro-USB cable looks exactly like a dead device.** If
> `journalctl -k` logs *no* USB enumeration at all — not even a failed one —
> swap the cable before concluding anything.

---

## 2. Why in-place repair is blocked

Each normal repair route depends on something the same fault has taken out:

| Route | Blocked by |
|---|---|
| SSH in and `fsck` | Dropbear's scripts are on the unmounted volume |
| KUAL → *Kindle Todo* → start by hand | KUAL is blank |
| KUAL → USBNetLite → enable SSH | KUAL is blank |
| Mount as a USB drive and repair the files | usbnet holds the USB gadget; only one gadget at a time, so no mass storage appears |
| `;un` in the home-screen search bar to toggle usbnet off | Search-bar debug commands are disabled on 5.18.x. It changes the USB descriptor (`cdc_subset` → `cdc_ether`) but restores neither storage nor SSH |
| `DISABLE` flag over USB | Needs USB drive mode — same block |

They interlock: every one's fix lives behind another. A ~40 s hard-restart does
not clear it. (A charge-only cable, a blank KUAL, and a dropped ping each looked
like this failure at some point — see the traps in §1.)

**The one non-destructive route left** is the serial console: interrupt u-boot
at `ttymxc0` @ 115200, drop to diags, and `fsck` the user-store partition. That
preserves the jailbreak and the data — but the console is internal, so it means
a teardown plus a USB-TTL adapter. Worth it only if the user store holds
something not in git (sideloaded books, KOReader annotations). For this project
it holds nothing you don't already have here. See the
[PW4 teardown](https://www.mobileread.com/forums/showthread.php?t=312360) and
[Kindle4NTHacking](https://wiki.mobileread.com/wiki/Kindle4NTHacking).

---

## 3. Check the jailbreak window **before** resetting

> **The one way to make this permanently worse.** A factory reset wipes the
> jailbreak. If no current exploit covers the firmware you land on, you own a
> stock Kindle and the kiosk is gone for good. **Confirm this first, every
> time** — the window moves as Amazon patches.

Used on 2026-09-12, on **5.18.1.1.1**: **SpiderCat** (`jb.sh v1.3.7`, by
sparklerfish). Sideload `spidercat.azw3` into `documents/`, open it, and the
reader crashes out once — that crash is the exploit, not a fault. It leaves
`privesc_marker.txt` (`uid=0`) and `JAILBROKEN.txt` on the user store, and
installs `libkh/bin/fbink` itself.

Alternatives at the time: Sanctuary (5.16.4–5.18.3), AdBreak (5.18.1–5.18.5),
Véra (≤ 5.19.6). Check
[KindleModding — Find my Jailbreak](https://kindlemodding.org/kindle-models.html)
before relying on any of this.

**Do not let the device take an OTA update before you jailbreak it.** An update
out of the supported window strands you.

### What the modern stack looks like (hdnext)

Two things about the post-SpiderCat world that cost time to discover:

- **KUAL is gone.** The launcher is **KPM** (`/var/local/kmc/bin/kpm`, driven from
  the search bar: `;kpm install koreader`). Commands are **silent** — no output
  is normal. Verify by looking at the user store over USB, not the screen.
- **Root does not survive a reboot until persistence is installed.** After a
  reboot `;kpm` silently does nothing and `privesc_marker.txt` gets no new line.
  Re-open the `spidercat` book to get root back, then do everything in one
  sitting. (Whether persistence was installed is still unverified for this unit —
  the kiosk does not need it, see §4.)
- **A scriptlet is a `#!/bin/sh` in `documents/`** with `# Name:` / `# Author:`
  header comments. It shows up as a book and **runs as root when opened**
  (verified 2026-09-12). This is how the one root-only install step is done now.
- **The official KPM repo has no SSH package** (four packages: KOReader, KPM,
  KOmpanion, kTerm). SSH means the usbnetlite `.bin`, or a shell via kTerm.

---

## 4. Rebuild walkthrough (as done 2026-09-12)

Everything the kiosk needs is in this repo plus `.env`. **SSH is not required.**
The board drew on the first reboot without it.

### Before you start

- [ ] Confirm the firmware is still inside a supported window (§3).
- [ ] Confirm Wi-Fi works (an active `connection refused` on port 22 already
      proves the stack is fine).
- [ ] Accept that **everything on the user store is lost** at reset.
- [ ] Have `.env` to hand (`TODO_TOKEN`, `KINDLE_IP`; `KINDLE_SSH_PASS` only if
      you also want SSH) — see [Secrets & the `.env`](../README.md#secrets--the-env).

### Steps

1. **Factory reset.** Settings → Device Options → Reset. This rebuilds the user
   store — the actual broken thing. Afterwards Device Info must show storage in
   **gigabytes** (it showed `6.21 GB`); if it still says `0.48 GB`, stop.

2. **Reconnect Wi-Fi.** Same **2.4 GHz SSID** — the PW4 has
   [no 5 GHz radio](devices/paperwhite_10gen.md#wireless). The DHCP lease kept
   the same IP (`KINDLE_IP` unchanged), but check.

3. **Jailbreak.** Enter USB drive mode, drop `spidercat.azw3` into `documents/`,
   eject, open it on the device. Confirm `privesc_marker.txt` appeared.

4. **Stage from the laptop** (Kindle in USB drive mode, mounted):
   ```sh
   scripts/stage-usb.sh
   ```
   That lays down `extensions/kindletodo/`, `bin/config.local` (the token, from
   `.env`), fbink at the hardcoded `libkh/bin/fbink` path, the error screens, and
   the install scriptlet `documents/KindleTodo-Install.sh`. Eject.

5. **On the device, with root live** (re-open `spidercat` first if you have
   rebooted since jailbreaking): open the book **"Kindle Todo - install boot
   service"**. It copies the Upstart job onto the root fs. The result is in
   `extensions/kindletodo/install-scriptlet.log` — expect `id: uid=0(root)`,
   `upstart conf installed`, `kindletodo stop/waiting`. An
   `initctl: Did not receive a reply` line is a D-Bus timeout and harmless.

6. **Reboot.** Home screen → ~20 s settle → display stack stops → the board
   draws. Under two minutes from power-on.

### Optional: SSH, afterwards

Only needed for `scripts/kindle.sh deploy/logs/ssh`. `stage-usb.sh` also stages
the usbnetlite installer into `mrpackages/` and pre-seeds its config with
`KINDLE_SSH_PASS`; its documented trigger is `;log mrpi` (unverified on hdnext).
Then `STAGE_USBNET_AUTO=1 scripts/stage-usb.sh` creates the enable flag — which
**takes USB drive mode away** at every boot, so do it last.

### Afterwards

- **Block OTA updates** — an update out of the jailbreak window is how you end
  up back here with no way out.
- **Run it off a wall charger, not a computer's USB port.** Unclean power loss
  is the suspected origin of this whole failure.
- Note the jailbreak name/version/date in
  [`devices/paperwhite_10gen.md`](devices/paperwhite_10gen.md) — not having it
  recorded cost time this time.

---

## 5. Prevention

The trigger was almost certainly **ext3 damage on the user store from an
unclean power loss**. The kiosk never sleeps and writes little, so the exposure
is mostly at power-cut time.

- Wall charger, always — not a laptop port, not a switched strip.
- Prefer a clean shutdown over yanking power when moving the frame.
- If a filesystem check ever does start on boot, **let it finish**. Interrupting
  it is how a recoverable mount failure becomes a reflash.

---

## Sources

- [KindleModding — Sanctuary](https://kindlemodding.org/jailbreaking/Sanctuary/)
- [KindleModding — Find my Jailbreak](https://kindlemodding.org/kindle-models.html)
- [MobileRead — Sanctuary: Jailbreak for ANY Kindle model, FW 5.16.4–5.18.3](https://www.mobileread.com/forums/showthread.php?t=374200)
- [MobileRead Wiki — Kindle4NTHacking](https://wiki.mobileread.com/wiki/Kindle4NTHacking)
- [PW4 teardown — MobileRead](https://www.mobileread.com/forums/showthread.php?t=312360)
