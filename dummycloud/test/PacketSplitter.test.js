const assert = require("node:assert/strict");
const fs = require("node:fs");
const PacketSplitter = require("../src/PacketSplitter");
const path = require("node:path");
const {describe, it} = require("node:test");

/**
 * @param {string} name file in test/fixtures
 * @returns {Buffer}
 */
function fixture(name) {
    return Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex");
}

const handshake = fixture("lsw3-handshake.hex"); // 225 bytes
const data = fixture("sun-5k-sg03lp1-data.hex"); // 1026 bytes
const reply = Buffer.from("a50a0010122216cac65fa30101a90fdb6a00000000f615", "hex");

describe("PacketSplitter", () => {
    it("returns a complete packet as is", () => {
        const {packets, discarded} = new PacketSplitter().push(data);

        assert.deepEqual(packets, [data]);
        assert.deepEqual(discarded, []);
    });

    it("waits for the rest of a packet split over several reads", () => {
        const splitter = new PacketSplitter();

        assert.deepEqual(splitter.push(data.subarray(0, 2)).packets, []); // not even the length yet
        assert.deepEqual(splitter.push(data.subarray(2, 600)).packets, []);
        assert.deepEqual(splitter.push(data.subarray(600)).packets, [data]);
    });

    it("splits several packets that arrive in one read", () => {
        const {packets} = new PacketSplitter().push(Buffer.concat([handshake, data, reply]));

        assert.deepEqual(packets, [handshake, data, reply]);
    });

    it("keeps the start of the next packet for the next read", () => {
        const splitter = new PacketSplitter();
        const both = Buffer.concat([handshake, data]);

        assert.deepEqual(splitter.push(both.subarray(0, handshake.length + 100)).packets, [handshake]);
        assert.deepEqual(splitter.push(both.subarray(handshake.length + 100)).packets, [data]);
    });

    it("skips bytes before a packet", () => {
        const {packets, discarded} = new PacketSplitter().push(Buffer.concat([Buffer.from("0d0a1234", "hex"), reply]));

        assert.deepEqual(packets, [reply]);
        assert.deepEqual(discarded, [Buffer.from("0d0a1234", "hex")]);
    });

    it("skips a stray start byte whose packet doesn't end with the end byte", () => {
        // a5 0200 ... claims a 15-byte packet, but its byte 14 isn't 0x15
        const junk = Buffer.from("a50200000000000000000000000000", "hex");
        const {packets, discarded} = new PacketSplitter().push(Buffer.concat([junk, reply]));

        assert.deepEqual(packets, [reply]);
        assert.deepEqual(Buffer.concat(discarded), junk);
    });

    it("skips a stray start byte with an impossible length instead of waiting for it", () => {
        const junk = Buffer.from("a5ffff00", "hex"); // 65535 byte payload
        const {packets, discarded} = new PacketSplitter().push(Buffer.concat([junk, reply]));

        assert.deepEqual(packets, [reply]);
        assert.deepEqual(Buffer.concat(discarded), junk);
    });
});
