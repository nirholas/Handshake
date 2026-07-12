# M2 — Medium: Upstream stream error in `proxyExternal` crashes the Cloud Run instance

**Severity:** Medium · **Area:** Server proxy / reliability · **Commit-gate:** no

## The defect
[server/index.mjs:147-149](../../server/index.mjs):

```js
Readable.fromWeb(upstream.body).pipe(res);
```

`.pipe()` does not forward source errors, and no `'error'` listener is attached to
the readable. An upstream reset mid-body (PostHog network blip, client abort) emits
`'error'` with no handler → an uncaught exception. Only `unhandledRejection` is
registered ([server/index.mjs:496](../../server/index.mjs)); there is **no
`process.on('uncaughtException')`**, so this terminates the process. The `try/catch`
around `fetch` does not cover the async pipe.

## The fix
Use `stream.pipeline` (which propagates and cleans up on error), and add a top-level
`uncaughtException` backstop:

```js
import { pipeline } from 'node:stream/promises';
// ...
try {
  await pipeline(Readable.fromWeb(upstream.body), res);
} catch (err) {
  if (!res.writableEnded) res.end();
  // optional: log at debug — client aborts are normal and shouldn't be noisy
}
```

And near the existing `unhandledRejection` handler:

```js
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  // do not exit — keep the instance serving other requests
});
```

## Verification
1. Simulate an upstream reset (point the proxy at a server that closes mid-body, or
   abort the client) → the instance keeps serving; no process exit.
2. Normal proxied responses still stream correctly end-to-end.

## Done checklist
- [ ] `pipeline` replaces bare `.pipe()` in `proxyExternal`.
- [ ] `uncaughtException` backstop added (non-exiting).
- [ ] Mid-stream reset no longer kills the instance.
