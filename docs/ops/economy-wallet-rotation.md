# Economy wallet registry and rotation

Every Solana wallet the platform spends from is defined in
[`api/_lib/solana-signers.js`](../../api/_lib/solana-signers.js): a role name, the
env var holding its secret, what it pays for, and the SOL floor it must keep.
That file answers "what does the economy use right now". It cannot answer "what
did the economy use in July", because rotating a signer overwrites an env var and
the previous address survives nowhere.

`economy_wallet_registry` is the missing half: a durable, append-only log of every
wallet each role has ever held, with the lineage between them. Reconciling an old
settle, attributing a fee, or proving which wallet received a payment last quarter
is now a query instead of an archaeology session on the chain.

**No secret material is ever stored in the registry.** A row records the public
address and *where* the secret lives (an env var name, or the 0600 file a freshly
generated key was written to). Nothing in this flow reads or writes Secret
Manager, and nothing puts a key into production for you: the cutover command is
printed for a human to run, because installing a live signing key is a deliberate
act.

- Schema: [`api/_lib/migrations/20260819010000_economy_wallet_registry.sql`](../../api/_lib/migrations/20260819010000_economy_wallet_registry.sql)
- Operator surface: [`scripts/economy-wallets.mjs`](../../scripts/economy-wallets.mjs) (`npm run economy:wallets`)
- Related: [economy funding root](../economy-master.md), [money map](../money-map.md), [x402 ring economy](../x402-ring-economy.md)

## Commands

```bash
npm run economy:wallets -- list                       # whole registry, newest first per role
npm run economy:wallets -- list --role economy-master # one role's history

# log a wallet that is already live (backfill, or an imported wallet)
npm run economy:wallets -- record --role economy-master --address <pubkey> --status active

# generate a fresh wallet for a role, logged as pending, production untouched
npm run economy:wallets -- new --role economy-master --vanity www

# flip a pending wallet to live AFTER it is funded and its env var is set
npm run economy:wallets -- activate --role economy-master --address <pubkey>

npm run economy:wallets -- retire --role economy-master --address <pubkey>
```

`--vanity` grinds a case-insensitive address prefix (up to 4 characters) so a
rotated wallet keeps the house `www…` look. Three characters takes a few seconds.

A unique partial index enforces **exactly one active wallet per role per
network**, so a half-finished rotation cannot be left behind: `activate` retires
the predecessor in the same step, and a second concurrent activation fails loudly
rather than leaving two wallets both claiming to be live.

## Rotating a role

Order matters. Funding first and env last means the window where production holds
a key to an empty wallet is zero.

1. **Generate.** `npm run economy:wallets -- new --role <role>`. The secret lands
   in `~/.three-ws-wallets/<role>.<pubkey>.env` (mode 0600, outside the repo). The
   address is logged as `pending` with `rotated_from` pointing at the incumbent.
2. **Fund it** to at least the role's `minSol` floor. Below the floor the wallet
   is live but useless: the sponsor stops settling, and an engine stalls.
3. **Sweep the old wallet** if the role carries `holdsTokens` (the x402 ring
   treasury holds the USDC float). Skipping this strands the float at an address
   production no longer reads.
4. **Set the env var**, including every alias for that role (see below), with a
   single `gcloud run services update --update-env-vars`. Never
   `--set-env-vars`: it replaces the entire env set.
5. **Activate** in the registry, then verify with `npm run audit:service-wallets`,
   which derives each pubkey from the secret production actually holds and
   cross-checks it against what the live 402 challenges advertise.

## Roles read through more than one env var

One physical wallet can be read through several vars. Rotating the role means
moving all of them in the same cutover, because a 402 challenge that advertises
one address while the server co-signs with another fails every settle against it.

| Role | Vars that must move together |
| --- | --- |
| `economy-master` | `ECONOMY_MASTER_SECRET_BASE58` (secret), `X402_FEE_PAYER_SOLANA` (advertised fee payer) |
| `pump-x402-launcher` (the x402 ring treasury) | `PUMP_X402_LAUNCHER_SECRET_KEY_B64` (secret), `X402_TREASURY_SECRET_BASE58` (same key, base58), `X402_PAY_TO_SOLANA` (advertised receiver) |

`npm run economy:wallets -- new` prints the alias set for the role it is
generating, so this table is a reference rather than something to remember.

## Why the master is the one to be careful with

The economy master is also the x402 sponsor fee payer. Below
`X402_SPONSOR_SOL_FLOOR_LAMPORTS` the self-facilitator refuses to settle and
`buildRequirements()` withdraws the Solana accept from every 402 challenge, so
Solana-only paid endpoints return `settlement_unavailable` and every other paid
endpoint quietly degrades to Base-only. The outward symptom is not a clean
outage, which is exactly why the runway alert in
[`api/_lib/x402/sponsor-runway.js`](../../api/_lib/x402/sponsor-runway.js) measures
days-to-floor rather than days-to-zero. Rotate the master only with the
replacement already funded above its floor.
