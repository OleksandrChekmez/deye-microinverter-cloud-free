const assert = require("node:assert/strict");
const CloudForwarder = require("../src/CloudForwarder");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {describe, it} = require("node:test");

const loggerPacket = Buffer.from(
    fs.readFileSync(path.join(__dirname, "fixtures", "sun-5k-sg03lp1-data.hex"), "utf8").trim(), "hex"
);
const cloudReply = Buffer.from("a50a0010122216cac65fa30101a90fdb6a00000000f615", "hex");

/**
 * Fake cloud server that records what it receives and answers with cloudReply, split over two TCP writes
 *
 * @returns {Promise<{server: net.Server, port: number, received: Buffer[]}>}
 */
function startFakeCloud() {
    return new Promise(resolve => {
        const received = [];
        const server = net.createServer(socket => {
            let buffered = Buffer.alloc(0);
            socket.on("data", data => {
                buffered = Buffer.concat([buffered, data]);
                if (buffered.length >= loggerPacket.length) {
                    received.push(buffered);
                    socket.write(cloudReply.subarray(0, 5));
                    setTimeout(() => {
                        socket.write(cloudReply.subarray(5));
                    }, 20);
                }
            });
        });
        server.listen(0, "127.0.0.1", () => {
            resolve({server: server, port: server.address().port, received: received});
        });
    });
}

describe("CloudForwarder", () => {
    it("copies logger packets to the target and reassembles its replies", async () => {
        const cloud = await startFakeCloud();
        const forwarder = new CloudForwarder(`127.0.0.1:${cloud.port}`, "test-logger");

        const frame = await new Promise(resolve => {
            forwarder.onFrame = resolve;
            forwarder.forward(loggerPacket);
        });

        assert.deepEqual(cloud.received[0], loggerPacket);
        assert.deepEqual(frame, cloudReply);

        forwarder.close();
        cloud.server.close();
    });

    it("describes frames for the log", () => {
        assert.equal(
            CloudForwarder.describe(cloudReply),
            "DATA reply, seq 22 16, payload 0101a90fdb6a00000000, raw " + cloudReply.toString("hex")
        );
        assert.equal(CloudForwarder.summarize(loggerPacket), "DATA, seq 22 16, 1013 byte payload, payload[0]=0x1");
    });

    it("rejects an invalid target", () => {
        assert.throws(() => {
            return new CloudForwarder("no-port-here", "test-logger");
        }, /expected host:port/);
    });
});
