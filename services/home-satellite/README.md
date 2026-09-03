# home-satellite

**Gives a three.ws agent's face and voice to the Home Assistant voice pipeline the household
already has.**

Home Assistant's Assist pipeline (wake word, speech to text, intent, text to speech) runs on the
user's own hardware and is already good. What it does not have is a body. This service registers
as a [Wyoming](https://github.com/rhasspy/wyoming) satellite, so Home Assistant treats it as any
other voice satellite, and supplies exactly two things: a **microphone** (streamed from a browser
showing the agent) and a **speaker** (that browser's audio output, with the agent's face moving in
front of it).

Everything else stays inside the house. The pipeline, the models, the audio: none of it crosses
the internet.

```
  Home Assistant  ──Wyoming/TCP──►  home-satellite  ──ws──►  a browser with the agent's face
   (the pipeline)                   (this service)           (microphone in, speaker out)
```

## The one rule that shapes the whole service

**The pipeline must never depend on the face.** A satellite that hangs Home Assistant because
somebody closed a browser tab is a satellite that breaks a house, and that is not a trade worth a
nicer demo. So every acknowledgement Home Assistant waits on is produced by the service itself,
whether or not anyone is watching: `pong` answers `ping` from the socket, and `played` is sent
when the audio has been consumed (waiting for a viewer to finish, bounded by the audio's own
duration plus a grace period, and sent immediately when there is no viewer at all).

Unplug three.ws entirely and the household's voice assistant works exactly as it did before.

## Two roles, one binary

```bash
node src/index.js satellite   # runs in the house, beside Home Assistant (the default)
node src/index.js hub         # runs on Cloud Run, joins satellites to browsers
node src/index.js token       # prints a viewer token for the LAN path, then exits
node src/index.js --help
```

The **satellite** listens for Wyoming on TCP, serves viewers on the LAN over HTTP and WebSocket,
and optionally dials out to a hub so a browser on `https://three.ws` can watch. The **hub** joins
satellites to viewers and does nothing else: it carries the face, and only the face.

## Run the satellite

```bash
cd services/home-satellite
npm ci
node src/index.js satellite --pairing-code ABC123 --name "Kitchen display" --area Kitchen
curl -s localhost:10701/healthz
```

| Flag | Environment variable | Default | What it is |
|---|---|---|---|
| `--pairing-code` | `THREE_WS_PAIRING_CODE` | none | A code from three.ws. First run only; after that the identity is on disk |
| `--name` | `SATELLITE_NAME` | `three.ws agent` | What Home Assistant calls this satellite |
| `--area` | `SATELLITE_AREA` | none | Suggested area for the device |
| `--api-base` | `THREE_WS_API_BASE` | `https://three.ws` | Where the pairing code is redeemed |
| `--state-dir` | `SATELLITE_STATE_DIR` | `./.satellite` | Where the claimed identity is written |
| `--wyoming-port` | `WYOMING_PORT` | `10700` | TCP port Home Assistant connects to |
| `--viewer-port` | `VIEWER_PORT` | `10701` | HTTP and WebSocket port browsers on this network use |
| `--no-hub` | `SATELLITE_HUB=off` | hub on | Do not dial out. LAN viewers only |

The hub role needs `HOME_SATELLITE_HUB_SECRET` and listens on `PORT` (default 8080).

An unpaired satellite **stays up**. It answers `/healthz`, and it tells a connecting Home
Assistant exactly why it is refusing, which is more useful than a container that exits on boot.

## Run it in Docker (the way a household actually runs it)

```bash
docker build -t three-ws-home-satellite services/home-satellite

docker run -d --name three-ws-satellite \
  --network host \
  -v three-ws-satellite:/data \
  -e THREE_WS_PAIRING_CODE=RH23-KSW5 \
  -e SATELLITE_NAME="Kitchen display" \
  -e SATELLITE_AREA=Kitchen \
  three-ws-home-satellite

docker logs three-ws-satellite | head
curl -s localhost:10701/healthz
```

`--network host` is the simple case: Home Assistant, this container and the display are all on the
same machine or the same LAN, and nothing needs a port map. On a bridge network, publish `10700`
(Home Assistant connects in) and `10701` (browsers on the LAN connect in) instead.

The `/data` volume matters. It holds the identity claimed with the pairing code, and a satellite
that loses it has to be paired again from scratch.

To point it at a three.ws you are running yourself, add `-e THREE_WS_API_BASE=http://host:port`.
To keep it entirely off the internet after pairing, add `-e SATELLITE_HUB=off`.

## Point Home Assistant at it

Home Assistant is the client here, not the server: its `wyoming` integration dials out to this
service.

1. Settings, Devices and services, Add integration, **Wyoming Protocol**.
2. Host: the machine running this service. Port: `10700`.
3. It appears as a satellite device. Assign it to an Assist pipeline as you would any other.

Then open the viewer (`http://<host>:10701/viewer`, with a token from `node src/index.js token`)
on the display that should show the agent, or watch from three.ws when the hub is enabled.

## Pairing, and why there is friction

A satellite is a screen with a microphone that can hear a house. Letting one attach to an agent
without proving it was invited would be an open relay into strangers' homes. So there is exactly
one way in: the owner asks three.ws for a pairing code, the code is short, single use and expires
in minutes, and the service redeems it once at first start. What comes back is a long-lived
identity written to `--state-dir`, so the code is never handled again.

That friction is the minimum that prevents an open relay, and no smaller version of it exists.

## The states a face has to render

The browser is driven by a small JSON control protocol plus raw PCM in binary frames, deliberately
separate from Wyoming: Wyoming carries things a web page has no business receiving, and a browser
needs things Wyoming has no concept of, like which state to draw.

`unpaired`, `pairing`, `idle`, `wake`, `listening`, `thinking`, `speaking`, `error`,
`disconnected`, `offline`. Every one of them has a design. Both ends validate what the other
sends: the service because a viewer is a web page, and the browser because a message that does not
typecheck should paint an honest error rather than a broken face.

## Echo, and why audio in is gated

Home Assistant restarts an always-on pipeline the instant the previous run ends. A display with
speakers a metre from its microphone would otherwise hear its own answer and wake itself up, so
audio in is gated while the satellite is speaking. The reference Wyoming satellite solves it the
same way.

## Endpoints

| Path | Port | What it does |
|---|---|---|
| `GET /healthz`, `GET /` | viewer port | Paired state, agent, viewer count, Wyoming version, live pipeline stage |
| `WS /viewer` | viewer port | A browser attaching a face, microphone and speaker |
| `WS /room` | hub | The hub side of the same join |
| Wyoming | `10700` (TCP) | What Home Assistant's `wyoming` integration connects to |

## Reproduce the end-to-end run

Three scripts in `scripts/` stand up the whole thing against real software. None of them uses a
fixture: Home Assistant runs its own speech recognition, its own intent handling and its own text
to speech, and the house really changes.

```bash
docker network create wyoming
docker run -d --name whisper --network wyoming rhasspy/wyoming-whisper:latest \
  --model tiny-int8 --language en --uri tcp://0.0.0.0:10300 --data-dir /data --download-dir /data
docker run -d --name piper --network wyoming -p 10200:10200 rhasspy/wyoming-piper:latest \
  --voice en_US-lessac-low --uri tcp://0.0.0.0:10200 --data-dir /data --download-dir /data
docker run -d --name openwakeword --network wyoming rhasspy/wyoming-openwakeword:latest \
  --preload-model ok_nabu --uri tcp://0.0.0.0:10400
docker run -d --name ha --network wyoming -p 8123:8123 \
  --add-host=host.docker.internal:host-gateway ghcr.io/home-assistant/home-assistant:stable

# Onboard Home Assistant and get a token (repo root).
node scripts/provision-home-assistant.mjs --url http://localhost:8123 --rooms

# Add the four Wyoming services, build an Assist pipeline, make it preferred.
node scripts/provision-ha-pipeline.mjs --url http://localhost:8123 --token "$HOME_ASSISTANT_TOKEN" \
  --stt whisper:10300 --tts piper:10200 --wake openwakeword:10400 \
  --satellite host.docker.internal:10700

# Speak a sentence into the pipeline through this satellite and print what came back.
node scripts/pipeline-run.mjs \
  --viewer ws://127.0.0.1:10701/viewer --token "$(node src/index.js token)" \
  --piper 127.0.0.1:10200 --say "turn off the kitchen lights" \
  --ha http://localhost:8123 --ha-token "$HOME_ASSISTANT_TOKEN" --watch light.kitchen_lights
```

`pipeline-run.mjs` plays the part of the browser: it connects to the viewer WebSocket exactly as
`src/home/satellite.js` does, streams microphone audio the same way, and receives the same events
and the same speech the avatar lip-syncs to. The "microphone audio" is real speech, synthesized by
the same piper container Home Assistant uses for its answers.

Add `--drop-viewer` and it closes the browser's socket the instant the utterance ends. The run
still has to finish and the house still has to change, which is how the claim at the top of this
file is checked rather than asserted.

`capture-states.mjs` drives the three.ws page itself in Chromium, with a WAV played into
`getUserMedia`, and screenshots every state the view can be in.

## Versions, and what happens when they move

| Piece | Verified against |
|---|---|
| Home Assistant | 2026.9.0 (`ghcr.io/home-assistant/home-assistant:stable`) |
| `wyoming` protocol package | read from `rhasspy/wyoming` at 1.10.2; the tested Home Assistant ships 1.10.0 |
| Speech to text | `rhasspy/wyoming-whisper`, `tiny-int8` |
| Text to speech | `rhasspy/wyoming-piper`, `en_US-lessac-low` |
| Wake word | `rhasspy/wyoming-openwakeword`, `ok_nabu` |

`WYOMING_VERSION` in `src/protocol.js` travels in every header this service writes and is reported
in the `info` handshake, exactly as the reference does, so a version mismatch is visible from the
Home Assistant side instead of turning into a mystery.

Two findings from that verification are worth knowing before you change anything here:

- **Home Assistant opens more than one connection.** The config entry's info coordinator opens its
  own short-lived socket every 30 seconds to re-read `describe`, alongside the satellite's
  long-lived one. A satellite that assumes a single connection kills the live socket every time
  that probe lands and reconnects forever without ever completing a pipeline.
- **Home Assistant does not stream partial transcripts to a satellite.** It sends `transcribe`
  when listening starts, `voice-started` and `voice-stopped` as it hears speech begin and end, and
  one final `transcript`. `transcript-chunk` exists in the protocol but the integration never
  writes it downstream, so the view streams the stages it does get rather than pretending to
  stream words.

## Licence and attribution

The Wyoming protocol and its reference implementation are MIT licensed, by Michael Hansen and the
Rhasspy project. This service **implements the protocol**; it does not vendor the reference
satellite, which is a device runtime for a Raspberry Pi with a microphone attached and is the
wrong shape for a client that lives in our own stack. The framing and the event set in
`src/protocol.js` were written from that source, and where our reading differed from the wire, the
wire won.

- Protocol and reference client: <https://github.com/rhasspy/wyoming> (MIT)
- Reference satellite runtime: <https://github.com/rhasspy/wyoming-satellite> (MIT)
- Home Assistant's side of it: `homeassistant/components/wyoming` (Apache-2.0)

## Read next

- [docs/smart-home.md](../../docs/smart-home.md): where the voice work sits in the campaign.
- [`@three-ws/home-bridge`](../../packages/home-bridge): the state and action channel, which is a
  separate path from this one and does not depend on it.
- [rhasspy/wyoming](https://github.com/rhasspy/wyoming): the protocol, and the reference
  implementation this follows.
