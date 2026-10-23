const DummyCloud = require("./src/DummyCloud");
const HomeAssistantApp = require("./src/HomeAssistantApp");
const Logger = require("./src/Logger");
const MqttClient = require("./src/MqttClient");

async function main() {
    // As a Home Assistant app, settings come from the app's configuration instead of environment variables
    await HomeAssistantApp.configure();

    if (process.env.LOGLEVEL) {
        Logger.setLogLevel(process.env.LOGLEVEL);
    }

    const dummyCloud = new DummyCloud();
    const mqttClient = new MqttClient(dummyCloud);

    dummyCloud.initialize();
    mqttClient.initialize();
}

main().catch(err => {
    Logger.error("Failed to start", err);
    process.exit(1);
});
