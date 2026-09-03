# home-relay

**The socket a LAN-only house dials out through.**

three.ws is served over https from Cloud Run. Home Assistant usually lives on a home network, on
an address no server on the internet can route to. For those houses there is no URL we could ever
dial, so the house dials us: the [three.ws Home Assistant
integration](../../home-assistant-integration) opens one outbound WebSocket to this service and
keeps it open, and the platform reaches the instance back down that socket.

Nothing listens on the user's network. No port is forwarded. No inbound firewall rule exists.

```
  three.ws api  ──POST /v1/agent(ws)──►  home-relay  ◄──dial-out ws──  Home Assistant
   (platform)                          (this service)                  (the house)
```

## What it deliberately is not

It is small and dumb on purpose, because it sits between the platform and a building.

- **It holds no database.** Ownership is proved by the signature on the install token the house
  presents ([`src/token.js`](src/token.js)), so the connect path queries nothing.
- **It holds no Home Assistant credential, ever.** Authentication happens locally, inside the
  house. No long-lived token crosses this process, which is why a relayed home's
  `home_connections.access_token_enc` is empty.
- **It forwards only what the protocol permits**, in the direction it permits
  ([`src/protocol.js`](src/protocol.js)), and the integration enforces the same list again at the
  far end, so compromising this service does not compromise a house.

That last point is the whole security argument, and it is why the allowlist is generated rather
than transcribed: see [The allowlist](#the-allowlist).

## Run it

```bash
cd services/home-relay
npm ci
HOME_RELAY_SIGNING_KEY=$(openssl rand -hex 32) \
HOME_RELAY_SERVICE_TOKEN=$(openssl rand -hex 32) \
PORT=8080 npm start
# {"event":"relay.listening","port":8080}

curl -s localhost:8080/healthz
```

| Variable | Required | What it is |
|---|---|---|
| `HOME_RELAY_SIGNING_KEY` | yes | Signs and verifies the install tokens a house presents. The platform mints tokens with the same key. |
| `HOME_RELAY_SERVICE_TOKEN` | yes | The platform's own credential for opening a session over a house's socket. Not a user credential. |
| `PORT` | no | Listen port. Defaults to 8080, which is what Cloud Run sets. |

## Endpoints

| Path | Who calls it | What it does |
|---|---|---|
| `GET /healthz`, `GET /` | Cloud Run, monitoring | Liveness plus counts |
| `GET /v1/status` | the platform | Which installs are connected right now |
| `WS /v1/agent` | a house | The dial-out socket. Presents an install token, then stays |
| `WS /v1/bridge?relay_id=` | the platform | Opens one session over that house's socket |
| `POST /v1/revoke`, `POST /v1/unrevoke` | the platform | Cut an install off, or restore it |

`@three-ws/home-bridge` speaks the `/v1/bridge` side for you:
`createRelayTransport({ relayUrl, relayId, serviceToken })` returns the transport a `HomeBridge`
takes in place of a URL and a token. See [that package's
README](../../packages/home-bridge/README.md#a-house-you-cannot-dial-into).

## The allowlist

[`allowlist.json`](allowlist.json) is the contract: which frame types cross, which Home Assistant
WebSocket commands may be sent into a house, which event types may come back, and which service
domains are refused outright (`shell_command`, `python_script`, `hassio`, `supervisor`, `backup`,
`update`, `cloud`, `config`, `auth`, `command_line`, plus named services like
`homeassistant.restart`).

It is enforced twice: here in JavaScript, and again in Python inside the house. Two enforcement
points that drift apart would be worse than one, so the Python side **reads this generated file**
rather than transcribing the rules, and it is generated from `src/protocol.js` rather than
hand-written:

```bash
node services/home-relay/scripts/gen-allowlist.mjs
```

`tests/home-relay-protocol.test.js` fails if the checked-in file is stale, so a rule change that
forgets to regenerate is a red test rather than a silent divergence between the two enforcers.

Rate limits live in the same manifest, per install, on both frame rate and actuation rate: a bug
in an integration must not be able to flood a house, and a compromised platform caller must not be
able to hammer a lock.

## Deploy

It deploys to Cloud Run with `--no-cpu-throttling` and a minimum instance count, and that is not a
performance preference. A house's dial-out socket has to survive between platform requests; a
throttled container lets every one of them die and reconnect in a loop.

```bash
docker build -t home-relay services/home-relay
```

## Read next

- [`home-assistant-integration/`](../../home-assistant-integration): the other end of the socket,
  the part that installs in the house through HACS.
- [`@three-ws/home-bridge`](../../packages/home-bridge): the client that speaks to this.
- [docs/smart-home.md](../../docs/smart-home.md): why the reachability problem exists and the
  three honest answers to it.
