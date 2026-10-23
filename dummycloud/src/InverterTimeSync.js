const Logger = require("./Logger");
const LoggerModbus = require("./LoggerModbus");

// Deye hybrid inverters keep their local time in holding registers 22-24 (as in ha-solarman's deye_hybrid.yaml):
// (year - 2000) << 8 | month, day << 8 | hour, minute << 8 | second
const TIME_REGISTER = 22;
const MAX_OFFSET_SECONDS = 30;
// After an attempt (successful or not), wait this long before the next one
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
// Don't touch the clock this close to midnight (real or inverter time), when the inverter resets its daily counters
const MIDNIGHT_GUARD_MINUTES = 15;

/**
 * Keeps a single-phase hybrid inverter's clock right. The time in our replies only reaches the logger; the inverter's
 * own clock drifts (about 11 minutes behind on 2026-10-23). Each new reading's timestamp is compared with the logger's
 * clock. When they differ by more than 30 s, the inverter's clock is read through the logger's port 8899 to confirm,
 * and set to the current local time (TZ). Enabled with INVERTER_TIME_SYNC=true.
 */
class InverterTimeSync {
    /**
     * @param {import("./DummyCloud")} dummyCloud
     * @param {object} [options] for tests
     * @param {Function} [options.createModbus] (host, loggerSerial) => LoggerModbus
     */
    constructor(dummyCloud, options = {}) {
        this.createModbus = options.createModbus ?? ((host, loggerSerial) => {
            return new LoggerModbus(host, loggerSerial);
        });

        this.loggerAddresses = {}; // the logger's IP from its handshake, by serial
        this.lastReadingTimes = {}; // to check each reading once (the logger repeats them)
        this.lastAttempts = {}; // Date.now() of the last read/write attempt, by serial
        this.running = {}; // by serial

        dummyCloud.onHandshake((data) => {
            this.handleHandshake(data);
        });
        dummyCloud.onData((data) => {
            this.handleData(data);
        });
    }

    initialize() {
        if (!process.env.TZ) {
            Logger.warn("INVERTER_TIME_SYNC needs TZ (e.g. Europe/Berlin) to know the local time; not syncing the inverter's clock");
            this.disabled = true;

            return;
        }
        Logger.info(`Keeping hybrid inverters' clocks within ${MAX_OFFSET_SECONDS} s of the local time (TZ=${process.env.TZ})`);
    }

    /**
     * @param {{header: object, payload: {ip: string}}} data
     */
    handleHandshake(data) {
        const ip = (data.payload.ip ?? "").trim();
        if (ip) {
            // Not the connection's address: in Docker that's the gateway, and port 8899 is on the logger
            this.loggerAddresses[data.header.loggerSerial.toString()] = ip;
        }
    }

    /**
     * @param {{header: object, payload: object}} data
     * @returns {Promise<void>} resolves when a sync it started is done (for tests)
     */
    async handleData(data) {
        if (this.disabled || data.payload.schema !== "HYBRIDINVERTER_SINGLEPHASE" || !data.payload.logger_status) {
            return;
        }

        const loggerSerial = data.header.loggerSerial.toString();
        if (this.lastReadingTimes[loggerSerial] === data.payload.inverter_time) {
            return; // a repeat: its timestamp is older than the packet
        }
        this.lastReadingTimes[loggerSerial] = data.payload.inverter_time;

        // Only an estimate: the reading is a few seconds older than the packet that carries it
        const estimate = parseLocalTime(data.payload.inverter_time) - data.payload.logger_status.clock;
        if (Math.abs(estimate) <= MAX_OFFSET_SECONDS) {
            return;
        }

        Logger.debug(`Inverter clock of logger ${loggerSerial} looks ${describeOffset(estimate)}; checking`);
        try {
            await this.sync(loggerSerial);
        } catch (e) {
            Logger.warn(`Couldn't sync the inverter clock through logger ${loggerSerial}: ${e.message}`);
        }
    }

    /**
     * @private
     * @param {string} loggerSerial
     * @returns {Promise<void>}
     */
    async sync(loggerSerial) {
        if (this.running[loggerSerial] || Date.now() - (this.lastAttempts[loggerSerial] ?? 0) < RETRY_INTERVAL_MS) {
            return;
        }
        if (isNearMidnight(new Date(Date.now()))) {
            Logger.debug("Not syncing the inverter clock near midnight");

            return;
        }
        const host = this.loggerAddresses[loggerSerial];
        if (!host) {
            Logger.debug(`Not syncing the inverter clock: no IP for logger ${loggerSerial} yet (it comes with the handshake)`);

            return;
        }

        this.running[loggerSerial] = true;
        this.lastAttempts[loggerSerial] = Date.now();
        try {
            await this.readAndSet(loggerSerial, this.createModbus(host, Number(loggerSerial)));
        } finally {
            this.running[loggerSerial] = false;
        }
    }

    /**
     * @private
     * @param {string} loggerSerial
     * @param {LoggerModbus} modbus
     * @returns {Promise<void>}
     */
    async readAndSet(loggerSerial, modbus) {
        const before = decodeTime(await modbus.readHoldingRegisters(TIME_REGISTER, 3));
        const offset = Math.round(before.getTime() / 1000 - Date.now() / 1000);
        if (Math.abs(offset) <= MAX_OFFSET_SECONDS) {
            Logger.info(`Inverter clock is ${describeOffset(offset)}, close enough`);

            return;
        }
        if (isNearMidnight(before)) {
            Logger.info("Not syncing the inverter clock near the inverter's midnight");

            return;
        }

        const now = new Date(Date.now());
        await modbus.writeMultipleRegisters(TIME_REGISTER, encodeTime(now));
        const after = decodeTime(await modbus.readHoldingRegisters(TIME_REGISTER, 3));
        const remaining = Math.round(after.getTime() / 1000 - Date.now() / 1000);

        Logger.info(
            `Set the inverter clock (logger ${loggerSerial}) from ${formatLocalTime(before)} to ${formatLocalTime(now)}: ` +
            `it was ${describeOffset(offset)}, now ${describeOffset(remaining)}`
        );
    }
}

/**
 * @param {Date} date
 * @returns {Array<number>} registers 22-24 for this local time
 */
function encodeTime(date) {
    return [
        ((date.getFullYear() - 2000) << 8) | (date.getMonth() + 1),
        (date.getDate() << 8) | date.getHours(),
        (date.getMinutes() << 8) | date.getSeconds()
    ];
}

/**
 * @param {Array<number>} registers 22-24
 * @returns {Date} that local time
 */
function decodeTime(registers) {
    const [ym, dh, ms] = registers;
    const date = new Date(2000 + (ym >> 8), (ym & 0xff) - 1, dh >> 8, dh & 0xff, ms >> 8, ms & 0xff);
    if (isNaN(date.getTime()) || (ym & 0xff) < 1 || (ym & 0xff) > 12) {
        throw new Error(`Registers ${registers.join(", ")} aren't a time`);
    }

    return date;
}

/**
 * @param {string} text "YYYY-MM-DD hh:mm:ss" local time, as in HybridInverterSinglePhase.parse()
 * @returns {number} Unix seconds
 */
function parseLocalTime(text) {
    const [y, mo, d, h, mi, s] = text.split(/[- :]/).map(Number);

    return new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
}

/**
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD hh:mm:ss" local time
 */
function formatLocalTime(date) {
    const pad = n => {
        return String(n).padStart(2, "0");
    };

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * @param {Date} date
 * @returns {boolean} within MIDNIGHT_GUARD_MINUTES of a local midnight
 */
function isNearMidnight(date) {
    const minutes = date.getHours() * 60 + date.getMinutes();

    return minutes < MIDNIGHT_GUARD_MINUTES || minutes >= 24 * 60 - MIDNIGHT_GUARD_MINUTES;
}

/**
 * @param {number} seconds inverter minus real time
 * @returns {string} e.g. "634 s behind"
 */
function describeOffset(seconds) {
    if (seconds === 0) {
        return "exact";
    }

    return `${Math.abs(seconds)} s ${seconds < 0 ? "behind" : "ahead"}`;
}

InverterTimeSync.MAX_OFFSET_SECONDS = MAX_OFFSET_SECONDS;
InverterTimeSync.decodeTime = decodeTime;
InverterTimeSync.encodeTime = encodeTime;

module.exports = InverterTimeSync;
