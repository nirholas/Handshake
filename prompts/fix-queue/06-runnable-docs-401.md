# 09. A documented API call no longer answers as documented

**Severity: P2.** Small, self-contained, and the exact case the runnable-docs
guard was built for. Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run check:runnable-docs
check-runnable-docs: 1 documented call(s) no longer answer as documented:

  https://three.ws/api/irl/world-lines/mine
    got 401, expected 2xx
    at docs/world-lines.md:488
exit=1
```

## What is actually wrong

Read [docs/world-lines.md:486-492](../../docs/world-lines.md#L486-L492) before
you touch the endpoint. The documented call is:

```bash
curl -s https://three.ws/api/irl/world-lines/mine -b 'session=<your session cookie>'
```

The doc itself says the endpoint requires auth ("Creator dashboard. Auth."), and
the sample carries a placeholder session cookie. So `401` is the correct and
expected response for an unauthenticated runner, and the defect is in the
annotation, not in the API: the checker was never told this call is auth-gated.

**Verify that reading before acting.** If the endpoint is in fact returning 401
to an authenticated caller, this becomes a real API bug and the fix is entirely
different. Test it with the QA account (`AUDIT_EMAIL` / `AUDIT_PASSWORD` in
`.env`, a real production QA login) and settle the question with evidence.

## The job

1. Authenticate as the QA user and call `/api/irl/world-lines/mine` with a real
   session cookie. Record the status and the body shape.
2. **If it returns 2xx** (the expected outcome): annotate the fence in
   `docs/world-lines.md` with the real contract, using the syntax the checker
   prints in its own error message:
   `<!-- runnable: 401 requires an authenticated session -->`. Then confirm the
   documented response body in the doc still matches the live body, field for
   field, and fix it if it drifted.
3. **If it returns 401 to an authenticated caller**: stop annotating and fix the
   handler. Trace the auth path, find why a valid session is rejected, and cover
   it with a test. Report it as an auth bug, because that means the creator
   dashboard is broken for every user.
4. Sweep the neighbours: `docs/world-lines.md` documents a family of endpoints,
   and if one lost its annotation others may be undocumented rather than merely
   unannotated. Check each fence in that file against the live service.

## Verification

```bash
npm run check:runnable-docs   # exit 0
npm run audit:docs            # stays clean
```

## Done when

`check:runnable-docs` passes, the annotation states the true contract rather
than silencing the check, and the documented response body matches the live one.
