Everything in this course has been real, run code. This capstone is about the last mile: getting what you built in front of actual users, and the checklist to walk before you let it touch mainnet with real money.

## Deploying a static app: GitHub Pages

If what you built is client-side — a ticker, a portfolio dashboard, anything using only `hood.public` reads (Tutorials 2, 4, 5, 7) — it needs no backend at all. This very site is the reference example: it's a static build in `docs/`, deployed from a branch.

**One-time setup:**

1. Push your repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: "Deploy from a branch."**
3. Branch: `main`, folder: `/docs`. Save.
4. Your site is live at `https://<username>.github.io/<repo>/` within a minute or two.

That's the entire deployment. No build step runs on GitHub's infrastructure — you commit the already-built `docs/` folder, exactly as this repo does. Re-deploying is `npm run build && git add docs && git commit && git push`.

:::tip Why deploy-from-branch instead of a GitHub Actions build
It's simpler, it's faster (no CI queue), and it means what's live is *exactly* what you built and tested locally — no environment drift between your machine and a CI runner. The tradeoff is you must remember to run the build before committing; a pre-commit hook or a habit covers that.
:::

### RPC calls from a static site

A pure static deploy still makes real, live RPC calls — straight from the visitor's browser to `rpc.mainnet.chain.robinhood.com`, exactly like this site's [live chain-stats strip](../) does. That's the whole trick behind "the landing page can show live data on GitHub Pages": public reads need no server. The only thing you can't do from a static site is anything requiring a private key or server-side secret — which brings us to Cloud Run.

## Deploying a server: Google Cloud Run

The moment your app needs a wallet key (an agent, Tutorial 10), verifies payments server-side (the x402 API, Tutorial 8), or holds any other secret, it needs a real backend. Google Cloud Run is a strong default: pay-per-request, scales to zero, and a straightforward `Dockerfile` gets you there.

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
```

Two things Cloud Run requires that are easy to miss the first time:

- **Listen on `process.env.PORT`**, not a hardcoded port. Cloud Run injects `PORT` (usually `8080`) and routes traffic there — a hardcoded `3000` will silently fail health checks.
- **Bind to `0.0.0.0`, not `localhost`.** `app.listen(port)` defaults to all interfaces in Express and is fine; some frameworks default to loopback-only, which Cloud Run can't reach.

Deploy:

```bash
gcloud run deploy my-robinhood-app \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars PAYOUT_ADDRESS=0xYourAddress
```

**Never bake a private key into the container image or set it with `--set-env-vars` in a command you'll paste into a README.** Use `gcloud run services update --update-secrets` backed by Secret Manager, or your platform's equivalent secret store — the difference between an env var and a secret-manager binding is the difference between a key that leaks the moment someone reads your shell history and one that doesn't.

## An alternative: Vercel

If your app is a standard Next.js/Vite frontend with lightweight serverless API routes, Vercel remains a fine choice for the same static-plus-functions shape — deploy with `vercel --prod` after `vercel link`. Prefer Cloud Run specifically once you have a long-running process (an always-on trading agent, a WebSocket firehose consumer) — Vercel's serverless functions are request-scoped and will terminate a background loop between invocations.

## The going-mainnet checklist

Everything below was demonstrated somewhere in this course. This is the assembled version — walk it in order before flipping any switch that spends real money.

### Funding
- [ ] The wallet holds **only** what you're prepared to lose during the first live days (Tutorial 10) — not your full intended capital.
- [ ] You've verified the wallet's mainnet ETH balance covers gas for your expected transaction volume; Robinhood Chain's ~100ms blocks mean a busy agent can rack up transaction count fast.

### Keys
- [ ] The private key lives in a secret manager or env var injected at runtime — never in source, never in a Docker image layer, never in a README example with a real value (Tutorial 6, 10, 12).
- [ ] `.env` and any key file are in `.gitignore`, and you've confirmed with `git status` that nothing sensitive is staged before your first push.

### Spend caps
- [ ] Per-transaction and per-period spend caps are enforced in code, not just "the strategy wouldn't do that" (Tutorial 10) — assume the strategy has a bug.
- [ ] A kill switch exists, is tested, and stops the process **between** operations rather than mid-transaction (Tutorial 10).

### Compliance
- [ ] Any flow that can acquire a Stock Token has the eligibility gate active by default, and `acknowledgeStockTokenEligibility: true` is set only after genuine confirmation of operator eligibility — never flipped on reflexively to silence an error (Tutorial 1, 6).
- [ ] Untrusted on-chain data (token names, memos, launch metadata) is escaped before rendering and never interpreted as an instruction to an agent or LLM (Tutorial 1, 11).

### Correctness
- [ ] Portfolio and pricing code follows the multiplier rule exactly — value is `balance × feed price`, never `balance × multiplier × feed price` (Tutorial 3, 5).
- [ ] Staleness windows account for the 24/5 market schedule; a tight window won't falsely flag every weekend read as broken (Tutorial 3, 4).
- [ ] Payment or transaction verification decodes actual event arguments (recipient, amount) rather than checking "a log exists" — Tutorial 8 documents a real bug of exactly this shape that was caught and fixed while writing this course.

### Infrastructure
- [ ] You're on a dedicated RPC (Alchemy or equivalent) for anything beyond light, occasional reads — the public RPC rate-limits wide scans (Tutorial 2, 7) and a production agent hitting `429`s is a production agent silently missing data.
- [ ] Logs capture every decision an autonomous component makes, with enough detail to reconstruct "why did it do that" after the fact (Tutorial 10).
- [ ] Secrets are in a secret manager, not env vars set from a shell command that lands in history or CI logs.

### Monitoring
- [ ] You have a way to know the agent/service is still running — a heartbeat, a health check endpoint, or an external uptime check — not just "I'll notice if it stops."
- [ ] Failed transactions and thrown errors are surfaced somewhere you'll actually see them (a log aggregator, an alert), not just printed to a terminal that isn't open.

## Where to go from here

You've built, in order: a correct mental model, a first read, the multiplier rule, a live ticker, a portfolio tracker, a working swap, two live streams, a paid API (with a real bug caught and fixed), a working MCP server, a risk-controlled paper-trading agent, and an honest account of the launch-write gap. That's the full stack of a serious Robinhood Chain application. The [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) that powered all of it is open source — read its source when you need to go deeper than any tutorial here, and consider contributing back (the launch-ABI gap from Tutorial 11 is a real, well-scoped next PR for someone with more time to reverse-engineer it responsibly).

Build something worth screenshotting.
