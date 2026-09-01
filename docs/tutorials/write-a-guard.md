# Write a repository guard

**Level:** intermediate. You should be comfortable with Node and `git`.
**Time:** about 20 minutes.
**You will build:** a real guard that fails the build when a server-side `fetch()` has no timeout, wired into the gate, proven against the violation it claims to catch, covered by tests, and registered so it shows up on [/guards](/guards).

This repository has no CI, so a guard is not a nice-to-have that runs somewhere in the cloud. It is the only thing standing between a mistake and production. [Repository guards](/docs/guards) explains the system; this page walks you through adding one.

---

## The example

We will build `check-fetch-timeouts`: a guard that refuses to build when server code calls `fetch()` without a timeout.

This is a real class of bug. A `fetch` with no timeout hangs until the platform's own limit kills it, so one slow upstream turns into stacked requests, then a cold pool, then a 502 on an endpoint that has nothing to do with the slow service. It is invisible in review because the line looks completely normal.

This guard has since shipped for real: [`scripts/check-fetch-timeouts.mjs`](../../scripts/check-fetch-timeouts.mjs) runs in the `gate` chain as `npm run check:fetch-timeouts`, is registered in `data/guards.json` with an `append` proof, and is covered by [`tests/check-fetch-timeouts.test.js`](../../tests/check-fetch-timeouts.test.js). The shipped version is stricter than the one built below (it balances parentheses to read each call's real extent, treats the shared bounded wrappers such as `fetchUpstream` as satisfying the rule, judges every `fetch` under `api/` whatever its URL, and skips a `fetch` that only appears inside a string). Follow the steps here to learn the shape, using a throwaway id such as `check-fetch-timeouts-tutorial` for the files you create, then read the shipped guard for the finished form.

---

## Step 1: write the checker

Guards live in `scripts/`. Create `scripts/check-fetch-timeouts.mjs`:

```js
#!/usr/bin/env node
// Refuse to build when server code calls fetch() without a timeout.
//
// A fetch with no timeout hangs until the platform kills the request, so a
// single slow upstream becomes stacked requests, an exhausted pool, and 502s on
// unrelated endpoints. It reads as ordinary code in review, which is why this
// has to be mechanical.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js file under a directory, skipping node_modules. */
function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules') continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.js')) out.push(full);
	}
	return out;
}

const failures = [];

for (const file of walk(path.join(root, 'api'))) {
	const body = readFileSync(file, 'utf8');
	body.split('\n').forEach((line, i) => {
		if (!/\bfetch\s*\(/.test(line)) return;
		// Conservative on purpose: only flag a fetch whose own line carries no
		// signal of a timeout. A multi-line call that sets `signal` below is left
		// alone, because a false positive here gets the whole guard switched off.
		if (/signal|timeout|AbortController|withTimeout/i.test(line)) return;
		if (/^\s*(\/\/|\*)/.test(line)) return;
		failures.push(`${path.relative(root, file)}:${i + 1}`);
	});
}

if (failures.length) {
	console.error(`[check-fetch-timeouts] ${failures.length} fetch call(s) with no timeout:`);
	for (const f of failures) console.error(`[check-fetch-timeouts]   ${f}`);
	console.error('[check-fetch-timeouts] Pass an AbortSignal, or use the shared withTimeout helper.');
	process.exit(1);
}

console.log('[check-fetch-timeouts] OK: every server fetch sets a timeout');
```

Three things to copy from this, because they are what keep a guard alive:

- **The header is a post-mortem.** State the failure that motivated the guard. Without it, a future maintainer reads a check that has never fired and deletes it.
- **It is conservative.** It skips any line that even mentions a timeout. Missing a real violation is recoverable; a false positive means somebody removes the guard entirely.
- **The failure message says what to do.** "Pass an AbortSignal, or use the shared `withTimeout` helper" is actionable. "Invalid fetch" is not.

---

## Step 2: give it an npm script

A guard nobody can run is a guard nobody runs. In `package.json`:

```json
"check:fetch-timeouts": "node scripts/check-fetch-timeouts.mjs"
```

Verify it:

```bash
npm run check:fetch-timeouts
```

---

## Step 3: register it

Add an entry to `data/guards.json`. This is what [/guards](/guards) renders and what [Repository guards](/docs/guards) documents, so the registry is the single source of truth rather than a copy of one:

```json
{
  "id": "check-fetch-timeouts",
  "script": "scripts/check-fetch-timeouts.mjs",
  "npm": "check:fetch-timeouts",
  "title": "Server fetch timeouts",
  "protects": "No server-side fetch can hang without a timeout.",
  "why": "A fetch with no timeout turns one slow upstream into stacked requests and 502s on unrelated endpoints. It reads as ordinary code in review.",
  "stages": ["gate"],
  "needs": "none",
  "proof": {
    "summary": "An API handler calling fetch() with no timeout.",
    "violation": {
      "write": {
        "api/guard-proof-fetch-timeout.js": "export default async function handler(req, res) {\n\tconst r = await fetch('https://example.com/slow');\n\tres.json(await r.json());\n}\n"
      }
    },
    "expect": "api/guard-proof-fetch-timeout.js"
  }
}
```

Every field is required, and `audit-guards` enforces that, because a guard with no `why` is one nobody dares delete and nobody understands.

`proof` is the field people forget, and it is the one the auditor refuses to let you skip. Leave it out and `npm run audit:guards` fails with:

```
[audit-guards]   guard `check-fetch-timeouts`: guard "check-fetch-timeouts" has no
proof block. Every guard must declare the violation it rejects (see docs/guards.md).
```

It declares the violation your guard must reject, in fixture form rather than code: `summary` says what the violation is in one line, `violation` is the mutation applied to a throwaway copy of the repo, and `expect` is the fragment the guard's own failure output must contain. Step 5 runs it. `violation` also takes `append`, `delete`, `link`, and `json` instead of `write`; a guard that genuinely cannot be proven offline declares `{"kind": "live", "reason": "..."}` and says why, rather than faking a green.

Nothing else needs regenerating by hand: `npm run build:guards` refreshes `public/guards.json` (the file [/guards](/guards) fetches), and it already runs inside `prebuild` on every build.

---

## Step 4: wire it into a stage

Registering is a claim; wiring makes it true. Add it to the `gate` chain in `package.json`:

```json
"gate": "npm run check:conflicts && npm run check:claude && ... && npm run check:fetch-timeouts"
```

Now run the registry auditor:

```bash
npm run audit:guards
```

If you skip this step, it fails with exactly the mismatch:

```
[audit-guards] guard `check-fetch-timeouts` claims it runs in `gate` but it is
not in the gate chain. Wire it there, or correct the stage in data/guards.json.
```

That message is the point of the whole registry. Documentation drifts from reality silently; this turns the drift into a failed command.

### Which stage?

| Stage | Use it when | Cost budget |
|---|---|---|
| `prebuild` | The guard checks something the build itself generates. | Under a second. |
| `gate` | Offline, deterministic, no credentials. Most guards belong here. | A few seconds. |
| `build:gcp` | It can only judge a finished artifact, like `dist/`. | Seconds. |
| `pre-push` | It judges commit content and must not be skippable. | Under a second. |
| `manual` | It needs a browser, live credentials, or the network. | Any. |

Anything needing the network or credentials goes in `manual`. A flaky guard on an automatic path gets bypassed, and once people are in the habit of bypassing, every other guard on that path is weaker too.

---

## Step 5: prove it still catches something

`audit:guards` proved the guard is *wired*. It cannot prove the guard still *catches* anything. A checker that has rotted into a no-op (a directory it stopped scanning, a regex that stopped matching, an exclusion list that grew until it excluded everything) exits 0 forever, and exit 0 is indistinguishable from a clean tree. That is the worst failure mode a safety net has: loudest when it works, silent when it dies.

The `proof` block you wrote in Step 3 is what closes that hole. Run it:

```bash
npm run prove:guards -- --only check-fetch-timeouts
```

The runner builds a throwaway git worktree overlaid with your working tree and runs your guard twice there. Both halves are required:

1. **Control.** The unmutated sandbox must make the guard exit 0. A clean baseline is what makes the next step attributable. Without it, a non-zero exit could just mean the sandbox is broken.
2. **Violation.** The `write` fixture lands `api/guard-proof-fetch-timeout.js`, and the guard must now exit non-zero *and* print the `expect` fragment, because a guard that fails for the wrong reason is not a working guard.

The verdicts you can get back are `proven`, `control-failed` (your guard already fails on a clean tree), `not-caught` (the fixture slipped past it, so the guard is a no-op), and `wrong-reason` (it failed, but not on your violation). Only the first one means what you built works. Results land in `public/guard-proofs.json` with a verdict per guard.

It is safe to run while other agents are working in this tree: each run gets its own sandbox keyed to its process id and never writes to the repository except that one results file.

---

## Step 6: test it

A guard with no test rots into a no-op, and you find out when the thing it was supposed to catch ships anyway. A proof covers the violation you thought of; a test file is where you pin the false positives. Create `tests/check-fetch-timeouts.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'check-fetch-timeouts.mjs');

let sandbox;

/** A miniature repo with one api/ file, so the real script can run against it. */
function makeRepo(name, contents) {
	const dir = join(sandbox, name);
	mkdirSync(join(dir, 'api'), { recursive: true });
	mkdirSync(join(dir, 'scripts'), { recursive: true });
	copyFileSync(script, join(dir, 'scripts', 'check-fetch-timeouts.mjs'));
	writeFileSync(join(dir, 'api', 'handler.js'), contents);
	return dir;
}

function run(dir) {
	try {
		return { code: 0, out: execFileSync('node', [join(dir, 'scripts', 'check-fetch-timeouts.mjs')], { encoding: 'utf8' }) };
	} catch (err) {
		return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

beforeAll(() => {
	sandbox = mkdtempSync(join(tmpdir(), 'fetch-timeouts-'));
});
afterAll(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

describe('check-fetch-timeouts', () => {
	it('passes when the fetch carries a signal', () => {
		const dir = makeRepo('ok', 'await fetch(url, { signal: AbortSignal.timeout(5000) });\n');
		expect(run(dir).code).toBe(0);
	});

	it('fails on a bare fetch and names the line', () => {
		const dir = makeRepo('bad', 'const a = 1;\nawait fetch(url);\n');
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('api/handler.js:2');
	});

	it('ignores a fetch mentioned in a comment', () => {
		// The false positive that would get this guard deleted.
		const dir = makeRepo('comment', '// call fetch(url) here later\nexport const ok = 1;\n');
		expect(run(dir).code).toBe(0);
	});
});
```

Run it:

```bash
npx vitest run tests/check-fetch-timeouts.test.js
```

Note the third test. It is not padding. It encodes the false positive that would get the guard switched off, so nobody can "simplify" the check later and reintroduce it.

Build the sandbox rather than pointing the test at the real repository. A test that asserts on real files fails the moment somebody adds an unrelated `fetch`, and a test that edits real files races every other agent working in the tree.

---

## Step 7: document it

Add a row to the relevant table in [`docs/guards.md`](/docs/guards), and add a `data/changelog.json` entry if the guard changes what contributors have to do.

---

## Checklist

Your guard is done when all of these are true:

- [ ] `scripts/check-<thing>.mjs` exists, exits non-zero with an actionable message, and opens with the incident that motivated it.
- [ ] An npm script runs it.
- [ ] `data/guards.json` has an entry with `title`, `protects`, `why`, `stages`, and a `proof`.
- [ ] It is wired into the chain for every stage it claims.
- [ ] `npm run audit:guards` passes.
- [ ] `npm run prove:guards -- --only <id>` returns `proven`, not `not-caught` or `control-failed`.
- [ ] A test covers the pass case, the fail case, and at least one false positive it must not report.
- [ ] `npm run gate` still passes.

---

## Related

- [Repository guards](/docs/guards): every existing guard, its stage, the design principles, and the full `proof` vocabulary.
- [/guards](/guards): the registry as a browsable page.
- [Start here](/docs/start-here): what three.ws is, if you landed here first.
