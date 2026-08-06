# Security Remediation Plan — 2026-06-18

_Historical record: the fix plan tracked against the 2026-06-18 audit. Preserved as written; for current infrastructure see [docs/ops/gcp-production.md](../ops/gcp-production.md)._

Ordered fix plan for the findings in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
Statuses are kept in sync as each item lands.

## Order of work

1. **SSRF guards** — `onchain.js` manifest fetch (H1), card-model (M1), erc8004
   register-confirm (M2). Single shared guard; highest unauthenticated impact.
2. **Stored XSS** — validator-report (H2), admin panel (H3/L1).
3. **Avatar IDOR** — optimize + video-generate (H4).
4. **OAuth** — atomic code consumption (H6), introspection auth (M8).
5. **Withdrawals** — saved-wallet destination (H5).
6. **pump-fun-mcp** — per-call settle, bearer scope, image SSRF, per-principal
   limit (H7, M6).
7. **Headers** — frame-ancestors/X-Frame-Options (H11), Permissions-Policy (M14),
   CSP trim/dedupe (H12), CORS audit (H13). `'unsafe-inline'` came out on
   2026-08-06 via per-response script hashes (`server/csp-hashes.mjs`);
   `'unsafe-eval'` scoping is the one piece still open, and SECURITY_AUDIT.md
   H12 records what has to move first.
8. **Missing rate limits / auth** — oracle/social (M3), ibm/attest (M4), persona
   (M5), forever/inscribe (M9), render endpoints (L10), misc Low.
9. **Payment concurrency** — idempotency NX (M10), USD spend cap atomic (H9),
   permissions/redeem atomic (M7).
10. **Wallet key encryption** — dedicated key + per-record salt + dual-read (H8).
11. **Recipient/decimals** — pay-by-name binding (M11), spending-cap decimals
    (M12), skill spend cap (M13).
12. **CSRF on cookie mutations** (M15), Solidity SafeERC20 (L2), remaining Low.
13. **Client secret exposure** — VITE_PINATA + RPC keys (H10).
14. **Dependencies**: remove the unused packages that carry the criticals, pin
    the rest through root `overrides` (C1); track what upstream has not fixed.

## Migration notes

- **H8 (wallet key encryption):** must be dual-read. Existing ciphertext was
  produced with the `JWT_SECRET`-derived key + constant salt. New code reads a
  version tag: legacy records decrypt with the old derivation; new writes use
  `WALLET_ENCRYPTION_KEY` + a random per-record salt embedded in the payload. No
  data migration required; records re-encrypt opportunistically on next write.
- **C1 (landed 2026-08-06):** the breaking `@metaplex-foundation/js` bump was
  never needed. The package was declared by four workspaces and imported by
  none, so it was removed outright along with its `aptos` / `axios@0.27` /
  `form-data@4.0.0` subtree, and the last critical (`protobufjs@6.11.6` under
  the greenfield cosmos types) fell to a global `protobufjs: ^7.6.5` override.
  The production tree went from 3 critical / 41 high to 0 critical / 18 high.
  `bigint-buffer`, `adm-zip`, `lodash.set`, `undici@5` under `hardhat`, and
  `@libp2p/kad-dht` have no non-breaking upstream fix and stay tracked.
