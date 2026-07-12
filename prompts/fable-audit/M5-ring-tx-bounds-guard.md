# M5 — Medium: `validateRingTransaction` can throw on malformed input, breaking its "never throws" contract

**Severity:** Medium · **Area:** Payments · **Commit-gate:** no

## The defect
[api/_lib/x402/self-facilitator.js](../../api/_lib/x402/self-facilitator.js) —
`validateRingTransaction` is documented/relied upon to return
`{ ok: false, reason }` on any bad input (a "clean refusal", never a throw). But:
- The ATA-create branch reads `keys[accts[0..3]]` with no length/range guard.
- The instruction loop reads `keys[ix.programIdIndex]` with no bounds check.
- Only `VersionedTransaction.deserialize` is wrapped in try/catch.

A crafted serialized tx with an out-of-range `programIdIndex` or a short
`accountKeyIndexes` on an ATA-create instruction yields `undefined.equals(...)` → a
`TypeError`, which propagates through `settleRingPayment` (called un-try/caught) and
surfaces as a **500 instead of the documented `{ ok:false, reason }`**. No fund loss,
but it violates the totality guarantee the security model leans on.

## The fix
Bounds-guard the index reads and return a clean refusal:

```js
// before dereferencing account-key indices:
const idxInRange = (i) => Number.isInteger(i) && i >= 0 && i < keys.length;

// ATA-create branch:
if (!accts.slice(0, 4).every(idxInRange)) {
  return { ok: false, reason: 'malformed_instruction' };
}

// instruction loop:
if (!idxInRange(ix.programIdIndex)) {
  return { ok: false, reason: 'malformed_instruction' };
}
```

Optionally also wrap the whole decode loop in a try/catch that maps any unexpected
throw to `{ ok: false, reason: 'decode_error' }`, so the totality guarantee holds
even against future additions.

## Verification
1. Add a test feeding a serialized tx with an out-of-range `programIdIndex` /
   truncated account-index list → expect `{ ok:false }`, not a throw / 500.
2. A valid ring transfer still validates.

## Done checklist
- [ ] Index bounds guarded in both branches.
- [ ] Malformed-input test added → returns clean refusal.
- [ ] Valid path unchanged.
