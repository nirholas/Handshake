# three-vanity/v1 — Provably-Fair Vanity Grinding Protocol

A vanity-address service normally asks you to **trust the operator**: trust that
your key was generated with real randomness, that no copy was kept, that they
didn't grind thousands of candidates and hand you the one whose key they secretly
logged. There is no proof; you just hope.

`three-vanity/v1` replaces that hope with a **commit–reveal + sealed-delivery +
signed-receipt** protocol. A buyer can verify, after the fact and with
open-source tooling, that:

1. the key was generated **fresh** from entropy the server committed to *before*
   it knew the buyer's pattern (no precomputed rainbow table of keys);
2. the buyer's own entropy was mixed in, so **neither party alone** controlled
   the output;
3. the address actually derives from the revealed seed, matches the pattern, and
   the difficulty claim is the honest probability model;
4. the receipt was **signed by the three.ws service key**, not an impostor;
5. (optionally) the key the buyer recovered from the sealed envelope is
   byte-for-byte the key the receipt describes — **the buyer alone holds it**.

This document specifies the scheme precisely enough to reimplement the verifier
in any language. The reference implementations are
[`src/solana/vanity/verifiable-grind.js`](../src/solana/vanity/verifiable-grind.js)
(server + Node verifier), [`solana-agent-sdk/src/vanity`](../solana-agent-sdk/src/vanity)
(TypeScript SDK), and [`scripts/verify-vanity-receipt.mjs`](../scripts/verify-vanity-receipt.mjs)
(CLI). The web verifier is [`/vanity/verify`](https://three.ws/vanity/verify).

---

## Primitives

| Purpose            | Algorithm                                   | Source                |
| ------------------ | ------------------------------------------- | --------------------- |
| Hash / commitment  | SHA-256                                      | `@noble/hashes`       |
| Seed mixing (KDF)  | HKDF-SHA256                                  | `@noble/hashes`       |
| Candidate stream   | HMAC-SHA256                                  | `@noble/hashes`       |
| Keypair            | Ed25519 (Solana address = public key)       | `@noble/curves`       |
| Receipt signature  | Ed25519                                      | `@noble/curves`       |
| Sealed delivery    | `x25519-hkdf-sha256-aes256gcm/v1` (ECIES)   | `sealed-envelope.js`  |

All byte strings below are concatenated left-to-right. `uint64_be(n)` is the
8-byte big-endian encoding of a non-negative integer. Domain-separation tags are
ASCII (UTF-8) byte strings.

### Domain-separation tags

```
TAG_SEED_COMMIT = "three-vanity/seed-commit/v1"
TAG_MIX_SALT    = SHA-256("three-vanity/mix-salt/v1")     // 32 bytes
TAG_MASTER_INFO = "three-vanity/master/v1"
TAG_CANDIDATE   = "three-vanity/candidate/v1"
TAG_RECEIPT     = "three-vanity/receipt/v1"
```

---

## 1. Commitment (commit phase)

Before grinding, the server draws a uniformly-random 32-byte `serverSeed` and
publishes a commitment to it:

```
commitment = hex( SHA-256( TAG_SEED_COMMIT ‖ serverSeed ) )
```

The commitment is bound into the signed receipt, so the server is locked to that
seed *before* it knows which candidate will win. It cannot have precomputed a
table of keys keyed to the buyer's pattern: any swap of `serverSeed` after the
fact breaks `SHA-256(serverSeed) == commitment`.

`serverSeed` is **revealed** in the receipt (the reveal phase). Verification
recomputes the commitment and compares it byte-for-byte.

## 2. Seed mixing

Neither the server nor the buyer may control the output alone. The two seeds and
the per-request nonce are folded into one 32-byte master seed:

```
masterSeed = HKDF-SHA256(
    ikm  = serverSeed ‖ clientSeed ‖ requestNonce,
    salt = TAG_MIX_SALT,
    info = TAG_MASTER_INFO,
    len  = 32 )
```

- `clientSeed` is buyer-supplied entropy (hex or Base58, any length 1–1024
  bytes). If the buyer omits it, the server generates a fresh random 32-byte
  `clientSeed` and **reveals** it in the receipt. Either way the buyer can
  confirm their entropy went into the mix.
- `requestNonce` is a fresh random 16 bytes drawn per request and revealed.

Because the order is fixed and each input is domain-separated by HKDF, swapping
`serverSeed` ↔ `clientSeed` (or altering either) yields a different `masterSeed`,
which yields a different candidate stream and address.

## 3. Candidate derivation (grind)

Candidate `i` (a 0-based counter) has a fully deterministic Ed25519 private seed:

```
seed_i      = HMAC-SHA256( key = masterSeed, msg = TAG_CANDIDATE ‖ uint64_be(i) )
publicKey_i = Ed25519.getPublicKey( seed_i )       // 32 bytes
address_i   = Base58( publicKey_i )                 // Solana address
```

The grinder walks `i = 0, 1, 2, …` until `address_i` satisfies the requested
pattern (see §4). The winning index is recorded as `winningIndex`. The Solana
64-byte secret key is `seed_i ‖ publicKey_i` (the `Keypair.fromSecretKey` /
Phantom import format).

> **Why pure-JS Ed25519, not the WASM grinder?** Verifiability requires the
> verifier to reproduce the exact candidate stream from `masterSeed` and
> `winningIndex`. The deterministic HMAC→Ed25519 derivation above is the stream;
> the WASM engine's internal `crypto.getRandomValues` keys are not reproducible
> and are therefore **not** used by this protocol.

## 4. Pattern matching

```
matches(address, prefix, suffix, ignoreCase):
    a, p, s = address, prefix, suffix
    if ignoreCase: a, p, s = lower(a), lower(p), lower(s)
    return (p == "" or a.startsWith(p)) and (s == "" or a.endsWith(s))
```

The Base58 alphabet excludes `0 O I l`. **Difficulty** is the mean of a geometric
distribution, the expected number of candidates to a hit, computed as the
reciprocal of the probability that a random address satisfies the pattern.

Base58 is a positional encoding of a 256-bit integer, **not** a string of
independent symbols, so the *leading* character is not uniform. A 32-byte key
encodes to 44 digits when its value is at least 58⁴³ and 43 digits otherwise, and
2²⁵⁶ / 58⁴³ ≈ 17.05, so a 44-digit encoding can only ever lead with one of the
first 17 symbols, while the ~5.9% of keys short enough for 43 digits can lead
with anything. Trailing characters *are* uniform.

```
prefixProbability(prefix):                  // EXACT, count, do not approximate
    zeros = number of leading '1's in prefix  // a '1' is a leading zero BYTE
    rest  = prefix without those leading '1's
    if rest == "": return 2^(256 - 8*zeros) / 2^256
    lo, hi = 2^(8*(31-zeros)), 2^(8*(32-zeros))   // top byte non-zero
    v = base58 value of rest
    count = 0
    for pad = 0, 1, 2, …:
        [a, b) = [v·58^pad, (v+1)·58^pad) ∩ [lo, hi)
        if v·58^pad >= hi: break
        count += max(0, b - a)
    return count / 2^256

suffixProbability(suffix, ignoreCase):
    p = 1
    for ch in suffix: p *= matchesPerChar(ch, ignoreCase) / 58
    return p

expectedAttempts(prefix, suffix, ignoreCase):
    pp = ignoreCase ? Σ over Base58-valid case spellings of prefixProbability(spelling)
                    : prefixProbability(prefix)
    return 1 / (pp · suffixProbability(suffix, ignoreCase))
```

`matchesPerChar` is 2 iff `ignoreCase` and both cases are valid Base58, else 1.
The resulting per-symbol leading probabilities fall into six bands:

| Leading symbol | P(lead) | vs uniform 1/58 |
|---|---|---|
| `1` | 1/256 | 0.23× |
| `2`-`3` | 5.804e-2 | 3.37× easier |
| `4` | 5.814e-2 | 3.37× easier |
| `5`-`H` | 5.904e-2 | 3.43× easier |
| `J` | 1.433e-2 | 0.83× |
| `K`-`z` | 1.001e-3 | 17.2× harder |

### 4.1 Difficulty model versioning

The receipt's `difficulty.expectedAttempts` MUST equal `round(expectedAttempts(…))`
under the model named in `difficulty.model`:

| `difficulty.model` | Meaning |
|---|---|
| `base58-exact/v2` | The exact distribution above. Required for all new receipts. |
| `58^effectiveLength` | Superseded: every character treated as uniform 1/58. Wrong for the leading character by up to 17×. |

A verifier MUST check a receipt against the model the receipt itself declares,
and MUST treat an absent `difficulty.model` as `58^effectiveLength`, every
receipt issued before the correction carried that model. Re-scoring an old
receipt under the new model would brand an honestly-issued attestation as
fraudulent.

## 5. Sealed delivery

When the buyer supplies an X25519 public key (`sealTo`), the secret bundle

```
{ format: "keypair", secretKeyBase58, secretKey: number[64], seed: hex }
```

is sealed with the ECIES scheme `x25519-hkdf-sha256-aes256gcm/v1` (see
[`sealed-envelope.js`](../src/solana/vanity/sealed-envelope.js)):

1. ephemeral X25519 keypair `e`;
2. `shared = X25519(e.secret, recipientPub)`;
3. `key = HKDF-SHA256(ikm=shared, salt=e.public ‖ recipientPub,
   info="three.ws sealed-envelope v1", 32)`;
4. AES-256-GCM(key, random 12-byte nonce, AAD = `e.public`);
5. emit `{ scheme, epk, nonce, ciphertext, recipient }`.

The ephemeral secret is discarded, so the envelope is forward-secret with respect
to the server. The receipt records `sealedRecipient` and `sealedEpk` so the buyer
can prove *this* envelope was sealed to *their* key. The plaintext secret never
appears in the response, a proxy log, or the idempotency cache.

## 6. Signed receipt

The server signs a canonical projection of the receipt with its long-lived
Ed25519 identity key (published at
[`/.well-known/three-vanity.json`](https://three.ws/.well-known/three-vanity.json)
and pinned in the SDK + CLI + web verifier).

**Signed fields** (and only these — delivery payload and navigation hints are
*not* signed):

```
protocol, receiptType, address, pattern, commitment, serverSeed, clientSeed,
requestNonce, winningIndex, attempts, durationMs, difficulty, sealed,
sealedScheme, sealedRecipient, sealedEpk, network, ts
```

**Canonical bytes.** Project the receipt to the signed fields above (dropping any
field whose value is `undefined`), JSON-serialize with **recursively
lexicographically-sorted object keys** and no insignificant whitespace, then:

```
message   = TAG_RECEIPT ‖ utf8( canonicalJSON )
signature = hex( Ed25519.sign(message, serviceSigningSeed) )
```

The receipt carries `signature`, `servicePublicKey` (Base58), and
`signatureScheme: "ed25519"`. Extra response fields (`sealedSecret`,
`secretKeyBase58`, `explorerUrl`, `verifyUrl`, …) are intentionally outside the
signature, so a UI or transport may add/strip them without invalidating it; the
verifier re-projects to the signed fields before checking.

---

## Verification algorithm

Given a receipt (and, optionally, the opened secret seed), a verifier MUST
recompute — never trust — each of the following. All must pass.

1. **protocol** — `receipt.protocol == "three-vanity/v1"`.
2. **commitment** — `SHA-256(TAG_SEED_COMMIT ‖ serverSeed) == commitment`.
3. **derivation** — re-derive `masterSeed` (§2) and `address_{winningIndex}`
   (§3); it MUST equal `receipt.address`.
4. **pattern** — `receipt.address` satisfies `receipt.pattern` (§4).
5. **difficulty**, `difficulty.expectedAttempts == round(expectedAttempts(…))`
   under the model named in `difficulty.model` (§4.1), NOT under the verifier's
   current default.
6. **signature** — Ed25519-verify the canonical message (§6) against the pinned
   service key, AND the receipt's `servicePublicKey` equals the pinned key
   (reject impostors that self-sign under a different key).
7. **custody** *(optional)* — if the buyer opened the sealed envelope, the
   recovered 32-byte seed MUST equal `seed_{winningIndex}` and its Ed25519 public
   key MUST equal `receipt.address`.

A single failing check means the receipt is not trustworthy. The negative test in
[`tests/vanity-verifiable-grind.test.js`](../tests/vanity-verifiable-grind.test.js)
pins that a tampered address, swapped `serverSeed`, wrong `winningIndex`, inflated
difficulty, impostor signing key, or mismatched opened secret each FAIL.

---

## Service key publication & rotation

`/.well-known/three-vanity.json` publishes:

```json
{
  "protocol": "three-vanity/v1",
  "serviceKey": { "curve": "ed25519", "keyId": "…", "publicKeyBase58": "…", "publicKeyHex": "…", "use": "receipt-signing" },
  "schemes": { … },
  "endpoints": {
    "grind": "https://three.ws/api/x402/vanity",
    "verifiableGrind": "https://three.ws/api/x402/vanity-verifiable",
    "certRegistry": "https://three.ws/api/vanity/cert",
    "verifyPage": "https://three.ws/vanity/verify"
  }
}
```

Endpoint URLs are absolute, so a verifier that fetched the document has everything
it needs without knowing the origin. `grind` is the plain vanity endpoint;
`verifiableGrind` is the one that issues the receipts this protocol specifies.

The SDK pins `THREE_VANITY_SERVICE_KEY`; for production verification, cross-check
it against the live well-known document (`fetchServiceKey()` / `--fetch-key` /
the web page does this automatically). On key rotation, update the well-known
document and the pinned SDK constant; receipts signed under the previous key
remain verifiable against that key but new pins should track the current one.

The signing **secret** is custodial: stored encrypted at rest via
[`secret-box.js`](../api/_lib/secret-box.js) under `VANITY_SERVICE_KEY`, never
logged, never returned.
