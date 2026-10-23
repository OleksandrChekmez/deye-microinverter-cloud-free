const assert = require("node:assert/strict");
const fs = require("node:fs");
const HomeAssistantApp = require("../src/HomeAssistantApp");
const os = require("node:os");
const path = require("node:path");
const {describe, it} = require("node:test");

const MOSQUITTO = {host: "core-mosquitto", port: 1883, ssl: false, username: "addons", password: "secret", protocol: "3.1.1"};

/**
 * @param {object} options
 * @returns {string} path of a temporary options.json
 */
function writeOptions(options) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dummycloud-"));
    const file = path.join(dir, "options.json");
    fs.writeFileSync(file, JSON.stringify(options));
    return file;
}

/**
 * @param {number} status
 * @param {object} body
 * @returns {{fetchFn: Function, calls: Array}} a fake fetch that records its calls
 */
function fakeFetch(status, body) {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push({url, init});
        return {ok: status === 200, status, json: async () => {
            return body;
        }};
    };
    return {fetchFn, calls};
}

describe("HomeAssistantApp", () => {
    it("does nothing outside Home Assistant", async () => {
        const env = {MQTT_BROKER_URL: "mqtt://nas"};
        const result = await HomeAssistantApp.configure(env, path.join(os.tmpdir(), "no-such-dir", "options.json"));

        assert.equal(result, false);
        assert.deepEqual(env, {MQTT_BROKER_URL: "mqtt://nas"});
    });

    it("uses the Mosquitto app when no broker URL is set", async () => {
        const env = {SUPERVISOR_TOKEN: "token", MQTT_BROKER_URL: "mqtt://127.0.0.1"};
        const {fetchFn, calls} = fakeFetch(200, {result: "ok", data: MOSQUITTO});
        const file = writeOptions({log_level: "info", mqtt_check_cert: true, capture_packets: false});

        assert.equal(await HomeAssistantApp.configure(env, file, fetchFn), true);
        assert.equal(calls[0].url, "http://supervisor/services/mqtt");
        assert.equal(calls[0].init.headers.Authorization, "Bearer token");
        assert.equal(env.MQTT_BROKER_URL, "mqtt://core-mosquitto:1883");
        assert.equal(env.MQTT_USERNAME, "addons");
        assert.equal(env.MQTT_PASSWORD, "secret");
        assert.equal(env.LOGLEVEL, "info");
        assert.equal(env.MQTT_CHECK_CERT, undefined);
        assert.equal(env.CAPTURE_DIR, undefined);
        assert.equal(env.FORWARD_TO, undefined);
    });

    it("prefers a broker URL from the options and doesn't ask the Supervisor", async () => {
        const env = {SUPERVISOR_TOKEN: "token"};
        const {fetchFn, calls} = fakeFetch(200, {result: "ok", data: MOSQUITTO});
        const file = writeOptions({
            log_level: "debug",
            mqtt_broker_url: "mqtts://192.168.0.124:8883",
            mqtt_username: "mqtt",
            mqtt_password: "pw",
            mqtt_check_cert: false,
            capture_packets: true,
            forward_to: "access1.solarmanpv.com:10000"
        });

        await HomeAssistantApp.configure(env, file, fetchFn);

        assert.equal(calls.length, 0);
        assert.deepEqual(env, {
            SUPERVISOR_TOKEN: "token",
            LOGLEVEL: "debug",
            MQTT_BROKER_URL: "mqtts://192.168.0.124:8883",
            MQTT_USERNAME: "mqtt",
            MQTT_PASSWORD: "pw",
            MQTT_CHECK_CERT: "false",
            CAPTURE_DIR: "/share/deye-dummycloud/captures",
            FORWARD_TO: "access1.solarmanpv.com:10000"
        });
    });

    it("fails with a clear message when there is no broker at all", async () => {
        const {fetchFn} = fakeFetch(400, {result: "error", message: "Service not available"});
        const file = writeOptions({log_level: "info"});

        await assert.rejects(HomeAssistantApp.configure({SUPERVISOR_TOKEN: "token"}, file, fetchFn), /install the Mosquitto app/);
    });

    it("uses mqtts for a broker with TLS", () => {
        const env = HomeAssistantApp.optionsToEnv({}, {...MOSQUITTO, ssl: true, port: 8883});

        assert.equal(env.MQTT_BROKER_URL, "mqtts://core-mosquitto:8883");
    });

    it("has the same version in config.yaml as in package.json", () => {
        const configYaml = fs.readFileSync(path.join(__dirname, "..", "config.yaml"), "utf8");
        const version = configYaml.match(/^version: "(.+)"$/m)?.[1];

        assert.equal(version, require("../package.json").version);
    });
});
