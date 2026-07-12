# M6 — Medium: `text-extract.js` allows cleartext HTTP fetch in production

**Severity:** Medium (Low-ish — private IPs still blocked) · **Area:** Security · **Commit-gate:** no

## The defect
[api/_lib/text-extract.js:51](../../api/_lib/text-extract.js) passes
`allowHttp: true` to the SSRF guard, so widget-knowledge ingestion will fetch plain
`http://` public URLs in production. The private/loopback/metadata IP blocklist still
applies (internal targets remain blocked), so impact is limited to **cleartext
fetch of public hosts** — MITM-tamperable content ingested into the knowledge base,
and a downgrade from the platform's otherwise-HTTPS posture.

## The fix
Gate `allowHttp` on the dev environment so production requires HTTPS:

```js
import { IS_DEV } from './env.js';   // or the existing env flag this repo uses
// ...
const result = await ssrfGuardedFetch(url, { /* ...existing opts... */, allowHttp: IS_DEV });
```

If some legitimate source is HTTP-only, allowlist that specific host rather than
enabling plaintext globally.

## Verification
1. In production config, an `http://` source URL is refused (or upgraded), an
   `https://` source works.
2. In dev, `http://` still works for local testing.
3. Private/loopback targets remain blocked in both (unchanged).

## Done checklist
- [ ] `allowHttp` gated on dev.
- [ ] Prod refuses plaintext public fetches; HTTPS works.
- [ ] SSRF blocklist behavior unchanged.
