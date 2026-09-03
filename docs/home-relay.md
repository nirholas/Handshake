# Connecting a home that is only on your network

Most Home Assistant installs cannot be reached from the internet. They live on a LAN behind a
router, with no port forwarded and no public address, and three.ws runs on the public internet, so
there is no address for us to dial. That is not a minority case: it is the default install.

This page is how those houses connect anyway. **The house dials three.ws, and three.ws never
dials the house.**

If your Home Assistant already has a remote https address (Home Assistant Cloud, or your own
reverse proxy), you do not need any of this. Connect it at [three.ws/smart-home](https://three.ws/smart-home)
with a long-lived access token and you are done.

---

## For someone with a house

### What gets installed

One Home Assistant integration, from [HACS](https://hacs.xyz). It opens a single outgoing
WebSocket to three.ws and keeps it open.

- Nothing listens on your network.
- No port is forwarded, and no firewall rule changes.
- No tunnel daemon, no third-party service, no account anywhere else.
- **three.ws never receives a Home Assistant token.** The integration signs in to Home Assistant
  on your own machine with a credential it creates for itself, which never leaves the house.

### Installing it

1. In three.ws, open [/smart-home](https://three.ws/smart-home), choose **Connect a home that is
   only on my network**, and press **show me a code**. Leave that tab open: it has a ten-minute
   countdown on it.
2. In Home Assistant, open HACS, then **Custom repositories**. Add
   `https://github.com/nirholas/three-ws-home-assistant`, category **Integration**.
3. Install **three.ws** and restart Home Assistant.
4. **Settings, Devices and services, Add integration, three.ws.** Paste the pairing code.

The three.ws tab flips to connected on its own within a few seconds. From there the house behaves
exactly like any other connected home: the same rooms, the same scenes, and the same rule that
unlocking, opening and disarming always stop and ask a person first.

To install without HACS, download the latest release, copy `custom_components/three_ws` into your
Home Assistant `config` folder, restart, and do step 4.

### What it can and cannot do

Read [the threat model](home-relay-threat-model.md). It is written for someone deciding whether to
install this, and it is specific about the blast radius rather than reassuring.

The short version: three.ws can read your entities and your room layout, and it can call device
services, including ones that unlock doors after you approve them. It cannot run anything on the
machine Home Assistant lives on, cannot restart or reconfigure your instance, cannot reach
anything else on your network, and holds no credential that would open your house if we were
breached.

### Disconnecting

Either end works, and either end is immediate:

- **In three.ws:** disconnect the home. The house's outbound socket is dropped at the relay in the
  same request, and it is refused if it tries to dial back in.
- **In Home Assistant:** delete the three.ws integration. Its socket closes, and it deletes the
  local credential it made for itself.

### When it says the home is not answering

That means the integration is not currently dialled in, which almost always means Home Assistant
is restarting or the machine is off. There is nothing to re-pair. It dials back in on its own,
measured at about ten seconds after Home Assistant finishes starting.

The integration also exposes a `binary_sensor` inside Home Assistant, so you can see the state of
the link from your own dashboard: connected or not, with the last error and the number of refused
messages as attributes.

---

## For someone running three.ws

### The pieces

| Piece | Path | What it is |
|---|---|---|
| The protocol | [`services/home-relay/src/protocol.js`](../services/home-relay/src/protocol.js) | Pure. Framing, versioning, and the allowlist. The security core. |
| The relay | [`services/home-relay/`](../services/home-relay) | A Cloud Run service that terminates dial-out sockets and multiplexes sessions onto them. No database. |
| The transport | [`packages/home-bridge/src/transport-relay.js`](../packages/home-bridge/src/transport-relay.js) | A `createSocket` for `home-assistant-js-websocket`, so `HomeBridge` reaches a relayed house with no other change. |
| The platform half | [`api/_lib/home/relay.js`](../api/_lib/home/relay.js) | Pairing, transport construction, revocation. |
| The endpoints | [`api/home/pair.js`](../api/home/pair.js), [`api/home/pair/redeem.js`](../api/home/pair/redeem.js) | Minting a code, and the one unauthenticated route in the home surface. |
| The UI | [`src/home/pair.js`](../src/home/pair.js) | Seven states, from "not installed" to "revoked". |
| The integration | [`home-assistant-integration/`](../home-assistant-integration) | The Python that runs inside the house. Published as its own public repository. |

### Configuration

Three variables, all required together. `isRelayConfigured()` is false unless all three are
present and the two secrets are at least 32 characters, and the connect UI then says the relay is
unavailable rather than minting a code nobody could redeem.

| Variable | Where | What |
|---|---|---|
| `HOME_RELAY_URL` | API | The relay's public address, e.g. `wss://home-relay.three.ws` |
| `HOME_RELAY_SERVICE_TOKEN` | API and relay | How the platform authenticates to the relay |
| `HOME_RELAY_SIGNING_KEY` | API and relay | HMAC key for install tokens. Rotating it un-pairs every house. |

Generate them once:

```bash
node -e "console.log('HOME_RELAY_SERVICE_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('HOME_RELAY_SIGNING_KEY='   + require('crypto').randomBytes(32).toString('hex'))"
```

Both belong in Secret Manager, per the runbook in
[`docs/ops/gcp-production.md`](ops/gcp-production.md), never as env literals.

### Deploying the relay

```bash
gcloud builds submit --config services/home-relay/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

Two settings in that config are load-bearing and must not be "tidied":

- `--no-cpu-throttling` and `--min-instances=1`. The relay holds sockets between requests. A
  throttled or scaled-to-zero instance drops every connected house into a reconnect loop.
- `--allow-unauthenticated`. Houses dial in from the public internet carrying their own bearer
  token, and the relay authenticates every single connection itself. IAM auth would make the whole
  feature impossible, not safer.

### Its own endpoints

| Route | Auth | What |
|---|---|---|
| `GET /healthz` | none | Liveness, plus install and session counts |
| `GET /v1/status` | service token | Every install, or one with `?relay_id=` |
| `POST /v1/revoke` | service token | Drop a house's socket now and deny the relay id |
| `POST /v1/unrevoke` | service token | Undo the above |
| `wss /v1/agent` | install token | A house dialling in |
| `wss /v1/bridge?relay_id=` | service token | The platform opening a session |

### Changing the allowlist

The rules live in `protocol.js` and nowhere else. The relay imports them; the integration reads a
generated copy. After any change:

```bash
node services/home-relay/scripts/gen-allowlist.mjs
cp services/home-relay/allowlist.json \
   home-assistant-integration/custom_components/three_ws/allowlist.json
npx vitest run tests/home-relay-protocol.test.js
```

The last command fails if the generated file or the integration's copy is stale, which is how the
two enforcement points are kept from drifting apart.

### Verifying it against a real house on an unroutable network

A test that reaches Home Assistant on localhost proves nothing about a relay. Build two networks
Docker will not route between, put the house on one and the caller on the other:

```bash
docker network create house-net
docker network create cloud-net

# The house. No published port: nothing on the outside can reach it.
mkdir -p .ha-relay-config
docker run -d --name threews-ha-relay --network house-net \
  --add-host relay.host:host-gateway \
  -v "$PWD/.ha-relay-config:/config" ghcr.io/home-assistant/home-assistant:stable
printf '\ndemo:\n' >> .ha-relay-config/configuration.yaml && docker restart threews-ha-relay

# The relay, on the host, which both networks reach through host-gateway, the
# same way a real house reaches a public service through its own NAT.
HOME_RELAY_SIGNING_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
HOME_RELAY_SERVICE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
PORT=8899 node services/home-relay/src/index.js

# Install the integration into that instance, pair it through /api/home/pair,
# then run the proof from cloud-net, which has no route to house-net at all:
docker run --rm --network cloud-net --add-host relay.host:host-gateway \
  -v "$PWD:/app" -w /app node:24-slim \
  node scripts/home-relay-e2e.mjs \
    --relay ws://relay.host:8899 --relay-id <id> --service-token <token> \
    --unroutable http://<the house's container ip>:8123
```

The script refuses to report success if `--unroutable` turns out to be reachable, so a run that
accidentally had a route fails loudly instead of passing for the wrong reason.

### Housekeeping

`/api/cron/home-relay-sweep` prunes pairings that can never be redeemed again (redeemed or expired
more than a day ago). It is wired in `vercel.json` and runs hourly.
