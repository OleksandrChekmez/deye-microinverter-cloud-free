const assert = require("node:assert/strict");
const fs = require("node:fs");
const HybridInverterSinglePhase = require("../src/HybridInverterSinglePhase");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

/**
 * @param {string} name file in test/fixtures holding one packet as a hex string
 * @returns {object} decoded single-phase hybrid DATA packet
 */
function decodeFixture(name) {
    const buf = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex");

    return Protocol.parseDataPacketPayload(Protocol.parsePacket(buf));
}

describe("HybridInverterSinglePhase", () => {
    describe("reference packet (compared with the inverter's readings on 2026-10-23)", () => {
        const decoded = decodeFixture("sun-5k-sg03lp1-reference.hex");

        it("reads serial and time", () => {
            assert.equal(decoded.inverter_serial, "2212218520");
            assert.equal(decoded.inverter_time, "2026-10-23 11:03:07");
        });

        it("decodes every field", () => {
            // Energy counters, temperatures and frequencies matched the inverter exactly. Live power values
            // were a few % off only because the inverter was read a few minutes after this packet.
            assert.deepEqual(decoded.values, {
                device_state: "Normal",

                pv1_voltage: 222.6,
                pv1_current: 0.4,
                pv1_power: 94,
                pv2_voltage: 219.8,
                pv2_current: 0.5,
                pv2_power: 116,
                pv_power: 210,
                today_production: 0.2,
                total_production: 14668.1,

                battery: 82,
                battery_voltage: 53.13,
                battery_current: 3.77,
                battery_power: 200,
                battery_state: "discharging",
                battery_temperature: 23.6,
                today_battery_charge: 1.5,
                today_battery_discharge: 1.1,
                total_battery_charge: 3116.1,
                total_battery_discharge: 2327.7,

                grid_l1_voltage: 233.7,
                grid_l1_current: 1.97,
                grid_l1_power: 15,
                grid_power: 15,
                grid_frequency: 50.03,
                today_energy_import: 3.7,
                today_energy_export: 0,
                total_energy_import: 7015.2,
                total_energy_export: 9368.6,
                external_ct1_current: 2.65,
                external_ct1_power: 0,
                external_power: 0,

                load_l1_voltage: 239.9,
                load_l1_current: 4.26,
                load_l1_power: 426,
                load_power: 426,
                load_frequency: 50.06,
                today_load_consumption: 3.5,
                total_load_consumption: 10346.3,

                output_l1_voltage: 233.7,
                output_l1_current: 1.8,
                output_l1_power: 411,
                power: 411,
                output_frequency: 50.06,
                today_energy: -0.2,
                total_energy: 12701.6,
                dc_temperature: 56.8,
                temperature: 44,

                generator_power: 0,
                generator_voltage: 11.1,
                generator_frequency: 54.13,
                generator_energy: 69,
            });
        });
    });

    describe("charging packet", () => {
        const {values} = decodeFixture("sun-5k-sg03lp1-charging.hex");

        it("reports charging with negative battery values", () => {
            assert.equal(values.battery_state, "charging");
            assert.equal(values.battery_power, -531);
            assert.equal(values.battery_current, -9.96);
        });

        it("balances: grid import covers the load and the inverter charging from AC", () => {
            assert.equal(values.grid_power, 695);
            assert.equal(values.load_power, 294);
            assert.equal(values.power, -401);
            assert.equal(values.grid_power, values.load_power - values.power);
        });
    });

    it("reports the battery as idle within +-50 W, like ha-solarman", () => {
        const buf = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", "sun-5k-sg03lp1-reference.hex"), "utf8").trim(), "hex");
        const payload = Protocol.parsePacket(buf).payload;

        for (const [watts, state] of [[50, "idle"], [-50, "idle"], [51, "discharging"], [-51, "charging"]]) {
            payload.writeInt16BE(watts, 177);
            assert.equal(HybridInverterSinglePhase.parse(payload).values.battery_state, state, `${watts} W`);
        }
    });

    it("has a unique key and name for every field", () => {
        const all = [...HybridInverterSinglePhase.FIELDS, ...HybridInverterSinglePhase.DERIVED_FIELDS];

        assert.equal(new Set(all.map(f => {
            return f.key;
        })).size, all.length);
        assert.equal(new Set(all.map(f => {
            return f.name;
        })).size, all.length);
    });

    it("rejects a payload that is too short", () => {
        assert.throws(() => {
            HybridInverterSinglePhase.parse(Buffer.alloc(500));
        }, /too short/);
    });
});
