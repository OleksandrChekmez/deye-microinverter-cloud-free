const fs = require("fs");
const Logger = require("./Logger");

/**
 * Support for running as a Home Assistant app.
 *
 * Home Assistant saves the settings from the app's UI to /data/options.json. This turns them into the
 * environment variables the rest of the code reads, so the Docker/Compose setup keeps working unchanged.
 */
class HomeAssistantApp {
    /**
     * Applies the app's options to the environment. Does nothing outside Home Assistant (no options file).
     *
     * @param {object} [env] environment to update
     * @param {string} [optionsPath]
     * @param {Function} [fetchFn] for tests
     * @returns {Promise<boolean>} true when running as a Home Assistant app
     */
    static async configure(env = process.env, optionsPath = HomeAssistantApp.OPTIONS_PATH, fetchFn = fetch) {
        if (!fs.existsSync(optionsPath)) {
            return false;
        }

        const options = JSON.parse(fs.readFileSync(optionsPath, "utf8"));
        let mqttService = null;

        if (!options.mqtt_broker_url) {
            mqttService = await HomeAssistantApp.fetchMqttService(env.SUPERVISOR_TOKEN, fetchFn);
        }

        Object.assign(env, HomeAssistantApp.optionsToEnv(options, mqttService));
        Logger.info(`Running as a Home Assistant app, MQTT broker: ${env.MQTT_BROKER_URL}`);

        return true;
    }

    /**
     * @param {object} options parsed /data/options.json
     * @param {object|null} mqttService the broker Home Assistant provides (Mosquitto app), or null
     * @returns {object} environment variables to set
     */
    static optionsToEnv(options, mqttService) {
        const env = {};

        if (options.log_level) {
            env.LOGLEVEL = options.log_level;
        }

        if (options.mqtt_broker_url) {
            env.MQTT_BROKER_URL = options.mqtt_broker_url;
            if (options.mqtt_username) {
                env.MQTT_USERNAME = options.mqtt_username;
            }
            if (options.mqtt_password) {
                env.MQTT_PASSWORD = options.mqtt_password;
            }
        } else if (mqttService) {
            env.MQTT_BROKER_URL = `${mqttService.ssl ? "mqtts" : "mqtt"}://${mqttService.host}:${mqttService.port}`;
            if (mqttService.username) {
                env.MQTT_USERNAME = mqttService.username;
            }
            if (mqttService.password) {
                env.MQTT_PASSWORD = mqttService.password;
            }
        } else {
            throw new Error("No MQTT broker: install the Mosquitto app, or set the MQTT broker URL in the app's configuration");
        }

        if (options.mqtt_check_cert === false) {
            env.MQTT_CHECK_CERT = "false";
        }
        if (options.capture_packets) {
            env.CAPTURE_DIR = HomeAssistantApp.CAPTURE_DIR;
        }
        if (options.forward_to) {
            env.FORWARD_TO = options.forward_to;
        }

        return env;
    }

    /**
     * Asks the Supervisor for the MQTT broker that Home Assistant provides (the Mosquitto app).
     *
     * @param {string} token SUPERVISOR_TOKEN
     * @param {Function} fetchFn
     * @returns {Promise<object|null>} {host, port, ssl, username, password}, or null if there is none
     */
    static async fetchMqttService(token, fetchFn) {
        if (!token) {
            Logger.warn("No SUPERVISOR_TOKEN, can't ask Home Assistant for the MQTT broker");
            return null;
        }

        try {
            const res = await fetchFn("http://supervisor/services/mqtt", {
                headers: {Authorization: `Bearer ${token}`}
            });
            if (!res.ok) {
                Logger.warn(`Home Assistant provides no MQTT broker (HTTP ${res.status})`);
                return null;
            }

            const body = await res.json();
            return body.data ?? null;
        } catch (e) {
            Logger.warn("Failed to ask Home Assistant for the MQTT broker", e);
            return null;
        }
    }
}

HomeAssistantApp.OPTIONS_PATH = "/data/options.json";
// In Home Assistant's "share" folder, reachable with the Samba share app
HomeAssistantApp.CAPTURE_DIR = "/share/deye-dummycloud/captures";

module.exports = HomeAssistantApp;
