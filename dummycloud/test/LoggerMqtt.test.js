const assert = require("node:assert/strict");
const fs = require("node:fs");
const Logger = require("../src/Logger");
const LoggerMqtt = require("../src/LoggerMqtt");
const MqttClient = require("../src/MqttClient");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

// Docker's gateway address: what the dummycloud sees as the connection's address on the Synology NAS
const DOCKER_GATEWAY = "172.18.0.1";
// serial number, IP, MAC, firmware and hardware version
const HANDSHAKE_FIELD_COUNT = 5;

/**
 * @param {string} name file in test/fixtures
 * @returns {{header: object, payload: Buffer}}
 */
function packet(name) {
    return Protocol.parsePacket(Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex"));
}

/**
 * @returns {object} what DummyCloud emits for the captured LSW-3 handshake
 */
function handshakeEvent() {
    const p = packet("lsw3-handshake.hex");

    return {header: p.header, payload: Protocol.parseLoggerPacketPayload(p), meta: {remoteAddress: DOCKER_GATEWAY}};
}

/**
 * @param {string} name file in test/fixtures
 * @returns {object} what DummyCloud emits for a DATA packet
 */
function dataEvent(name) {
    const p = packet(name);

    return {header: p.header, payload: Protocol.parseDataPacketPayload(p), meta: {remoteAddress: DOCKER_GATEWAY}};
}

/**
 * @returns {{mqttClient: MqttClient, published: Array<{topic: string, message: string, retain: boolean}>}}
 */
function createClient() {
    const published = [];
    const mqttClient = new MqttClient({
        onHandshake: () => {},
        onData: () => {}
    });
    mqttClient.client = {
        publish: (topic, message, options) => {
            published.push({topic: topic, message: message, retain: options.retain});
        }
    };

    return {mqttClient: mqttClient, published: published};
}

/**
 * @param {Array<{topic: string}>} published
 * @returns {object|undefined} the hybrid inverter's device block from its discovery messages
 */
function inverterDevice(published) {
    const config = published.find(m => {
        return m.topic === "homeassistant/sensor/deye_dummycloud_2740963018/2740963018_battery/config";
    });

    return config && JSON.parse(config.message).device;
}

describe("Logger handshake", () => {
    it("decodes the LSW-3's handshake", () => {
        const handshake = Protocol.parseLoggerPacketPayload(packet("lsw3-handshake.hex"));

        assert.equal(handshake.fw_ver, "LSW3_15_FFFF_1.0.92R");
        assert.equal(handshake.mac, "E8:FD:F8:7A:73:6A");
        assert.equal(handshake.ip, "192.168.0.148");
        assert.equal(handshake.ver, "V1.1.00.0F");
    });

    it("has no MAC address when its bytes are blank", () => {
        const p = packet("lsw3-handshake.hex");
        const payload = Buffer.from(p.payload);
        payload.fill(0x00, 59, 65);

        assert.equal(Protocol.parseLoggerPacketPayload({header: p.header, payload: payload}).mac, null);
    });

    it("prefers the logger's own IP over the connection's address", () => {
        const values = LoggerMqtt.fromHandshake("1", {fw_ver: "", mac: null, ip: "192.168.0.148", ver: ""}, DOCKER_GATEWAY);
        const withoutIp = LoggerMqtt.fromHandshake("1", {fw_ver: "", mac: null, ip: "", ver: ""}, DOCKER_GATEWAY);

        assert.equal(values.ip_address, "192.168.0.148");
        assert.equal(withoutIp.ip_address, DOCKER_GATEWAY);
        assert.equal(withoutIp.firmware_version, null);
    });
});

describe("MqttClient with logger handshakes", () => {
    it("publishes the logger's info as retained diagnostic sensors on the inverter's device", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleHandshake(handshakeEvent());

        const state = Object.fromEntries(published.filter(m => {
            return m.topic.startsWith("deye-dummycloud/");
        }).map(m => {
            assert.equal(m.retain, true);
            return [m.topic, m.message];
        }));
        assert.deepEqual(state, {
            "deye-dummycloud/2740963018/logger/serial_number": "2740963018",
            "deye-dummycloud/2740963018/logger/ip_address": "192.168.0.148",
            "deye-dummycloud/2740963018/logger/mac_address": "E8:FD:F8:7A:73:6A",
            "deye-dummycloud/2740963018/logger/firmware_version": "LSW3_15_FFFF_1.0.92R",
            "deye-dummycloud/2740963018/logger/hardware_version": "V1.1.00.0F"
        });

        const discovery = published.filter(m => {
            return m.topic.startsWith("homeassistant/");
        });
        assert.equal(discovery.length, HANDSHAKE_FIELD_COUNT);
        const ip = JSON.parse(discovery.find(m => {
            return m.topic === "homeassistant/sensor/deye_dummycloud_2740963018/2740963018_logger_ip_address/config";
        }).message);
        assert.deepEqual(ip, {
            state_topic: "deye-dummycloud/2740963018/logger/ip_address",
            name: "Logger IP Address",
            object_id: "deye_dummycloud_2740963018_logger_ip_address",
            unique_id: "deye_dummycloud_2740963018_logger_ip_address",
            icon: "mdi:ip-network",
            entity_category: "diagnostic",
            // Only the identifier, so the inverter's device keeps its name and model
            device: {identifiers: ["deye_dummycloud_2740963018"]}
        });
    });

    it("sends the logger's discovery only once, its values on every handshake", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleHandshake(handshakeEvent());
        const first = published.length;
        mqttClient.handleHandshake(handshakeEvent());

        assert.equal(published.length - first, HANDSHAKE_FIELD_COUNT);
        assert.ok(published.slice(first).every(m => {
            return m.topic.startsWith("deye-dummycloud/");
        }));
    });

    it("links the inverter's device to the logger's IP, not to the Docker gateway", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleHandshake(handshakeEvent());
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-data.hex"));

        assert.equal(inverterDevice(published).configuration_url, "http://192.168.0.148/index_cn.html");
    });

    it("re-sends the inverter's discovery when the logger's IP becomes known later", () => {
        const {mqttClient, published} = createClient();
        // The dummycloud restarted while the logger was connected: a reading arrives before any handshake
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-data.hex"));
        assert.equal(inverterDevice(published).configuration_url, `http://${DOCKER_GATEWAY}/index_cn.html`);

        published.length = 0;
        mqttClient.handleHandshake(handshakeEvent());
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-charging.hex"));

        assert.equal(inverterDevice(published).configuration_url, "http://192.168.0.148/index_cn.html");
    });
});

describe("Logger status from DATA packets", () => {
    // When the reference packet was captured (its file name in captures/ was ..._2026-10-23T08-14-11-098Z_...)
    const REFERENCE_RECEIVED = Date.parse("2026-10-23T08:14:11.098Z");

    it("decodes the logger's uptime and clock from the start of the payload", () => {
        const decoded = Protocol.parseDataPacketPayload(packet("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(decoded.logger_status, {uptime_seconds: 2918, clock: Date.parse("2026-10-23T08:14:10Z") / 1000});
    });

    it("publishes uptime, last reboot, report time and clock offset", (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        const {mqttClient, published} = createClient();
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        const state = Object.fromEntries(published.filter(m => {
            return m.topic.startsWith("deye-dummycloud/2740963018/logger/");
        }).map(m => {
            return [m.topic.split("/").pop(), m.message];
        }));
        assert.deepEqual(state, {
            uptime_seconds: "2918",
            last_reboot: "2026-10-23T07:25:32Z",
            report_time: "2026-10-23T08:14:10Z",
            clock_offset_seconds: "-1" // the logger's clock has whole seconds
        });

        const config = key => {
            return JSON.parse(published.find(m => {
                return m.topic === `homeassistant/sensor/deye_dummycloud_2740963018/2740963018_logger_${key}/config`;
            }).message);
        };
        assert.deepEqual(config("uptime_seconds"), {
            state_topic: "deye-dummycloud/2740963018/logger/uptime_seconds",
            name: "Logger Uptime",
            object_id: "deye_dummycloud_2740963018_logger_uptime_seconds",
            unique_id: "deye_dummycloud_2740963018_logger_uptime_seconds",
            icon: "mdi:timer-outline",
            entity_category: "diagnostic",
            unit_of_measurement: "s",
            device_class: "duration",
            state_class: "measurement",
            suggested_unit_of_measurement: "h",
            device: {identifiers: ["deye_dummycloud_2740963018"]},
            expire_after: 1200
        });
        assert.equal(config("last_reboot").device_class, "timestamp");
        assert.equal(config("last_reboot").expire_after, undefined); // stays true while the logger is offline
        assert.equal(config("report_time").enabled_by_default, false);
        assert.equal(config("clock_offset_seconds").unit_of_measurement, "s");
    });

    it("publishes the status for repeated readings too, which the inverter values skip", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        const first = published.length;
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(published.slice(first).map(m => {
            return m.topic;
        }), [
            "deye-dummycloud/2740963018/logger/uptime_seconds",
            "deye-dummycloud/2740963018/logger/last_reboot",
            "deye-dummycloud/2740963018/logger/report_time",
            "deye-dummycloud/2740963018/logger/clock_offset_seconds"
        ]);
    });

    it("keeps the last reboot time steady, but follows a real reboot", () => {
        const boot = Date.parse("2026-10-23T07:25:32Z") / 1000;
        const first = LoggerMqtt.fromDataStatus({uptime_seconds: 957, clock: boot + 957}, boot + 957);
        // 31 s later the uptime counter is a second behind the clock
        const next = LoggerMqtt.fromDataStatus({uptime_seconds: 987, clock: boot + 988}, boot + 988, first.lastReboot);
        // The logger rebooted 3 minutes later
        const rebooted = LoggerMqtt.fromDataStatus({uptime_seconds: 5, clock: boot + 1200}, boot + 1200, next.lastReboot);

        assert.equal(first.values.last_reboot, "2026-10-23T07:25:32Z");
        assert.equal(next.values.last_reboot, "2026-10-23T07:25:32Z");
        assert.equal(rebooted.values.last_reboot, "2026-10-23T07:45:27Z");
    });

    it("warns once an hour when the logger's clock is off", (t) => {
        let now = REFERENCE_RECEIVED + 10 * 60 * 1000; // the packet says 08:14:10, but it's 08:24
        t.mock.method(Date, "now", () => {
            return now;
        });
        const warn = t.mock.method(Logger, "warn", () => {});
        const {mqttClient} = createClient();

        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        now += 60 * 1000;
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        assert.equal(warn.mock.callCount(), 1);
        assert.match(warn.mock.calls[0].arguments[0], /clock is -601 s off/);

        now += 60 * 60 * 1000;
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        assert.equal(warn.mock.callCount(), 2);
    });

    it("doesn't warn when the clock is right", (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        const warn = t.mock.method(Logger, "warn", () => {});
        createClient().mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.equal(warn.mock.callCount(), 0);
    });
});
