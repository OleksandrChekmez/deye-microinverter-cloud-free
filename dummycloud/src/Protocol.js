const HybridInverterSinglePhase = require("./HybridInverterSinglePhase");
const Logger = require("./Logger");
const {formatMacAddress, getKeyByValue, toHexByte, truncateToNullTerminator} = require("./util");

const HEADER_LEN = 11;
const FOOTER_LEN = 2;

class Protocol {
    static parseHeader(buf) {
        const result = {
            magic: buf[0], //should be 0xa5
            payloadLength: buf.readUInt16LE(1),
            unknown1: buf[3],
            type: buf[4],
            msgIDResponse: buf[5],
            msgIDRequest: buf[6],
            loggerSerial: buf.readUint32LE(7)
        };

        if (result.magic !== 0xa5) {
            throw new Error("Invalid header magic: " + result.magic);
        }

        if (result.payloadLength + HEADER_LEN + FOOTER_LEN !== buf.length) {
            throw new Error("Payload length from header doesn't match packet length. Truncated?");
        }

        return result;
    }

    static parseFooter(buf) {
        const result = {
            checksum: buf[buf.length - 2],
            magic: buf[buf.length - 1] //should always be 0x15
        };

        if (result.magic !== 0x15) {
            throw new Error("Invalid footer magic: " + result.magic);
        }

        return result;
    }

    static checksum(msgBuf) {
        const slice = msgBuf.subarray(1, msgBuf.length - 2); //exclude magic bytes and checksum
        let sum = 0;

        for (let i = 0; i < slice.length; i++) {
            sum = (sum + slice[i]) & 255;
        }

        return sum & 255;
    }


    static parsePacket(buf) {
        const header = Protocol.parseHeader(buf);

        const typeStr = getKeyByValue(Protocol.MESSAGE_REQUEST_TYPES, header.type);
        if (typeStr) {
            Logger.debug(`Received packet of type "${typeStr}"`);
        } else {
            Logger.warn(`Received packet of unknown type "0x${header.type.toString(16)}"`);
        }

        return {
            header: header,
            payload: buf.subarray(HEADER_LEN, buf.length - FOOTER_LEN)
        };
    }

    /**
     * Returns null (and logs why at debug level) for packets that aren't decoded.
     *
     * @param {{header: object, payload: Buffer}} packet
     * @returns {object|null}
     */
    static parseDataPacketPayload(packet) {
        const schema = packet.payload[1];

        switch (schema) {
            case Protocol.DATA_PACKET_SCHEMAS.MICROINVERTER:
                return Protocol.parseDataPacketMicroinverterPayload(packet);
            case Protocol.DATA_PACKET_SCHEMAS.HYBRIDINVERTER_SINGLEPHASE:
                return Protocol.parseDataPacketHybridSinglePhasePayload(packet);
            default: {
                //TODO: parse three-phase hybrid, relay and string inverter packets
                const schemaName = getKeyByValue(Protocol.DATA_PACKET_SCHEMAS, schema) ?? "unknown";

                Logger.debug(
                    `Discarded DATA packet: unsupported schema ${toHexByte(schema)} (${schemaName}),`,
                    `payload[0]=${toHexByte(packet.payload[0])}, payload length ${packet.payload.length}`
                );

                return null;
            }
        }
    }

    static parseDataPacketHybridSinglePhasePayload(packet) {
        if (!!(packet.payload[0] & 0b10000000)) {
            // Not seen from hybrids yet. Skip it like the microinverter ones, rather than publish old data as current
            Logger.debug(`Discarded DATA packet: historic single-phase hybrid packet (payload[0]=${toHexByte(packet.payload[0])})`);

            return null;
        }

        return {
            ...HybridInverterSinglePhase.parse(packet.payload),
            logger_status: Protocol.parseDataPacketLoggerStatus(packet.payload)
        };
    }

    /**
     * The logger's own fields at the start of a DATA payload. pysolarmanv5 calls them total working time, power on
     * time and offset time; upstream's Kaitai schema has power_on_time at 7 for three-phase hybrids. Checked on an LSW-3
     * (schema 0x07, 2026-10-23): power on time counts seconds since the logger booted, and offset time + total working
     * time is the logger's clock (Unix time), which matched the capture time to the second.
     * For microinverters (schema 0x08) these bytes are unverified, so they aren't decoded there.
     *
     * @param {Buffer} payload
     * @returns {{uptime_seconds: number, clock: number}} clock in Unix seconds
     */
    static parseDataPacketLoggerStatus(payload) {
        return {
            uptime_seconds: payload.readUInt32LE(7),
            clock: payload.readUInt32LE(11) + payload.readUInt32LE(3)
        };
    }

    static parseDataPacketMicroinverterPayload(packet) {
        if (!!(packet.payload[0] & 0b10000000)) {
            // Seems to be one of these weird historic data packets from the SUN-M series. Ignoring for now
            // TODO: understand what they mean and how they should be handled
            Logger.debug(`Discarded DATA packet: historic microinverter packet (payload[0]=${toHexByte(packet.payload[0])})`);

            return null;
        }

        //TODO: there's a lot more in this packet

        return {
            pv: {
                "1": {
                    v: packet.payload.readUInt16LE(85) / 10,
                    i: packet.payload.readUInt16LE(87) / 10,

                    w: parseFloat(((packet.payload.readUInt16LE(85) / 10) * (packet.payload.readUInt16LE(87) / 10)).toFixed(2)),

                    kWh_today: packet.payload.readUInt16LE(136) / 10,
                    kWh_total: packet.payload.readUInt16BE(145) / 10,
                },
                "2": {
                    v: packet.payload.readUInt16LE(89) / 10,
                    i: packet.payload.readUInt16LE(91) / 10,

                    w: parseFloat(((packet.payload.readUInt16LE(89) / 10) * (packet.payload.readUInt16LE(91) / 10)).toFixed(2)),

                    kWh_today: packet.payload.readUInt16LE(138) / 10,
                    kWh_total: packet.payload.readUInt16BE(149) / 10,
                },
                "3": {
                    v: packet.payload.readUInt16LE(93) / 10,
                    i: packet.payload.readUInt16LE(95) / 10,

                    w: parseFloat(((packet.payload.readUInt16LE(93) / 10) * (packet.payload.readUInt16LE(95) / 10)).toFixed(2)),

                    kWh_today: packet.payload.readUInt16LE(140) / 10,
                    kWh_total: packet.payload.readUInt16BE(153) / 10,
                },
                "4": {
                    v: packet.payload.readUInt16LE(97) / 10,
                    i: packet.payload.readUInt16LE(99) / 10,

                    w: parseFloat(((packet.payload.readUInt16LE(97) / 10) * (packet.payload.readUInt16LE(99) / 10)).toFixed(2)),

                    kWh_today: packet.payload.readUInt16LE(142) / 10,
                    kWh_total: packet.payload.readUInt16BE(157) / 10,
                },
            },
            grid: {
                active_power_w: packet.payload.readUInt32LE(59),

                kWh_today: packet.payload.readUInt32LE(33) / 100,
                kWh_total: packet.payload.readUInt32LE(37) / 10,

                v: packet.payload.readUInt16LE(45) / 10,
                i: packet.payload.readUInt16LE(51) / 10,

                hz: packet.payload.readUInt16LE(57) / 100,

            },
            inverter: {
                radiator_temp_celsius: packet.payload.readInt16LE(63) / 100, //TODO: is this actually a signed int?
            },
            inverter_meta: {
                rated_power_w: packet.payload.readUInt16BE(129) / 10,
                mppt_count: packet.payload.readInt8(131),
                phase_count: packet.payload.readInt8(132),

                startup_self_check_time: packet.payload.readUInt16BE(243),
                current_time: Protocol.parseTime(packet.payload.subarray(245, 251)),


                grid_freq_hz_overfreq_load_reduction_starting_point: packet.payload.readUInt16BE(223) / 100,
                grid_overfreq_load_reduction_percent: packet.payload.readUInt16BE(225),

                grid_v_limit_upper: packet.payload.readUInt16BE(235) / 10,
                grid_v_limit_lower: packet.payload.readUInt16BE(237) / 10,
                grid_freq_hz_limit_upper: packet.payload.readUInt16BE(239) / 100,
                grid_freq_hz_limit_lower: packet.payload.readUInt16BE(241) / 100,

                protocol_ver: packet.payload.subarray(101, 109).toString("ascii"),
                dc_master_fw_ver: packet.payload.subarray(109, 117).toString("ascii"),
                ac_fw_ver: packet.payload.subarray(117, 125).toString("ascii"),
            },

            //for some reason everything after byte ~120 is all BE compared to the above?

        };
    }

    static parseLoggerPacketPayload(packet) {
        //TODO: there's a lot more in this packet
        return {
            fw_ver: truncateToNullTerminator(packet.payload.subarray(19, 60).toString("ascii")),
            mac: formatMacAddress(packet.payload.subarray(59, 65)), // as in dummycloud2; null when blank
            ip: truncateToNullTerminator(packet.payload.subarray(65, 82).toString("ascii")),
            ver: truncateToNullTerminator(packet.payload.subarray(89, 130).toString("ascii")), //hw revision maybe?
            ssid: truncateToNullTerminator(packet.payload.subarray(172, 210).toString("ascii")),
        };
    }

    /**
     * A REPORT packet (type 0x48), as decoded by dummycloud2, which saw them from microinverter loggers (the LSW-3
     * hasn't sent one so far). Same fields as the start of a DATA payload, without its two schema bytes:
     * 0 version, 1-4 offset into the base time (LE), 5-8 uptime in seconds, 9-12 base time (Unix seconds),
     * 13-15 unknown status bytes.
     *
     * @param {{header: object, payload: Buffer}} packet
     * @returns {{version: number, uptime_seconds: number, clock: number|null, status: string}|null} clock in Unix
     *          seconds, null when the base time is 0; null when the payload is too short
     */
    static parseReportPacketPayload(packet) {
        const payload = packet.payload;
        if (payload.length < 16) {
            Logger.debug(`Discarded REPORT packet: payload too short (${payload.length} bytes)`);

            return null;
        }

        const base = payload.readUInt32LE(9);

        return {
            version: payload[0],
            uptime_seconds: payload.readUInt32LE(5),
            clock: base === 0 ? null : base + payload.readUInt32LE(1),
            status: payload.subarray(13, 16).toString("hex")
        };
    }

    /**
     * Builds the reply to a logger message in the format the real Solarman cloud uses
     * (captured 2026-10-23 from an LSW-3 logger, see CLAUDE.md).
     *
     * @param {{header: object, payload: Buffer}} packet
     * @param {number} replyNumber how many replies this connection has had, including this one (1, 2, 3, …)
     * @returns {Buffer}
     */
    static buildTimeResponse(packet, replyNumber) {
        const response = Buffer.alloc(23);

        // header
        response[0] = 0xa5; //magic
        response.writeUInt16LE(10, 1); //payload len
        response[3] = packet.header.unknown1;
        response[4] = packet.header.type - 0x30; // set type to response for that type
        // Sequence number: the cloud counts its replies per connection in the first byte and echoes the second
        response[5] = replyNumber & 0xff;
        response[6] = packet.header.msgIDRequest;
        response.writeUint32LE(packet.header.loggerSerial, 7);
        // end header

        response[11] = packet.payload[0];
        response[12] = 0x01;

        response.writeUint32LE(
            Math.round(Date.now()/1000),
            13
        );
        // Local timezone offset in minutes (e.g. 180 for UTC+3), as the cloud sends it. Comes from the TZ setting
        response.writeInt32LE(
            Protocol.getTimezoneOffsetMinutes(),
            17
        );


        response[response.length - 2] = Protocol.checksum(response);
        response[response.length - 1] = 0x15; //magic

        return response;
    }

    /**
     * @returns {number} minutes east of UTC for the current local time (TZ setting), e.g. 180 for UTC+3
     */
    static getTimezoneOffsetMinutes() {
        return -new Date().getTimezoneOffset() || 0; // "|| 0" turns -0 into 0
    }

    static parseTime(buf) {
        return new Date(
            [
                `${2000 + buf[0]}-${buf[1].toString().padStart(2, "0")}-${buf[2].toString().padStart(2, "0")}T`,
                `${buf[3].toString().padStart(2, "0")}:${buf[4].toString().padStart(2, "0")}:${buf[5].toString().padStart(2, "0")}Z`
            ].join("")
        );
    }
}

Protocol.MESSAGE_REQUEST_TYPES = {
    HANDSHAKE: 0x41,
    DATA: 0x42,
    WIFI: 0x43,
    HEARTBEAT: 0x47,
    REPORT: 0x48,
};

Protocol.MESSAGE_RESPONSE_TYPES = {
    HANDSHAKE: 0x11,
    DATA: 0x12,
    // wifi info reply is 0x13?
    HEARTBEAT: 0x17,
    REPORT: 0x18,
};

Protocol.DATA_PACKET_SCHEMAS = {
    HYBRIDINVERTER_SINGLEPHASE: 0x07, // e.g. SUN-5K-SG03LP1-EU; layout in HybridInverterSinglePhase.js
    MICROINVERTER: 0x08,
    HYBRIDINVERTER: 0x11,
    RELAYMODULE: 0x13
};

module.exports = Protocol;
