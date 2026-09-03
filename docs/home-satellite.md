# Give your Home Assistant voice assistant a face

Your voice assistant already works. It hears you, it understands you, it turns on the
lights, and it answers. What it does not have is a body: it is a speaker with an LED
ring, and the LED ring is the entire visual vocabulary it gets.

A three.ws voice satellite changes that half and nothing else. Home Assistant keeps the
wake word, the speech recognition, the intent handling and the answer, all running on
your own hardware exactly as they do today. three.ws supplies a face on a screen that
lip-syncs the answer your pipeline produced and reacts while you speak.

**Close the page and your voice assistant keeps working.** That is not a nice property we
noticed afterwards, it is the constraint the whole thing was built around. Nothing in
your house is allowed to depend on a browser tab.

---

## What you need

- Home Assistant, with an Assist pipeline you already use. If "hey, turn on the kitchen
  lights" works today, you are ready.
- Docker on any machine that can reach it. The same box is fine.
- A three.ws account and an agent. That is what supplies the face.

Nothing has to be exposed to the internet. Home Assistant connects **out** to the
satellite over your own network, and the satellite connects **out** to three.ws. No port
forwarding, no inbound firewall rule, no reverse proxy.

## Set it up

### 1. Get a pairing code

Open [three.ws/smart-home/satellite](/smart-home/satellite), pick the agent that should
appear on the screen, and press **Get a pairing code**. You get a code like `RH23-KSW5`
and the exact command to run with it already filled in.

The code is good **once** and dies after fifteen minutes. It exists because a satellite is
a screen with a microphone that can hear your house, and letting one attach to an agent
without proving it was invited would be an open relay into strangers' homes.

### 2. Run the satellite

```bash
docker run -d --name three-ws-satellite \
  --network host \
  -v three-ws-satellite:/data \
  -e THREE_WS_PAIRING_CODE=RH23-KSW5 \
  -e SATELLITE_NAME="Kitchen display" \
  -e SATELLITE_AREA=Kitchen \
  ghcr.io/nirholas/three-ws-home-satellite:latest
```

It redeems the code once, writes a long-lived identity to `/data`, and starts listening.
The code is never needed again; the volume is, so do not skip it.

Check it came up:

```bash
curl -s localhost:10701/healthz
```

```json
{ "ok": true, "paired": true, "state": "disconnected", "ha_connected": false }
```

`disconnected` is correct at this point. Home Assistant has not been told about it yet.

### 3. Tell Home Assistant about it

In Home Assistant: **Settings → Devices and services → Add integration → Wyoming
Protocol**. Give it the host running that container and port **10700**.

It appears as a voice satellite device, named whatever you passed as `SATELLITE_NAME`.
Assign it to an Assist pipeline the way you would any other satellite. `/healthz` flips to
`"ha_connected": true` within a few seconds.

### 4. Open the face

Back on [three.ws/smart-home/satellite](/smart-home/satellite), your satellite is listed.
Press **Open** on the screen that should show the agent: a kitchen tablet, a wall display,
a spare monitor, a phone propped against the kettle.

Press **Talk now** and speak. The transcript appears as Home Assistant produces it, the
agent thinks, and then it answers with your pipeline's own voice while its mouth moves to
that audio. Press **Listen for the wake word** instead and it streams continuously and
lets your own wake word decide, which is what it does on a wall all day.

---

## What crosses your network, and what does not

This matters to the kind of person who runs Home Assistant, so it is worth being exact.

| Stays entirely inside your house | Leaves your network |
|---|---|
| The Wyoming connection between Home Assistant and the satellite | The pairing code, once, when the satellite is claimed |
| Wake word detection, speech recognition, intent handling, text to speech | The agent's 3D model, fetched by the browser showing it |
| Your Home Assistant credential (the satellite never has one) | Audio and pipeline state, only while a browser is watching from three.ws |
| Every device, entity and room name | |

The last row on the right is the one to understand. A browser on `https://three.ws` cannot
open a connection to a machine on your LAN, so when you watch from three.ws the satellite
relays through a hub: the audio of the answer and the state of the run pass through it,
and nothing else does. The hub holds no database and no credential of yours, it can only
move bytes between two sockets that presented tokens for the same satellite, and the voice
path does not go through it at all.

If you would rather it never left at all, two options:

- **Watch from your own network.** The satellite serves the same view itself on port 10701
  to any browser on the LAN holding a token from `docker exec three-ws-satellite node
  src/index.js token`. three.ws is out of the loop entirely after pairing.
- **Turn the hub off.** Add `-e SATELLITE_HUB=off` and the satellite never dials out.

Either way, the voice pipeline is unaffected. Unplug three.ws completely and your
assistant works exactly as it did before you installed this.

## The states you will see

| State | What it means |
|---|---|
| **Not paired** | The service is running but has never redeemed a code. It also tells a connecting Home Assistant exactly that, rather than dropping the connection. |
| **Pairing** | A code has been generated and is waiting to be used. |
| **Ready** | Paired, Home Assistant connected, nothing happening. |
| **Yes?** | Home Assistant's wake word fired. |
| **Listening** | Streaming to the pipeline. The transcript fills in as it arrives. |
| **Thinking** | Audio finished; the pipeline is deciding what to do. |
| **Speaking** | Playing your pipeline's own answer, lip-synced to that audio. |
| **Something went wrong** | The pipeline failed and said why. The message is shown, not swallowed. |
| **Home Assistant is not connected** | The satellite is up but nothing is driving it. |
| **Reconnecting** | This screen lost the satellite. Your voice assistant is unaffected; the page says so and reconnects on its own. |
| **Screen resting** | The display went to sleep. The socket stays open and the pipeline keeps running. |

## Things worth knowing

**One microphone, many faces.** Open the satellite on three screens and all three show the
agent; the first one to open its microphone holds it until it closes it or leaves.
Otherwise two open tabs stream two microphones into one pipeline and the transcript is a
duet.

**It will not talk over itself.** Home Assistant restarts an always-on pipeline the moment
the previous run ends, and a display with speakers a metre from its microphone would hear
its own answer and wake itself up. Audio in is muted while the agent is speaking.

**The transcript arrives in stages, not words.** Home Assistant sends a satellite the fact
that listening started, that it heard speech begin and end, and then one final transcript.
It does not stream partial words downstream, so neither do we, and the screen shows the
stages it actually has rather than faking the rest.

**Retiring one is instant.** Press **Retire** on the satellite list. Its identity can never
authenticate again, and the container on your network becomes an unpaired service that
refuses connections and says why.

## If it does not work

| What you see | What it is |
|---|---|
| Home Assistant says "Unable to connect" | The host or port is wrong, or the container is not running. `curl localhost:10701/healthz` from the same machine Home Assistant is on. |
| Home Assistant logs "this satellite has not been paired" | The pairing code was wrong, already used, or expired. Get a fresh one; they last fifteen minutes and work once. |
| The satellite reconnects in a loop | The service is older than the fix for Home Assistant's info probe, which opens a second connection every thirty seconds. Pull a current image. |
| The page says the hub is not configured | The three.ws instance you paired against has no hub. The satellite still works; open it from a browser on the same network as the house. |
| "Language en-us not supported" | The pipeline's text-to-speech language does not match what the engine advertises. Piper wants `en_US`, not `en-us`. |

## For developers

The service is [`services/home-satellite/`](https://github.com/nirholas/three.ws/tree/main/services/home-satellite),
MIT, and its README covers the protocol, both deployment roles and how to reproduce an
end-to-end run against a real Home Assistant.

The [Wyoming protocol](https://github.com/rhasspy/wyoming) is MIT, by Michael Hansen and the
Rhasspy project. three.ws **implements** it rather than vendoring the reference satellite:
that satellite is a device runtime for a Raspberry Pi with a microphone soldered to it, and
what a 3D agent needs is a client in its own stack. The framing and the event set were
written from that source, and where our reading differed from the wire, the wire won.

## Read next

- [Connect your house](/docs/smart-home): how a three.ws agent reads and acts on a real
  home, and the gate that stops it unlocking anything unasked.
- [Privacy and retention](/docs/home-privacy): everything the Home lane stores, and for how
  long.
