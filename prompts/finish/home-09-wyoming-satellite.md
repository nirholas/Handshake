# 09. three.ws as a Home Assistant voice satellite (Wyoming)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Order
[08](home-08-voice-loop.md) should have landed; this order can be built in parallel with it, but
not before order 06.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**This is the distribution play, not just a feature.** Today a Home Assistant voice assistant is
a speaker with an LED ring. Point an existing HA pipeline at a three.ws agent and it gains a
face, an expression, lip sync and a body that turns toward you. That is a new product for 90,225
stars' worth of users who already own the hard part.

---

## Step 0: re-derive the current state

```bash
ls src/voice/                                            # what already exists
grep -rn "wyoming" . --include=*.js --include=*.md -l | grep -v node_modules | head
docker exec threews-ha ls /config                        # a live instance to point at us
```

Read the protocol from the reference implementation, not from a blog:
[rhasspy/wyoming-satellite](https://github.com/rhasspy/wyoming-satellite) (MIT, 1,244 stars) and
the `wyoming` protocol package it depends on. **Adopt the protocol, not the code**: it is a small
TCP framing of newline-delimited JSON headers with optional binary payloads, and reimplementing
the client side in our stack is correct. Vendoring a Python satellite is not.

## What this order owns

A three.ws surface that a Home Assistant instance can select as a voice satellite: it announces
itself, receives the pipeline's audio and events, plays the response, and drives the 3D avatar's
mouth and expression from it. Home Assistant owns the pipeline (wake word, STT, intent, TTS);
we own the body.

**The direction of control is the opposite of order 08.** There, we run the loop and call Home
Assistant. Here, Home Assistant runs the loop and calls us. Both must exist: one serves three.ws
users who have a house, the other serves Home Assistant users who want a face.

## The shape

Wyoming is a TCP protocol and a browser cannot speak TCP, so the satellite is a small service,
not a page:

```
Home Assistant  --wyoming/TCP-->  three.ws satellite service  --wss-->  the browser (3D agent)
                                  (announces info, relays audio + events)
```

- `services/home-satellite/` (a new service directory, which per CLAUDE.md **requires its own
  README.md**), or `workers/` if the fleet conventions there fit better. Read `STRUCTURE.md` and
  a neighbouring service before choosing, and put the choice in your report.
- The service implements the `info` handshake (announcing a satellite with our name, our
  attribution and our capabilities), the audio chunk stream in both directions, and the pipeline
  event set (`run-pipeline`, `wake`, `transcript`, `synthesize`, `audio-start`, `audio-chunk`,
  `audio-stop`, `error`).
- The browser side subscribes over a websocket and drives the avatar: the existing
  `src/voice/lipsync-driver.js` and `src/voice/talk-emotes.js` are the target, not new code.
- Pairing: a user connects their satellite to a specific three.ws agent with a short-lived code,
  the same way any device pairing works. No open relay, ever.

## The bar this must clear

Home Assistant users are a discerning, local-first audience who will notice anything dishonest.

- **Local-first respected.** Say plainly which parts leave their network. If a deployment can run
  the satellite locally (it can: the service is small and containerized), document that path and
  ship the container.
- **No account required to try it.** A pairing code and an avatar. Ask for an account when there
  is a reason.
- **Degrades to audio.** If the display is off or the browser is closed, the pipeline must still
  complete. We are the face, never a dependency of the voice working.
- **Attribution and licensing correct.** Wyoming is MIT; credit it, link it, and say we
  implemented the protocol rather than vendoring the satellite.

## Every state

1. Unpaired: the code, and how to add it in Home Assistant.
2. Pairing.
3. Paired and idle: the avatar present, waiting.
4. Wake detected (by Home Assistant, relayed to us).
5. Listening, with the transcript streaming in.
6. Thinking.
7. Speaking, lip-synced to the pipeline's own TTS audio.
8. Error from the pipeline: shown, not swallowed.
9. Satellite disconnected: the avatar says so rather than freezing.
10. Display asleep: the pipeline still works, and we say we are the optional half.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | The protocol client: framing, the event set, the info handshake. Pure and unit-testable. | `services/home-satellite/src/protocol.js`, tests |
| 2 | The service: TCP listener, session management, the browser websocket relay. | `services/home-satellite/src/server.js` |
| 3 | Pairing with short-lived codes, bound to a user and an agent. | `api/home/satellite.js`, a migration if it needs storage |
| 4 | The browser side driving the existing lip sync and emotes. | `src/home/satellite.js` |
| 5 | A container and its deploy config, following a sibling service. | `services/home-satellite/Dockerfile`, `cloudbuild.yaml` |
| 6 | `README.md` in the service directory: what it is, how to run it locally, how to add it in Home Assistant, its public interface, one runnable example. **Required by CLAUDE.md.** | `services/home-satellite/README.md` |
| 7 | All ten states. | as above |
| 8 | `STRUCTURE.md` row, `docs/` page, `data/changelog.json` entry. | as listed |

## Definition of done

- [ ] A real Home Assistant instance lists the three.ws satellite in its voice assistant settings. Screenshot from Home Assistant, not from us.
- [ ] A full pipeline run: speak to Home Assistant's pipeline, and the three.ws avatar lip-syncs the response and reacts. Recorded.
- [ ] The transcript streams into the UI as Home Assistant produces it (state 5), not only at the end.
- [ ] Closing the browser leaves the pipeline working. Prove it.
- [ ] An unpaired satellite is rejected; a pairing code is single-use and short-lived. Three transcripts.
- [ ] The service runs locally in Docker against a local Home Assistant, with the command in the README, and it works.
- [ ] `services/home-satellite/README.md` exists and someone who did not build it could follow it. `npm run audit:docs` passes, which enforces the README existing.
- [ ] Screenshots of all ten states.
- [ ] `npx vitest run services/home-satellite` (or the repo's equivalent for that directory) passes.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| The protocol is under-documented | Read the reference implementation's source. It is small, MIT, and unambiguous. Where our reading differs from the wire, trust the wire and write down what you found. |
| A browser cannot open a TCP socket | Correct, which is why this is a service. Do not try to force it into the page. |
| Tempted to vendor the Python satellite | Do not. We need a client in our own stack; the Python satellite is a device runtime. Implement the protocol. |
| Home Assistant changes the event set | Pin what you tested against, name the version in the README, and add the version to the info handshake so a mismatch is visible. |
| Someone proposes making the three.ws display required for voice to work | Refuse. That would make us a dependency of somebody's house working, which is both wrong and how a project gets a bad reputation in this community. |
| The pairing flow feels like too much friction | It is the minimum that prevents an open relay into strangers' homes. Make it fast, not absent. |

## Report format

1. The Home Assistant-side screenshot listing our satellite.
2. The recorded pipeline run with lip sync.
3. The three pairing transcripts.
4. The local Docker run transcript.
5. The ten state screenshots.
6. Test and audit output.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-09-wyoming-satellite.md

Never delete it on a partial.
