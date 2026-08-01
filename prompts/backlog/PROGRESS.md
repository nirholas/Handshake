# backlog/ progress log

Cross-chat handoff. Append one block per work order attempt: what you measured,
what you changed, what is left, and who owns it. Newest at the bottom.

Format:

```
## <date>: <NN work-order name>
Measured: <the numbers you read, with the command>
Did: <what changed, with commit SHAs or env var names>
Left: <exactly what remains, and who owns it>
```

---

## 2026-08-01: pack created

Measured (see the snapshot table in [00-INDEX.md](00-INDEX.md)): prod at `6cc0370dc`
with no deploy gap, `x402_settle` down at 25.9% with `fee_runway_exhausted` at
85,331 rejects against 562 `broadcast_failed`, RPC lanes at 1/3 paid serving,
forge at 100%, fact-check benchmark unrun, Draco transcode fixed on the running
image, media CORS at the site edge already permissive.

Did: wrote ten work orders covering every open item carried by ISSUES.md and the
retired campaign logs. Dropped the Draco item from ISSUES.md against live
evidence rather than leaving a fixed item on the tracker.

Left: all ten work orders are unstarted.

## 2026-08-01: 05 R2 bucket CORS
Measured (`node scripts/set-r2-cors.mjs --probe`, plus raw curl against both hosts):
site edge PASS (`three.ws/avatars/*.glb` returns `access-control-allow-origin: *`
to any origin); public bucket host FAIL (`pub-*.r2.dev` returns no header to a
foreign origin, preflight `OPTIONS` 403); presigned PUT preflight MIXED (204 for
`three.ws`, `*.vercel.app`, `localhost:3000`; 403 for `www.three.ws`,
`*.app.github.dev`, `localhost:5173`). The live policy is one allowlist rule
serving both reads and writes, predating the script's read/write split. Item
confirmed, not closed.

Did: added a credential-free `--probe` mode to `scripts/set-r2-cors.mjs` that
measures the enforced policy with object-scoped keys and exits 1 on drift, so
this is verifiable without an admin token. Rewrote the script's usage block and
`scripts/README.md` to drop `vercel env pull` and name the real credential
sources. Documented which host needs `/api/glb` and which does not, measured, in
`docs/media-api.md`, `docs/character-library.md`, and both embed tutorials
(`render-avatar-images.md` was recommending the proxy for a `three.ws` URL that
never needed it). Updated ISSUES.md item 9 with the measurement table. Changelog
entry added. `npm run audit:docs` clean.

Left: applying the policy. Blocked on one credential, not on code: the only R2
token reachable here (`S3_*` in `.env`, identical to the Cloud Run service env)
is object-scoped and 403s on Get/PutBucketCors, and Secret Manager holds no R2 or
Cloudflare admin token (checked with working gcloud auth). Owner: mint an
"Admin Read & Write" R2 token scoped to `chatty-storage`, put it in `.env.local`
as `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, run `node scripts/set-r2-cors.mjs`,
confirm with `--probe`. Keep `/api/glb` either way.
