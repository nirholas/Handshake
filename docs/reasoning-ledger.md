# The Reasoning Ledger: hash-chained agent decisions you can audit

Every consequential call a three.ws agent makes (what it decided, why, what it predicted, and what actually happened) is appended to a per-agent, hash-chained ledger. The decision is committed at the moment it is made; the outcome is reconciled later against real on-chain data and stored separately, so a record can never be rewritten to flatter the agent. Being wrong is exactly as visible as being right: honesty is the trust signal.

Browse it at [three.ws/ledger](https://three.ws/ledger). The page is per-agent (`/ledger/<agentId>`, or `/reasoning-ledger?agent=<id>`): a filterable decision timeline, a transparent reputation score with a "how is this computed" drill-down, a calibration chart, and a verification badge that re-checks the chain and its on-chain anchor on demand.

## What a ledger entry contains

Each entry in `agent_decisions` commits, at decision time:

- `seq`: the entry's 1-based position in the agent's chain
- `kind`: what sort of decision (e.g. `snipe`, `optimize`)
- `subject_ref` / `action_ref`: what the decision was about (a token mint, a strategy id) and the concrete action it produced (a position id)
- `inputs`: the evidence in front of the agent (trigger, firewall verdict and score, price impact, size, model thesis)
- `rationale`: a plain-language explanation of why
- `prediction`: a falsifiable claim (direction, basis, metric)
- `confidence`: 0 to 1, self-rated and later scored against reality
- `network` and `decided_at`
- `prev_hash` and `entry_hash`: the chain links (below)

The outcome lives in a separate table, `decision_outcomes`, written only when ground truth arrives: what was observed (realized P&L in SOL and percent, the sell signature, the exit reason), `was_correct`, and when it was reconciled. Reconciled entries on the page show a right/wrong chip, the exact P&L, and an explorer link to the on-chain proof.

## How the hash chain makes tampering evident

The chain construction lives in `api/_lib/reasoning-ledger.js`:

- Each agent's chain starts from a **genesis hash bound to that agent's id** (`threews-reasoning-ledger:v1:<agentId>`), so one agent's history cannot be spliced onto another's.
- Every entry is serialized to a **canonical form**: object keys sorted recursively, confidence at fixed precision, timestamps normalized, so the hash is reproducible after a database round-trip.
- `entry_hash = sha256(prev_hash + separator + canonical(entry))`. Each entry commits to the one before it, so the head hash commits to the entire history.
- **Only decision-time fields are hashed, never the outcome.** Reconciling a decision cannot alter its hash, and neither can anyone "fixing" a bad call after the fact.

The consequences, each detectable and pinpointed to a specific `seq`:

- Editing any committed field breaks that entry's own hash.
- Deleting or inserting an entry breaks the next entry's `prev_hash` link (or leaves a sequence gap).
- Rewriting the whole chain produces a new head, which no longer matches the head committed on-chain.

That last check is the anchor: on a schedule, each agent's current chain head is written to Solana as a signed SPL-Memo transaction (kind `threews.ledger.v1`, recorded in `ledger_anchors`). Because the head commits to the whole prefix, anchoring one hash is a tamper proof for the entire history up to that point. Anchoring is best-effort by contract: without a funded attester key the commitment is recorded locally as pending, and the chain's cryptographic tamper-evidence holds regardless; only the independent on-chain timestamp is deferred.

## Verifying a ledger yourself

```bash
curl "https://three.ws/api/ledger/verify/<agentId>"
```

Public, no account. The verifier trusts **no stored hash**: it recomputes every `entry_hash` from the committed fields, checks every `prev_hash` link and the sequence, then compares the recomputed head against the latest on-chain anchor. Statuses:

- `verified`: chain intact and the head matches the on-chain anchor (the response includes the anchor transaction and explorer link)
- `verified_unanchored`: chain intact, on-chain commitment still pending
- `verification_failed`: a tamper or inconsistency was found; `chain.broken_at` names the exact entry and `chain.reason` says what broke
- `empty`: no decisions recorded yet

The ledger page runs this same check and renders it as the verification badge; clicking it re-verifies live.

The timeline itself is public too:

```bash
curl "https://three.ws/api/ledger/<agentId>?limit=50&kind=snipe&q=firewall"
```

It returns the agent, the reputation breakdown, the latest anchor summary, and the paginated decisions with outcomes (`before=<seq>` pages older entries).

## Who writes entries

There is a single write path, `recordDecision`, and it is a chokepoint by design: appends are idempotent per real-world action (a handler that fires twice records once) and concurrency-safe when claiming the next chain slot. Today's writers, as coded:

- **The [Agent Sniper](agent-sniper.md) executor** appends a `snipe` entry the moment a buy settles: trigger, firewall verdict, price impact, committed size, the buy signature, and (for LLM-judged arms) the model's thesis and confidence.
- **The sniper optimizer cron** appends an `optimize` entry whenever it auto-tunes a strategy from realized outcomes, so the self-tuning loop's own decisions are auditable next to the trades that drove them.
- **The reconcile cron** (`api/cron/reconcile-decisions`) writes no decisions; it closes the loop. When a linked position settles on-chain, it records the outcome against the sell signature (idempotently, so re-runs never double-count), then anchors each agent's advanced chain head, and raises an ops alert if a sizeable track record's hit rate collapses.

Any subsystem that makes a consequential agent decision can adopt the same write path; the page's filters already anticipate more kinds than the sniper pipeline emits today.

## The reputation score is explainable, not a black box

The headline score (0 to 100) is derived only from reconciled outcomes, and the API returns the full formula next to the number: 50% hit rate, 30% calibration (1 minus expected calibration error: do 80%-confidence calls hit about 80% of the time?), 20% realized P&L squashed to a 0-1 range, regressed toward neutral until the agent has 20 reconciled decisions. Every component ships with its raw value, weight, and contribution, and the calibration chart plots predicted confidence against actual hit rate per band.

## Related

- [Agent Sniper](agent-sniper.md): the pipeline that writes `snipe` entries, with a live case-study ledger
- [Custody you can verify](custody.md): the same provable-not-promised approach applied to the wallets these decisions spend from
