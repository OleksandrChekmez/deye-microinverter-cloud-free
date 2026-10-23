/*
 * MQTT state and Home Assistant discovery messages for the Wi-Fi logger itself (not the inverter):
 *   <TOPIC_PREFIX>/<loggerSerial>/logger/<key>   e.g. deye-dummycloud/2740963018/logger/ip_address
 * Same topics and unique IDs as dummycloud2. The sensors are diagnostics on the inverter's device in Home Assistant.
 * Sources: the handshake when the logger connects (fromHandshake), and the logger's uptime and clock (fromStatus)
 * from the start of every DATA packet (single-phase hybrids only so far) or from REPORT packets.
 */

// Values from DATA or REPORT packets arrive every 30 s to 8 min; after that long without one, Home Assistant shows "unavailable"
const EXPIRE_AFTER_SECONDS = 20 * 60;
// The logger's clock comes from our replies; more than this off means it didn't get or accept them
const CLOCK_OFFSET_WARNING_SECONDS = 5 * 60;
// Uptime and clock tick separately, so the computed boot time can move by a second between packets
const REBOOT_TOLERANCE_SECONDS = 60;

const FIELDS = Object.freeze([
    {key: "serial_number", name: "Logger Serial Number", icon: "mdi:identifier"},
    {key: "ip_address", name: "Logger IP Address", icon: "mdi:ip-network"},
    {key: "mac_address", name: "Logger MAC Address", icon: "mdi:network-outline"},
    {key: "firmware_version", name: "Logger Firmware Version", icon: "mdi:chip"},
    {key: "hardware_version", name: "Logger Hardware Version", icon: "mdi:chip"},
    {
        key: "uptime_seconds", name: "Logger Uptime", icon: "mdi:timer-outline", expires: true,
        config: {unit_of_measurement: "s", device_class: "duration", state_class: "measurement", suggested_unit_of_measurement: "h"}
    },
    {key: "last_reboot", name: "Logger Last Reboot", icon: "mdi:restart", config: {device_class: "timestamp"}},
    {
        // The logger's clock when it sent the packet; Clock Offset says the same more readably
        key: "report_time", name: "Logger Report Time", icon: "mdi:clock-outline", expires: true,
        config: {device_class: "timestamp", enabled_by_default: false}
    },
    {
        key: "clock_offset_seconds", name: "Logger Clock Offset", icon: "mdi:clock-alert-outline", expires: true,
        config: {unit_of_measurement: "s", state_class: "measurement"}
    },
]);

/**
 * @param {string} loggerSerial
 * @param {{fw_ver: string, mac: string|null, ip: string, ver: string}} handshake Protocol.parseLoggerPacketPayload()
 * @param {string} [remoteAddress] where the connection came from; only used when the handshake has no IP
 * @returns {object} values by FIELDS key, null when unknown
 */
function fromHandshake(loggerSerial, handshake, remoteAddress) {
    return {
        serial_number: loggerSerial,
        // The logger's own IP. The connection's address can be a Docker or NAT gateway (e.g. 172.18.0.1).
        ip_address: nonEmpty(handshake.ip) ?? nonEmpty(remoteAddress),
        mac_address: handshake.mac ?? null,
        firmware_version: nonEmpty(handshake.fw_ver),
        hardware_version: nonEmpty(handshake.ver),
    };
}

/**
 * @param {{uptime_seconds: number, clock: number|null}} status Protocol.parseDataPacketLoggerStatus() or
 *        parseReportPacketPayload(); without a clock, only the uptime is known
 * @param {number} nowSeconds Unix time when the packet arrived
 * @param {number} [previousReboot] lastReboot returned for this logger's previous packet
 * @returns {{values: object, lastReboot: number|undefined}} values by FIELDS key; lastReboot in Unix seconds, to pass
 *          back next time
 */
function fromStatus(status, nowSeconds, previousReboot) {
    if (status.clock === null || status.clock === undefined) {
        return {values: {uptime_seconds: status.uptime_seconds}, lastReboot: previousReboot};
    }

    let lastReboot = status.clock - status.uptime_seconds;
    if (previousReboot !== undefined && Math.abs(lastReboot - previousReboot) <= REBOOT_TOLERANCE_SECONDS) {
        lastReboot = previousReboot;
    }

    return {
        values: {
            uptime_seconds: status.uptime_seconds,
            last_reboot: toIsoTime(lastReboot),
            report_time: toIsoTime(status.clock),
            clock_offset_seconds: Math.round(status.clock - nowSeconds)
        },
        lastReboot: lastReboot
    };
}

/**
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {object} values from fromHandshake() or fromStatus()
 * @returns {Array<{topic: string, message: string, retain: boolean}>} only for known values
 */
function getStateMessages(baseTopic, values) {
    return FIELDS.filter(field => {
        return values[field.key] !== null && values[field.key] !== undefined;
    }).map(field => {
        return {
            topic: `${baseTopic}/logger/${field.key}`,
            message: String(values[field.key]),
            retain: true // the handshake values only arrive when the logger connects; keep them across HA restarts
        };
    });
}

/**
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {string} loggerSerial
 * @param {object} values from fromHandshake() or fromStatus(); sensors are only announced for known values
 * @returns {Array<{topic: string, message: string, retain: boolean}>}
 */
function getDiscoveryMessages(baseTopic, loggerSerial, values) {
    // Only the identifier: Home Assistant adds these sensors to the inverter's device and keeps its name and model
    const device = {
        "identifiers": [
            `deye_dummycloud_${loggerSerial}`
        ]
    };

    return FIELDS.filter(field => {
        return values[field.key] !== null && values[field.key] !== undefined;
    }).map(field => {
        const id = `deye_dummycloud_${loggerSerial}_logger_${field.key}`;
        const config = {
            "state_topic": `${baseTopic}/logger/${field.key}`,
            "name": field.name,
            "object_id": id,
            "unique_id": id,
            "icon": field.icon,
            "entity_category": "diagnostic",
            ...field.config,
            "device": device
        };
        if (field.expires) {
            config["expire_after"] = EXPIRE_AFTER_SECONDS;
        }

        return {
            topic: `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_logger_${field.key}/config`,
            message: JSON.stringify(config),
            retain: true
        };
    });
}

/**
 * @param {number} seconds Unix time
 * @returns {string} e.g. "2026-10-23T07:25:32Z", as Home Assistant's timestamp sensors expect
 */
function toIsoTime(seconds) {
    return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * @param {string|undefined|null} value
 * @returns {string|null}
 */
function nonEmpty(value) {
    const trimmed = (value ?? "").trim();

    return trimmed === "" ? null : trimmed;
}

module.exports = {
    CLOCK_OFFSET_WARNING_SECONDS: CLOCK_OFFSET_WARNING_SECONDS,
    FIELDS: FIELDS,
    fromHandshake: fromHandshake,
    fromStatus: fromStatus,
    getDiscoveryMessages: getDiscoveryMessages,
    getStateMessages: getStateMessages
};
