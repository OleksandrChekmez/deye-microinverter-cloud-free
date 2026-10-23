FROM node:lts-alpine

# Set by the GitHub workflow that publishes the Home Assistant app's images; the defaults are for local builds
ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64

# Home Assistant reads the app's version and architecture from these labels
LABEL \
    io.hass.name="Deye Dummycloud" \
    io.hass.description="Replaces the Solarman cloud for Deye inverter loggers and publishes their data to MQTT" \
    io.hass.type="app" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}"

WORKDIR /app
ENV LOGLEVEL="info"
ENV MQTT_BROKER_URL="mqtt://127.0.0.1"

COPY package.json /app
COPY package-lock.json /app

# Only what the app needs to run: no ESLint (about 22 MB), and no npm download cache
RUN npm ci --omit=dev && npm cache clean --force
COPY . /app

CMD ["npm", "start"]
