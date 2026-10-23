const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

/**
 * @param {string} name file in test/fixtures holding one packet as a hex string
 * @returns {Buffer}
 */
function loadFixture(name) {
    return Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex");
}

describe("SUN-5K-SG03LP1-EU DATA packet (schema 0x07)", () => {
    // Captured 2026-10-23 from the owner's inverter
    const buf = loadFixture("sun-5k-sg03lp1-data.hex");
    const packet = Protocol.parsePacket(buf);

    it("parses the header", () => {
        assert.equal(packet.header.type, Protocol.MESSAGE_REQUEST_TYPES.DATA);
        assert.equal(packet.header.payloadLength, 1013);
        assert.equal(packet.header.loggerSerial, 2740963018);
    });

    it("has a valid checksum and footer", () => {
        assert.equal(Protocol.parseFooter(buf).checksum, Protocol.checksum(buf));
    });

    it("uses the single-phase hybrid schema", () => {
        assert.equal(packet.payload[0], 0x01);
        assert.equal(packet.payload[1], Protocol.DATA_PACKET_SCHEMAS.HYBRIDINVERTER_SINGLEPHASE);
        assert.equal(packet.payload.subarray(21, 31).toString("ascii"), "2212218520");
    });

    it("is decoded by the single-phase hybrid decoder", () => {
        const decoded = Protocol.parseDataPacketPayload(packet);

        assert.equal(decoded.schema, "HYBRIDINVERTER_SINGLEPHASE");
        assert.equal(decoded.inverter_time, "2026-10-23 09:08:33");
        // Discharging: PV 37 + 45 W, battery 216 W, grid 18 W cover the 313 W load
        assert.equal(decoded.values.battery_power, 216);
        assert.equal(decoded.values.battery_state, "discharging");
        assert.equal(decoded.values.load_power, 313);
    });

    it("skips historic packets", () => {
        const historic = Protocol.parsePacket(Buffer.from(buf));
        historic.payload[0] |= 0x80;

        assert.equal(Protocol.parseDataPacketPayload(historic), null);
    });

    it("gets a valid time response", () => {
        const response = Protocol.buildTimeResponse(packet);
        const responseHeader = Protocol.parseHeader(response);

        assert.equal(responseHeader.type, 0x12);
        assert.equal(responseHeader.msgIDResponse, packet.header.msgIDResponse + 1);
        assert.equal(responseHeader.loggerSerial, packet.header.loggerSerial);
        assert.equal(response[11], packet.payload[0]);
        assert.equal(Protocol.parseFooter(response).checksum, Protocol.checksum(response));
    });
});
