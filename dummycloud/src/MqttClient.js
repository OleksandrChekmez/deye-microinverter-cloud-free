const HybridInverterSinglePhaseMqtt = require("./HybridInverterSinglePhaseMqtt");
const Logger = require("./Logger");
const LoggerMqtt = require("./LoggerMqtt");
const mqtt = require("mqtt");


class MqttClient {
    /**
     *
     * @param {import("./DummyCloud")} dummyCloud
     */
    constructor(dummyCloud) {
        this.dummyCloud = dummyCloud;

        this.autoconfTimestamps = {};
        this.lastReadingTimes = {}; // by logger serial
        this.loggers = {}; // what the last handshake said about each logger, by serial (see LoggerMqtt)
        this.loggerReboots = {}; // each logger's last boot time (Unix seconds), by serial
        this.clockWarningTimes = {}; // when a wrong logger clock was last logged, by serial

        this.dummyCloud.onHandshake((data) => {
            this.handleHandshake(data);
        });
        this.dummyCloud.onData((data) => {
            this.handleData(data);
        });
    }

    initialize() {
        const options = {
            clientId: `deye_dummycloud_${Math.random().toString(16).slice(2, 9)}`,  // 23 characters allowed
        };

        if (process.env.MQTT_USERNAME) {
            options.username = process.env.MQTT_USERNAME;

            if (process.env.MQTT_PASSWORD) {
                options.password = process.env.MQTT_PASSWORD;
            }
        } else if (process.env.MQTT_PASSWORD) {
            // MQTT_PASSWORD is set but MQTT_USERNAME is not
            Logger.error("MQTT_PASSWORD is set but MQTT_USERNAME is not. MQTT_USERNAME must be set if MQTT_PASSWORD is set.");
            process.exit(1);
        }

        if (process.env.MQTT_CHECK_CERT) {
            options.rejectUnauthorized = (process.env.MQTT_CHECK_CERT !== "false");
        }

        this.client = mqtt.connect(process.env.MQTT_BROKER_URL, options);

        this.client.on("connect", () => {
            Logger.info("Connected to MQTT broker");
        });

        this.client.on("error", (e) => {
            if (e && e.message === "Not supported") {
                Logger.info("Connected to non-standard-compliant MQTT Broker.");
            } else {
                Logger.error("MQTT error:", e.toString());
            }
        });

        this.client.on("reconnect", () => {
            Logger.info("Attempting to reconnect to MQTT broker");
        });
    }

    handleHandshake(data) {
        const loggerSerial = data.header.loggerSerial.toString();
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${loggerSerial}`;
        const info = LoggerMqtt.fromHandshake(loggerSerial, data.payload, data.meta?.remoteAddress);

        if (this.loggers[loggerSerial]?.ip_address !== info.ip_address) {
            // The inverter's discovery links to the logger's IP: re-send it with the next reading
            delete this.autoconfTimestamps[loggerSerial];
        }
        this.loggers[loggerSerial] = info;

        const autoconfKey = `${loggerSerial}_logger`;
        if (this.isAutoconfDue(autoconfKey)) {
            this.publishAll(LoggerMqtt.getDiscoveryMessages(baseTopic, loggerSerial, info));
            this.autoconfTimestamps[autoconfKey] = Date.now();
        }
        this.publishAll(LoggerMqtt.getStateMessages(baseTopic, info));
    }

    /**
     * @private
     * @param {string} loggerSerial
     * @param {{remoteAddress: string}} meta
     * @returns {string} the logger's IP from its handshake, else where the connection came from
     */
    getLoggerAddress(loggerSerial, meta) {
        return this.loggers[loggerSerial]?.ip_address ?? meta.remoteAddress;
    }

    handleData(data) {
        if (data.payload.schema === "HYBRIDINVERTER_SINGLEPHASE") {
            this.handleHybridSinglePhaseData(data);

            return;
        }

        this.ensureAutoconf(data.meta, data.header.loggerSerial.toString(), data.payload.inverter_meta.mppt_count);
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${data.header.loggerSerial.toString()}`;

        for (let i = 1; i <= data.payload.inverter_meta.mppt_count; i++) {
            this.client.publish(`${baseTopic}/pv/${i}/v`, data.payload.pv[`${i}`].v.toString());
            this.client.publish(`${baseTopic}/pv/${i}/i`, data.payload.pv[`${i}`].i.toString());
            this.client.publish(`${baseTopic}/pv/${i}/w`, data.payload.pv[`${i}`].w.toString());
            this.client.publish(
                `${baseTopic}/pv/${i}/kWh_today`,
                data.payload.pv[`${i}`].kWh_today.toString(),
                {retain: true}
            );

            if (data.payload.pv[`${i}`].kWh_total > 0) {
                this.client.publish(
                    `${baseTopic}/pv/${i}/kWh_total`,
                    data.payload.pv[`${i}`].kWh_total.toString(),
                    {retain: true}
                );
            }
        }

        this.client.publish(`${baseTopic}/grid/active_power_w`, data.payload.grid.active_power_w.toString());

        this.client.publish(
            `${baseTopic}/grid/kWh_today`,
            data.payload.grid.kWh_today.toString(),
            {retain: true}
        );
        if (data.payload.grid.kWh_total > 0) {
            this.client.publish(
                `${baseTopic}/grid/kWh_total`,
                data.payload.grid.kWh_total.toString(),
                {retain: true}
            );
        }
        this.client.publish(`${baseTopic}/grid/v`, data.payload.grid.v.toString());
        this.client.publish(`${baseTopic}/grid/hz`, data.payload.grid.hz.toString());

        this.client.publish(`${baseTopic}/inverter/radiator_temperature`, data.payload.inverter.radiator_temp_celsius.toString());


        const totalDcPower = Object.values(data.payload.pv).reduce((sum, pv) => {
            return sum + pv.w;
        }, 0);
        const acPower = Math.abs(data.payload.grid.active_power_w);
        const efficiency = totalDcPower > 0 && totalDcPower > acPower ? ((acPower / totalDcPower) * 100).toFixed(2) : "null";

        this.client.publish(`${baseTopic}/inverter/efficiency`, efficiency);
    }

    handleHybridSinglePhaseData(data) {
        const loggerSerial = data.header.loggerSerial.toString();
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${loggerSerial}`;

        // Before the repeat check: a repeated reading still brings the logger's current uptime and clock
        if (data.payload.logger_status) {
            this.handleLoggerStatus(loggerSerial, baseTopic, data.payload.logger_status);
        }

        // The logger sends every reading several times; publish each one only once
        if (this.lastReadingTimes[loggerSerial] === data.payload.inverter_time) {
            Logger.debug(`Skipped repeated reading from ${data.payload.inverter_time} (logger ${loggerSerial})`);

            return;
        }
        this.lastReadingTimes[loggerSerial] = data.payload.inverter_time;

        if (this.isAutoconfDue(loggerSerial)) {
            this.publishAll(HybridInverterSinglePhaseMqtt.getDiscoveryMessages(
                baseTopic, loggerSerial, data.payload, this.getLoggerAddress(loggerSerial, data.meta)
            ));
            this.autoconfTimestamps[loggerSerial] = Date.now();
        }

        this.publishAll(HybridInverterSinglePhaseMqtt.getStateMessages(baseTopic, data.payload));
        Logger.debug(`Published reading from ${data.payload.inverter_time} (logger ${loggerSerial})`);
    }

    /**
     * Publishes the logger's uptime, last reboot and clock from the start of a DATA packet
     *
     * @private
     * @param {string} loggerSerial
     * @param {string} baseTopic
     * @param {{uptime_seconds: number, clock: number}} status
     */
    handleLoggerStatus(loggerSerial, baseTopic, status) {
        const {values, lastReboot} = LoggerMqtt.fromDataStatus(status, Date.now() / 1000, this.loggerReboots[loggerSerial]);
        this.loggerReboots[loggerSerial] = lastReboot;

        const autoconfKey = `${loggerSerial}_logger_status`;
        if (this.isAutoconfDue(autoconfKey)) {
            this.publishAll(LoggerMqtt.getDiscoveryMessages(baseTopic, loggerSerial, values));
            this.autoconfTimestamps[autoconfKey] = Date.now();
        }
        this.publishAll(LoggerMqtt.getStateMessages(baseTopic, values));

        // Its clock comes from our replies, so a large offset means the time sync isn't working (at most once an hour)
        const offset = values.clock_offset_seconds;
        if (Math.abs(offset) > LoggerMqtt.CLOCK_OFFSET_WARNING_SECONDS && !(Date.now() - (this.clockWarningTimes[loggerSerial] ?? 0) < 60 * 60 * 1000)) {
            Logger.warn(`Logger ${loggerSerial}'s clock is ${offset} s off (it says ${values.report_time}). It may not accept the time in our replies.`);
            this.clockWarningTimes[loggerSerial] = Date.now();
        }
    }

    /**
     * @private
     * @param {Array<{topic: string, message: string, retain: boolean}>} messages
     */
    publishAll(messages) {
        for (const {topic, message, retain} of messages) {
            this.client.publish(topic, message, {retain: retain});
        }
    }

    /**
     * Home Assistant discovery configs are (re-)published every 4 hours
     *
     * @private
     * @param {string} loggerSerial
     * @returns {boolean}
     */
    isAutoconfDue(loggerSerial) {
        return Date.now() - (this.autoconfTimestamps[loggerSerial] ?? 0) > 4 * 60 * 60 * 1000;
    }

    ensureAutoconf(meta, loggerSerial, mpptCount) {
        if (!this.isAutoconfDue(loggerSerial)) {
            return;
        }
        const baseTopic = `${MqttClient.TOPIC_PREFIX}/${loggerSerial.toString()}`;
        const device = {
            "manufacturer":"Deye",
            "model":"Microinverter",
            "name":`Deye Microinverter ${loggerSerial}`,
            "configuration_url": `http://${this.getLoggerAddress(loggerSerial, meta)}/index_cn.html`,
            "identifiers":[
                `deye_dummycloud_${loggerSerial}`
            ]
        };

        for (let i = 1; i <= mpptCount; i++) {
            this.client.publish(
                `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_pv${i}_v/config`,
                JSON.stringify({
                    "state_topic": `${baseTopic}/pv/${i}/v`,
                    "name":`PV ${i} Voltage`,
                    "unit_of_measurement": "V",
                    "device_class": "voltage",
                    "state_class": "measurement",
                    "object_id": `deye_dummycloud_${loggerSerial}_pv_${i}_v`,
                    "unique_id": `deye_dummycloud_${loggerSerial}_pv_${i}_v`,
                    "expire_after": 360,
                    "enabled_by_default": i < 3,
                    "device": device
                }),
                {retain: true}
            );
            this.client.publish(
                `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_pv${i}_i/config`,
                JSON.stringify({
                    "state_topic": `${baseTopic}/pv/${i}/i`,
                    "name":`PV ${i} Current`,
                    "unit_of_measurement": "A",
                    "device_class": "current",
                    "state_class": "measurement",
                    "object_id": `deye_dummycloud_${loggerSerial}_pv_${i}_i`,
                    "unique_id": `deye_dummycloud_${loggerSerial}_pv_${i}_i`,
                    "expire_after": 360,
                    "enabled_by_default": i < 3,
                    "device": device
                }),
                {retain: true}
            );
            this.client.publish(
                `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_pv${i}_w/config`,
                JSON.stringify({
                    "state_topic": `${baseTopic}/pv/${i}/w`,
                    "name":`PV ${i} Power`,
                    "unit_of_measurement": "W",
                    "device_class": "power",
                    "state_class": "measurement",
                    "object_id": `deye_dummycloud_${loggerSerial}_pv_${i}_w`,
                    "unique_id": `deye_dummycloud_${loggerSerial}_pv_${i}_w`,
                    "expire_after": 360,
                    "enabled_by_default": i < 3,
                    "device": device
                }),
                {retain: true}
            );

            this.client.publish(
                `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_pv${i}_kWh_today/config`,
                JSON.stringify({
                    "state_topic": `${baseTopic}/pv/${i}/kWh_today`,
                    "name":`PV ${i} Energy Today`,
                    "unit_of_measurement": "kWh",
                    "device_class": "energy",
                    "state_class": "total_increasing",
                    "object_id": `deye_dummycloud_${loggerSerial}_pv_${i}_kWh_today`,
                    "unique_id": `deye_dummycloud_${loggerSerial}_pv_${i}_kWh_today`,
                    "enabled_by_default": i < 3,
                    "device": device
                }),
                {retain: true}
            );
            this.client.publish(
                `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_pv${i}_kWh_total/config`,
                JSON.stringify({
                    "state_topic": `${baseTopic}/pv/${i}/kWh_total`,
                    "name":`PV ${i} Energy Total`,
                    "unit_of_measurement": "kWh",
                    "device_class": "energy",
                    "state_class": "total_increasing",
                    "object_id": `deye_dummycloud_${loggerSerial}_pv_${i}_kWh_total`,
                    "unique_id": `deye_dummycloud_${loggerSerial}_pv_${i}_kWh_total`,
                    "enabled_by_default": i < 3,
                    "device": device
                }),
                {retain: true}
            );
        }


        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_grid_active_power_w/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/grid/active_power_w`,
                "name":"Grid Power (Active)",
                "unit_of_measurement": "W",
                "device_class": "power",
                "state_class": "measurement",
                "object_id": `deye_dummycloud_${loggerSerial}_grid_active_power_w`,
                "unique_id": `deye_dummycloud_${loggerSerial}_grid_active_power_w`,
                "expire_after": 360,
                "device": device
            }),
            {retain: true}
        );
        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_grid_kWh_today/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/grid/kWh_today`,
                "name":"Grid Energy Today",
                "unit_of_measurement": "kWh",
                "device_class": "energy",
                "state_class": "total_increasing",
                "object_id": `deye_dummycloud_${loggerSerial}_grid_energy_today`,
                "unique_id": `deye_dummycloud_${loggerSerial}_grid_energy_today`,
                "device": device
            }),
            {retain: true}
        );
        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_grid_kWh_total/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/grid/kWh_total`,
                "name":"Grid Energy Total",
                "unit_of_measurement": "kWh",
                "device_class": "energy",
                "state_class": "total_increasing",
                "object_id": `deye_dummycloud_${loggerSerial}_grid_energy_total`,
                "unique_id": `deye_dummycloud_${loggerSerial}_grid_energy_total`,
                "device": device
            }),
            {retain: true}
        );
        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_grid_v/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/grid/v`,
                "name":"Grid Voltage",
                "unit_of_measurement": "V",
                "device_class": "voltage",
                "state_class": "measurement",
                "object_id": `deye_dummycloud_${loggerSerial}_grid_v`,
                "unique_id": `deye_dummycloud_${loggerSerial}_grid_v`,
                "expire_after": 360,
                "device": device
            }),
            {retain: true}
        );
        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_grid_hz/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/grid/hz`,
                "name":"Grid Frequency",
                "unit_of_measurement": "Hz",
                "device_class": "frequency",
                "state_class": "measurement",
                "object_id": `deye_dummycloud_${loggerSerial}_grid_hz`,
                "unique_id": `deye_dummycloud_${loggerSerial}_grid_hz`,
                "expire_after": 360,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_inverter_radiator_temperature/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/inverter/radiator_temperature`,
                "name":"Radiator Temperature",
                "unit_of_measurement": "°C",
                "device_class": "temperature",
                "state_class": "measurement",
                "object_id": `deye_dummycloud_${loggerSerial}_inverter_radiator_temperature`,
                "unique_id": `deye_dummycloud_${loggerSerial}_inverter_radiator_temperature`,
                "expire_after": 360,
                "device": device
            }),
            {retain: true}
        );

        this.client.publish(
            `homeassistant/sensor/deye_dummycloud_${loggerSerial}/${loggerSerial}_inverter_efficiency/config`,
            JSON.stringify({
                "state_topic": `${baseTopic}/inverter/efficiency`,
                "name":"Inverter Efficiency",
                "unit_of_measurement": "%",
                "entity_category": "diagnostic",
                "icon": "mdi:cog-transfer",
                "state_class": "measurement",
                "object_id": `deye_dummycloud_${loggerSerial}_inverter_efficiency`,
                "unique_id": `deye_dummycloud_${loggerSerial}_inverter_efficiency`,
                "expire_after": 360,
                "value_template": "{{ value_json }}",
                "device": device
            }),
            {retain: true}
        );

        this.autoconfTimestamps[loggerSerial] = Date.now();
    }
}

MqttClient.TOPIC_PREFIX = "deye-dummycloud";

module.exports = MqttClient;
