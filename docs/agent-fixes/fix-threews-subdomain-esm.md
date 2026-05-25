# Fix: api/threews/subdomain — 5 × 500 crashes (ESM import of @bonfida/spl-name-service)

## Context

`GET /api/threews/subdomain` returns 500 on every cold-start with a Node.js process crash. The error in Vercel logs:

```
[api] unhandled file:///var/task/node_modules/@bonfida/spl-name-service/dist/esm/instructions/burnInstruction.js:1
import"../node_modules/buffer/index.js";import{TransactionInstruction as i}from"@solana/web3.js"
```

This kills the entire process — the `SyntaxError: Cannot use import statement in a module` prevents the handler from ever running.

## Root Cause

Read `api/threews/subdomain.js` (the import block at the top) and `api/_lib/threews-sns.js` (the full file) before touching anything.

`api/threews/subdomain.js` imports from `api/_lib/threews-sns.js` at the **top level**. `threews-sns.js` in turn imports from `@bonfida/spl-name-service` and `@solana/web3.js` using static ESM `import` statements.

Vercel's Node.js serverless runtime bundles API functions as CommonJS (CJS) by default. When Vercel's bundler (`@vercel/nft`) encounters `@bonfida/spl-name-service`, it pulls in the ESM distribution (`dist/esm/`) which uses bare `import` statements. The CJS runtime cannot execute these and throws a `SyntaxError` at cold-start — before any request handler runs.

The fix must happen at the import level, not in the handler body.

## What You Must Fix — Completely

### Option A: Convert to dynamic import in `api/_lib/threews-sns.js`

This is the cleanest fix for Vercel CJS bundling.

In `api/_lib/threews-sns.js`, change the static imports of `@bonfida/spl-name-service` to dynamic imports that are resolved at call time. Specifically:

1. Remove the top-level `import { ... } from '@bonfida/spl-name-service'` statements.
2. Inside any function that uses the `@bonfida` exports, add:
   ```javascript
   const { NameRegistryState, getHashedNameSync, getNameAccountKeySync } = await import('@bonfida/spl-name-service');
   ```
3. Repeat the same pattern for any other ESM-only dependency that is currently statically imported.

After this change, the module loads without error at cold-start. The first request that calls a SNS lookup will pay a small dynamic import overhead (cached by Node after the first call).

### Option B: Add @bonfida to Vercel externals in vercel.json

In `vercel.json`, check whether there is an `externals` configuration for the Node bundler. If so, add:
```json
"functions": {
  "api/**/*.js": {
    "external": ["@bonfida/spl-name-service", "@solana/web3.js"]
  }
}
```

This tells `@vercel/nft` to leave these packages as native `require()`s rather than trying to inline them. This works only if the packages also ship a CJS distribution — verify this by checking `node_modules/@bonfida/spl-name-service/package.json` for a `main` or `exports.require` field.

Choose Option A if Option B is not available or if the package is ESM-only.

### Step 3: Verify the fix locally

After making the change:
```bash
node --input-type=module <<'EOF'
import('./api/threews/subdomain.js').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))
EOF
```

Must print `OK`. If it prints `FAIL`, resolve the remaining ESM crash before deploying.

### Step 4: Test the endpoint end-to-end

1. Start the dev server (`npm run dev`)
2. Request `GET /api/threews/subdomain?label=test` as an unauthenticated user — should return 401 (not 500)
3. Request with a valid auth session and a `label` param — should return 200 with subdomain details

Confirm no crash in the Vercel logs after deploy.

### Step 5: Set ZAUTH_API_KEY (related issue)

The Vercel logs for this endpoint also show `[zauth] disabled: ZAUTH_API_KEY not set`. While not the crash cause, this means the zauth middleware is disabled. After fixing the ESM crash, set `ZAUTH_API_KEY` in Vercel env (see `fix-zauth-api-key.md`).

## Do Not

- Do not wrap the top-level import in a try/catch — ESM syntax errors in static imports cannot be caught at runtime.
- Do not remove the SNS integration — it must continue to function for subdomain registration.
- Do not use a stub or mock for `@bonfida/spl-name-service` — this must call the real Solana Name Service.

## Related Files

- `api/threews/subdomain.js` — static importer
- `api/_lib/threews-sns.js` — the file with the ESM imports (primary fix target)
- `vercel.json` — may need `externals` config (Option B only)
