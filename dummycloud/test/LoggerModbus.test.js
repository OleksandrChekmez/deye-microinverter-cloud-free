const assert = require("node:assert/strict");
const LoggerModbus = require("../src/LoggerModbus");
const net = require("node:net");
const Protocol = require("../src/Protocol");
const {after, describe, it} = require("node:test");

// Captured 2026-10-23 from the LSW-3 (logger 2740963018): reading the inverter's clock, registers 22-24
const READ_REQUEST = "a517001045ac00cac65fa3020000000000000000000000000000010300160003e40fbc15";
const READ_RESPONSE = "a519001015ac01cac65fa30201c6f0f7050c000000000000000103061a0a17111004e2fc8615";

/**
 * @param {Buffer} modbus Modbus response without CRC
 * @returns {Buffer} a logger response frame carrying it
 */
function responseFrame(modbus) {
    const withCrc = LoggerModbus.withCrc(modbus);
    const frame = Buffer.alloc(11 + 14 + withCrc.length + 2);
    frame[0] = 0xa5;
    frame.writeUInt16LE(14 + withCrc.length, 1);
    frame[3] = 0x10;
    frame[4] = 0x15;
    frame.writeUInt32LE(2740963018, 7);
    frame[11] = 0x02;
    frame[12] = 0x01;
    withCrc.copy(frame, 25);
    frame[frame.length - 2] = Protocol.checksum(frame);
    frame[frame.length - 1] = 0x15;

    return frame;
}

/**
 * @param {Function} answer (request: Buffer, socket: net.Socket) => void
 * @returns {Promise<{port: number, requests: Array<Buffer>}>} a fake logger on a free local port
 */
function fakeLogger(answer) {
    return new Promise(resolve => {
        const requests = [];
        const server = net.createServer(socket => {
            socket.on("data", data => {
                requests.push(data);
                answer(data, socket);
            });
        });
        servers.push(server);
        server.listen(0, "127.0.0.1", () => {
            resolve({port: server.address().port, requests: requests});
        });
    });
}

const servers = [];

describe("LoggerModbus", () => {
    after(() => {
        for (const server of servers) {
            server.close();
        }
    });

    it("computes the Modbus CRC", () => {
        assert.equal(LoggerModbus.withCrc(Buffer.from("01030000000a", "hex")).toString("hex"), "01030000000ac5cd");
    });

    it("reads registers with the same request as the captured one, skipping other frames", async () => {
        const {port, requests} = await fakeLogger((request, socket) => {
            // The logger may send other frames (here a heartbeat) before the answer, and split the answer
            const response = Buffer.from(READ_RESPONSE, "hex");
            socket.write(Buffer.concat([Buffer.from("a5010010470000cac65fa300", "hex"), response.subarray(0, 20)]));
            setTimeout(() => {
                socket.write(response.subarray(20));
            }, 20);
        });
        const modbus = new LoggerModbus("127.0.0.1", 2740963018, port);
        modbus.sequence = 0xab; // the next request uses 0xac, as in the capture

        assert.deepEqual(await modbus.readHoldingRegisters(22, 3), [0x1a0a, 0x1711, 0x1004]);
        assert.equal(requests[0].toString("hex"), READ_REQUEST);
    });

    it("writes registers", async () => {
        const {port, requests} = await fakeLogger((request, socket) => {
            socket.write(responseFrame(Buffer.from("011000160003", "hex")));
        });
        await new LoggerModbus("127.0.0.1", 2740963018, port).writeMultipleRegisters(22, [0x1a0a, 0x1711, 0x1a26]);

        // V5 header and prefix, then: slave 1, function 16, register 22, 3 registers, 6 bytes, the values, CRC
        const modbus = requests[0].subarray(26, requests[0].length - 2);
        assert.equal(modbus.subarray(0, 13).toString("hex"), "01100016000306" + "1a0a17111a26");
        assert.equal(LoggerModbus.crc16(modbus.subarray(0, 13)), modbus.readUInt16LE(13));
    });

    it("fails on a Modbus exception", async () => {
        const {port} = await fakeLogger((request, socket) => {
            socket.write(responseFrame(Buffer.from("019002", "hex")));
        });

        await assert.rejects(new LoggerModbus("127.0.0.1", 1, port).writeMultipleRegisters(22, [1, 2, 3]), /Modbus exception 2/);
    });

    it("fails when the logger's reply has no Modbus frame", async () => {
        const {port} = await fakeLogger((request, socket) => {
            socket.write(responseFrame(Buffer.alloc(0)));
        });

        await assert.rejects(new LoggerModbus("127.0.0.1", 1, port).readHoldingRegisters(22, 3), /inverter may not have answered/);
    });

    it("fails when the logger closes the connection", async () => {
        const {port} = await fakeLogger((request, socket) => {
            socket.end();
        });

        await assert.rejects(new LoggerModbus("127.0.0.1", 1, port).readHoldingRegisters(22, 3), /closed the connection/);
    });
});
