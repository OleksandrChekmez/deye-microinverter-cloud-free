# Deye Dummycloud

Replaces the Solarman cloud for Deye inverter Wi-Fi loggers. It receives the logger's data on port 10000 and publishes it to MQTT, with Home Assistant discovery, so the sensors appear by themselves.

Supported: Deye microinverters and single-phase hybrid inverters with an LSW-3 stick logger (e.g. SUN-5K-SG03LP1-EU).

## Setup

1. Install and start the **Mosquitto broker** app, and set up the MQTT integration in Home Assistant if you haven't yet.
2. Start this app. With the MQTT broker URL left empty, it uses the Mosquitto app automatically.
3. Open the logger's web interface at `http://<logger IP>/config_hide.html` and set **Server A** to this Home Assistant machine's IP address, port `10000`, TCP.
   - Hybrid inverters with an LSW-3 logger: leave the **Optional Server Setting** (Server B) empty.
   - Microinverters: Server B may point to the same address.
4. Block the logger's internet access in your router, so it can't reach the real cloud.

Readings arrive every few minutes. The sensors show up under the MQTT integration as a device named after the logger's serial number. Its diagnostic sensors show the logger's IP address, MAC address, firmware and hardware version, and for hybrid inverters also when the logger last rebooted and whether its clock is right (Logger Clock Offset should stay within a few seconds). The device's "Visit" link opens the logger's web interface.

## Notes

- The replies to the logger carry Home Assistant's timezone, so the inverter's clock and daily counters stay right.
- The LSW-3 logger re-sends its last message about every 30 seconds and reconnects every few minutes. That's harmless: each reading is published only once.
- Logs are in the app's **Log** tab. Set the log level to `debug` to see why a packet was skipped.
