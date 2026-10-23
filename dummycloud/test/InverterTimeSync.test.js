const assert = require("node:assert/strict");
const fs = require("node:fs");
const InverterTimeSync = require("../src/InverterTimeSync");
const Logger = require("../src/Logger");
const path = require("node:path");
const Protocol = require("../src/Protocol");
const {after, before, describe, it} = require("node:test");

// The reference packet: the inverter says 11:03:07 local (UTC+3), the logger's clock 08:14:10 UTC, i.e. 663 s behind
const REFERENCE_RECEIVED = Date.parse("2026-10-23T08:14:11Z");
// Registers 22-24 for 2026-10-23 11:03:08 (inverter, 663 s behind)
const BEHIND = [0x1a0a, 0x170b, 0x0308];

/**
 * @param {string} name file in test/fixtures
 * @returns {object} what DummyCloud emits for a DATA packet
 */
function dataEvent(name) {
    const p = Protocol.parsePacket(Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex"));

    return {header: p.header, payload: Protocol.parseDataPacketPayload(p), meta: {remoteAddress: "172.18.0.1"}};
}

/**
 * @param {Array<Array<number>>} reads what each register read returns, in order
 * @returns {{sync: InverterTimeSync, calls: Array}} a sync whose logger already did its handshake, and a fake
 *          Modbus connection that records its calls
 */
function createSync(reads) {
    const calls = [];
    const handlers = {};
    const sync = new InverterTimeSync({
        onHandshake: listener => {
            handlers.handshake = listener;
        },
        onData: listener => {
            handlers.data = listener;
        }
    }, {
        createModbus: (host, loggerSerial) => {
            calls.push(["connect", host, loggerSerial]);

            return {
                readHoldingRegisters: async (address, count) => {
                    calls.push(["read", address, count]);
                    const result = reads.shift();
                    if (result instanceof Error) {
                        throw result;
                    }

                    return result;
                },
                writeMultipleRegisters: async (address, values) => {
                    calls.push(["write", address, values]);
                }
            };
        }
    });
    sync.initialize();
    handlers.handshake({header: {loggerSerial: 2740963018}, payload: {ip: "192.168.0.148"}});

    return {sync: sync, calls: calls};
}

describe("InverterTimeSync", () => {
    const originalTz = process.env.TZ;

    before(() => {
        process.env.TZ = "Europe/Kyiv";
    });
    after(() => {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    });

    it("decodes and encodes the inverter's time registers", () => {
        // Read from the inverter on 2026-10-23 at 17:26:38 Kyiv time: it said 17:16:04
        assert.equal(InverterTimeSync.decodeTime([0x1a0a, 0x1711, 0x1004]).toISOString(), "2026-10-23T14:16:04.000Z");
        assert.deepEqual(InverterTimeSync.encodeTime(new Date("2026-10-23T14:26:38Z")), [0x1a0a, 0x1711, 0x1a26]);
        assert.throws(() => {
            InverterTimeSync.decodeTime([0x1a00, 0x1711, 0x1004]);
        }, /aren't a time/);
    });

    it("sets the inverter's clock when a reading shows it's more than 30 s off", async (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        const info = t.mock.method(Logger, "info", () => {});
        const {sync, calls} = createSync([BEHIND, [0x1a0a, 0x170b, 0x0e0b]]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls, [
            ["connect", "192.168.0.148", 2740963018],
            ["read", 22, 3],
            ["write", 22, InverterTimeSync.encodeTime(new Date(REFERENCE_RECEIVED))], // 11:14:11 local
            ["read", 22, 3]
        ]);
        assert.match(info.mock.calls.at(-1).arguments[0], /from 2026-10-23 11:03:08 to 2026-10-23 11:14:11: it was 663 s behind, now exact/);
    });

    it("doesn't write when the clock turns out to be close enough", async (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        t.mock.method(Logger, "info", () => {});
        // The packet's timestamp suggested 663 s, but the inverter itself says 11:13:51 (20 s behind)
        const {sync, calls} = createSync([[0x1a0a, 0x170b, 0x0d33]]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls.map(c => {
            return c[0];
        }), ["connect", "read"]);
    });

    it("leaves a clock alone when the reading's time is within 30 s of the logger's", async (t) => {
        const event = dataEvent("sun-5k-sg03lp1-reference.hex");
        event.payload.logger_status.clock = Date.parse("2026-10-23T08:03:30Z") / 1000; // inverter 11:03:07 = 08:03:07Z
        const {sync, calls} = createSync([]);

        await sync.handleData(event);

        assert.deepEqual(calls, []);
    });

    it("checks each reading once, not the logger's repeats", async (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        t.mock.method(Logger, "info", () => {});
        const {sync, calls} = createSync([BEHIND, BEHIND]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        calls.length = 0;
        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls, []);
    });

    it("tries at most every 15 minutes", async (t) => {
        let now = REFERENCE_RECEIVED;
        t.mock.method(Date, "now", () => {
            return now;
        });
        const warn = t.mock.method(Logger, "warn", () => {});
        t.mock.method(Logger, "info", () => {});
        const {sync, calls} = createSync([new Error("No answer"), BEHIND, BEHIND]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-data.hex"));
        assert.match(warn.mock.calls[0].arguments[0], /Couldn't sync the inverter clock through logger 2740963018: No answer/);

        now += 10 * 60 * 1000;
        calls.length = 0;
        await sync.handleData(dataEvent("sun-5k-sg03lp1-charging.hex"));
        assert.deepEqual(calls, []);

        now += 6 * 60 * 1000;
        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));
        assert.deepEqual(calls.map(c => {
            return c[0];
        }), ["connect", "read", "write", "read"]);
    });

    it("doesn't touch the clock near midnight", async (t) => {
        t.mock.method(Date, "now", () => {
            return Date.parse("2026-10-23T20:50:00Z"); // 23:50 in Kyiv
        });
        const {sync, calls} = createSync([BEHIND]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls, []);
    });

    it("doesn't touch the clock near the inverter's midnight either", async (t) => {
        t.mock.method(Date, "now", () => {
            return Date.parse("2026-10-23T21:20:00Z"); // 00:20 in Kyiv
        });
        t.mock.method(Logger, "info", () => {});
        const {sync, calls} = createSync([[0x1a0a, 0x1800, 0x0900]]); // the inverter says 2026-10-24 00:09, 11 min behind

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls.map(c => {
            return c[0];
        }), ["connect", "read"]);
    });

    it("waits for the handshake to know the logger's IP", async (t) => {
        t.mock.method(Date, "now", () => {
            return REFERENCE_RECEIVED;
        });
        const calls = [];
        const sync = new InverterTimeSync({onHandshake: () => {}, onData: () => {}}, {
            createModbus: () => {
                calls.push("connect");
            }
        });
        sync.initialize();

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls, []);
    });

    it("does nothing without TZ", async (t) => {
        delete process.env.TZ;
        t.after(() => {
            process.env.TZ = "Europe/Kyiv";
        });
        t.mock.method(Logger, "warn", () => {});
        const {sync, calls} = createSync([BEHIND]);

        await sync.handleData(dataEvent("sun-5k-sg03lp1-reference.hex"));

        assert.deepEqual(calls, []);
    });
});
