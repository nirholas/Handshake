# 05. R2 bucket CORS: verify what is actually broken, then fix it at the origin

Read [00-INDEX.md](backlog-00-INDEX.md) first.

## Start by narrowing the claim

The tracker says third-party origins get no `access-control-allow-origin` on media
reads. That is **not true at the site edge**. Measured 2026-08-01:

```sh
curl -I -H "Origin: https://example.org" https://three.ws/avatars/cesium-man.glb
# HTTP/2 200
# access-control-allow-origin: *
# access-control-allow-methods: GET, HEAD, OPTIONS
```

So anything loading media through `three.ws` already works cross-origin. What is
unverified is the **bucket origin**: the public `r2.dev` host and the presigned
`PUT` path used by the upload flow. `scripts/set-r2-cors.mjs` sets
`AllowedOrigins: ['*']` for GET/HEAD plus a write rule for presigned uploads, and
the live bucket policy is believed to still echo an older allowlist.

**Your first task is a measurement, not a fix.** Determine, for each of these,
whether CORS is correct today:

1. Public bucket host (`r2.dev`) GET/HEAD from a foreign origin.
2. Presigned `PUT` preflight from a browser origin (the avatar upload modal).
3. The `three.ws` edge path (already known good, re-confirm).

If 1 and 2 pass, this item is closed: say so with the evidence, drop it from
[../../ISSUES.md](../../ISSUES.md), and stop.

## If the bucket policy is wrong

```sh
node scripts/set-r2-cors.mjs --get       # show live policy
node scripts/set-r2-cors.mjs --dry-run   # print the policy that would be pushed
node scripts/set-r2-cors.mjs             # apply, idempotent
```

The blocker is credentials, not code. The only R2 token on this machine (`S3_*`
in `.env`, bucket `chatty-storage`) is **object-scoped** and returns
`403 AccessDenied` on `GetBucketCors` and `PutBucketCors`.

**Owner action, one credential:** mint an "Admin Read & Write" R2 token scoped to
the bucket, then put it in `.env.local` as `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` and re-run the script. The script's `--get` path already
prints the exact steps instead of crashing.

## Two cleanups while you are in here

- **The script's own usage docs are wrong.** Its header says
  `vercel env pull .env` to get credentials. `vercel env pull` returns **empty**
  for secret-type vars (a documented trap in CLAUDE.md), and production env now
  lives on the Cloud Run service. Rewrite that comment block to name the real
  sources: `.env.local` for an R2 admin token, `gcloud run services describe` for
  runtime values.
- **Decide the fate of the `/api/glb` proxy.** A permissive bucket policy removes
  the need for it in client-side viewers, but it stays the right advice for
  notebooks and unusual dev ports. Do not delete it. Do update the docs that
  recommend it so a reader knows when each path applies.

## Verify

```sh
node scripts/set-r2-cors.mjs --get
curl -I -H "Origin: https://example.org" <public r2.dev object url>
npm run audit:docs
```

## Definition of done

- [ ] A measured table of the three surfaces above with pass/fail and headers.
- [ ] Either the bucket policy is correct and applied, or the item is closed with
      evidence and removed from ISSUES.md.
- [ ] `scripts/set-r2-cors.mjs` no longer instructs the reader to use
      `vercel env pull`.
- [ ] Docs recommending `/api/glb` state when the proxy is needed and when a
      direct fetch is fine.
- [ ] `npm run audit:docs` clean.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/backlog-05-r2-bucket-cors.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
