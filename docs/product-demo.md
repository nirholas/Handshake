# Filming the product demo

`npm run demo:video` records a narrated walkthrough of the whole platform: a presenter moving a real
cursor through the live site, one feature at a time, with spoken narration and captions. It is the
film you send someone who asks "what is three.ws, exactly?".

Everything on screen is the real product answering in real time. There is no slideshow, no mock-up,
and no staged data. If a page is broken on the day you film, it lands in the run report as a skipped
stop instead of in the film as a still frame.

```bash
npm run demo:video                          # every feature, all chapters
npm run demo:video:highlights               # the short cut, the flagship stops only
npm run demo:video -- --dry-run             # print the route and exit
npm run demo:video -- --sections=build      # re-record one chapter
```

## What lands

Output goes to `marketing/product-demo/`:

| File | What it is |
|---|---|
| `three-ws-demo.mp4` | The whole film, all chapters joined |
| `three-ws-demo-01-main.mp4` … | One file per chapter, in route order |
| `three-ws-demo-manifest.json` | What was filmed: origin, route, narration lane and voice, stop count, chapter durations, and every skipped stop with the reason |

The mp4s are gitignored on purpose. Each chapter is a 1080p screen recording and the set runs to
hundreds of megabytes, which is not something a git history should carry forever. The manifest is
committed, so the repo still records what was filmed and when. Re-run the script to get the film
back.

## The route is generated, not hand-written

The stops come from [`public/tour/curriculum.json`](../public/tour/curriculum.json), the same
curriculum the in-product [Feature Tour](../tour-sdk/README.md) walks, which
[`scripts/build-tour.mjs`](../scripts/build-tour.mjs) generates from `data/pages.json`. Two things
follow from that:

- **A page that ships tomorrow is in the film.** Add it to `data/pages.json`, run
  `node scripts/build-tour.mjs`, and the next recording visits it. Nothing here needs editing.
- **The narration is the page's own description.** The words spoken over each stop are the same
  plain-language sentences that feed the sitemap, `llms.txt`, and the changelog, so the film cannot
  drift into claiming something the platform does not do.

Chapters are the curriculum's sections, in its order: Main, Build, Crypto, Labs, Agent Tools, Learn.

## Flagship stops are performed, not just visited

Most stops are visited and read through the way a presenter scrolls a page they are showing you.
About twenty surfaces get a hand-written act in the `ACTS` table at the top of
[`scripts/make-product-demo.mjs`](../scripts/make-product-demo.mjs), and each one is a real
interaction with the real page:

- `/marketplace` is really searched, and the cards that answer are live 3D models
- `/forge` really switches between the text, photo, and sketch lanes
- `/create/prompt` really generates an avatar through the production pipeline
- `/chat` really sends a message and waits for the model behind it to answer
- `/pose` and `/playground` really turn their viewers with a pointer drag
- `/holo` really drags the peel slider on the procedural foil

An act also speaks: `beat('…')` says a line and waits it out, so the film keeps talking while it
clicks instead of going silent on a surface that takes a moment. Add an act by adding a key to
`ACTS` whose name is the stop's path.

A selector that has gone missing does not fail the run. It fails that stop, which is recorded in
the run manifest under `skipped`, and the film moves on. Pass `--strict` when you want a missing
selector to stop everything.

## How it is filmed

[`scripts/lib/demo-stage.mjs`](../scripts/lib/demo-stage.mjs) is the stage, and it is worth knowing
three things about it.

**Real time, not stepped frames.** The Seeker recordings
([`docs/seeker-video.md`](./seeker-video.md)) step one frame at a time to reproduce a phone panel
exactly. This does the opposite and uses Playwright's own recorder at 1920x1080, because a product
demo is watched for its motion: 3D scenes streaming in, a model spinning under the cursor, a grid
settling after a search. Stepped frames freeze all of that, and nearly every route here runs WebGL.

**The cursor is a listener, not a puppet.** The arrow you see follows real `mousemove` and
`mousedown` events that Playwright dispatches into the page, the same way a screen recorder draws
the host cursor over a real session. It reports the interaction; it never stands in for one. Same
for the click ring.

**The voice is the platform's own.** Narration is synthesized through the site's own TTS lane, so
three.ws narrates three.ws. The default is `/api/tts/edge` (Microsoft Edge Neural voices, proxied
and cached in R2 by the platform), because it allows 20 lines a minute for a signed-in caller and a
full film has close to three hundred of them. `--narrator=speak` switches to `/api/tts/speak`, which
is better suited to a handful of lines: it allows 40 an hour, and its free NVIDIA Magpie lane falls
through to a paid OpenAI backstop when Magpie errors, which on a few hundred lines is real spend.
Both lanes need the QA session, so `--authed` is not optional when there is a voice track.

Every line is synthesized **before** the camera rolls. Filming is real time, so a line fetched
mid-take is dead air on screen: the first cut of this film opened on 52 seconds of silence because
its longest line was being synthesized while the page sat there. The warm-up collects the whole
script (chapter intros, every stop's line, and the `beat()` literals inside the acts), synthesizes
what is missing, and caches it on disk under `marketing/product-demo/.raw/voice/`. A rerun pays none
of that twice, and a single re-shot chapter gets exactly the audio the full run gave it.

Captions carry the same words for anyone watching without sound. What is written and what is spoken
are not the same string, though: a caption reads `three.ws` and `USDC`, and the synthesizer is handed
`three dot w s` and `U S D C`.

The narration track is laid down as a single exact concatenation of speech and silence at the
offsets each line was spoken at, then muxed with the video. Nothing is mixed, so an hour-long film
stays sample accurate end to end.

## Flags

| Flag | Effect |
|---|---|
| `--route=full` | Every feature page (default) |
| `--route=highlights` | Only the curriculum's highlight stops |
| `--sections=build,crypto` | Only these chapters |
| `--limit=n` | First n stops per chapter, for a smoke test |
| `--authed` | Replay the QA session, so signed-in surfaces are on screen |
| `--origin=http://localhost:3000` | Film a dev server instead of production |
| `--out=<dir>` | Write somewhere else |
| `--narrator=edge\|speak` | Which TTS lane to synthesize on (default `edge`) |
| `--voice=<id>` | Voice for that lane (default `en-US-AndrewMultilingualNeural`; the `speak` lane takes ids from `/api/tts/voices`) |
| `--no-voice` | Captions only, no narration track |
| `--reuse` | Keep chapter mp4s that already exist, and film the rest |
| `--strict` | A failed stop fails the run |
| `--crf=<n>` | x264 quality, default 22; lower is bigger |
| `--name=<basename>` | Output basename (default `three-ws-demo`, or `three-ws-demo-<route>`) |
| `--dry-run` | Print the route and exit |

## Before you film

- **`--authed` needs a session.** `npm run audit:web:login` mints one into `.auth/audit-state.json`
  from the QA credentials in `.env`. Without it, the signed-in surfaces (x402 Studio, profile,
  wallet) show their sign-in wall, `/create/prompt` cannot start a real generation, and the
  narration cannot be synthesized at all: the edge lane answers an anonymous caller with a 401, and
  the `speak` lane drops to ten lines an hour.
- **`ffmpeg` and `ffprobe` must be on `PATH`** (`sudo apt-get install -y ffmpeg`). Playwright ships
  its own ffmpeg, but that build is VP8-only with no filters, so it can do neither the H.264 encode
  nor the audio mux.
- **Check the disk.** A full run writes a raw webm per chapter before encoding it. Reclaim space
  first with `npm run clean:worktrees -- --apply` if the workspace is tight.
- **The first run pays for the narration.** Warming close to three hundred lines at the edge lane's
  20 a minute takes about 15 minutes before any filming starts. Later runs skip it.
- **A full run takes about as long as the film.** It is a real-time recording of a real site, so
  budget roughly an hour of wall clock for the full route, and film it in chapters (`--sections=`,
  then `--reuse`) if you would rather not hold one process open that long.

## Re-recording one chapter

Chapters are independent recordings joined at the end, so a chapter that went wrong can be re-shot
on its own:

```bash
npm run demo:video -- --sections=crypto        # re-record just that chapter
npm run demo:video -- --reuse                  # rejoin, keeping the chapters already on disk
```

`--reuse` skips any chapter whose mp4 is already in the output directory and films the rest, then
concatenates all of them into `three-ws-demo.mp4`.
