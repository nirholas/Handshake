# M1 — Medium: Public self-hosted facilitator endpoint has no rate limiting

**Severity:** Medium · **Area:** Payments · **Commit-gate:** no

## The defect
[api/x402-facilitator/[action].js](../../api/x402-facilitator/[action].js) has no
`limits.*` / `clientIp` call anywhere (verified). `X402_FACILITATOR_URL_SOLANA`
points at the public `https://three.ws/api/x402-facilitator`, so anyone holding a
few cents of USDC can spam `/settle` with valid tiny (1-atomic) allowlisted-payTo
transfers. Each forces the sponsor to co-sign and pay ~5000 lamports base fee (plus
one-time ATA rent per new recipient).

No theft — the `SPONSOR_SOL_FLOOR_LAMPORTS` floor
([self-facilitator.js:64-68](../../api/_lib/x402/self-facilitator.js)) stops
settlement below 0.02 SOL — but reaching the floor **halts the entire paid agent
economy** until a human tops up the sponsor, and the attacker's cost is negligible
vs. the sponsor's fee burn.

## The fix
Add per-IP + global rate limits mirroring the existing verify limiters, and a
minimum settle amount so dust can't be used as a fee-burn pump:

```js
import { limits, clientIp } from '../_lib/rate-limit.js';
import { rateLimited } from '../_lib/http.js';

// at the top of the handler, before doing work:
const ipRl = await limits.x402FacilitatorIp(clientIp(req));   // add bucket to rate-limit.js
if (!ipRl.success) return rateLimited(res, ipRl);
const gRl = await limits.x402FacilitatorGlobal();
if (!gRl.success) return rateLimited(res, gRl);
```

Add the `x402FacilitatorIp` / `x402FacilitatorGlobal` buckets to
`api/_lib/rate-limit.js` alongside `x402VerifyIp`/`x402VerifyGlobal` (same fail
mode). Optionally enforce a minimum settle amount (e.g. reject amounts below the
sponsor's per-tx fee so a settle can never be net-negative for the platform).

## Verification
1. Rapid repeated `/settle` from one IP → 429 after the limit.
2. A dust settle below the minimum → rejected before sponsor co-sign.
3. Legit paid flow unaffected.

## Done checklist
- [ ] Facilitator IP + global buckets added and wired.
- [ ] Minimum settle amount enforced.
- [ ] Griefing repro now rate-limited; legit flow works.
