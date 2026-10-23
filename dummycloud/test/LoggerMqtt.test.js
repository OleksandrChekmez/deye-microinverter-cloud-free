const assert = require("node:assert/strict");
const fs = require("node:fs");
const LoggerMqtt = require("../src/LoggerMqtt");
const MqttClient = require("../src/MqttClient");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

// Docker's gateway address: what the dummycloud sees as the connection's address on the Synology NAS
const DOCKER_GATEWAY = "172.18.0.1";

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
        assert.equal(discovery.length, LoggerMqtt.FIELDS.length);
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

        assert.equal(published.length - first, LoggerMqtt.FIELDS.length);
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
