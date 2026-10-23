const Logger = require("./Logger");
const net = require("net");
const PacketSplitter = require("./PacketSplitter");

const HEADER_LEN = 11;
const FOOTER_LEN = 2;
const CONNECT_TIMEOUT_MS = 10 * 1000;

const TYPE_NAMES = Object.freeze({
    0x11: "HANDSHAKE reply",
    0x12: "DATA reply",
    0x13: "WIFI reply",
    0x17: "HEARTBEAT reply",
    0x18: "REPORT reply",
    0x41: "HANDSHAKE",
    0x42: "DATA",
    0x43: "WIFI",
    0x45: "REQUEST",
    0x47: "HEARTBEAT",
    0x48: "REPORT",
});

/**
 * Diagnostic tool: copies everything one logger connection sends to another server (normally the real Solarman
 * cloud) and logs what that server answers. The answers are never passed on to the logger, so the cloud can't
 * send it commands or firmware updates. Enabled with FORWARD_TO=host:port.
 */
class CloudForwarder {
    /**
     * @param {string} target "host:port"
     * @param {string} loggerAddress only used in log lines
     */
    constructor(target, loggerAddress) {
        const separator = target.lastIndexOf(":");
        this.host = target.slice(0, separator);
        this.port = parseInt(target.slice(separator + 1), 10);
        if (!this.host || !(this.port > 0)) {
            throw new Error(`Invalid FORWARD_TO "${target}", expected host:port`);
        }

        this.loggerAddress = loggerAddress;
        this.socket = null;
        this.pending = []; // chunks waiting for the connection
        this.splitter = new PacketSplitter();
        this.onFrame = null; // optional (frame: Buffer) => void, e.g. for tests
    }

    /**
     * @param {Buffer} chunk raw bytes received from the logger
     */
    forward(chunk) {
        if (this.socket && this.socket.readyState === "open") {
            this.socket.write(chunk);
        } else {
            this.pending.push(chunk);
            this.connect();
        }
    }

    /**
     * Logs the reply the dummycloud itself sent, next to the cloud's, for comparison
     *
     * @param {Buffer} response
     */
    logOwnReply(response) {
        Logger.info(`[forward] dummycloud replied: ${CloudForwarder.describe(response)}`);
    }

    close() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    /**
     * @private
     */
    connect() {
        if (this.socket) {
            return; // already connecting
        }

        Logger.info(`[forward] Connecting to ${this.host}:${this.port} for logger ${this.loggerAddress}`);
        const socket = net.connect({host: this.host, port: this.port});
        this.socket = socket;
        this.splitter = new PacketSplitter();

        socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
            if (socket.connecting) {
                Logger.warn(`[forward] Timed out connecting to ${this.host}:${this.port}`);
                socket.destroy();
            }
        });

        socket.on("connect", () => {
            socket.setTimeout(0);
            Logger.info(`[forward] Connected to ${this.host}:${this.port}`);
            for (const chunk of this.pending) {
                socket.write(chunk);
            }
            this.pending = [];
        });

        socket.on("data", (data) => {
            this.handleCloudData(data);
        });

        socket.on("error", (err) => {
            Logger.warn(`[forward] Connection to ${this.host}:${this.port} failed: ${err.message}`);
        });

        socket.on("close", () => {
            Logger.info(`[forward] Connection to ${this.host}:${this.port} closed`);
            if (this.socket === socket) {
                this.socket = null;
            }
        });
    }

    /**
     * Splits the cloud's byte stream into V5 frames and logs each one
     *
     * @private
     * @param {Buffer} data
     */
    handleCloudData(data) {
        const {packets, discarded} = this.splitter.push(data);

        for (const bytes of discarded) {
            Logger.info(`[forward] cloud sent non-V5 bytes: ${bytes.toString("hex")}`);
        }
        for (const frame of packets) {
            Logger.info(`[forward] cloud replied: ${CloudForwarder.describe(frame)}`);
            if (this.onFrame) {
                this.onFrame(frame);
            }
        }
    }

    /**
     * @param {Buffer} frame
     * @returns {string} e.g. "DATA, seq 22 16, 1013 byte payload" (short; logger DATA packets are 1 KB)
     */
    static summarize(frame) {
        if (frame.length < HEADER_LEN + FOOTER_LEN || frame[0] !== 0xa5) {
            return `${frame.length} bytes, not a V5 frame`;
        }

        const type = TYPE_NAMES[frame[4]] ?? `type 0x${frame[4].toString(16)}`;
        const seq = frame.subarray(5, 7).toString("hex").replace(/(..)(..)/, "$1 $2");

        return `${type}, seq ${seq}, ${frame.length - HEADER_LEN - FOOTER_LEN} byte payload, payload[0]=0x${frame[HEADER_LEN].toString(16)}`;
    }

    /**
     * @param {Buffer} frame
     * @returns {string} e.g. "DATA reply, seq 22 16, payload 0101..., raw a50a..."
     */
    static describe(frame) {
        if (frame.length < HEADER_LEN + FOOTER_LEN) {
            return `raw ${frame.toString("hex")}`;
        }

        const type = TYPE_NAMES[frame[4]] ?? `type 0x${frame[4].toString(16)}`;
        const seq = frame.subarray(5, 7).toString("hex").replace(/(..)(..)/, "$1 $2");
        const payload = frame.subarray(HEADER_LEN, frame.length - FOOTER_LEN).toString("hex");

        return `${type}, seq ${seq}, payload ${payload}, raw ${frame.toString("hex")}`;
    }
}

module.exports = CloudForwarder;
