# Device spec — Kindle Paperwhite 4 (10th gen, 2018)

Hardware profile of the Kindle this project runs on, probed live over SSH from
the jailbroken device (July 2026). Amazon codename **juno**, hardware platform
**rex**. Useful for sizing decisions (render target, polling cost, storage) and
for anyone porting kindle-todo to other e-ink hardware.

| | |
|---|---|
| Model | Kindle Paperwhite 4 (10th generation, "PW4", 2018), Wi-Fi, 8 GB |
| Codename / platform | `juno` / `rex` |
| Board | "Lab126 i.MX6SLL Board" |
| Firmware at probe | 5.18.1.1.1 (`023-juno_18010101_moonshine_rex-476968`) |

## SoC & compute

| Component | Detail |
|---|---|
| SoC | NXP **i.MX6SLL** (SoloLite L) |
| CPU | 1× ARM **Cortex-A9** r4p1 (ARMv7-A), NEON + VFPv3 |
| Clock | Two P-states only: **396 MHz / 996 MHz** (`performance` governor in kiosk mode) |
| L2 cache | ARM L2C-310, dynamic clock gating |
| Thermals | ~49 °C SoC while idling as a kiosk |

Single core at under 1 GHz — the reason this project renders the PNG in a
Cloudflare Worker and ships pixels, rather than asking the device to render
anything.

## Memory & storage

| Component | Detail |
|---|---|
| RAM | **512 MB**, plus a 128 MB **zram** compressed swap |
| eMMC | **8 GB** (`mmcblk1`, ~7.28 GiB) on i.MX uSDHC (ADMA); vendor not exposed by Amazon's kernel |
| Layout | EXT3; ~493 MB root (typically >90 % full — don't install to `/`), ~6.2 GB user store mounted at `/mnt/us` (extensions live here) |

## Display

The panel is the whole point of the device:

| Component | Detail |
|---|---|
| Panel | E Ink **ED060KC4U3** — 6″ Carta, **1072 × 1448**, **300 ppi**, 8-bit grayscale |
| Controller | i.MX **EPDC v2** (`20f4000.epdc`, `imx_epdc_v2_fb`), framebuffer `mxc_epdc_fb` |
| Waveform | `320_R226_AI0A02_ED060KC4U3_TC` (VCOM −2.32 V, panel hwid 12) |
| Touch | **Goodix** capacitive controller (`goodix-ts`, I²C) |
| Frontlight | White edge LEDs, Amazon `frontlight` driver, backlight `bl`, range **0–2047** |

kindle-todo renders `/todo.png` at exactly 1072 × 1448 for this panel, and maps
its `FLINTENSITY` 0–24 (`lipc-set-prop com.lab126.powerd flIntensity`) onto the
0–2047 hardware range via Amazon's power daemon.

## Wireless

| Component | Detail |
|---|---|
| Wi-Fi | Cypress **CYW43436** class (Broadcom lineage), `bcmdhd` driver |
| Firmware | `wl0: 7.45.102.16 (r728411 CY)`, FWID `01-361e1702` (2021) |
| Bands | **802.11 b/g/n, 2.4 GHz only** — no 5 GHz, so the kiosk needs a 2.4 GHz SSID |
| Bluetooth | Present on the retail PW4 (audio only); unused by this project |
| Bus | SDIO on `mmc0` |

The chip identification is a firmware-fingerprint match (the `(CY)` string +
FWID); the silkscreened part could be a Cypress- or Broadcom-marked equivalent.

## Power

| Component | Detail |
|---|---|
| PMIC | ROHM **BD71827** (I²C `0-004b`) — regulators, charging, RTC, power button |
| Battery | **1507 mAh** Li-ion design capacity; measured full-charge 1504 mAh (~100 % health after 7+ years) |
| Charging | micro-USB (i.MX6 USB PHY / VBUS); no wireless charging |
| Waterproofing | IPX8 (retail spec — the reason the wall unit shrugs off hallway humidity) |

In kiosk mode the device never sleeps (`preventScreenSaver=1`) but e-ink only
draws power on redraw, so it idles at load ~0.06 with the radio as the main
consumer.

## Software stack (as jailbroken)

| Layer | Detail |
|---|---|
| Kernel | Linux **4.1.15-lab126**, SMP PREEMPT, built with gcc 4.9.1 |
| libc | glibc **2.20** (2014) — why modern binaries generally need static linking |
| Init | Upstart (this project's `kindletodo.conf` hooks `started framework`) |
| Bootloader | u-boot with secure boot (`secure_cpu=1`, `unlocked_kernel=false`); serial console `ttymxc0` @ 115200 |
| Display userland | stock: X + lxinit/pillow/blanket (stopped by `boot-image.sh`); kiosk draws via **fbink** |
| SSH | Dropbear via USBNetLite (port 22, Wi-Fi) |

## Not software-visible

Two parts can't be identified without a physical teardown: the **eMMC flash
vendor** and the exact **frontlight LED driver IC**. Everything else above was
read from `/proc`, `/sys`, `dmesg`, or lipc on the running device.
