# Deye-dummycloud

A small Node.js service that replaces the Deye/Solarman cloud for Deye inverters' Wi-Fi loggers. The logger sends its
data to the dummycloud instead of the cloud; the dummycloud answers like the cloud would (including the current time),
publishes all values to an MQTT broker, and sets up the entities in Home Assistant by itself (MQTT discovery).

![dummycloud_demo.png](../img/dummycloud_demo.png)

## Supported devices

| Inverters | Logger | What's published |
|---|---|---|
| Microinverters (e.g. SUN600G3, SUN-M80G3/G4) | built-in MW3 | per PV input: voltage, current, power, energy today/total; grid power, voltage, frequency, energy; radiator temperature, efficiency |
| Single-phase hybrid inverters (tested: SUN-5K-SG03LP1-EU) | LSW-3 stick | PV1/PV2, battery (SOC, power, voltage, current, temperature, charge/discharge counters), grid (power, voltage, current, frequency, import/export counters), load, inverter output, temperatures, device state; generator and external CT values are disabled by default |

For every logger it also publishes, as diagnostic sensors on the same device:

- from the logger's handshake: serial number, IP address, MAC address, firmware and hardware version
- where the logger reports them (hybrid inverters' DATA packets, or REPORT packets): uptime, last reboot, its clock
  and the offset of its clock from the real time
- where the logger reports them (WIFI packets): Wi-Fi network name and signal strength

Everything goes to `deye-dummycloud/<logger serial>/...`: the hybrid inverters' values as
`deye-dummycloud/<logger serial>/<value>` (e.g. `battery_power`), the logger's as `.../logger/<value>`. Energy counters
and the logger's details are retained, so Home Assistant keeps them across restarts.

## Logger setup

1. Give the logger a fixed IP in your router and block its internet access.
2. Open the logger's hidden configuration page, `http://<logger IP>/config_hide.html`.
3. Set **Server A** to the machine running the dummycloud, port `10000`, TCP.
   - **Hybrid inverters with an LSW-3 stick: leave the "Optional Server Setting" (Server B) empty.** Pointing it at
     the same address made the logger deliver readings much less often.
   - Microinverters: Server B may point to the same address.
4. Save. The logger restarts and connects within a minute or two.

The LSW-3 re-sends its last message about every 30 seconds and reconnects every few minutes, even with replies
identical to the real cloud's. This doesn't affect the data: the dummycloud publishes each reading only once.

## Running it

### As a Home Assistant app

This folder is a Home Assistant app (`config.yaml`). Home Assistant downloads a prebuilt image
(`ghcr.io/oleksandrchekmez/{arch}-deye-dummycloud`, for `amd64` and `aarch64`); nothing is built on your machine.

1. In Home Assistant, open the app store (**Settings → Apps → Install app**), then **⋮ → Repositories**, and add
   `https://github.com/OleksandrChekmez/deye-microinverter-cloud-free` (append `#<branch>` for a branch other than the
   default one).
2. Install **Deye Dummycloud** and start it. With the **Mosquitto broker** app installed, it connects to it by itself,
   with Home Assistant's own login.
3. Point the logger's Server A at the Home Assistant machine (see [Logger setup](#logger-setup)).

The app's **Configuration** tab has the log level, an optional different MQTT broker (URL, login, certificate check),
packet capture (to `/share/deye-dummycloud/captures`) and the diagnostic forwarding described below. The timezone
comes from Home Assistant. `DOCS.md` is shown in the app's **Documentation** tab.

### With Docker

Copy `compose.example.yaml` to `compose.yaml`, fill in your MQTT broker, and start it with `docker compose up -d`.
The example builds the image from the Dockerfile next to it. You can also use the prebuilt image instead of building:
replace `build: .` and the `image:` line with `image: ghcr.io/oleksandrchekmez/amd64-deye-dummycloud:<version>`
(`aarch64-deye-dummycloud` on 64-bit ARM).

To update a built image, raise the version in `package.json` and the `image:` tag (Docker only rebuilds when the tag is
new), then rebuild (Synology Container Manager: Project → Stop → Build, or `docker compose up -d --build`).

Without Docker: `npm ci --omit=dev`, then `npm start` with the environment variables below.

### Configuration

The dummycloud is configured with environment variables (the Home Assistant app sets them from its options):

- `MQTT_BROKER_URL` (required), e.g. `mqtt://192.168.0.10` or `mqtts://broker:8883`
- `MQTT_USERNAME`, `MQTT_PASSWORD` (optional; a password needs a username)
- `MQTT_CHECK_CERT` set to `false` to accept a self-signed certificate with `mqtts` (default `true`)
- `LOGLEVEL`: `trace`, `debug`, `info` (default), `warn` or `error`. `debug` also says why a packet was skipped,
  `trace` logs every packet as hex.
- `TZ`: your timezone, e.g. `Europe/Berlin`. Replies to the logger carry its UTC offset, as the Solarman cloud's do.
- `CAPTURE_DIR` (optional, for development): saves every received packet as a `.hex` file in this folder
- `FORWARD_TO` (optional, diagnostic only), e.g. `access1.solarmanpv.com:10000`: copies all logger traffic to that
  server and logs its replies, which are never passed on to the logger. While it's set, your data is sent there.

## Notes

- The dummycloud gives the logger the current time with every reply, which a logger without internet access has no
  other way to get. A hybrid inverter's own clock is separate and isn't set by this. It drifts over time; set it on
  the inverter's display, or with ha-solarman's "Date & Time" entity.
- Home Assistant entities go "unavailable" when no reading arrives for 20 minutes (hybrid inverters) or 6 minutes
  (microinverters), for example at night when a microinverter shuts down.

## Development

- `npm ci`, then `npm test` (Node's built-in test runner) and `npm run lint` (ESLint 8)
- Captured packets for the tests are in `test/fixtures/*.hex`, one packet per file, in the format `CAPTURE_DIR` saves.
- Releasing: raise the version in both `package.json` and `config.yaml` (a test checks they match) and push. The
  workflow `../.github/workflows/dummycloud-image.yaml` lints, tests, builds the images, checks that they start, and
  publishes them. A version that's already published isn't published again, so every release needs a new version.
  Home Assistant offers the update once the workflow has finished.
