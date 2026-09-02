# P100-02: Stranded custodial funds, and the dry-run plan that lies about them

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/production-100-02-stranded-wallet-reclaim.md`".
Read [00-INDEX.md](production-100-00-INDEX.md) and `CLAUDE.md` first.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. When the definition of done
   is verified, delete this file and log in [PROGRESS.md](production-100-PROGRESS.md); any remainder gets a
   follow-up file per the index's follow-up protocol first.
2. **Nothing in this order moves funds.** Re-keying, crediting, or abandoning customer
   balances is the owner's call (stop-and-ask gate 1 and 4 territory). Your job is to make
   the system stop lying about these wallets and to put a complete decision in front of the
   owner. Firing the non-dry reclaim by hand is forbidden here.
3. Hard rules: no mocks, no placeholder data, explicit-path commits, no em-dash characters.

## The problem, measured 2026-08-02 (re-measure in step 0)

The 2026-07 host-migration key rotation left 8 of 565 custodial wallets encrypted under a
retired `WALLET_ENCRYPTION_KEY` that exists in no system we control. About 0.49 SOL is
stranded, of which roughly 0.35 SOL belongs to two CUSTOMERS who see a balance they can
never move. `WALLET_ENCRYPTION_KEY_PREVIOUS` fallback support already shipped in
`api/_lib/secret-box.js`, but there is no retired key to put in it, so those records are
permanently sealed.

The compounding defect: `reclaimIdleAgentSol()` in `api/_lib/economy-sweepback.js` returns
its dry-run plan BEFORE attempting key recovery (the `dryRun` early return sits above the
`recoverSolanaAgentKeypair` import). So `POST /api/cron/treasury-topup?dry=1` advertises
~0.12 SOL as reclaimable from two sealed platform wallets on every read. Two separate
sessions read that plan and concluded the treasury self-heals. It does not, and the phantom
number will keep costing sessions until the dry path runs the same key check as the real path.

## Step 0: re-derive the state

```bash
node --env-file=.env scripts/audit-custodial-key-health.mjs   # count + SOL, split platform/customer
grep -n "dryRun" api/_lib/economy-sweepback.js | head          # is the early return still before recovery?
# The dry read (needs CRON_SECRET from .env or the service env):
curl -s -X POST "https://three.ws/api/cron/treasury-topup?dry=1" -H "authorization: Bearer $CRON_SECRET" | head -c 2000
ls docs/ops/wallet-key-migration.md                            # the rotation runbook that already exists
```

Note the recent commit `e5ad85478` hardened the audit script against RPC failure; trust its
current output, not numbers from older logs. If someone already fixed the dry path, verify
against the tests and skip to task 3.

## Tasks

1. **Make the dry run honest.** In `reclaimIdleAgentSol()` (`api/_lib/economy-sweepback.js`),
   the dry path must attempt key recovery for every planned wallet, read-only, exactly as the
   real path would, and mark each planned move `recoverable: true|false` with the failure
   stage on false. `reclaimedSol` in a dry result counts only recoverable moves; sealed
   wallets appear separately (for example `sealed: [{agentId, pubkey, sol, reason}]`) so the
   information is not silently dropped. The real path's behavior is unchanged.
2. **Pin it with tests.** Extend the sweepback tests (`tests/economy-sweepback.test.js` or a
   sibling): a wallet whose secret fails AES-GCM recovery contributes 0 to a dry plan and
   appears in `sealed`; a recoverable wallet still plans normally; the summary ledger row
   distinguishes the two. Make the failing case fail before your fix so you trust the test.
3. **Make stranded funds permanently visible.** The ops surface that already reports settle
   health (`api/_lib/ops/x402-settle-health.js` feeding `/api/ops/payment-outcomes` and the
   `/admin/ops` card) gains a stranded-custody read: wallet count, total SOL, platform vs
   customer split, sourced from the same checks the audit script runs (share the logic; do
   not duplicate it). This must not add per-request RPC load: compute on the existing tick
   or cache with a long TTL. Verify the card renders in a real browser.
4. **Write the owner decision brief**: `docs/ops/stranded-wallets.md`. It must contain the
   measured wallet list (ids, pubkeys, balances, owner type), why recovery is impossible
   (one Secret Manager version, created on migration day; no prior key anywhere), what each
   option costs (credit the two customers from treasury; contact them; write the balance
   off), the support obligation for the two customer agents, and the exact commands for
   whichever option the owner picks. Link it from `docs/ops/README.md`. Then add one row to
   [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md) pointing at the brief.
5. **Changelog:** ops-internal work, so no entry unless you changed something user-visible.
   If you surface a "balance locked" state to the two affected users' wallet UI, that is a
   product decision belonging to the owner brief, not to this order; do not ship it
   unilaterally.

## Definition of done

- [ ] `curl ...treasury-topup?dry=1` (or the module test equivalent) no longer counts sealed
      wallets in `reclaimedSol`, and lists them as sealed with a reason.
- [ ] Tests cover both paths and pass; `npm run gate` no worse than your baseline.
- [ ] The ops surface shows stranded count and SOL, verified rendered in a browser.
- [ ] `docs/ops/stranded-wallets.md` exists, complete, linked; `npm run audit:docs` clean.
- [ ] One row in [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md); outcome logged in
      [PROGRESS.md](production-100-PROGRESS.md); this file deleted (the owner decision itself stays open in
      OWNER-ACTIONS, which is exactly where it belongs).

## Never blocked

| Blocker | Resolution |
|---|---|
| `CRON_SECRET` unknown | `.env`, then the Cloud Run service env (`gcloud run services describe three-ws-api ...`). The playbook order in CLAUDE.md. |
| RPC flaky during the audit | The audit script post-`e5ad85478` distinguishes RPC failure from zero. Re-run; do not report zero stranded on a failed read. |
| Production behind main | Irrelevant to this order's code work; note it and continue. The ops-surface read goes live with the next A-category ship. |
| Tempted to just fund the master instead | That is [OWNER-ACTIONS.md](production-100-OWNER-ACTIONS.md) capital, a different lever. This order is about honesty of the plan and the customer obligation. |

## Report format

Measured before/after of the dry plan, the audit script's current stranded table, where the
ops surface shows it (with a screenshot path if you took one), the brief's location, and the
one-line owner ask.
