const CloudForwarder = require("./CloudForwarder");
const EventEmitter = require("events").EventEmitter;
const fs = require("fs");
const Logger = require("./Logger");
const net = require("net");
const packageJson = require("../package.json");
const path = require("path");
const Protocol = require("./Protocol");
const {toHexByte} = require("./util");

class DummyCloud {
    constructor() {
        this.eventEmitter = new EventEmitter();
        this.server = new net.Server();

        // Optional: folder to save every DATA packet to, one hex file per packet
        this.captureDir = process.env.CAPTURE_DIR;
        // Optional diagnostic: "host:port" to copy all logger traffic to, logging that server's replies
        this.forwardTo = process.env.FORWARD_TO;
    }

    initialize() {
        if (this.captureDir) {
            fs.mkdirSync(this.captureDir, {recursive: true});
            Logger.info(`Saving DATA packets to ${this.captureDir}`);
        }
        if (this.forwardTo) {
            Logger.warn(`FORWARD_TO is set: copying all logger traffic to ${this.forwardTo} and logging its replies (not passed on to the logger)`);
        }

        this.server.listen(
            {
                port: DummyCloud.PORT,
                host: "0.0.0.0"
            },
            function() {
                Logger.info(`Starting deye-dummycloud v${packageJson.version} on port ${DummyCloud.PORT}`);
                Logger.info(`Timezone offset sent to loggers: ${Protocol.getTimezoneOffsetMinutes()} minutes (TZ=${process.env.TZ ?? "not set"})`);
            });

        this.server.on("connection", (socket) => {
            this.handleConnection(socket);
        });
    }

    /**
     * @private
     * @param {net.Socket} socket
     */
    handleConnection(socket) {
        const remoteAddress = socket.remoteAddress; // As this is a getter, it may become unavailable
        Logger.info(`New connection from ${remoteAddress}`);

        const forwarder = this.forwardTo ? new CloudForwarder(this.forwardTo, remoteAddress) : null;
        let replyCount = 0; // the reply's sequence number counts replies per connection, like the real cloud

        socket.on("data", (data) => {
            Logger.trace(new Date().toISOString(), `Data received from client ${remoteAddress}: ${data.toString()}`);
            Logger.trace(new Date().toISOString(), `Data ${remoteAddress}:`, data.toString("hex"));

            if (forwarder) {
                Logger.info(`[forward] logger sent: ${CloudForwarder.summarize(data)}`);
                forwarder.forward(data);
            }

            try {
                const packet = Protocol.parsePacket(data);
                let response;

                switch (packet.header.type) {
                    case Protocol.MESSAGE_REQUEST_TYPES.HEARTBEAT: {
                        response = Protocol.buildTimeResponse(packet, ++replyCount);
                        break;
                    }
                    case Protocol.MESSAGE_REQUEST_TYPES.WIFI: {
                        /*
                            There isn't much of interest in this packet
                            It can contain the SSID or the Logger SN
                            + Some counters increasing every second
                            
                            On connect, it also can contain the signal strength
                            But that's about it
                            
                            The signal strength over time would've been interesting, but it only gets sent on connect
                            With that, it's close to useless
                         */
                        response = Protocol.buildTimeResponse(packet, ++replyCount);
                        break;
                    }
                    case Protocol.MESSAGE_REQUEST_TYPES.HANDSHAKE: {
                        const data = Protocol.parseLoggerPacketPayload(packet);

                        Logger.debug(`Handshake packet data from ${remoteAddress}`, data);
                        this.emitHandshake({
                            header: packet.header,
                            payload: data
                        });

                        response = Protocol.buildTimeResponse(packet, ++replyCount);
                        break;
                    }
                    case Protocol.MESSAGE_REQUEST_TYPES.DATA: {
                        this.capturePacket(data, packet);

                        // Returns null for packets it can't decode, and logs the reason itself
                        const decoded = Protocol.parseDataPacketPayload(packet);

                        if (decoded) {
                            Logger.debug(`DATA packet data from ${remoteAddress}`, decoded);
                            this.emitData({
                                header: packet.header,
                                payload: decoded,
                                meta: {
                                    remoteAddress: remoteAddress
                                }
                            });
                        }

                        response = Protocol.buildTimeResponse(packet, ++replyCount);
                        break;
                    }

                    default: {
                        response = Protocol.buildTimeResponse(packet, ++replyCount);
                    }
                }

                if (response) {
                    Logger.trace("Response", response.toString("hex"));

                    socket.write(response);
                    if (forwarder) {
                        forwarder.logOwnReply(response);
                    }
                }
            } catch (e) {
                Logger.error(`Error while parsing packet from ${remoteAddress}`, e);
            }
        });

        socket.on("end", function() {
            Logger.info(`Ending connection with ${remoteAddress}`);
        });

        socket.on("close", function() {
            Logger.info(`Closing connection with ${remoteAddress}`);
            if (forwarder) {
                forwarder.close();
            }
        });

        socket.on("error", function(err) {
            Logger.error(`Error on dummycloud socket for ${remoteAddress}`, err);
        });
    }

    /**
     * Saves the raw packet as a hex file in CAPTURE_DIR (if set), in the same format as test/fixtures.
     *
     * @private
     * @param {Buffer} raw
     * @param {{header: object, payload: Buffer}} packet
     */
    capturePacket(raw, packet) {
        if (!this.captureDir) {
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const schema = toHexByte(packet.payload[1]).slice(2);
        const fileName = `${packet.header.loggerSerial}_${timestamp}_schema${schema}.hex`;

        fs.promises.writeFile(path.join(this.captureDir, fileName), raw.toString("hex") + "\n").catch(err => {
            Logger.error(`Failed to save captured packet ${fileName}`, err);
        });
    }

    emitData(data) {
        this.eventEmitter.emit(DummyCloud.PACKET_EVENTS.Data, data);
    }

    onData(listener) {
        this.eventEmitter.on(DummyCloud.PACKET_EVENTS.Data, listener);
    }

    emitHandshake(data) {
        this.eventEmitter.emit(DummyCloud.PACKET_EVENTS.Handshake, data);
    }

    onHandshake(listener) {
        this.eventEmitter.on(DummyCloud.PACKET_EVENTS.Handshake, listener);
    }
}

DummyCloud.PACKET_EVENTS = {
    Data: "Data",
    Handshake: "Handshake"
};


DummyCloud.PORT = 10000;

module.exports = DummyCloud;
