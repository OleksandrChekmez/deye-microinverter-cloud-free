const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {describe, it} = require("node:test");

/*
 * Real exchanges captured on 2026-10-23 with FORWARD_TO: the logger's message and what the Solarman cloud
 * answered. Our reply has to be identical, given the same reply number, time and timezone (UTC+3 = 180 min).
 */
const EXCHANGES = [
    {
        name: "HANDSHAKE, first reply on the connection",
        fixture: "lsw3-handshake.hex",
        replyNumber: 1,
        unixTime: 0x6adb3291,
        cloudReply: "a50a001011014ccac65fa302019132db6ab4000000c915"
    },
    {
        name: "DATA, second reply on the connection",
        fixture: "sun-5k-sg03lp1-cloud-capture.hex",
        replyNumber: 2,
        unixTime: 0x6adb3325,
        cloudReply: "a50a001012020ccac65fa301012533db6ab40000001f15"
    },
];

describe("Replies match the real Solarman cloud", () => {
    for (const exchange of EXCHANGES) {
        it(exchange.name, (t) => {
            t.mock.method(Date, "now", () => {
                return exchange.unixTime * 1000;
            });
            t.mock.method(Protocol, "getTimezoneOffsetMinutes", () => {
                return 180;
            });

            const request = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", exchange.fixture), "utf8").trim(), "hex");
            const reply = Protocol.buildTimeResponse(Protocol.parsePacket(request), exchange.replyNumber);

            assert.equal(reply.toString("hex"), exchange.cloudReply);
        });
    }
});
