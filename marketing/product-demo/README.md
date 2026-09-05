# marketing/product-demo/

The narrated product demo: a presenter walking the whole of three.ws, feature by feature, on the
live site. This directory holds what the recorder produces.

Make it, or make it again, with:

```bash
npm run demo:video                 # every feature, all chapters
npm run demo:video:highlights      # the short cut, flagship stops only
```

The recorder is [scripts/make-product-demo.mjs](../../scripts/make-product-demo.mjs) and the full
guide is [docs/product-demo.md](../../docs/product-demo.md).

## What lands here

| File | What it is |
| --- | --- |
| `three-ws-demo.mp4` | The whole film, every chapter joined, 1920x1080 with narration |
| `three-ws-demo-01-main.mp4` … | One file per chapter, in route order, so a chapter can be posted or re-shot on its own |
| `three-ws-demo-manifest.json` | The run record: origin, route, narration lane and voice, stop count, per-chapter durations, and every stop that was skipped with the reason |
| `.raw/` | Working directory: the narration clip cache and per-chapter audio tracks. Safe to delete; deleting the voice cache means the next run re-synthesizes it |

**The mp4s are gitignored.** Each chapter is a 1080p screen recording and the set runs to hundreds of
megabytes, which is not something a git history should carry forever. The manifest is
committed, so the repo still records what was filmed and when. Re-run the recorder to get the film
back.

## What is in it

The route is the same curriculum the in-product Feature Tour walks
([`public/tour/curriculum.json`](../../public/tour/curriculum.json), generated from
`data/pages.json`), so the film covers every feature page the platform declares and a page that
ships tomorrow is in the next recording without anyone editing a script. Chapters are that
curriculum's sections: Main, Build, Crypto, Labs, Agent Tools, Learn.

Every frame is the live site. The flagship surfaces are really used (the marketplace is searched,
the forge switches lanes, an agent answers a message, a model turns under a drag), and a page that
fails is reported as a skipped stop rather than filmed as a still frame. The narration is spoken by
the platform's own TTS lane, so three.ws narrates three.ws.
