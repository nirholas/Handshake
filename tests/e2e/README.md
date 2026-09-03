# Browser end-to-end specs (Playwright)

Real-Chromium specs that drive product UI against the Vite dev server. Kept
separate from Vitest (which only globs `*.test.js`) by the `.spec.js` suffix and
`testDir: tests/e2e` in [`playwright.config.js`](../../playwright.config.js).

## Running

```bash
# whole suite (Vitest unit + Playwright e2e)
npm test

# just the browser specs
npm run test:e2e                                  # = playwright test

# one spec, fast iteration (no retries, single worker)
npx playwright test tests/e2e/launch-token-flow.spec.js --retries=0 --workers=1
npx playwright test tests/e2e/coin-buy-trade.spec.js   --retries=0 --workers=1
```

### Pre-start the dev server (avoids cold-start flakiness)

`playwright.config.js` will start `npm run dev` itself, but a cold Vite server
plus the first transform of the Solana/pump SDK module graph can take 30–60s. To
keep that cost out of the per-test budget, **pre-start a dedicated dev server**
and let Playwright reuse it (`reuseExistingServer` is on when `CI` is unset):

```bash
npm run dev            # leave running on :3000 in another shell
npx playwright test    # reuses the running server
```

Do not wait on `networkidle` in specs — the app holds long-lived connections
(HMR socket, live feeds). Wait on concrete DOM/state instead.

## The home lane

The smart-home journeys live behind their own config,
[`playwright.home.config.js`](../../playwright.home.config.js), and their own ports. They are not
part of `npm run test:e2e`, because a spec about `/club` has no business booting a house.

```bash
npm run test:home:e2e          # the ten journeys, against a real Home Assistant
npm run home:instance          # just the house: prints its URL and token
npm run home:instance:down     # remove it and its config directory
npm run home:matrix            # the release matrix (pulls one HA image at a time)
```

The lane's three suites, from cheapest to most expensive:

| Suite | Command | Needs |
|---|---|---|
| Pure, over a recording of a real instance | `npx vitest run packages/home-bridge` | nothing |
| Live, against a real house | `npm run test:home:live` | Docker, or a house you already have |
| The ten browser journeys | `npm run test:home:e2e` | Docker, `.env.local` with `DATABASE_URL` |

### What `npm run test:home:e2e` actually starts

Three processes and no stubs anywhere between the click and the assertion:

1. **Home Assistant**, from [`scripts/home-test-instance.mjs`](../../scripts/home-test-instance.mjs):
   a container on a free port, onboarded through the real API, seeded with a floor, four rooms,
   scenes, `mcp_server`, and a lock exposed to Assist.
2. **The API**, `node server/index.mjs` on `:8099`: the same handlers Cloud Run runs, against the
   database in `.env.local`.
3. **The frontend**, `vite` on `:3020`, with `DEV_API_PROXY` pointed at that API.

Dedicated ports and `reuseExistingServer: false` are deliberate. Other agents run their own
`npm run dev` on `:3000` in this worktree, and reusing one is not a smaller version of this
stack: its `/api` proxy points at **production**, so the run silently tests the wrong API and
reports `No API route matches /api/home` as though the handler were missing.

The house lives on `127.0.0.1`, which both the browser and the server accept because
`normalizeBaseUrl` exempts loopback from the private-host refusal, so a developer running Home
Assistant on this machine still works. Journey 10 proves the refusal still fires for every other
private host.

### Rules this lane holds

- **Assert on the house, never on our own text.** Every journey that touches a lock reads that
  lock's state back out of Home Assistant. A confirmation card that renders perfectly while the
  deadbolt moves anyway is the exact failure this lane exists to catch.
- **No `waitForTimeout`.** Wait for a condition: the state in Home Assistant, the element, the
  event. `waitForState` in [`tests/_helpers/home-instance.js`](../_helpers/home-instance.js) is
  the tool for the first one.
- **No retries.** `retries: 0`, on purpose. A journey that only passes on the second attempt has
  told us something, and hiding it is how the finding gets lost. A flaky test on a door is worse
  than an absent one: fix it or delete it, in the session it is found.
- **Two accounts, provisioned once.** Account creation is limited to five per hour per IP, so the
  owner and guest accounts are created through the real signup page once and reused from
  `.ha-config-e2e-accounts.json` (gitignored: real credentials).

### Cleaning up

The house outlives the run on purpose, so ten consecutive runs pay for one boot:

```bash
npm run home:instance:down     # or: node scripts/home-test-instance.mjs --down --name lane
```

The harness only ever touches containers it labelled itself, so it can never remove another
agent's Home Assistant on this machine.

## The conversion-path specs

`launch-token-flow.spec.js` and `coin-buy-trade.spec.js` cover the platform's
most important path — launching a coin and trading it. Both follow the same
fidelity contract as `galaxy.spec.js`:

- **Real product code, driven — not re-implemented.** The specs import and run
  the actual modules ([`src/pump/launch-token-modal.js`](../../src/pump/launch-token-modal.js),
  [`src/game/coin-buy.js`](../../src/game/coin-buy.js)) on a minimal same-origin
  harness page so the dev server still resolves `/src/*` imports and relative
  `/api/*` fetches without booting the heavy homepage.
- **Endpoints fulfilled at the route layer with realistic payloads.** Vite dev
  proxies `/api/*` to production, so the launch-quote / launch-prep /
  launch-confirm endpoints, the pump buy/sell prep+confirm endpoints, and the
  Solana RPC proxy are intercepted with `page.route` to stay deterministic and
  never touch a real chain. The client makes the real fetches; the specs assert
  the real prep/confirm calls fire with the expected body. Prep transactions are
  genuine, parseable `@solana/web3.js` transactions built in Node.
- **`window.solana` is the only stubbed surface** — it is an external browser
  extension, not our code or a real API. Its `signTransaction` returns a
  serialized transaction exactly as a real wallet would, so the broadcast path
  runs for real against the fulfilled RPC.

### `launch-token-flow.spec.js` — all four launch steps

1. step 1 form validation (malformed symbol rejected, flow blocked)
2. step 2 cost breakdown + bonding-curve chart render
3. step 3 wallet connect arms the launch button
4. step 4 sign → broadcast → confirm → success share card (mint chip, share
   link, pump.fun link), asserting real `launch-prep` + `launch-confirm` fire
5. a broadcast failure surfaces specific, actionable copy (no generic catch-all)

### `coin-buy-trade.spec.js` — the buy/sell trade widget

1. wallet gating (connect → buy CTA)
2. lifecycle stage pill: a bonding-curve coin vs a graduated coin render
   distinct, unmistakable states (driven by the real `/api/pump/quote`
   detection)
3. SOL buy happy path: prep → sign → broadcast → settle
4. USDC buy happy path on a graduated coin (denomination upgrades to USDC)
5. sell happy path: switch to Sell, enter amount, prep → broadcast
6. a failed prep surfaces specific, actionable copy
