/*
 * MQTT state and Home Assistant discovery messages for the Wi-Fi logger itself (not the inverter):
 *   <TOPIC_PREFIX>/<loggerSerial>/logger/<key>   e.g. deye-dummycloud/2740963018/logger/ip_address
 * Same topics and unique IDs as dummycloud2. The sensors are diagnostics on the inverter's device in Home Assistant.
 */

const FIELDS = Object.freeze([
    {key: "serial_number", name: "Logger Serial Number", icon: "mdi:identifier"},
    {key: "ip_address", name: "Logger IP Address", icon: "mdi:ip-network"},
    {key: "mac_address", name: "Logger MAC Address", icon: "mdi:network-outline"},
    {key: "firmware_version", name: "Logger Firmware Version", icon: "mdi:chip"},
    {key: "hardware_version", name: "Logger Hardware Version", icon: "mdi:chip"},
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
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {object} values from fromHandshake()
 * @returns {Array<{topic: string, message: string, retain: boolean}>} only for known values
 */
function getStateMessages(baseTopic, values) {
    return FIELDS.filter(field => {
        return values[field.key] !== null && values[field.key] !== undefined;
    }).map(field => {
        return {
            topic: `${baseTopic}/logger/${field.key}`,
            message: String(values[field.key]),
            retain: true // they rarely change, and only arrive when the logger connects
        };
    });
}

/**
 * @param {string} baseTopic e.g. "deye-dummycloud/2740963018"
 * @param {string} loggerSerial
 * @param {object} values from fromHandshake(); sensors are only announced for known values
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

        return {
            topic: `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_logger_${field.key}/config`,
            message: JSON.stringify({
                "state_topic": `${baseTopic}/logger/${field.key}`,
                "name": field.name,
                "object_id": id,
                "unique_id": id,
                "icon": field.icon,
                "entity_category": "diagnostic",
                "device": device
            }),
            retain: true
        };
    });
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
    FIELDS: FIELDS,
    fromHandshake: fromHandshake,
    getDiscoveryMessages: getDiscoveryMessages,
    getStateMessages: getStateMessages
};
