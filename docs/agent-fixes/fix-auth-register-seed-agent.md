# Fix: POST /api/auth/register — NeonDB cold-start failures in seedDefaultAgent

## Context

User registration occasionally returns 500 with an unhandled rejection from `seedDefaultAgent`:

```
Unhandled Rejection: NeonDbError: Error connecting to database: fetch failed
  at execute (...@neondatabase/serverless/index.mjs:1549)
  at async seedDefaultAgent (api/_lib/seed-default-agent.js:20)
```

The user account is created successfully, but the 500 response makes the user think registration failed. This causes duplicate registration attempts.

## Current State — Verify Before Changing Anything

Read `api/_lib/seed-default-agent.js` in full and `api/auth/[action].js` around line 147 before touching anything.

The current code in `seed-default-agent.js` **may already have a fix** in place:
- Lines 23–75 have a try/catch with retry logic
- Line 51: one retry after 1 second on first failure
- Line 72: catches all second-attempt errors and returns null

And in `api/auth/[action].js` at line 147:
```javascript
queueMicrotask(() => seedDefaultAgent(user.id));
```

`queueMicrotask()` fires asynchronously — errors inside it do NOT propagate to the HTTP response. If both the try/catch AND the queueMicrotask are in place, the 500 from this source should be impossible.

**If both safeguards are already in the code as described above, this issue is already fixed. Verify and close.**

## If the Fix Is NOT Yet Complete

### Fix 1: Wrap seedDefaultAgent in try/catch in seed-default-agent.js

The entire exported function must be wrapped in try/catch with retry:

```javascript
export async function seedDefaultAgent(userId) {
    try {
        const [agent] = await sql`INSERT INTO agent_identities ... RETURNING id`;
        return agent?.id || null;
    } catch (err) {
        console.warn('[seed-default-agent] first attempt failed, retrying', { userId, error: err?.message });
        await new Promise(r => setTimeout(r, 1000));
        try {
            const [agent] = await sql`INSERT INTO agent_identities ... RETURNING id`;
            return agent?.id || null;
        } catch (err2) {
            console.error('[seed-default-agent] failed', { userId, error: err2?.message });
            return null; // Never propagate — registration must succeed regardless
        }
    }
}
```

**Critical:** Both catch blocks must return `null`, never `throw`. A failed agent seed is recoverable — the user can create an agent manually.

### Fix 2: Use queueMicrotask for the seed call in auth/register

In `api/auth/[action].js`, wherever `seedDefaultAgent` is called after registration, it must NOT be awaited in the request handler:

```javascript
// Wrong — awaiting makes seed failures block the 201 response:
await seedDefaultAgent(user.id);

// Correct — fire-and-forget, never blocks the response:
queueMicrotask(() => seedDefaultAgent(user.id));
```

If the current code already uses `queueMicrotask()`, no change is needed here.

### Verify the fix

1. Start the dev server (`npm run dev`)
2. Register a new user via the registration endpoint — must return 201 regardless of whether the seed agent succeeds
3. Check that a default agent eventually appears for the user (it may take up to 2 seconds due to the retry delay)
4. Temporarily break the DB connection in local dev (e.g., invalid DATABASE_URL) and verify registration still returns 201

## Do Not

- Do not await `seedDefaultAgent` in the registration handler — it must never block the 201 response
- Do not propagate seed errors to the user — log them and return null
- Do not remove the retry logic — Neon cold-start failures recover quickly on the second attempt

## Related Files

- `api/_lib/seed-default-agent.js` — the seed function (verify try/catch is complete)
- `api/auth/[action].js:147` — the queueMicrotask call (verify it's fire-and-forget)
