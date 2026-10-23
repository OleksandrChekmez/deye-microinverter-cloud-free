const assert = require("node:assert/strict");
const fs = require("node:fs");
const HybridInverterSinglePhase = require("../src/HybridInverterSinglePhase");
const MqttClient = require("../src/MqttClient");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

const FIELD_COUNT = HybridInverterSinglePhase.FIELDS.length + HybridInverterSinglePhase.DERIVED_FIELDS.length;

/**
 * @param {string} name file in test/fixtures
 * @returns {object} what DummyCloud emits for this DATA packet
 */
function dataEvent(name) {
    const buf = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex");
    const packet = Protocol.parsePacket(buf);

    return {
        header: packet.header,
        payload: Protocol.parseDataPacketPayload(packet),
        meta: {remoteAddress: "192.168.0.50"}
    };
}

/**
 * @param {{topic: string}} message
 * @returns {boolean} whether it is about the logger (see LoggerMqtt.test.js) rather than the inverter
 */
function isLoggerMessage(message) {
    return message.topic.includes("/logger/") || message.topic.includes("_logger_");
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

describe("MqttClient with a single-phase hybrid inverter", () => {
    it("publishes discovery and state for every field on the first reading", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        const discovery = published.filter(m => {
            return m.topic.startsWith("homeassistant/") && !isLoggerMessage(m);
        });
        const state = published.filter(m => {
            return m.topic.startsWith("deye-dummycloud/") && !isLoggerMessage(m);
        });
        assert.equal(discovery.length, FIELD_COUNT);
        assert.equal(state.length, FIELD_COUNT);

        const byTopic = Object.fromEntries(state.map(m => {
            return [m.topic, m];
        }));
        assert.deepEqual(byTopic["deye-dummycloud/2740963018/battery_power"], {
            topic: "deye-dummycloud/2740963018/battery_power", message: "200", retain: false
        });
        assert.equal(byTopic["deye-dummycloud/2740963018/battery_state"].message, "discharging");
        assert.equal(byTopic["deye-dummycloud/2740963018/today_energy"].message, "-0.2");
        assert.deepEqual(byTopic["deye-dummycloud/2740963018/total_load_consumption"], {
            topic: "deye-dummycloud/2740963018/total_load_consumption", message: "10346.3", retain: true
        });
    });

    it("builds Home Assistant sensor configs", () => {
        const {mqttClient, published} = createClient();
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        const config = key => {
            const message = published.find(m => {
                return m.topic === `homeassistant/sensor/deye_dummycloud_2740963018/2740963018_${key}/config`;
            });

            return JSON.parse(message.message);
        };

        assert.deepEqual(config("battery_power"), {
            state_topic: "deye-dummycloud/2740963018/battery_power",
            name: "Battery Power",
            object_id: "deye_dummycloud_2740963018_battery_power",
            unique_id: "deye_dummycloud_2740963018_battery_power",
            unit_of_measurement: "W",
            device_class: "power",
            state_class: "measurement",
            expire_after: 1200,
            device: {
                manufacturer: "Deye",
                model: "Single-Phase Hybrid Inverter",
                name: "Deye Hybrid Inverter 2740963018",
                serial_number: "2212218520",
                configuration_url: "http://192.168.0.50/index_cn.html",
                identifiers: ["deye_dummycloud_2740963018"]
            }
        });

        assert.equal(config("battery").device_class, "battery");
        assert.equal(config("battery_voltage").suggested_display_precision, 2);
        assert.equal(config("total_production").state_class, "total_increasing");
        assert.equal(config("total_production").expire_after, undefined);
        assert.equal(config("today_energy").state_class, "total");
        assert.equal(config("device_state").entity_category, "diagnostic");
        assert.equal(config("device_state").unit_of_measurement, undefined);
        assert.equal(config("generator_voltage").enabled_by_default, false);
    });

    it("publishes each reading only once, and discovery only on the first", () => {
        const {mqttClient, published} = createClient();
        const inverterMessages = () => {
            return published.filter(m => {
                return !isLoggerMessage(m);
            });
        };

        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        assert.equal(inverterMessages().length, 2 * FIELD_COUNT);

        // The logger repeats the same reading
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        assert.equal(inverterMessages().length, 2 * FIELD_COUNT);

        // A new reading: state only
        mqttClient.handleData(dataEvent("sun-5k-sg03lp1-charging.hex"));
        assert.equal(inverterMessages().length, 3 * FIELD_COUNT);
        assert.ok(inverterMessages().slice(2 * FIELD_COUNT).every(m => {
            return m.topic.startsWith("deye-dummycloud/");
        }));
    });
});
