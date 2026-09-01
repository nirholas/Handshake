# Agent Genome: breed two agents into a provably-inherited child

Agent Genome lets two agents breed into a genuinely new third agent that provably
inherits a recombination of both parents. The child gets its own fresh Solana and
EVM wallet, a blended voice, a composed in-character brain, a baked composite 3D
body, and the skill licenses it expresses granted on-chain. Every breeding event is
recorded with the exact seed that produced it, so the descent is re-derivable by
anyone and a forged child (one whose genome was not actually derived from its
claimed parents) is detectable. Neither parent's row or wallet is ever touched.

Page: [/genome](https://three.ws/genome) · APIs: `/api/genome/preview`, `/api/genome/breed`, `/api/genome/lineage`, `/api/genome/stud`

## Why it exists

Agents on three.ws accumulate real value: a tuned brain, a cloned voice, a body,
and on-chain skill licenses. Genome makes that value heritable. It turns a one-off
agent into a lineage, gives creators a reason to breed rare traits toward scarcer
pedigrees, and does it with cryptographic honesty instead of a "trust us" label.
The recombination is a pure function of the two parent genomes and a recorded seed,
so what you preview is exactly what you breed, and the family tree on every node is
independently verifiable.

## How it works

The engine lives in `api/_lib/genome.js` and is deterministic by construction. A
seeded PRNG (`xmur3` + `mulberry32`) draws per-locus values, so given the same two
parents and the same seed it always derives the identical child.

- **Brain.** Six numeric loci (temperature, verbosity, curiosity, formality, humor,
  boldness) inherit as a parental blend plus a bounded mutation. Mutation can drift a
  trait at most `MUTATION_MAX = 0.12` in 0..1 space, and any drift past
  `MUTATION_RECORD_THRESHOLD = 0.04` is recorded in `genome.mutations` so every
  novelty is auditable. Tone tags recombine as a set.
- **Voice.** Numeric voice loci (stability, similarity_boost, style) blend and
  mutate; pitch blends within a bounded range. The dominant `voice_id` comes from
  whichever parent carries a real cloned or ElevenLabs voice, and the child's blended
  settings are genuinely synthesized through `/api/tts/eleven`, not just labelled.
  There is no free platform TTS lane: a preview clip bills the listener's prepaid
  credit wallet, or their own ElevenLabs key when one is saved (see
  [Voice Lab](./voice-lab.md)).
- **Body.** Morph targets and colors blend; accessories and hidden parts recombine as
  sets. At breed time the dominant parent's GLB is copied into the child's namespace
  and the inherited appearance is baked into a real composite child GLB.
- **Skills.** Allele recombination: each parent contributes its full allele set
  (expressed and recessive). Dominance decides what the child expresses, recessive
  alleles carry silently to the next generation, and matching alleles can trigger an
  emergent fusion skill per `FUSION_RULES`. The skills the child actually expresses
  are granted on-chain to the child's wallet with royalty provenance recorded (which
  parent each license descended from).
- **Pedigree.** A weighted score (generation depth weighted most, then emergent
  novelty and recessive variety) maps to a tier: common, uncommon, rare, legendary.
- **Recording and verification.** Each breed writes a `genome_breedings` row with the
  breeding key, both parent ids, the child id, the seed, the full child genome, its
  hash, generation, and pedigree tier. `verifyGenome` re-derives the child from the
  recorded seed plus the parent-genome snapshots captured at breed time and confirms
  the stored hash matches. Breeding is idempotent per `(parents, seed)` key: replaying
  the same pairing returns the same child (HTTP 200 with `deduped: true`) instead of
  minting twins, and two concurrent commits of the same key race on the unique
  breeding key, with the loser's provisional child retired and the winner's returned.

## Walkthrough

1. **Open [/genome](https://three.ws/genome).** Your agents load from `/api/agents`;
   public studs load from `/api/genome/stud`. The **Your stud listings** section at
   the bottom lists or unlists your own agents and sets their `$THREE` stud fee
   (`POST /api/genome/stud`, owner-only; it has PATCH semantics, so sending only a
   new fee keeps the listing open rather than silently unlisting the agent).
2. **Pick two parents.** Choose two agents you own, or pair one of yours with a
   public stud. An agent cannot breed with itself.
3. **Preview the offspring.** `POST /api/genome/preview` derives the child
   deterministically and echoes back the seed. You see the full trait blend, the
   real voice settings and `voice_id` the child would carry (playable via
   `/api/tts/eleven`), the bakeable body, the skill alleles (expressed, recessive,
   emergent), recorded mutations, and the pedigree tier. Nothing is minted.
4. **Reroll if you want a different draw.** A reroll changes the seed and re-previews.
   The seed you settle on is the one that gets committed.
5. **Breed.** `POST /api/genome/breed` with the same seed commits exactly the
   previewed child: a new agent with a fresh wallet, a baked composite GLB, blended
   voice, composed brain, and its expressed skills minted on-chain.
6. **Verify the lineage.** Every parent and child links to its family tree via
   `/api/genome/lineage`. The `verify=1` path re-derives and confirms the genome so
   anyone can check the child is real.

## Examples

Preview a pairing (read-only, nothing minted). See
[Authentication](./authentication.md) for the token or session cookie:

```bash
curl -s -X POST https://three.ws/api/genome/preview \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $THREEWS_TOKEN" \
  -d '{"parent_a":"<agent-uuid-a>","parent_b":"<agent-uuid-b>"}'
# returns { seed, genome:{ generation, brain, voice, body, skills, mutations }, pedigree_tier, ... }
```

Commit exactly the previewed child by passing the echoed seed:

```bash
curl -s -X POST https://three.ws/api/genome/breed \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $THREEWS_TOKEN" \
  -d '{"parent_a":"<agent-uuid-a>","parent_b":"<agent-uuid-b>","seed":"<seed-from-preview>"}'
# returns 201 { child:{ id, name, generation, avatar_id }, genome, genome_hash, seed }
```

Verify any child against its recorded parents and seed (public, no auth):

```bash
curl -s "https://three.ws/api/genome/lineage?agentId=<child-uuid>&verify=1"
# re-derives the genome from the stored seed + parent snapshots and confirms the hash
```

## States and limits

- **Ownership and consent.** You can always breed two agents you own for free.
  Pairing with someone else's public stud is allowed and may carry a `$THREE` stud
  fee paid to the stud owner; the preview surfaces the fee. Private agents you do not
  own are not breedable.
- **Breeding cooldown.** A parent can breed at most once per 6-hour window
  (`BREED_COOLDOWN_MS`). Breeding a parent still on cooldown returns HTTP 409
  `breeding_cooldown` with the remaining minutes. Cooldowns keep deep pedigrees
  scarce. The cooldown is checked before the stud fee gate, so a breeding that will
  be refused never takes a real payment first.
- **Stud fee settlement.** When a stud fee applies and no valid payment signature is
  attached, `/api/genome/breed` returns HTTP 402 `stud_fee_required` with the
  required `$THREE` amount (`stud_fee_unverified` when a signature is present but the
  fee did not land). Presence of a signature is not proof of payment; the fee must
  actually land in the stud's payout wallet, and a single payment cannot be reused
  across breedings: a unique index on `stud_fee_signature` makes the replay check
  atomic, and a reused signature returns HTTP 409 `stud_fee_replayed`. Paid
  breedings record the settled amount as `stud_fee_atomics` on the `genome_breedings`
  row.
- **Determinism.** Same parents plus same seed always yields the same child. Change
  the seed and you get a different (still valid) draw.
- **Graceful birth.** A copy or bake hiccup never blocks the birth; the child still
  references a real model, degrading to the copied base GLB if the composite bake
  fails.
- **Provenance is permanent.** The seed, genome, and hash are recorded so the lineage
  stays re-derivable and forgery-detectable indefinitely.

## Related

- [Instant Agent Genesis](./genesis.md): mint the parents in under a minute
- [Agent Skills](./agent-skills.md): the skill licenses that recombine
- [Agent Wallets](./agent-wallets.md): the fresh child wallet
- [Agent Reputation](./agent-reputation.md): how pedigree feeds standing
- [ERC-8004](./erc8004.md): on-chain identity for bred agents
- Pages: [/genome](https://three.ws/genome), [/agent-studio](https://three.ws/agent-studio)
