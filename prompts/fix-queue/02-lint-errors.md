# 05. Three eslint errors, one of which is a real bug in a test that guards money

**Severity: P1.** Read [00-INDEX.md](00-INDEX.md) first.

## Symptom (reproduced 2026-08-01)

```
$ npm run lint
...
x 7807 problems (3 errors, 7804 warnings)
exit=1
```

The three errors, with the file each belongs to:

| File | Error |
|---|---|
| [tests/bundle-pricing.test.js:129](../../tests/bundle-pricing.test.js#L129) | `This number literal will lose precision at runtime` (`no-loss-of-precision`) |
| [vite.config.js:375](../../vite.config.js#L375) | `Duplicate key 'bundles'` (`no-dupe-keys`) |
| [.claude/workflows/docs-drift.js:65](../../.claude/workflows/docs-drift.js#L65) | `Parsing error: 'return' outside of function` |

## Each one, diagnosed

1. **`tests/bundle-pricing.test.js:129` is the important one.** The test is
   named `keeps atomic amounts as strings so a 9-decimal mint cannot lose
   precision`, and its own setup line is
   `const big = 9_007_199_254_740_993;`, a Number literal that exceeds
   `Number.MAX_SAFE_INTEGER` and is therefore silently rounded to
   `9007199254740992` before `simulatePrice` ever sees it. The test asserts the
   result is a `string`, so it still passes, but it is testing the wrong input:
   the exact value it was written to defend was destroyed by the literal. Fix
   the input (BigInt literal or a string, matching whatever `simulatePrice`
   actually accepts, which you must read rather than assume), and strengthen the
   assertions to compare the exact digits out, not just `typeof`. If the fixed
   input makes the test fail, you have found a real precision bug in the pricing
   path: fix that too, and say so prominently.
2. **`vite.config.js:374-375` is a literal duplicated line.** `bundles:` is
   declared twice with an identical value inside `rollupOptions.input`. Harmless
   at runtime, but it is exactly the kind of copy-paste residue that hides a
   *different* intended entry. Check git history for what line 375 was meant to
   be before you delete it; if it was always a duplicate, delete one.
3. **`.claude/workflows/docs-drift.js:65` is a parser mismatch, not bad code.**
   Workflow scripts run inside an async context where a top-level `return` is
   legal (see the Workflow contract), and this file's `return { written, ... }`
   is correct. eslint parses it as a plain module. Fix the config, not the file:
   add an override in [eslint.config.js](../../eslint.config.js) for
   `.claude/workflows/**` with `parserOptions.ecmaFeatures.globalReturn` (or the
   flat-config equivalent), and leave the script alone.

## The warnings are not in scope, but the ratchet is

7,804 warnings is untriaged debt that makes the errors invisible. Do not attempt
a mass fix in this work order. Instead, make the number unable to grow: record
the current count and fail `npm run lint` (or a new `lint:ratchet` script wired
where the existing guards live) when it increases. Register it in
`data/guards.json` with its stage and a `why`, because `/guards` and
`docs/guards.md` both render that registry and drift there misleads readers.

## Verification

```bash
npm run lint                 # 0 errors
npx vitest run tests/bundle-pricing.test.js
npm run gate                 # no worse than the baseline in 00-INDEX.md
```

## Done when

`npm run lint` reports zero errors, the pricing test defends the value it claims
to defend, the eslint config understands workflow scripts, and the warning count
cannot silently grow.
