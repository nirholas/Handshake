# Announcement pack: Instant Agent Genesis

**Surface:** [`/genesis`](https://three.ws/genesis) · **Ledger key:** `/genesis` · **Stage:** drafted
· **Shipped:** 2026-06-23 · **Announced externally:** never

Ranked first of 320 never-announced surfaces by `npm run announce:rank` (score 106: sitemap
priority 0.9, showcase, token topic, taggable partner, on the audit's shortlist, backed by a
feature doc). Written against [the announcement voice](../announce-voice.md).

---

## The claim, and where it is checked

> A sentence or a selfie becomes a rigged 3D agent that already owns a custodial Solana wallet
> and a custodial EVM wallet, a synthesized persona, a voice, and an optional on-chain identity,
> in under a minute of active work.

Every part of that is verifiable in the tree, which is the only reason it can be posted:

| Part of the claim | Where it is real |
|---|---|
| Prompt or selfie to a textured 3D body | `POST /api/avatars/reconstruct`, the same pipeline behind `/create/prompt` and `/create/selfie` |
| Rigged, not a T-posed mesh | The pipeline chains an auto-rig job and only surfaces the avatar once it can be animated |
| Custodial Solana wallet and custodial EVM wallet | `POST /api/agents/:id/wallet/provision`, real custodial keys ([Agent Wallets](../agent-wallets.md), [Custody](../custody.md)) |
| Synthesized persona and voice | `POST /api/persona/extract` through the shared free-providers-first LLM chain; voices from `/api/tts/voices` |
| Optional on-chain identity | A real [ERC-8004](../erc8004.md) record returning a real transaction hash, defaulting to Base |
| Under a minute of active work | The flow is a state machine over those production endpoints, with a progress bar driven by real job state |

Full mechanism: [docs/genesis.md](../genesis.md).

## Media

Captured from the live route by `npm run announce:media`. Provenance (route, commit, time, sha256)
is in [`public/announce/media-manifest.json`](../../public/announce/media-manifest.json).

| Shot | File | Notes |
|---|---|---|
| `genesis-hero` | `/announce/img/genesis-hero.webp` | 1800x1013, signed in. The three entry modes and the describe field, which is the whole interface. |

**Alt text, required on the post:**

> The three.ws Genesis page signed in: describe an agent, upload a selfie, or remix a public
> avatar, and it becomes a rigged 3D agent with its own wallet and on-chain identity.

The frame is captured against a signed-in QA session so it shows the working page rather than its
sign-in gate. The nav's account chip is framed out, the same call as the corner promo; the recipe
in [`data/announce-media.json`](../../data/announce-media.json) records it.

## The post

Pattern: mechanism lead. **163 weighted characters**, inside the 100-179 band that measured a 3.0x
lift and the best band reachable in a single post. Tags `@solana` because the agent's primary
wallet is genuinely a Solana wallet, and Solana is the home chain.

Postable file: [`genesis.post.txt`](./genesis.post.txt).

```text
A sentence or a selfie becomes a rigged 3D agent holding its own custodial @solana wallet, a persona, and a voice. It walks and emotes on arrival: three.ws/genesis
```

Ship it with `genesis-hero` attached and the alt text above.

### Why it is written that way

The temptation is "Introducing Instant Agent Genesis", and 213 of our 214 posts have correctly
resisted that opening. The interesting fact here is not that the page exists, it is that the thing
it hands back is already funded, already rigged, and already has a voice. So the post opens on the
mechanism and lets the reader reach "that is a lot for one sentence of input" without being told
to. "It walks and emotes on arrival" is doing specific work: it pre-empts the reasonable
assumption that a generated character arrives as a static T-posed mesh, which is what every other
text-to-3D tool hands back.

Two true details were cut to hold the band: the second custodial wallet on Base, and the optional
ERC-8004 identity returning a real transaction hash. Both are in the Telegram variant, where there
is room. Cutting them is a length decision, not a hedge; neither is in doubt.

## Telegram variant

Plain text for the community channel. No tagging, no character ceiling worth managing, more
mechanism, and it says what to do with the thing.

```text
Instant Agent Genesis is live at three.ws/genesis, and it has never been posted about.

Give it a sentence, a selfie, or a public avatar to remix. What comes back is a full agent, not a
model file:

- A textured 3D body off the same reconstruction pipeline /create uses, auto-rigged so it walks
  and emotes immediately rather than arriving in a T-pose.
- Its own custodial Solana wallet and its own custodial EVM wallet, provisioned as part of the
  flow. Real custodial keys, not placeholders.
- A persona synthesized from your description, and a voice you pick.
- Optionally, a real ERC-8004 on-chain identity that returns a real transaction hash.

Under a minute of active work, and the agent is yours: it plugs straight into Agent Studio, the
economy, breeding, and every embed surface.

three.ws/genesis
```

## Changelog

**No new entry.** Genesis was already logged on 2026-06-23 ("Instant Agent Genesis: a selfie or a
sentence becomes a funded, on-chain 3D agent in under a minute"). This pack announces an existing
feature externally for the first time; it ships nothing new, so adding an entry would tell the
community something shipped today that did not.

## Posting

Publishing to an external channel is owner-gated under the operating rules, every time. Nothing in
this pipeline posts. When the owner approves:

```bash
node scripts/post-tweet.mjs --file docs/announcements/genesis.post.txt --dry-run
```

Drop `--dry-run` to send. The Telegram variant goes to the community channel by hand; the
changelog cron must not be used for it, because this is not a changelog entry.
