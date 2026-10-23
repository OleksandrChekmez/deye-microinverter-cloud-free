const CloudForwarder = require("./CloudForwarder");
const EventEmitter = require("events").EventEmitter;
const fs = require("fs");
const Logger = require("./Logger");
const net = require("net");
const packageJson = require("../package.json");
const PacketSplitter = require("./PacketSplitter");
const path = require("path");
const Protocol = require("./Protocol");
const {getKeyByValue, toHexByte} = require("./util");

class DummyCloud {
    constructor() {
        this.eventEmitter = new EventEmitter();
        this.server = new net.Server();

        // Optional: folder to save every packet to, one hex file per packet
        this.captureDir = process.env.CAPTURE_DIR;
        // Optional diagnostic: "host:port" to copy all logger traffic to, logging that server's replies
        this.forwardTo = process.env.FORWARD_TO;
    }

    initialize() {
        if (this.captureDir) {
            fs.mkdirSync(this.captureDir, {recursive: true});
            Logger.info(`Saving all packets to ${this.captureDir}`);
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

        const connection = {
            remoteAddress: remoteAddress,
            socket: socket,
            forwarder: this.forwardTo ? new CloudForwarder(this.forwardTo, remoteAddress) : null,
            replyCount: 0 // the reply's sequence number counts replies per connection, like the real cloud
        };
        // TCP doesn't keep packet boundaries: one read can hold part of a packet, or several packets
        const splitter = new PacketSplitter();

        socket.on("data", (data) => {
            Logger.trace(new Date().toISOString(), `Data received from client ${remoteAddress}: ${data.toString()}`);
            Logger.trace(new Date().toISOString(), `Data ${remoteAddress}:`, data.toString("hex"));

            if (connection.forwarder) {
                connection.forwarder.forward(data);
            }

            const {packets, discarded} = splitter.push(data);
            for (const bytes of discarded) {
                Logger.warn(`Skipped ${bytes.length} bytes from ${remoteAddress} that aren't a packet: ${bytes.toString("hex")}`);
            }
            for (const raw of packets) {
                this.handlePacket(raw, connection);
            }
        });

        socket.on("end", function() {
            Logger.info(`Ending connection with ${remoteAddress}`);
        });

        socket.on("close", function() {
            Logger.info(`Closing connection with ${remoteAddress}`);
            if (connection.forwarder) {
                connection.forwarder.close();
            }
        });

        socket.on("error", function(err) {
            Logger.error(`Error on dummycloud socket for ${remoteAddress}`, err);
        });
    }

    /**
     * Decodes one complete packet and answers it
     *
     * @private
     * @param {Buffer} raw
     * @param {{remoteAddress: string, socket: net.Socket, forwarder: CloudForwarder|null, replyCount: number}} connection
     */
    handlePacket(raw, connection) {
        const remoteAddress = connection.remoteAddress;

        if (connection.forwarder) {
            Logger.info(`[forward] logger sent: ${CloudForwarder.summarize(raw)}`);
        }

        try {
            const packet = Protocol.parsePacket(raw);
            this.capturePacket(raw, packet);

            switch (packet.header.type) {
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
                    break;
                }
                case Protocol.MESSAGE_REQUEST_TYPES.HANDSHAKE: {
                    const data = Protocol.parseLoggerPacketPayload(packet);

                    Logger.debug(`Handshake packet data from ${remoteAddress}`, data);
                    this.emitHandshake({
                        header: packet.header,
                        payload: data,
                        meta: {
                            remoteAddress: remoteAddress
                        }
                    });
                    break;
                }
                case Protocol.MESSAGE_REQUEST_TYPES.DATA: {
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
                    break;
                }
                default: {
                    // HEARTBEAT and unknown types carry nothing to decode
                }
            }

            // Every packet gets answered, the logger expects it. The reply also gives it the current time.
            const response = Protocol.buildTimeResponse(packet, ++connection.replyCount);
            Logger.trace("Response", response.toString("hex"));

            connection.socket.write(response);
            if (connection.forwarder) {
                connection.forwarder.logOwnReply(response);
            }
        } catch (e) {
            Logger.error(`Error while handling packet from ${remoteAddress}`, e);
        }
    }

    /**
     * Saves the raw packet as a hex file in CAPTURE_DIR (if set), in the same format as test/fixtures.
     * DATA packets are named after their schema byte (e.g. _schema07), the others after their type (e.g. _handshake).
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
        let kind;
        if (packet.header.type === Protocol.MESSAGE_REQUEST_TYPES.DATA && packet.payload.length > 1) {
            kind = "schema" + toHexByte(packet.payload[1]).slice(2);
        } else {
            const typeName = getKeyByValue(Protocol.MESSAGE_REQUEST_TYPES, packet.header.type);
            kind = typeName ? typeName.toLowerCase() : "type" + toHexByte(packet.header.type).slice(2);
        }
        // Packets that arrive in the same read get the same timestamp, so number them
        const baseName = `${packet.header.loggerSerial}_${timestamp}_${kind}`;
        this.captureSeq = baseName === this.lastCaptureName ? this.captureSeq + 1 : 0;
        this.lastCaptureName = baseName;
        const fileName = `${baseName}${this.captureSeq > 0 ? "-" + this.captureSeq : ""}.hex`;

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
