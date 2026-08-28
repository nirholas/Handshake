<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-vitals</h1>

<p align="center"><strong>Your agent says it is healthy. It has not done anything in three weeks.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/agent-vitals"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/agent-vitals?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/agent-vitals"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/agent-vitals?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/agent-vitals?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/agent-vitals?color=339933">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-idea">The idea</a> ·
  <a href="#api">API</a> ·
  <a href="#design-rules">Design rules</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

## The story

On 2026-08-28 we audited twelve autonomous trading agents. All twelve reported
armed. The worker was `Ready:True` with `minScale: 1`. The launch feed was
streaming. Every strategy row said `enabled = true`. Every dashboard was green.

Ten of the twelve had not attempted a single action in **weeks**.

Three separate things were wrong, and not one of them was visible to anything
we were measuring:

1. The deployed container predated the commit that moved our model providers off
   decommissioned model IDs, so every rung of the chain answered `404`.
2. The providers behind the surviving rungs were out of credit (`402`) or on a
   billing hold (`403`).
3. Several agent wallets could not fund a single action.

Every existing check was correct and every one of them was useless. Liveness
measures the *process*. Acting requires a chain of preconditions the process
knows nothing about. **The agent was perfectly healthy and structurally
incapable of doing its job.**

This library is what we built so that never takes an afternoon to diagnose again.

## Install

```bash
npm i @three-ws/agent-vitals
```

Zero dependencies. Node 18+. Works in any runtime with `fetch` and `AbortSignal`.

## Quick start

Declare what your agent *needs* in order to act, and how those needs depend on
each other. Then ask.

```js
import { vitals } from '@three-ws/agent-vitals';

const chart = vitals({ agent: 'trader-01' })
  .vital('deploy-fresh', {
    describe: 'the running image is the code we think it is',
    probe: async () => ({
      ok: (await imageAgeDays()) < 7,
      detail: `image is ${await imageAgeDays()} days old`,
    }),
    remedy: 'gcloud builds submit --config worker/cloudbuild.yaml',
  })
  .vital('cognition', {
    describe: 'the agent can reach a model and get a decision',
    needs: ['deploy-fresh'],                    // <- a stale image CAUSES this to fail
    probe: async () => ({ ok: await modelChainAnswers() }),
    remedy: 'top up the model provider credits',
  })
  .vital('solvency', {
    describe: 'the wallet can fund one action',
    probe: async () => ({ ok: balance >= perAction, data: { short: perAction - balance } }),
    remedy: ({ data }) => `send ${data.short.toFixed(4)} SOL to ${wallet}`,
  })
  .capability('trade', { needs: ['cognition', 'solvency'] })
  .capability('exit',  { needs: ['solvency'] });   // exiting needs no model

const verdict = await chart.attest();

verdict.can.trade;        // false
verdict.can.exit;         // true   <- it can still close its open risk
verdict.rootCauses[0].id; // 'deploy-fresh'   NOT 'cognition'
verdict.remedies;         // ['gcloud builds submit --config worker/cloudbuild.yaml']
```

```
> console.log(verdict.explain())

trader-01: cannot trade because cognition is blocked, because deploy-fresh is down (image is 16 days old)
fix: gcloud builds submit --config worker/cloudbuild.yaml
```

That output is the entire product. One sentence, the real cause, and the command.

## The idea

### Health checks report symptoms. This reports causes.

A checklist gives you three red rows and makes a human guess which to chase:

```
✗ decision queue saturated
✗ model chain unreachable
✗ deployment stale
```

Those are not three problems. They are **one problem and two of its
consequences**. `agent-vitals` takes `needs` edges between preconditions, walks
the graph, and returns only the nodes that nothing else explains:

```
ROOT  deploy-fresh is down: image is 16 days old
      fix: gcloud builds submit --config worker/cloudbuild.yaml
      (blocked downstream, not probed: cognition, decision-queue)
```

### A vital behind a failing dependency is never probed

If `deploy-fresh` is down, probing `cognition` only spends a timeout to
rediscover something already known. In the outage that produced this library,
that mistake meant every decision walked ten dead provider rungs before giving
up, which saturated the decision queue, which looked like a *third* independent
fault. Blocked vitals are marked `blocked` and skipped.

### "I could not tell" is never "it is broken"

An unread balance is not a balance of zero. A probe that throws, times out, or
returns no verdict is `unknown`, and `unknown` never becomes `down`. A
capability with an unreadable precondition is `null` (cannot say), not `false`
(cannot act). One flaky RPC call must not page someone to a healthy fleet.

This rule propagates. Blocking on an *unreadable* dependency yields
`blockedSeverity: 'unknown'` and leaves the capability `unknown`; only a block
tracing back to something genuinely `down` makes it `unable`. We shipped that
backwards first, and it reported an agent that had acted sixty seconds earlier
as definitively unable.

### Every failure carries its fix

`remedy` is part of a vital's declaration, and it can be a function that
receives the probe's own `detail` and `data`. `send 0.0437 SOL to D5BGRD…`
is a fix. `solvency: down` is a status page.

### Capabilities are scoped, so partial failure stays partial

`exit` above depends on `solvency` but not `cognition`. When the model chain
dies, the agent correctly reports that it can still close its open positions.
Collapsing that into one "agent unhealthy" bit tells an operator their risk is
stranded when it is not.

## API

### `vitals(opts?) → VitalsChart`

`{ agent?: string, timeoutMs?: number }`. Default per-probe deadline is 10s.

### `.vital(id, spec) → this`

| field | type | meaning |
|---|---|---|
| `probe` | `() => ProbeResult \| Promise<ProbeResult>` | **required.** Return `{ ok, detail?, data? }`, or a bare boolean. |
| `needs` | `string[]` | Vitals that must be `up` before this one is worth probing. |
| `describe` | `string` | What being `up` means, in a sentence. |
| `remedy` | `string \| (ctx) => string` | The fix. The function form receives `{ detail, data }`. |
| `timeoutMs` | `number` | Overrides the chart default for this probe. |

`ok: true` → `up`. `ok: false` → `down`. Anything else (missing, `null`, a
throw, a timeout, a non-result value) → `unknown`.

### `.capability(id, { needs, describe? }) → this`

An action the agent should be able to perform, as an AND over vitals. The
transitive `needs` closure is included automatically.

### `.attest({ signal? }) → Promise<Verdict>`

Probes layer by layer. Everything at one dependency depth runs concurrently.
Throws at call time on a dependency cycle or an edge to an undeclared vital,
with the offending names in the message.

### `Verdict`

| member | type | meaning |
|---|---|---|
| `can` | `Record<string, boolean \| null>` | Per capability. `true` ready, `false` unable, `null` cannot say. |
| `healthy` | `boolean` | Every capability is ready. |
| `rootCauses` | `VitalReport[]` | Deduplicated causes across all failing capabilities, worst first. |
| `remedies` | `string[]` | Distinct fixes, in the same order. |
| `vitals` | `VitalReport[]` | Every reading, including `blocked` ones. |
| `capabilities` | `CapabilityReport[]` | Per capability status, root causes and a one-line `explain`. |
| `vital(id)` | `VitalReport \| null` | One reading by id. |
| `explain()` | `string` | The whole verdict as a paragraph, written to be pasted into an incident channel. |
| `toJSON()` | `object` | Plain and serialisable, answer first. |

A `VitalReport` carries `status`, `detail`, `data`, `remedy`, `needs`,
`blockedBy`, `blockedSeverity` and `ms`.

## Design rules

These are the invariants. Each one is enforced by a test, and each one exists
because getting it wrong produced a wrong answer in production.

1. **Report causes, never symptoms.** A failing vital with a failing dependency
   is not a root cause.
2. **Never probe behind a known failure.** It costs a timeout to learn nothing.
3. **Unreadable is not failed**, at any depth, including through a chain of
   blocks.
4. **A definite failure outranks an unreadable one.** If one precondition is
   genuinely broken, the agent genuinely cannot act.
5. **Every failure carries its fix**, with real values in it.
6. **One cause blocking five capabilities is one work item**, not five.
7. **Pure core, injected I/O.** Graph building, ordering, cycle detection,
   blocking and root-cause resolution are synchronous and side-effect free. The
   whole test suite runs with no network, no clock and no database.

## A note on being wrong

A capability model is a model, and models are wrong. Ours was: the first
revision made every agent depend on deployment freshness, and confidently
reported an agent as unable to act while it was opening positions every few
minutes on the very image being complained about.

So give your ledger a vote. If the graph says `unable` and the agent
demonstrably acted five minutes ago, the graph is wrong, and it should say so
rather than quietly winning the argument against reality. The three.ws
integration ships this as a `contradiction` field; the pattern is worth copying
wherever you have a record of what the agent actually did.

## License

Apache-2.0 · [three.ws](https://three.ws)
