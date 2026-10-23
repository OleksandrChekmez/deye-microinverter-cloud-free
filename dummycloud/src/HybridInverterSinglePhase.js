/*
 * DATA packet layout for schema 0x07: single-phase hybrid inverters such as the SUN-5K-SG03LP1-EU.
 *
 * Offsets are into the packet payload (after the 11-byte header). All values are big-endian,
 * and 32-bit values are stored high word first. Value = (raw - subtract) / divisor.
 * Names are the inverter's own sensor names. Verified against the inverter's readings on 2026-10-23.
 *
 * Offsets 79-95 and 97-195 are copies of Modbus registers 108-116 and 150-196 (offset 79 + 2*(reg-108) and
 * 97 + 2*(reg-150)), with the same types and scales as ha-solarman's deye_hybrid.yaml. The other values have
 * their own layout. Note DC Temperature and Temperature have no +1000 offset here, unlike over Modbus.
 */

// As in ha-solarman's deye_hybrid.yaml
const DEVICE_STATES = Object.freeze({
    0: "Standby",
    1: "Self-test",
    2: "Normal", // the only state seen so far
    3: "Alarm",
    4: "Fault"
});

// ha-solarman reports "idle" while battery power is within +-50 W
const BATTERY_IDLE_W = 50;

const FIELDS = Object.freeze([
    {key: "device_state", name: "Device State", offset: 31, type: "u16", lookup: DEVICE_STATES},

    {key: "pv1_voltage", name: "PV1 Voltage", offset: 81, type: "u16", divisor: 10, unit: "V"},
    {key: "pv1_current", name: "PV1 Current", offset: 83, type: "u16", divisor: 10, unit: "A"},
    {key: "pv1_power", name: "PV1 Power", offset: 169, type: "u16", unit: "W"},
    {key: "pv2_voltage", name: "PV2 Voltage", offset: 85, type: "u16", divisor: 10, unit: "V"},
    {key: "pv2_current", name: "PV2 Current", offset: 87, type: "u16", divisor: 10, unit: "A"},
    {key: "pv2_power", name: "PV2 Power", offset: 171, type: "u16", unit: "W"},
    {key: "today_production", name: "Today Production", offset: 79, type: "u16", divisor: 10, unit: "kWh"},
    {key: "total_production", name: "Total Production", offset: 265, type: "u32", divisor: 10, unit: "kWh"},

    {key: "battery", name: "Battery", offset: 165, type: "u16", unit: "%"},
    {key: "battery_voltage", name: "Battery Voltage", offset: 163, type: "u16", divisor: 100, unit: "V"},
    // Positive = discharging, negative = charging
    {key: "battery_current", name: "Battery Current", offset: 179, type: "s16", divisor: 100, unit: "A"},
    {key: "battery_power", name: "Battery Power", offset: 177, type: "s16", unit: "W"},
    {key: "battery_temperature", name: "Battery Temperature", offset: 161, type: "u16", subtract: 1000, divisor: 10, unit: "°C"},
    {key: "today_battery_charge", name: "Today Battery Charge", offset: 269, type: "u16", divisor: 10, unit: "kWh"},
    {key: "today_battery_discharge", name: "Today Battery Discharge", offset: 271, type: "u16", divisor: 10, unit: "kWh"},
    {key: "total_battery_charge", name: "Total Battery Charge", offset: 273, type: "u32", divisor: 10, unit: "kWh"},
    {key: "total_battery_discharge", name: "Total Battery Discharge", offset: 277, type: "u32", divisor: 10, unit: "kWh"},

    {key: "grid_l1_voltage", name: "Grid L1 Voltage", offset: 97, type: "u16", divisor: 10, unit: "V"},
    {key: "grid_l1_current", name: "Grid L1 Current", offset: 117, type: "s16", divisor: 100, unit: "A"},
    // Positive = import from the grid, negative = export
    {key: "grid_l1_power", name: "Grid L1 Power", offset: 131, type: "s16", unit: "W"},
    {key: "grid_power", name: "Grid Power", offset: 135, type: "s16", unit: "W"},
    {key: "grid_frequency", name: "Grid Frequency", offset: 289, type: "u16", divisor: 100, unit: "Hz"},
    {key: "today_energy_import", name: "Today Energy Import", offset: 281, type: "u16", divisor: 10, unit: "kWh"},
    {key: "today_energy_export", name: "Today Energy Export", offset: 283, type: "u16", divisor: 10, unit: "kWh"},
    {key: "total_energy_import", name: "Total Energy Import", offset: 285, type: "u32", divisor: 10, unit: "kWh"},
    {key: "total_energy_export", name: "Total Energy Export", offset: 291, type: "u32", divisor: 10, unit: "kWh"},
    // Only seen as 0 so far; offsets follow the Modbus register layout (registers 162, 170, 172)
    {key: "external_ct1_current", name: "External CT1 Current", offset: 121, type: "s16", divisor: 100, unit: "A"},
    {key: "external_ct1_power", name: "External CT1 Power", offset: 137, type: "s16", unit: "W"},
    {key: "external_power", name: "External Power", offset: 141, type: "s16", unit: "W"},

    {key: "load_l1_voltage", name: "Load L1 Voltage", offset: 111, type: "u16", divisor: 10, unit: "V"},
    {key: "load_l1_current", name: "Load L1 Current", offset: 155, type: "s16", divisor: 100, unit: "A"},
    {key: "load_l1_power", name: "Load L1 Power", offset: 149, type: "s16", unit: "W"},
    {key: "load_power", name: "Load Power", offset: 153, type: "s16", unit: "W"},
    {key: "load_frequency", name: "Load Frequency", offset: 181, type: "u16", divisor: 100, unit: "Hz"},
    {key: "today_load_consumption", name: "Today Load Consumption", offset: 493, type: "u16", divisor: 10, unit: "kWh"},
    {key: "total_load_consumption", name: "Total Load Consumption", offset: 495, type: "u32", divisor: 10, unit: "kWh"},

    // Inverter AC side. Negative power = charging the battery from AC
    {key: "output_l1_voltage", name: "Output L1 Voltage", offset: 105, type: "u16", divisor: 10, unit: "V"},
    {key: "output_l1_current", name: "Output L1 Current", offset: 125, type: "s16", divisor: 100, unit: "A"},
    {key: "output_l1_power", name: "Output L1 Power", offset: 143, type: "s16", unit: "W"},
    {key: "power", name: "Power", offset: 147, type: "s16", unit: "W"},
    {key: "output_frequency", name: "Output Frequency", offset: 183, type: "u16", divisor: 100, unit: "Hz"},
    // Net inverter AC energy; can be negative while the battery charges from the grid
    {key: "today_energy", name: "Today Energy", offset: 33, type: "s16", divisor: 10, unit: "kWh"},
    {key: "total_energy", name: "Total Energy", offset: 39, type: "s32", divisor: 10, unit: "kWh"},
    {key: "dc_temperature", name: "DC Temperature", offset: 43, type: "s16", divisor: 10, unit: "°C"},
    {key: "temperature", name: "Temperature", offset: 45, type: "s16", divisor: 10, unit: "°C"},

    // Registers 166, 181 and 196. Nothing is connected to the generator port, so these read 0 W / ~10 V / ~54 Hz
    {key: "generator_power", name: "Generator Power", offset: 129, type: "u16", unit: "W"},
    {key: "generator_voltage", name: "Generator Voltage", offset: 159, type: "u16", divisor: 10, unit: "V"},
    {key: "generator_frequency", name: "Generator Frequency", offset: 189, type: "u16", divisor: 100, unit: "Hz"},
    {key: "generator_energy", name: "Generator Energy", offset: 985, type: "u16", divisor: 10, unit: "kWh"},
]);

// Values calculated from the decoded fields
const DERIVED_FIELDS = Object.freeze([
    {key: "pv_power", name: "PV Power", unit: "W"},
    {key: "battery_state", name: "Battery State"},
]);

const SERIAL_OFFSET = 21;
const SERIAL_LENGTH = 10;
const TIME_OFFSET = 1001; // yy mm dd hh mm ss, inverter local time
const MIN_PAYLOAD_LENGTH = TIME_OFFSET + 6;

/**
 * @param {Buffer} payload
 * @param {object} field one entry of FIELDS
 * @returns {number|string}
 */
function readField(payload, field) {
    let raw;

    switch (field.type) {
        case "u16":
            raw = payload.readUInt16BE(field.offset);
            break;
        case "s16":
            raw = payload.readInt16BE(field.offset);
            break;
        case "u32":
            raw = payload.readUInt32BE(field.offset);
            break;
        case "s32":
            raw = payload.readInt32BE(field.offset);
            break;
        default:
            throw new Error(`Unknown field type "${field.type}" for ${field.key}`);
    }

    if (field.lookup) {
        return field.lookup[raw] ?? `Unknown (${raw})`;
    }

    return (raw - (field.subtract ?? 0)) / (field.divisor ?? 1);
}

/**
 * @param {Buffer} buf 6 bytes: yy mm dd hh mm ss
 * @returns {string} e.g. "2026-10-23 11:03:07" (inverter local time, no timezone)
 */
function readTime(buf) {
    const pad = n => {
        return String(n).padStart(2, "0");
    };

    return `${2000 + buf[0]}-${pad(buf[1])}-${pad(buf[2])} ${pad(buf[3])}:${pad(buf[4])}:${pad(buf[5])}`;
}

/**
 * @param {Buffer} payload DATA packet payload with schema byte 0x07
 * @returns {{schema: string, inverter_serial: string, inverter_time: string, values: object}}
 */
function parse(payload) {
    if (payload.length < MIN_PAYLOAD_LENGTH) {
        throw new Error(`Single-phase hybrid DATA payload too short: ${payload.length} bytes, expected at least ${MIN_PAYLOAD_LENGTH}`);
    }

    const values = {};
    for (const field of FIELDS) {
        values[field.key] = readField(payload, field);
    }

    values.pv_power = values.pv1_power + values.pv2_power;
    if (values.battery_power > BATTERY_IDLE_W) {
        values.battery_state = "discharging";
    } else if (values.battery_power < -BATTERY_IDLE_W) {
        values.battery_state = "charging";
    } else {
        values.battery_state = "idle";
    }

    return {
        schema: "HYBRIDINVERTER_SINGLEPHASE",
        inverter_serial: payload.subarray(SERIAL_OFFSET, SERIAL_OFFSET + SERIAL_LENGTH).toString("ascii"),
        inverter_time: readTime(payload.subarray(TIME_OFFSET, TIME_OFFSET + 6)),
        values: values
    };
}

module.exports = {
    DERIVED_FIELDS: DERIVED_FIELDS,
    DEVICE_STATES: DEVICE_STATES,
    FIELDS: FIELDS,
    parse: parse
};
