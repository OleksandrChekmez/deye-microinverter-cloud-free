/*
 * MQTT state and Home Assistant discovery messages for single-phase hybrid inverters (schema 0x07).
 * One topic and one HA sensor per entry of HybridInverterSinglePhase.FIELDS / DERIVED_FIELDS:
 *   <TOPIC_PREFIX>/<loggerSerial>/<key>   e.g. deye-dummycloud/2740963018/battery_power
 */
const HybridInverterSinglePhase = require("./HybridInverterSinglePhase");

// The logger sends a new reading about every 8 minutes; allow one to go missing before HA shows "unavailable"
const EXPIRE_AFTER_SECONDS = 20 * 60;

const DEVICE_CLASSES = Object.freeze({
    "%": "battery",
    "A": "current",
    "Hz": "frequency",
    "V": "voltage",
    "W": "power",
    "kWh": "energy",
    "°C": "temperature",
});

// Energy values that can go down (as in ha-solarman). All other kWh values only increase, or reset daily.
const STATE_CLASS_TOTAL = new Set(["today_energy", "total_energy"]);

const DIAGNOSTIC = new Set([
    "device_state",
    "dc_temperature",
    "temperature",
    "grid_frequency",
    "load_frequency",
    "output_frequency",
]);

// Nothing is connected to the generator port or the external CT
const DISABLED_BY_DEFAULT = new Set([
    "external_ct1_current",
    "external_ct1_power",
    "external_power",
    "generator_power",
    "generator_voltage",
    "generator_frequency",
    "generator_energy",
]);

const ALL_FIELDS = Object.freeze([...HybridInverterSinglePhase.FIELDS, ...HybridInverterSinglePhase.DERIVED_FIELDS]);

/**
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {object} decoded result of HybridInverterSinglePhase.parse()
 * @returns {Array<{topic: string, message: string, retain: boolean}>}
 */
function getStateMessages(baseTopic, decoded) {
    return ALL_FIELDS.map(field => {
        return {
            topic: `${baseTopic}/${field.key}`,
            message: String(decoded.values[field.key]),
            // Like the microinverter energy topics, so HA keeps the last counter value across restarts
            retain: field.unit === "kWh"
        };
    });
}

/**
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {string} loggerSerial
 * @param {object} decoded result of HybridInverterSinglePhase.parse()
 * @param {string} loggerAddress the logger's IP, for the device's link to its web interface
 * @returns {Array<{topic: string, message: string, retain: boolean}>}
 */
function getDiscoveryMessages(baseTopic, loggerSerial, decoded, loggerAddress) {
    const device = {
        "manufacturer": "Deye",
        "model": "Single-Phase Hybrid Inverter",
        "name": `Deye Hybrid Inverter ${loggerSerial}`,
        "serial_number": decoded.inverter_serial,
        "configuration_url": `http://${loggerAddress}/index_cn.html`,
        "identifiers": [
            `deye_dummycloud_${loggerSerial}`
        ]
    };

    return ALL_FIELDS.map(field => {
        const id = `deye_dummycloud_${loggerSerial}_${field.key}`;
        const config = {
            "state_topic": `${baseTopic}/${field.key}`,
            "name": field.name,
            "object_id": id,
            "unique_id": id,
            "device": device
        };

        if (field.unit) {
            config["unit_of_measurement"] = field.unit;
            config["device_class"] = DEVICE_CLASSES[field.unit];

            if (field.unit === "kWh") {
                config["state_class"] = STATE_CLASS_TOTAL.has(field.key) ? "total" : "total_increasing";
            } else {
                config["state_class"] = "measurement";
                config["expire_after"] = EXPIRE_AFTER_SECONDS;
            }

            if (field.divisor) {
                config["suggested_display_precision"] = Math.round(Math.log10(field.divisor));
            }
        } else {
            // Text values: Device State, Battery State
            config["expire_after"] = EXPIRE_AFTER_SECONDS;
        }

        if (DIAGNOSTIC.has(field.key)) {
            config["entity_category"] = "diagnostic";
        }
        if (DISABLED_BY_DEFAULT.has(field.key)) {
            config["enabled_by_default"] = false;
        }

        return {
            topic: `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_${field.key}/config`,
            message: JSON.stringify(config),
            retain: true
        };
    });
}

module.exports = {
    EXPIRE_AFTER_SECONDS: EXPIRE_AFTER_SECONDS,
    getDiscoveryMessages: getDiscoveryMessages,
    getStateMessages: getStateMessages
};
