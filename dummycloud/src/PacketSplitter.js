const HEADER_LEN = 11;
const FOOTER_LEN = 2;
const START_MAGIC = 0xa5;
const END_MAGIC = 0x15;
// Logger packets are at most about 1 KB (a hybrid inverter's DATA packet is 1026 bytes)
const MAX_PACKET_LEN = 4096;

/**
 * Splits a TCP byte stream into V5 packets. TCP doesn't keep message boundaries, so one read can hold part of a
 * packet or several packets. Bytes that can't start a packet are skipped until the next start byte.
 */
class PacketSplitter {
    constructor() {
        this.buffer = Buffer.alloc(0);
    }

    /**
     * @param {Buffer} chunk bytes as received
     * @returns {{packets: Array<Buffer>, discarded: Array<Buffer>}} the complete packets, and any bytes skipped
     */
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const packets = [];
        const discarded = [];

        while (this.buffer.length > 0) {
            if (this.buffer[0] !== START_MAGIC) {
                this.skipToNextStart(discarded);
                continue;
            }
            if (this.buffer.length < 3) {
                break;
            }

            const packetLength = this.buffer.readUInt16LE(1) + HEADER_LEN + FOOTER_LEN;
            if (packetLength > MAX_PACKET_LEN) {
                this.skipToNextStart(discarded); // a stray 0xa5, not a real header
                continue;
            }
            if (this.buffer.length < packetLength) {
                break; // wait for the rest
            }
            if (this.buffer[packetLength - 1] !== END_MAGIC) {
                this.skipToNextStart(discarded);
                continue;
            }

            packets.push(this.buffer.subarray(0, packetLength));
            this.buffer = this.buffer.subarray(packetLength);
        }

        return {packets: packets, discarded: discarded};
    }

    /**
     * Drops the first byte and everything up to the next start byte
     *
     * @private
     * @param {Array<Buffer>} discarded
     */
    skipToNextStart(discarded) {
        let next = this.buffer.indexOf(START_MAGIC, 1);
        if (next === -1) {
            next = this.buffer.length;
        }

        discarded.push(this.buffer.subarray(0, next));
        this.buffer = this.buffer.subarray(next);
    }
}

module.exports = PacketSplitter;
