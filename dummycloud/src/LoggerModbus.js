const Logger = require("./Logger");
const net = require("net");
const PacketSplitter = require("./PacketSplitter");
const Protocol = require("./Protocol");

const HEADER_LEN = 11;
const FOOTER_LEN = 2;
const REQUEST_TYPE = 0x45; // control code 0x4510
const RESPONSE_TYPE = 0x15; // control code 0x1510
// Payload bytes before the Modbus frame: request = frame type + sensor type + 3 time fields,
// response = frame type + status + 3 time fields
const REQUEST_PREFIX_LEN = 15;
const RESPONSE_PREFIX_LEN = 14;
const MODBUS_SLAVE = 1;
const TIMEOUT_MS = 10 * 1000;

/**
 * Reads and writes the inverter's Modbus registers through the logger's local port 8899, the way pysolarmanv5 and
 * ha-solarman do (Solarman V5 frames with a Modbus RTU frame inside). Works without internet access.
 * One TCP connection per request: it's only used now and then.
 */
class LoggerModbus {
    /**
     * @param {string} host the logger's IP
     * @param {number} loggerSerial
     * @param {number} [port]
     */
    constructor(host, loggerSerial, port = 8899) {
        this.host = host;
        this.loggerSerial = loggerSerial;
        this.port = port;
        this.sequence = Math.floor(Math.random() * 256);
    }

    /**
     * @param {number} address first register
     * @param {number} count
     * @returns {Promise<Array<number>>} the register values
     */
    async readHoldingRegisters(address, count) {
        const response = await this.request(Buffer.from([
            MODBUS_SLAVE, 0x03, address >> 8, address & 0xff, count >> 8, count & 0xff
        ]));
        if (response[2] !== count * 2) {
            throw new Error(`Expected ${count * 2} data bytes, got ${response[2]}`);
        }

        const values = [];
        for (let i = 0; i < count; i++) {
            values.push(response.readUInt16BE(3 + i * 2));
        }

        return values;
    }

    /**
     * @param {number} address first register
     * @param {Array<number>} values
     * @returns {Promise<void>}
     */
    async writeMultipleRegisters(address, values) {
        const frame = Buffer.alloc(7 + values.length * 2);
        frame.set([MODBUS_SLAVE, 0x10, address >> 8, address & 0xff, values.length >> 8, values.length & 0xff, values.length * 2]);
        values.forEach((value, i) => {
            frame.writeUInt16BE(value, 7 + i * 2);
        });

        const response = await this.request(frame);
        if (response.readUInt16BE(2) !== address || response.readUInt16BE(4) !== values.length) {
            throw new Error(`Unexpected write response ${response.toString("hex")}`);
        }
    }

    /**
     * Sends one Modbus request (without CRC) and returns the Modbus response (CRC checked and removed)
     *
     * @private
     * @param {Buffer} modbusRequest
     * @returns {Promise<Buffer>}
     */
    async request(modbusRequest) {
        const request = this.buildFrame(LoggerModbus.withCrc(modbusRequest));
        Logger.trace(`[modbus] request to ${this.host}:${this.port}: ${request.toString("hex")}`);

        const frame = await this.exchange(request);
        Logger.trace(`[modbus] response: ${frame.toString("hex")}`);

        const modbus = frame.subarray(HEADER_LEN + RESPONSE_PREFIX_LEN, frame.length - FOOTER_LEN);
        if (modbus.length < 5) {
            throw new Error(`No Modbus response in the logger's reply (${frame.toString("hex")}); the inverter may not have answered`);
        }
        if (LoggerModbus.crc16(modbus.subarray(0, modbus.length - 2)) !== modbus.readUInt16LE(modbus.length - 2)) {
            throw new Error(`Bad Modbus CRC in ${modbus.toString("hex")}`);
        }
        if (modbus[1] & 0x80) {
            throw new Error(`Modbus exception ${modbus[2]} for function ${modbus[1] & 0x7f}`);
        }
        if (modbus[1] !== modbusRequest[1]) {
            throw new Error(`Modbus response for function ${modbus[1]}, expected ${modbusRequest[1]}`);
        }

        return modbus.subarray(0, modbus.length - 2);
    }

    /**
     * @private
     * @param {Buffer} modbusFrame with CRC
     * @returns {Buffer} V5 request frame
     */
    buildFrame(modbusFrame) {
        const payloadLength = REQUEST_PREFIX_LEN + modbusFrame.length;
        const frame = Buffer.alloc(HEADER_LEN + payloadLength + FOOTER_LEN);

        frame[0] = 0xa5;
        frame.writeUInt16LE(payloadLength, 1);
        frame[3] = 0x10;
        frame[4] = REQUEST_TYPE;
        this.sequence = (this.sequence + 1) & 0xff;
        frame[5] = this.sequence;
        frame[6] = 0x00;
        frame.writeUInt32LE(this.loggerSerial, 7);
        frame[HEADER_LEN] = 0x02; // frame type: inverter; sensor type and time fields stay 0
        modbusFrame.copy(frame, HEADER_LEN + REQUEST_PREFIX_LEN);
        frame[frame.length - 2] = Protocol.checksum(frame);
        frame[frame.length - 1] = 0x15;

        return frame;
    }

    /**
     * @private
     * @param {Buffer} request
     * @returns {Promise<Buffer>} the logger's response frame (other frames it sends meanwhile are ignored)
     */
    exchange(request) {
        return new Promise((resolve, reject) => {
            const socket = net.connect({host: this.host, port: this.port});
            const splitter = new PacketSplitter();
            const finish = (err, frame) => {
                socket.destroy();
                if (err) {
                    reject(err);
                } else {
                    resolve(frame);
                }
            };

            socket.setTimeout(TIMEOUT_MS, () => {
                finish(new Error(`No answer from ${this.host}:${this.port} within ${TIMEOUT_MS / 1000} s`));
            });
            socket.on("connect", () => {
                socket.write(request);
            });
            socket.on("data", data => {
                const response = splitter.push(data).packets.find(frame => {
                    return frame[4] === RESPONSE_TYPE;
                });
                if (response) {
                    finish(null, response);
                }
            });
            socket.on("error", err => {
                finish(err);
            });
            socket.on("close", () => {
                finish(new Error(`${this.host}:${this.port} closed the connection without answering`));
            });
        });
    }

    /**
     * @param {Buffer} frame
     * @returns {Buffer} the frame with its Modbus CRC (low byte first) appended
     */
    static withCrc(frame) {
        const crc = Buffer.alloc(2);
        crc.writeUInt16LE(LoggerModbus.crc16(frame));

        return Buffer.concat([frame, crc]);
    }

    /**
     * @param {Buffer} buf
     * @returns {number} Modbus CRC-16
     */
    static crc16(buf) {
        let crc = 0xffff;
        for (const byte of buf) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) {
                crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
            }
        }

        return crc;
    }
}

module.exports = LoggerModbus;
