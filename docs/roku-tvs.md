# Roku TVs on the Network

Documented for reference and for the privacy-blocking experiment.

## TV 1 — Kitchen
| Field | Value |
|---|---|
| IP | 192.168.1.248 |
| Brand | TCL |
| Model | 55S20 (55") |
| Model number | C147X |
| Software | 16.0.4 (build 853) |
| Friendly name | "Ava's music room" |
| Location | Kitchen |
| MAC (Wi-Fi) | dc:72:23:d1:b6:1e |
| Network | Wi-Fi (Ben Lomand WiFi) |
| Power | On |
| ECP port | 8060 (open) |

## TV 2 — Bedroom
| Field | Value |
|---|---|
| IP | 192.168.1.115 |
| Brand | onn. (Walmart) |
| Model | 100044717 (75") |
| Model number | G891X |
| Software | 16.0.4 (build 853) |
| Friendly name | "75\" onn. Roku TV" |
| Location | Bedroom |
| MAC (Wi-Fi) | (not captured) |
| Network | Wi-Fi |
| Power | On |
| ECP port | 8060 (open) |

## Notes
- Both run Roku OS 16.0.4 with ECP (External Control Protocol) enabled on port 8060.
- ECP can be used for remote control and app launching (disabled by default on some; here `ecp-setting-mode: limited`).
- To control: `POST http://<ip>:8060/keypress/<key>` (Home, Up, Down, Left, Right, Select, Back, Play, Rev, Fwd, VolumeUp, VolumeDown, VolumeMute, Power).
- App list: `GET http://<ip>:8060/query/apps`. Launch: `POST http://<ip>:8060/launch/<channel-id>`.

## Privacy: blocking telemetry (experiment)
Goal: reduce data sent to Roku/TCL (and potentially China-based endpoints).

### Step 1 — Observe what they actually contact
Npcap is not installed, so local packet capture isn't available. Options:
- Install Npcap (https://npcap.com/) to enable tshark/Wireshark captures on this PC.
- Or monitor at the router (most routers have a "connected devices / traffic" log).
- Or run a DNS filter (AdGuard Home / Pi-hole) which logs every DNS query per device.

### Step 2 — Known Roku/TCL telemetry domains to block
Roku:
- logs.roku.com
- cooper.logs.roku.com
- austin.logs.roku.com (older firmware)
- (ad/tracking) *.roku.com ad endpoints

TCL (Chinese OEM):
- *.tcl.com / *.tclai.com
- Various TCL cloud endpoints

General tracking:
- doubleclick.net, google-analytics.com, googletagmanager.com (used by some Roku channels)

### Step 3 — Block (choose one)
**A. Router-level (best, affects the TVs directly):**
- Most routers support "Access Restrictions" / "Parental Controls" / custom DNS blocklists.
- Add the domains above to the router's blocklist, or set the router DNS to a filtering DNS (AdGuard DNS: 94.140.14.14, or NextDNS).

**B. DNS filter on this PC (AdGuard Home):**
- Download AdGuard Home: https://github.com/AdguardTeam/AdGuardHome/releases
- Run it, set router DNS to this PC's LAN IP (192.168.1.249).
- Add blocklists (AdGuard DNS filter, OISD, etc.) and per-device rules.
- Caveat: PC must stay on for DNS to work.

**C. Pi-hole (Linux/WSL or separate Pi):**
- Run on a Raspberry Pi or in WSL/Docker. Same concept as AdGuard.

**D. hosts file (this PC only — does NOT affect the TVs):**
- Only blocks on this machine, not the Roku. Not recommended for this goal.

### Step 4 — Test
- After blocking, open a channel on the TV and watch the DNS query log.
- If a channel stops working, unblock the domain it needs (some telemetry domains are shared with functional services).
- Start conservative: block only `logs.roku.com` and `cooper.logs.roku.com` first.

### Caution
- Blocking too aggressively can break software updates, channel loading, or streaming.
- Roku OS updates are signed; blocking update servers won't brick the TV, just delay updates.
- Some "telemetry" is required for channel functionality (e.g., Netflix needs its own endpoints).

## Recommended next step
Install AdGuard Home on this PC, point the router's DNS at 192.168.1.249, and monitor the query log for a day to see exactly what the two TVs contact — then block selectively. Want me to download and set up AdGuard Home?