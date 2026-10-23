# Plain Alpine with Alpine's own Node.js package (Node.js 24 in 3.24): much smaller than the official node image
FROM alpine:3.24

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

RUN apk add --no-cache nodejs

WORKDIR /app
ENV LOGLEVEL="info"
ENV MQTT_BROKER_URL="mqtt://127.0.0.1"

COPY package.json /app
COPY package-lock.json /app

# Only what the app needs to run: no ESLint, no npm download cache, and npm itself is removed again after the install
RUN apk add --no-cache --virtual .install npm \
    && npm ci --omit=dev \
    && apk del .install \
    && rm -rf /root/.npm
COPY . /app

CMD ["node", "app.js"]
