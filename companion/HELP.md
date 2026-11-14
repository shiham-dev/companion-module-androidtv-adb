## Android TV (ADB)

Controls one Android / Google TV of any brand over the network with ADB (TCP port 5555). The module speaks the ADB protocol itself, so you don't need `adb.exe` or an adb server. Add one connection per TV.

### TV preparation (once per TV)

1. **Settings → System → About → Android TV OS build**: press OK 7 times to enable **Developer options**.
2. **Developer options**: turn on **USB debugging** and **Network debugging / ADB over network** (the name varies by brand). Leave it on.
3. Give the TV a fixed IP (a DHCP reservation). A wired connection is strongly recommended.
4. For power-on from deep standby, enable **Network standby / Wake on LAN / Wake on Wi-Fi / Quick start** (the name varies by brand).
5. The first time the module connects, the TV shows **"Allow USB debugging?"**. Tick **Always allow from this computer** and press **Allow**. Until you do, the connection shows _Awaiting approval on TV_. The fingerprint on the TV matches the one shown in the connection settings.

### Network

- The Companion host needs TCP access to the TV on port 5555 (routing between subnets works).
- For Wake-on-LAN across subnets, set **WoL broadcast address** to the TV subnet's _directed broadcast_ (e.g. `192.168.20.255`). The router or firewall must allow directed broadcasts (UDP, port 9 by default) to that subnet.
- Many TVs accept **only one ADB client at a time**. If another system (relay, control processor) also uses ADB, untick **Keep ADB connection open**.

### Configuration

| Field                          | Meaning                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TV IP / port                   | Address of the TV, port 5555                                                                                                                                                                                                                                                                   |
| MAC address                    | Optional. Enables Wake-on-LAN when the TV is unreachable                                                                                                                                                                                                                                       |
| WoL broadcast / port / packets | Where to send magic packets (default 255.255.255.255:9, 5 packets)                                                                                                                                                                                                                             |
| Wake wait                      | How long to keep retrying ADB after WoL before giving up (default 15 s)                                                                                                                                                                                                                        |
| Poll interval                  | How often to read the power state (`dumpsys power`), default 5 s                                                                                                                                                                                                                               |
| HDMI switching method          | **Auto** (default: reads `dumpsys tv_input` once, maps HDMI ports to the TV's input IDs and opens them with the passthrough intent; falls back to key events), **Key event** (KEYCODE_TV_INPUT_HDMI_1..4), **Passthrough intent** (enter the TV input ID per HDMI) or **Custom shell command** |
| ADB key                        | Generated automatically and stored in the connection config so the approval survives restarts. Advanced: paste an existing `adbkey` (PEM) to reuse a key the TV already trusts                                                                                                                 |

### Actions

- **Power: On** sends KEYCODE_WAKEUP. If the TV is offline and a MAC is set, it sends Wake-on-LAN, waits for ADB, then sends KEYCODE_WAKEUP.
- **Power: Off** sends KEYCODE_SLEEP. **Power: Toggle** sends KEYCODE_POWER (or does Power On if the TV is offline).
- **Input: Select HDMI 1–4**, with an optional per-button method and input ID or command override.
- **Volume: Up / Down / Mute**.
- **Send key code**: any `KEYCODE_*` name or number.
- **Run shell command**: any `adb shell` command. Its output goes to `last_shell_output`.
- **List TV inputs**: runs `dumpsys tv_input` and puts the TV input IDs into `tv_inputs` and the log (for the passthrough method).
- **Refresh status now**.

### Feedbacks

- **Power state**: on / off / offline / unknown.
- **Connection state**: connected / connecting / awaiting approval / offline / approval denied / disconnected / error.
- **Waking**: Wake-on-LAN in progress.

### Variables

`power_state`, `connection_status`, `model`, `manufacturer`, `android_version`, `last_error`, `last_input`, `tv_inputs`, `last_shell_output`, `adb_key_fingerprint`

### HDMI switching notes

HDMI selection is vendor-specific. The HDMI key events (KEYCODE_TV_INPUT_HDMI_1..4) are ignored by many Google TVs (a TCL Android 12 TV ignored them in testing, and the same was reported for a Philips Google TV). **Auto** handles this by opening the TV input framework passthrough URI for the input that `dumpsys tv_input` reports on that HDMI port, which worked on the TCL. If Auto picks the wrong input on your TV, run **List TV inputs** (the result goes to `tv_inputs` and the log) and enter IDs per port, e.g. `com.mediatek.tvinput/.hdmi.HDMIInputService/HW5`, or switch to **Custom shell command**.
