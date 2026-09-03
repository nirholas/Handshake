# The three.ws Home Assistant voice satellite.
#
# Two roles, one image, chosen by the command:
#
#   satellite   runs on the user's own network, beside Home Assistant. It
#               listens for Wyoming on TCP 10700, serves viewers on 10701, and
#               dials out to a hub so a browser on https://three.ws can watch.
#               This is what a person runs at home.
#
#   hub         runs on Cloud Run and joins satellites to browsers. Stateless,
#               holds no database and no Home Assistant credential.
#
# The image is deliberately small and dependency-light: one runtime dependency
# (`ws`), no build step, no native modules. It runs on the same box as somebody's
# home automation, and a voice satellite that needs half a gigabyte of node
# modules to sit idle is a bad neighbour.
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
# Where the claimed identity is written. Mount a volume here, or the satellite
# has to be paired again on every restart.
ENV SATELLITE_STATE_DIR=/data
VOLUME ["/data"]

# Wyoming (Home Assistant connects in) and the viewer server (browsers on this
# network connect in). Neither needs to be reachable from the internet.
EXPOSE 10700 10701

CMD ["node", "src/index.js", "satellite"]
