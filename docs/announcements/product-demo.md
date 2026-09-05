# Announcement pack: The product demo film

**Surface:** [`/tour`](https://three.ws/tour) and [`/docs/product-demo`](https://three.ws/docs/product-demo)
· **Ledger key:** `/tour` · **Stage:** drafted · **Filmed:** 2026-09-05 · **Announced externally:** never

The asset is a 65 minute narrated walkthrough of the entire platform, recorded against the live
site by [`npm run demo:video`](../../scripts/make-product-demo.mjs). Written against
[the announcement voice](../announce-voice.md).

---

## The claim, and where it is checked

> Every feature page three.ws declares was filmed on the live production site in one run: 257
> stops, none skipped, 65 minutes and 50 seconds at 1920x1080, narrated by the platform's own
> text to speech lane. The route was generated from the site's page index, not written by hand.

Every number comes from the committed run record,
[`marketing/product-demo/three-ws-demo-manifest.json`](../../marketing/product-demo/three-ws-demo-manifest.json),
which the recorder writes at the end of the run:

| Part of the claim | Where it is real |
|---|---|
| Filmed on the live production site | `"origin": "https://three.ws"`, `"authed": true` in the manifest |
| 257 stops, none skipped | `"stops": 257`, `"recorded": 257`, `"skipped": []`. A page that fails is reported as a skipped stop rather than filmed as a still frame |
| 65 minutes 50 seconds, 1920x1080 | `"seconds": 3950`, `"stage": "1920x1080@30"` |
| three.ws narrates three.ws | `"narrator": { "lane": "edge" }`, the platform's own TTS lane, the same one that voices agents |
| The route is generated | Stops come from [`public/tour/curriculum.json`](../../public/tour/curriculum.json), which `scripts/build-tour.mjs` generates from `data/pages.json`. A page that ships tomorrow is in the next recording with nobody editing a script |
| Six chapters | Main, Build, Crypto, Labs, Agent Tools, Learn, one mp4 each, listed in the manifest with per-chapter durations |

Full mechanism: [docs/product-demo.md](../product-demo.md).

## Media

The payload of this post is the film itself. The still below is captured from the live route by
`npm run announce:media` and is what ships if the video cannot be uploaded on the account's tier
(see **Delivery** below). Provenance is in
[`public/announce/media-manifest.json`](../../public/announce/media-manifest.json).

| Shot | File | Notes |
|---|---|---|
| `tour-hero` | `/announce/img/tour-hero.webp` | 1800x1013. The Guided Tour page, which proves the two numbers the post leans on: 257 features, 6 chapters |

**Alt text, required on the post:**

> The three.ws Guided Tour page: quick highlights of 18 picks in about 7 minutes, or the full tour
> of 257 features across 6 chapters, walked on the live site by a 3D guide that speaks and points,
> paced by you.

X does not accept alt text on a video upload the way it does on an image, so when the film is the
attachment the accessibility payload is the film's own burned-in captions and its spoken narration,
both produced by the recorder. The alt text above is required on any still that ships instead.

## The post

Pattern: number lead. **174 weighted characters** as X counts it (the local counter reads 164
because it only reflates a link carrying its protocol; X charges 23 for the bare `three.ws/tour`
too). That is inside the 100 to 179 band which measured a 3.0x lift.

Postable file: [`product-demo.post.txt`](./product-demo.post.txt).

```text
257 stops on the live site, none skipped, 66 minutes, and three.ws narrates three.ws. The route is generated from the page index, not written by hand: three.ws/tour
```

### Why it is written that way

The reflex for a demo video is to describe the video ("we made a walkthrough of the platform"),
which tells a reader nothing they could not guess from the attachment. The three facts worth
posting are the ones a viewer cannot see by watching: that it is the live production site and not
a staged build, that not one of the 257 stops had to be dropped, and that nobody chose the route.
"Not written by hand" is the sentence doing the real work: it means the film is a byproduct of the
page index rather than a marketing artifact, so the next cut covers whatever shipped since.

Two true details were cut for length: the six chapters ship as separate files so one can be posted
or re-shot alone, and there is a 16 minute 46 second highlights cut of 18 flagship stops. Both are
in the Telegram variant.

No account is tagged. Nothing external is load-bearing here: the site is ours, the narration lane
is ours, and a tag we cannot defend costs more than the 4.5x it would buy.

## Delivery: which file to attach

The archive says an uploaded video measured 0.71x against a still, so this is the rare pack where
the media is a deliberate exception to the usual "ship the frame" rule. The film is the point of
the post; the tradeoff is recorded here rather than discovered later.

Local files, all in `marketing/product-demo/` and all gitignored:

| File | Runtime | Size | Fits |
|---|---|---|---|
| `three-ws-demo.mp4` | 65m50s | 449 MB | Paid X tier only |
| `three-ws-demo-highlights.mp4` | 16m46s | 76 MB | Paid X tier only |
| `three-ws-demo-highlights-03-crypto.mp4` | 1m42s | 6.6 MB | Any account |
| `three-ws-demo-highlights-05-agent-tools.mp4` | 0m57s | 6.3 MB | Any account |
| `three-ws-demo-highlights-06-learn.mp4` | 1m05s | 9.8 MB | Any account |

A standard X account caps a video at 2 minutes 20 seconds and 512 MB, so the full film needs a
subscription tier that raises both. Order of preference: the full film if the account's tier takes
it, the highlights cut if not, and a single chapter under the standard cap as the always-available
fallback with the full film linked in a reply.

**The GCS console link is not shareable.** `storage.cloud.google.com/three-ws-veo/...` is the
authenticated console URL, and the object is private: an anonymous request to the equivalent
`storage.googleapis.com` path returns 403. Do not put that URL in a post. Uploading the mp4 to X
natively is the path that needs no hosting change at all. If the film should also live at a public
URL, the bucket has uniform bucket-level access off and public access prevention inherited, so one
owner-run command publishes the object:

```bash
gcloud storage objects update gs://three-ws-veo/marketing/product-demo/three-ws-demo.mp4 \
  --add-acl-grant=entity=AllUsers,role=READER
```

That is publishing to an external channel and is owner-gated like the post itself.

## Telegram variant

```text
We filmed the whole platform.

three.ws now has a narrated walkthrough of every feature it declares, recorded against the live
production site: 257 stops, not one of them skipped, 65 minutes and 50 seconds at 1080p, in six
chapters (Main, Build, Crypto, Labs, Agent Tools, Learn).

Three things about how it was made:

- Nobody wrote the route. The stops are generated from the same curriculum the in-product Guided
  Tour walks, which is generated from the site's page index. A page that ships tomorrow is in the
  next recording without anyone editing a script.
- Nothing on screen is staged. The marketplace is really searched, the forge really switches
  lanes, an agent really answers, a model really turns under a drag. A page that had broken would
  have landed in the run report as a skipped stop instead of in the film as a still frame. The
  report lists none.
- three.ws narrates three.ws. The voice is the platform's own text to speech lane, the same one
  that speaks for agents.

There is also a 16 minute highlights cut of 18 flagship stops, and every chapter exists as its own
file so one can be watched on its own.

Want the self-guided version instead of the film? A 3D guide walks the same 257 stops on the live
site, paced by you: three.ws/tour
```

## Changelog

**No new entry.** `/docs/product-demo` was added to `data/pages.json` on 2026-09-05, and a new
page's `added` date feeds the changelog automatically. The film is a marketing asset, not a
shipped surface, so a second entry would tell the community something shipped that did not. If the
mp4 is later published at a public URL and linked from a page, that page is the entry.

## Posting

Publishing to an external channel is owner-gated under the operating rules, every time. Nothing in
this pipeline posts. When the owner approves:

```bash
node scripts/post-tweet.mjs --file docs/announcements/product-demo.post.txt --dry-run
```

Drop `--dry-run` to send, with the chosen mp4 attached. The Telegram variant goes to the community
channel by hand; the changelog cron must not be used for it, because this is not a changelog entry.
