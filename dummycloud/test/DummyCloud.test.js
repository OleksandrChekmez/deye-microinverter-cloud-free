const assert = require("node:assert/strict");
const DummyCloud = require("../src/DummyCloud");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const PacketSplitter = require("../src/PacketSplitter");
const path = require("node:path");
const {after, before, describe, it} = require("node:test");

/**
 * @param {string} name file in test/fixtures
 * @returns {Buffer}
 */
function fixture(name) {
    return Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8").trim(), "hex");
}

const handshake = fixture("lsw3-handshake.hex");
const data = fixture("sun-5k-sg03lp1-data.hex");
const charging = fixture("sun-5k-sg03lp1-charging.hex");
const report = fixture("report-synthetic.hex");

/**
 * @param {Function} condition
 * @returns {Promise<void>} resolves once condition() is true (fails the test after 2 s)
 */
async function waitFor(condition) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise(resolve => {
            setTimeout(resolve, 10);
        });
    }
}

describe("DummyCloud over TCP", () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "dummycloud-capture-"));
    const originalPort = DummyCloud.PORT;
    let dummyCloud;
    let port;

    before(async () => {
        process.env.CAPTURE_DIR = captureDir;
        DummyCloud.PORT = 0; // any free port
        dummyCloud = new DummyCloud();
        delete process.env.CAPTURE_DIR;

        const listening = new Promise(resolve => {
            dummyCloud.server.once("listening", resolve);
        });
        dummyCloud.initialize();
        await listening;
        port = dummyCloud.server.address().port;
    });

    after(() => {
        dummyCloud.server.close();
        DummyCloud.PORT = originalPort;
        fs.rmSync(captureDir, {recursive: true, force: true});
    });

    it("decodes and answers packets however TCP splits or joins them", async () => {
        const handshakes = [];
        const readings = [];
        dummyCloud.onHandshake(event => {
            handshakes.push(event);
        });
        dummyCloud.onData(event => {
            readings.push(event);
        });

        const client = net.connect({host: "127.0.0.1", port: port});
        const replies = [];
        const replySplitter = new PacketSplitter();
        client.on("data", chunk => {
            replies.push(...replySplitter.push(chunk).packets);
        });
        await new Promise(resolve => {
            client.once("connect", resolve);
        });

        // Handshake and the first half of a DATA packet in one write, the rest later, then a second DATA packet
        const stream = Buffer.concat([handshake, data, charging]);
        const cut = handshake.length + 500;
        client.write(stream.subarray(0, cut));
        await new Promise(resolve => {
            setTimeout(resolve, 50);
        });
        client.write(stream.subarray(cut));

        await waitFor(() => {
            return replies.length === 3;
        });
        client.destroy();

        assert.equal(handshakes.length, 1);
        assert.equal(handshakes[0].payload.fw_ver, "LSW3_15_FFFF_1.0.92R");
        assert.deepEqual(readings.map(r => {
            return r.payload.inverter_time;
        }), ["2026-10-23 09:08:33", "2026-10-23 10:38:46"]);
        // Replies are numbered per connection, like the real cloud's
        assert.deepEqual(replies.map(r => {
            return [r[4], r[5]];
        }), [[0x11, 1], [0x12, 2], [0x12, 3]]);
    });

    it("saves every packet type to CAPTURE_DIR", async () => {
        await waitFor(() => {
            return fs.readdirSync(captureDir).length === 3;
        });
        const files = fs.readdirSync(captureDir);

        assert.equal(files.filter(f => {
            return /^2740963018_.+_handshake\.hex$/.test(f);
        }).length, 1);
        assert.equal(files.filter(f => {
            return /^2740963018_.+_schema07(-1)?\.hex$/.test(f); // -1 when both arrived in the same millisecond
        }).length, 2);
        const saved = files.find(f => {
            return f.endsWith("_handshake.hex");
        });
        assert.equal(fs.readFileSync(path.join(captureDir, saved), "utf8").trim(), handshake.toString("hex"));
    });

    it("decodes and answers REPORT packets", async () => {
        const reports = [];
        dummyCloud.onReport(event => {
            reports.push(event);
        });

        const client = net.connect({host: "127.0.0.1", port: port});
        const replies = [];
        const replySplitter = new PacketSplitter();
        client.on("data", chunk => {
            replies.push(...replySplitter.push(chunk).packets);
        });
        client.write(report);

        await waitFor(() => {
            return replies.length === 1;
        });
        client.destroy();

        assert.equal(replies[0][4], 0x18); // REPORT reply
        assert.equal(reports.length, 1);
        assert.equal(reports[0].payload.uptime_seconds, 42);
        await waitFor(() => {
            return fs.readdirSync(captureDir).some(f => {
                return f.endsWith("_report.hex");
            });
        });
    });
});
