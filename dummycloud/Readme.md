# Deye-dummycloud

This is a small Node.js service that mocks the deye solarman cloud and publishes all the data to an MQTT broker.
It also takes care of Home Assistant autodiscovery leading to things just working.
Besides the inverter's values, it publishes the Wi-Fi logger's own details (IP and MAC address, firmware and hardware version; and its uptime, last reboot and clock offset where the logger sends them: in hybrid inverters' DATA packets, or in REPORT packets; and its Wi-Fi network and signal where the logger sends them) to `deye-dummycloud/<logger serial>/logger/...`, shown as diagnostic sensors.

![dummycloud_demo.png](../img/dummycloud_demo.png)

## Usage

The dummycloud is configured using environment variables to be container-friendly to use.

- `LOGLEVEL` (defaults to `info`)
- `MQTT_BROKER_URL` (no default. Should look like `mqtt://foo.bar`)
- `MQTT_USERNAME` (no default, optional.)
- `MQTT_PASSWORD` (no default, optional.)
- `MQTT_CHECK_CERT` set to `false` for using `mqtts` with self signed certificate (defaults to `true`)
- `TZ` your timezone, e.g. `Europe/Berlin` (optional). Replies to the logger include its UTC offset, as the Solarman cloud's do.
- `CAPTURE_DIR` (optional, for development) saves every received packet as a `.hex` file in this folder
- `FORWARD_TO` (optional, diagnostic only) e.g. `access1.solarmanpv.com:10000`: copies all logger traffic to that server and logs its replies, which are never passed on to the logger. While it's set, your data is sent to that server.

## Inverter Setup

Using the `/config_hide.html` of the inverter webinterface, simply point `Server A Setting` and `Optional Server Setting` to the host this is running on.

### Single-phase hybrid inverters (e.g. SUN-5K-SG03LP1-EU)

Single-phase hybrid inverters with a Solarman LSW-3 stick logger are supported too. Their values (PV, battery, grid, load, energy counters) are published to `deye-dummycloud/<logger serial>/<value>` with Home Assistant autodiscovery.

For these, set only `Server A Setting` to the dummycloud and leave `Optional Server Setting` empty. With both pointing to the same host, server B never connects, and the logger delivers new readings much less often.

Even then, the LSW-3 re-sends its last message about every 30 seconds and reconnects every few minutes. This doesn't affect the data: the dummycloud publishes each reading only once.
I'd still keep the firewall rules preventing the inverter from phoning home in place for good measure.

## Deployment

### As a Home Assistant app

This folder is also a Home Assistant app (`config.yaml`). Home Assistant downloads a prebuilt image (`ghcr.io/oleksandrchekmez/{arch}-deye-dummycloud`, for `amd64` and `aarch64`) instead of building it.

1. In Home Assistant, open the app store (**Settings → Apps**), then the **⋮** menu → **Repositories**, and add
   `https://github.com/OleksandrChekmez/deye-microinverter-cloud-free` (append `#<branch>` to use a branch other than the default one).
2. Install **Deye Dummycloud** from the new repository and start it.
3. Point the logger's `Server A Setting` at the Home Assistant machine, port `10000`.

With the Mosquitto broker app installed, the app connects to it by itself. Its settings (log level, a different MQTT broker, packet capture) are in the app's **Configuration** tab, and `DOCS.md` is shown in its **Documentation** tab.
Captured packets go to `/share/deye-dummycloud/captures`. The timezone comes from Home Assistant.

To release an update, raise the version in both `package.json` and `config.yaml` (a test checks they match) and push. The GitHub workflow `.github/workflows/dummycloud-image.yaml` then lints, tests, and publishes the images for that version (a version that already exists isn't published again). Once it's finished, after a few minutes, Home Assistant offers the update. The registry packages must be public, so Home Assistant can download them without logging in.

### With Docker

The dummycloud can be started using `npm run start`. Next to this readme, there's also a dockerfile provided.

A `docker-compose.yml` entry could for example look like this:

```yml
  deye-dummycloud:
    build:
      context: ./deye-microinverter-cloud-free/dummycloud/
      dockerfile: Dockerfile
    container_name: "deye-dummycloud"
    restart: always
    environment:
      - "LOGLEVEL=info"
      - "MQTT_BROKER_URL=mqtt://foobar.example"
      # User those variables if the MQTT broker requires username and password
      # - "MQTT_USERNAME=example-user"
      # - "MQTT_PASSWORD=example-password"
    ports:
      - "10000:10000"
```
