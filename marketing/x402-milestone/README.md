# x402 milestone video

A 25-second cinematic stats film for the x402 economy's first 25 days on Solana
mainnet: days, payments settled, distinct endpoints paid, all through our own
facilitator. Built for X, Telegram and the holder channel.

The footage is generated with Vertex AI Veo 3. The numbers are not: Veo renders
text as garbled pseudo-glyphs and cannot be trusted with a figure like `59,173`.
So the video is two layers composited together.

| Layer | Produced by | Why |
| --- | --- | --- |
| Background | Veo 3, one 8s clip per beat | Cinematic b-roll no stock library has |
| Foreground | Headless Chrome rendering this site's real webfonts, one transparent PNG per frame | Vector-crisp type, and the figures count up instead of sitting still |
| Composite | ffmpeg: cover-fit, exposure/vignette pass, overlay, 0.5s crossfades | Legibility over bright footage |

## The figures are read from the database, never typed

[`scripts/x402-milestone-stats.mjs`](../../scripts/x402-milestone-stats.mjs)
queries the facilitator's own logs (`x402_self_facilitator_log`,
`x402_ring_ledger`, `x402_autonomous_log`) and the video script consumes its
JSON directly. The video therefore cannot drift from the database. Run the stats
script on its own any time to see the current figures:

```bash
node --env-file=.env scripts/x402-milestone-stats.mjs
```

Each figure and the query that proves it are documented in the header of that
file. Two definitions worth knowing before quoting them publicly:

- **Payments settled** counts `action='settle' AND ok` rows. Verifies are
  excluded; a verify is a quote, not a payment. This is the figure the video
  shows (owner decision, 2026-07-28).
- **On-chain transactions** is `COUNT(DISTINCT tx_sig)` and is materially lower.
  Never present the two as the same number, and never label the payments figure
  "on-chain transactions". See below.

The script also prints the network breakdown, which is what substantiates the
"all on Solana mainnet" claim rather than assuming it.

### The duplicate-signature finding (read before writing any caption)

21% of settle rows share a `tx_sig` with another row: 59,307 rows resolve to
46,624 distinct signatures. This is **not** batching. Two of the shared
transactions were pulled from mainnet on 2026-07-28 and each contains exactly
one SPL token transfer of 1,000 atomic units, yet nine settle rows with nine
distinct idempotency keys were logged against each, seconds apart:

```
5h7Ts4Heg2VcTp91yT14bzXn3AsbVkqfYcabFZfNCUm9JHK6f4NRYhMqggb1TjQcHtAincGtNAyQFgyvqwLb76pw
Ft2uxNa1uvTFZ4eAd6ASjcd8desRzRzxu9xX3NEWKDjYrWHrTAnwUamAuwwo6oU8c56KE58joZnz4LtrhW2UuDX
```

Summed, the log implies 1,103.444 USDC moved; the unique signatures account for
1,027.424 USDC, a 76.019 USDC overstatement. `x402-milestone-stats.mjs` prints a
warning with the live numbers on every run.

Two consequences. For copy: "payments settled" is a claim about the
facilitator's own settlement operations and is what the video says; a claim of
one chain transaction per payment would not survive an explorer check. For
engineering: the settle path is returning an already-used signature for distinct
payment requests, meaning some paid requests were served without their own
settlement. That is a live correctness bug, tracked separately from this video.

## Files

- `x402-milestone.mp4` - the rendered film, 1920x1080, 30fps, 25.1s, silent.
- `x402-milestone-vertical.mp4` - 1080x1920 cut for stories/Reels, from
  natively-generated 9:16 footage (not a center crop of the horizontal).
- `stats-snapshot.json` - the pinned figures both cuts were rendered from, so
  the two formats cannot disagree and the published numbers stay reproducible.
- `other-session-*.mp4` - a different cut of this asset that a concurrent agent
  session wrote to the same paths mid-render. Kept rather than deleted; it uses
  the on-chain figure and different copy. Delete once its owner has landed.

Source clips are kept in `gs://three-ws-veo/x402-milestone*/` so a re-cut does
not require re-paying for generation.

## Re-render

Both steps need `gcloud` auth (`gcloud auth login`) because Veo runs on Vertex
AI. Generation takes 2-4 minutes; compositing takes 2-3 minutes.

```bash
# 1. b-roll -> GCS + local files (only needed if you want new footage)
node scripts/veo-generate.mjs --file prompts.json --download /tmp/veo-clips

# 2. overlay + composite, pulling live figures from the DB
node --env-file=.env scripts/x402-milestone-video.mjs
node --env-file=.env scripts/x402-milestone-video.mjs --vertical
```

To re-cut with an older snapshot instead of live numbers:

```bash
node --env-file=.env scripts/x402-milestone-video.mjs \
  --stats '{"paymentsSettled":55195,"onchainTxs":43856,"distinctEndpoints":3384,"spanDaysWhole":25}'
```

The storyboard (beat order, copy, timing) is the `storyboard()` function in
[`scripts/x402-milestone-video.mjs`](../../scripts/x402-milestone-video.mjs).
One Veo clip per beat, in order; a missing clip is a hard error rather than a
silently reused shot.

## Writing the copy

`x402_self_facilitator_log` records our own ring economy: a small number of
agent wallets paying our own endpoints. The payments, the signatures and the
SOL spent are all real, and "our facilitator settled N payments in 25 days" is
a defensible infrastructure claim. Framing the same number as third-party market
demand is not. Check `distinctPayers` / `distinctRecipients` in the stats output
before writing any caption that implies external demand.
