FROM node:lts-alpine

WORKDIR /app
ENV LOGLEVEL="info"
ENV MQTT_BROKER_URL="mqtt://127.0.0.1"

COPY package.json /app
COPY package-lock.json /app

# Only what the app needs to run: no ESLint (about 22 MB), and no npm download cache
RUN npm ci --omit=dev && npm cache clean --force
COPY . /app

CMD ["npm", "start"]