# companion-module-androidtv-adb

[Bitfocus Companion](https://bitfocus.io/companion) module that controls **any-brand Android TV / Google TV over the network using ADB** (TCP 5555): power with Wake-on-LAN, power-state feedback, HDMI input, volume, arbitrary key codes and shell commands. Built for Stream Deck users.

- **Direct ADB in pure Node.** The module implements the ADB protocol itself (CNXN handshake, RSA auth with on-screen approval, shell streams) using only Node's built-in `crypto`/`net`. There's no `adb.exe`, no adb server, no relay, and no runtime dependencies beyond `@companion-module/base`.
- **Works across subnets.** It uses routed TCP to the TV, plus Wake-on-LAN to a configurable directed-broadcast address.
- **One connection per TV.** Each connection keeps its own persisted ADB key, so the TV's "Allow USB debugging" approval survives restarts and upgrades.

Requires **Companion 4.0 or later** (module API 1.12, Node 22 runtime). Tested on **Companion 5.1.3** (Windows x64).

## Features

|                         |                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Actions**             | Power On (KEYCODE_WAKEUP; with Wake-on-LAN + ADB retry window if the TV is offline), Power Off (KEYCODE_SLEEP), Power Toggle (KEYCODE_POWER), Select HDMI 1–4, Volume Up / Down, Mute, Send key code (number or `KEYCODE_*` name), Run shell command, List TV inputs, Refresh status |
| **Feedbacks** (boolean) | Power state (on / off / offline / unknown), Connection state (connected / connecting / awaiting approval / offline / approval denied / disconnected / error), Waking (WoL in progress)                                                                                               |
| **Variables**           | `power_state`, `connection_status`, `model`, `manufacturer`, `android_version`, `last_error`, `last_input`, `tv_inputs`, `last_shell_output`, `adb_key_fingerprint`                                                                                                                  |
| **Presets**             | Power: On / Off / Toggle (shows state) · Input: HDMI 1–4 · Volume: Up / Down / Mute · Status display. All carry power / approval / waking feedbacks                                                                                                                                  |
| **Status**              | OK, Connecting, _Awaiting approval on TV_ (warning), _TV offline / unreachable_ (connection failure), approval denied (auth failure)                                                                                                                                                 |

### HDMI switching

HDMI selection is vendor-specific, so there are four methods. Set one per connection, and override it per button if needed.

- **Auto** (default): reads `dumpsys tv_input` once and maps each HDMI port to the TV's input ID (the TV input framework names hardware inputs `…/HW<deviceId>` and reports `hdmi_port=<n>` for each device). It then opens that input with the passthrough intent `am start -a android.intent.action.VIEW -d content://android.media.tv/passthrough/<id>`. If nothing is found, it falls back to the key event.
- **Key event**: `KEYCODE_TV_INPUT_HDMI_1..4` (243–246). Many Google TVs ignore these: the test TCL did, and the same was reported for a Philips Google TV.
- **Passthrough intent**: you enter the TV input ID per HDMI port. **List TV inputs** fills `tv_inputs` and the log with suggestions.
- **Custom shell command** per port.

## Install on the Companion PC

1. Download `androidtv-adb-<version>.tgz` from the [Releases](https://github.com/shiham-dev/companion-module-androidtv-adb/releases) page (or build it, see below).
2. In the Companion web UI (default `http://127.0.0.1:8000`), go to **Modules → Import module package** and pick the `.tgz`.
3. Go to **Connections**, search for **"Android TV / Google TV (ADB)"** (listed under "Generic") and click **Add**.
4. Enter the TV IP and click **Save**. The MAC address and the WoL broadcast address fill in **automatically** the first time the module reaches the TV. The MAC comes from the TV's wired interface and the broadcast from its subnet. You can also type them in.
5. On the TV, accept **"Allow USB debugging?"**: tick _Always allow from this computer_, then press _Allow_. Until you do, the connection shows _Awaiting approval on TV_. The fingerprint shown on the TV matches the one in the connection settings and in `$(<label>:adb_key_fingerprint)`.
6. Drag the presets from **Buttons → Presets → \<connection\>** onto your Stream Deck pages.

To update, import the newer `.tgz`, then pick the new version on the connection (the pencil next to _Module Version_). The connection keeps its config and ADB key.

**Alternative (developer modules folder):** in the Companion launcher, open settings, enable _Developer modules_ and point the path at a folder that contains this repository, built with `npm ci && npm run build`. Companion loads `companion/manifest.json`, which points at `dist/main.js`.

## Per-TV prerequisites

1. **Developer options**: Settings → System → About → _Android TV OS build_. Press OK 7 times.
2. Under **Developer options**, enable **USB debugging** and **Network debugging / ADB over network** (the name varies by brand). TVs that only offer Android 11+ _Wireless debugging_ with pairing codes (TLS) aren't supported. The module reports "TLS required".
3. **Approve the key** on first connect (see above). Each Companion connection has its own key.
4. For power-on from standby, enable **Network standby / Wake on LAN / Wake on Wi-Fi / Quick start** (the name varies by brand). A **wired connection is strongly preferred**: on Wi-Fi many TVs drop off the network when asleep.
5. Give the TV a fixed IP (DHCP reservation).

### Network / firewall

- **Companion host → TV: TCP 5555** must be allowed (routing across subnets is fine).
- **Wake-on-LAN: UDP (port 9 by default)** from the Companion host to the TV subnet's **directed broadcast** address. The router or L3 switch must allow directed broadcasts to that subnet (often off by default, e.g. `ip directed-broadcast` on Cisco), and firewalls must pass the UDP packets.
- Many TVs accept **only one ADB client at a time**. If another system also uses ADB on the TV, untick **Keep ADB connection open** so the module connects only for each poll or command. With the box ticked (the default), the module holds the connection to keep polling light and fast.

## Configuration

| Field                       | Default                 | Notes                                                                                                                                                 |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TV IP address / hostname    |                         | required                                                                                                                                              |
| ADB port                    | 5555                    |                                                                                                                                                       |
| MAC address                 | learned                 | Read from the TV on first connect (wired MAC) and saved. Without it, Power On cannot wake a TV that is off the network                                |
| WoL broadcast address       | learned                 | The TV subnet's directed broadcast, read from the TV on first connect. If empty, x.y.z.255 of the TV IP is used. Packets also go unicast to the TV IP |
| WoL port                    | 9                       |                                                                                                                                                       |
| WoL packets per burst       | 5                       | The burst repeats every 5 s during the wake window                                                                                                    |
| Wake wait (s)               | 60                      | How long Power On keeps sending WoL and retrying ADB. A TV booting after a power cut needed about 50 s                                                |
| Status poll interval (s)    | 5                       | `dumpsys power` (filtered on the TV). 0 disables polling                                                                                              |
| Keep ADB connection open    | on                      | See the one-client note above                                                                                                                         |
| HDMI switching method       | Auto                    | Auto / Key event / Passthrough / Custom, plus per-port ID or command                                                                                  |
| ADB key name                | companion-androidtv-adb | Label shown on the TV's approval dialog                                                                                                               |
| Show / edit ADB private key | off                     | Advanced: view or paste a PEM key (e.g. reuse an `adbkey` the TV already trusts), or generate a new one                                               |

**Key storage.** The RSA-2048 key is generated on first run and saved in the connection's config (hidden field, written with `saveConfig`). That's what makes the approval stick. It also means a Companion config export contains the key, so treat exports as sensitive.

## How it works

- **ADB:** `CNXN` with version `0x01000001` and a 1 MiB max payload (the older version with a large payload makes adbd drop the connection). Then `AUTH TOKEN` → `SIGNATURE` (RSA PKCS#1 v1.5 over the SHA-1 DigestInfo prefix plus the token, not re-hashed). If the TV rejects that, `RSAPUBLICKEY` in Android's mincrypt format (`base64(struct) + " name\0"`), and the TV shows the approval prompt. Commands run as `shell:` streams over one connection, serialized, with reconnect on drop.
- **Power state:** `dumpsys power`, using `mWakefulness=Awake|Dreaming` → on and `Asleep|Dozing` → off (with fallback to `Display Power: state=`). If the TV is unreachable, the state is **offline**.
- **Power On:** if ADB answers, send `KEYCODE_WAKEUP`. Otherwise, if a MAC is set, send WoL bursts and retry ADB for the wake window, then send `KEYCODE_WAKEUP`. Actions return to Companion at once and run in the background, so Companion never blocks.

## After a power cut (mains off/on)

Many TVs, including the TCL tested here, come back from a mains cycle in a **cold standby** with Android not running. The TV is then completely off the network: no ping, no ADB. Plain ADB can't wake it, and **Wake-on-LAN is the only remote path**. That needs:

1. The **MAC address** on the connection. The module learns it on first contact; if the TV has never been reached, switch it on once with the remote.
2. The TV's **Wake-on-LAN / network standby** setting **on**, and the TV must honour it from cold standby. Not every model does: check the TV menu, usually _Settings → System/Device preferences → Power_ (or _Network_) → _Network standby_, _Wake on LAN_ or _Power on with network_. If the menu offers _Power on behaviour after power loss: Last state / On_, set it to suit the room.
3. The **network** delivering the magic packet: a directed broadcast to the TV subnet (routers often block these) or unicast to the TV IP.

Power On then sends WoL bursts every 5 s and retries ADB for the wake window (60 s by default; a cold boot to ADB took about 50 s on the test TV). After that it sends KEYCODE_WAKEUP and checks that the TV reports Awake. If the TV doesn't come back, the connection reports why.

## Development

```sh
npm ci
npm run lint        # eslint (Companion ruleset)
npm run typecheck
npm test            # unit tests: framing, pubkey encoding, signing, WoL, parsers, fake-adbd client tests
npm run package     # builds dist/ and androidtv-adb-<version>.tgz via companion-module-build
npm run livetest -- <tv-ip> [port] [path/to/adbkey]   # read-only: connect, dumpsys power, getprop model
```

Releases: push a `v*` tag, and the release workflow builds the `.tgz` and attaches it to a GitHub release.

## Tested

- Unit tests (30), including an in-process fake adbd that exercises signature auth, public-key approval, approval timeout, refused services, command timeouts, reconnect and serialization. The pubkey encoder output was checked byte-for-byte against a `.pub` file written by the real adb tool.
- Live, from Companion 5.1.3 on Windows, against a **TCL Android TV** (Android 12, wired). Verified: first-run key generation and on-TV approval, power off / on / toggle with feedback, HDMI 1–3 with Auto and with manual passthrough IDs (key events were ignored by this TV), volume up / down, mute, offline detection and the WoL code path. That TV has _network standby_ enabled and keeps ADB alive while asleep, so plain ADB wake works there. It did **not** respond to magic packets, so a real wake-from-deep-standby via WoL is **untested**.

## License

MIT
