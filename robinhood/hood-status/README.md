# hood-status

**The status page for Robinhood Chain.** Nobody ran one; every "is Robinhood Chain down?" search
now has an answer backed by real probes, published thresholds, and a front end that keeps working
even when its own backend does not.

Two pieces:

- **Probe worker** (`worker/`): a small Node service that measures the public chain surface every
  30 seconds, keeps a rolling 90 days of samples in SQLite, detects incidents with a
  flap-suppressed state machine, and serves JSON + an SVG badge over CORS-open HTTP.
- **Static front end** (`docs/`): the classic status-page layout (overall banner, per-component
  rows, 90-day uptime bars, latency sparklines, incident timeline) as plain HTML/CSS/JS, deployable
  on GitHub Pages. If the worker is unreachable the page flips to **direct probe mode** and
  measures the chain from the visitor's browser with the same thresholds. It is never a dead page.

## Website

The static front end in [`docs/`](./docs) is served at **https://nirholas.github.io/hood-status/**.
The landing page draws every monitored surface onto a live **seismograph roll** (RPC, block
production, the sequencer feed, settlement lag, gas, Chainlink freshness) redrawn every frame;
trip the controls to watch the flap-suppressed incident machine open, escalate, and resolve an
incident in real time. The signal is a self-contained synthetic demo, clearly labelled as such;
deploy the worker for live probes. Zero external requests, works from `file://`.

Deploy your own copy (publishes the `docs/` folder as a static site):

[![Deploy to Cloudflare Pages](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nirholas/hood-status)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/nirholas/hood-status)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nirholas/hood-status)

## What is monitored

| Component | Probe | Source |
| --- | --- | --- |
| Public RPC | `eth_blockNumber` round-trip latency and availability | `rpc.mainnet.chain.robinhood.com` |
| Alchemy RPC (optional) | same, when `ALCHEMY_API_KEY` is set | `robinhood-mainnet.g.alchemy.com` |
| Block production | height progression, blocks/min, head timestamp age | latest block via RPC |
| Sequencer feed | WebSocket connect, message rate, sequence lag vs RPC head | `feed.mainnet.chain.robinhood.com` |
| Settlement (L1 view) | latest block's `l1BlockNumber` vs the real Ethereum head | chain RPC + any public L1 RPC |
| Blockscout explorer | `GET /api/v2/stats` availability and latency | `robinhoodchain.blockscout.com` |
| Chainlink stock feeds | `latestRoundData()` age on AAPL, TSLA, NVDA, MSFT, AMZN, market-hours aware | verified feed addresses from [robinhood-chain-sdk](../robinhood-chain-sdk) |
| Gas | base fee current / p50 / p95 over the last 128 blocks (informational, never an incident) | `eth_feeHistory` |

Every rule (what counts as degraded, what counts as down, flap suppression, the honest
limitations) is published on the [methodology page](docs/methodology.html). The thresholds live in
[`docs/assets/status-core.js`](docs/assets/status-core.js), one module imported by the worker, the
browser fallback, and the test suite, so the page can never drift from the code.

## Quickstart

```bash
npm install
npm start            # probe worker on :8080, SQLite in ./data/
npm run serve:docs   # front end on :4663
```

Open `http://localhost:4663/?worker=http://localhost:8080` to see the full worker-backed page, or
just open `docs/index.html` from disk for direct-probe mode (no backend at all).

Run the tests:

```bash
npm test
```

## HTTP API (worker)

All endpoints are `GET`, CORS `*`, JSON unless noted.

| Endpoint | Returns |
| --- | --- |
| `/api/status` | overall + per-component status, current metrics, 90-day daily uptime, open and recent incidents |
| `/api/history?metric=rpc_public&window=24h` | bucketed series `{t, samples, okRatio, avg, min, max}`. Windows: `1h`, `6h`, `24h`, `7d`, `90d`. Metrics: `rpc_public`, `rpc_alchemy`, `block_height`, `blocks_per_min`, `feed`, `settlement_lag`, `blockscout`, `gas_basefee`, `chainlink` |
| `/badge.svg` | SVG status badge for the overall status. `?component=feed` for one component, `?label=...` to relabel |
| `/embed.js` | drop-in status pill widget (see below) |
| `/healthz` | liveness + sample count |

### Badge

```markdown
![Robinhood Chain status](https://YOUR-WORKER-URL/badge.svg)
```

Renders a shields-style badge (operational / degraded / down / unknown) that any README can
embed, including the other repos in this family (hood-js, hoodkit, hood-cli, hood-mcp, ...).

### Embeddable status pill

```html
<div data-hood-status></div>
<script src="https://YOUR-WORKER-URL/embed.js" data-page="https://YOUR-PAGES-URL" defer></script>
```

Shows a live "Robinhood Chain: operational" pill linking to the status page, refreshed every
minute, with an honest "unreachable" state when the worker is down.

## Front-end configuration

`docs/config.js` holds the deployment config. Set `workerUrl` to the deployed worker origin after
the Cloud Run deploy; leave it `''` to run the page in permanent direct-probe mode. Visitors can
also override per-visit with `?worker=https://...` (useful for testing a staging worker), which is
how the local quickstart wires the two halves together.

## Deploying

### Worker on Cloud Run

```bash
gcloud run deploy hood-status \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --memory 256Mi
```

- `--min-instances 1` is required: the prober must run continuously, not scale to zero.
- `--max-instances 1` keeps one SQLite writer. This worker is a single-vantage prober by design;
  do not shard it behind a load balancer.
- Or build the image yourself: `docker build -t hood-status . && docker run -p 8080:8080 hood-status`.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/hood-status.sqlite` (`/data/...` in Docker) | SQLite location |
| `PROBE_INTERVAL_MS` | `30000` | probe cadence |
| `CHAINLINK_INTERVAL_MS` | `300000` | Chainlink freshness sampling cadence |
| `RETENTION_DAYS` | `90` | rolling sample retention |
| `INCIDENT_RETENTION_DAYS` | `180` | closed-incident retention |
| `RPC_URL` | public mainnet RPC | override the probed RPC |
| `ALCHEMY_API_KEY` | unset | adds the Alchemy RPC as a monitored component |
| `FEED_URL` | public sequencer feed | override |
| `BLOCKSCOUT_URL` | public Blockscout | override |
| `L1_RPC_URL` | `ethereum-rpc.publicnode.com` | any Ethereum mainnet RPC (only `eth_blockNumber` is called) |

No secrets are required. Nothing here ever signs or sends a transaction; every call is read-only.

### Data retention, honestly

Samples older than `RETENTION_DAYS` are pruned hourly. On Cloud Run the SQLite file lives on the
instance filesystem, which is ephemeral: **a redeploy or instance replacement resets history.**
The front end detects a young worker and says so ("uptime bars fill in as the window
accumulates") instead of painting unknown days green. If you need history that survives
redeploys, run the container somewhere with a persistent disk (a $4 VM outlives most status
pages) and keep Cloud Run as the probe of last resort.

### Front end on GitHub Pages

One-time setup: repository Settings, then Pages, then deploy from branch `main`, folder `/docs`.
After the worker deploy, set `workerUrl` in `docs/config.js` and push. The page works before,
during, and after that step; it just gains history when the worker URL lands.

## Architecture notes

- **One thresholds module.** `docs/assets/status-core.js` exports the evaluators, the market-hours
  logic, and the `IncidentMachine`. The worker imports it, the browser imports it, vitest covers
  it. The methodology page's table is a rendering of that file.
- **No fake green.** Failed probes report `unknown`, not operational. Days without data render
  gray. The Chainlink component knows US market hours (DST-correct) and treats weekend staleness
  as expected; because it ships no holiday calendar it caps at degraded, and the methodology page
  says exactly that.
- **Flap suppression.** 3 consecutive bad cycles open an incident, 4 consecutive good ones close
  it, severity changes are recorded on the open incident, and `unknown` never opens or closes
  anything. The worker resumes open incidents across restarts instead of silently closing them.
- **Settlement heartbeat without privileged infra.** Every Arbitrum-lineage block records the
  parent-chain block the sequencer ingested. Comparing that against an independent Ethereum RPC
  detects a stalled bridge path (deposits stall first) with two `eth_blockNumber`-class calls.

## Repo layout

```
worker/src/        probe worker (config, db, probes, feed watcher, incident wiring, HTTP)
docs/              static front end: index.html, methodology.html, config.js, assets/
docs/assets/status-core.js   shared thresholds + incident machine (worker + browser + tests)
tests/             vitest: incident machine, thresholds, badge, store/history, feed parsing
scripts/           local static server for docs/
Dockerfile         worker container (Cloud Run ready)
```

## License

All rights reserved. See [LICENSE](./LICENSE).

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
