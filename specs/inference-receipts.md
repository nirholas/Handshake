# Inference settlement receipts (three-inference-receipt/v1)

The wire format that ties an x402 payment for inference work to the exact job
and response it paid for (Roadmap phase 4). When a paid inference call on
[`/api/x402/llm-proxy`](../api/x402/llm-proxy.js) settles, the response body
carries an `inferenceReceipt` object. Anyone holding the receipt can prove,
offline and from first principles, that a specific payment on a specific
network bought a specific metered job with a specific signed response. A node
operator uses the same receipt to prove they were paid for exactly the work
they performed.

- Spec id: `three-inference-receipt/v1` (receipt), `three-inference-response/v1` (metered job)
- Status: live on `/api/x402/llm-proxy` behind `INFERENCE_SIGNING_KEY` (unset
  disables signing and receipt issuance; the rollback toggle).
- Reference implementation: [`api/_lib/inference-settlement.js`](../api/_lib/inference-settlement.js)
- Persistence: `inference_jobs` table, [`api/_lib/migrations/20260812000000_inference_jobs.sql`](../api/_lib/migrations/20260812000000_inference_jobs.sql)
- Verifiers: `POST /api/x402/inference-verify` (free, HTTP) and
  [`scripts/inference-receipt-verify.mjs`](../scripts/inference-receipt-verify.mjs) (offline CLI)
- Relationship to OIN: [OPEN_INFERENCE_PROTOCOL.md](OPEN_INFERENCE_PROTOCOL.md)
  signs GPU worker job envelopes; this spec settles LLM inference over the
  x402 payment rail. Same ed25519 primitive, different artifact.

## Design goals

1. **Payment bound to work, not to a timestamp.** The receipt commits to the
   sha256 of the exact prompt and the exact completion, the provider-reported
   token counts, the settlement transaction, the amount, the asset, the payer
   and the payTo. Changing any one byte of any committed field invalidates a
   signature.
2. **Two attributable identities.** The *response signature* answers "which
   node stands behind this output"; the *receipt signature* answers "which
   issuer vouches that this payment covered this job". They can be the same
   key (default) or distinct operator-controlled keys.
3. **Verify without trusting us.** Both signatures are ed25519 over
   domain-tagged canonical JSON, verifiable with any RFC 8032 implementation.
   The on-chain leg (settlement confirmation) is optional and read-only.
4. **No real funds in proof runs.** The test lane settles on Solana devnet
   (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), which the platform's
   self-hosted facilitator already routes. Mainnet activation is a documented,
   owner-gated step (see "Activation" below).

## Canonical encoding

Identical construction to the 3D provenance credentials
([PROVENANCE_3D.md](PROVENANCE_3D.md)): JSON with object keys sorted
recursively, no whitespace, UTF-8. All digests are SHA-256 over canonical
bytes, hex-encoded lowercase. Signatures are ed25519 (RFC 8032) over

```
TAG || canonical_bytes
```

where `TAG` is a versioned domain-separation string so a signature from any
other three.ws signing scheme can never replay as an inference artifact:

| Artifact      | Tag                               |
| ------------- | --------------------------------- |
| Metered job   | `three-inference-response/v1\n`   |
| Receipt       | `three-inference-receipt/v1\n`    |

Signatures and public keys are base58 (Solana encoding), so an operator's
existing Solana keypair doubles as a signing identity.

## The metered job (`three-inference-response/v1`)

Produced by the node immediately after inference, before settlement. Lives on
the paid response body as `metering` and inside the receipt as `job`.

```jsonc
{
	"type": "three-inference-response/v1",
	"jobId": "9b2f…",              // uuid, one per paid request
	"route": "/api/x402/llm-proxy",
	"model": "llama-3.3-70b-versatile", // concrete model that produced the output
	"provider": "groq",               // provider lane that ran it
	"promptSha256": "a1b2…",          // sha256 hex of the raw prompt string
	"responseSha256": "c3d4…",        // sha256 hex of the raw completion text
	"inputTokens": 5,                 // provider-reported prompt tokens
	"outputTokens": 6,                // provider-reported completion tokens
	"tokensUsed": 11,                 // inputTokens + outputTokens
	"latencyMs": 312                  // optional, measured wall-clock
}
```

The prompt and completion themselves never appear in the receipt: only their
hashes. A verifier who holds the raw text re-derives the hashes; a verifier
who does not can still check both signatures and the on-chain settlement.

## The receipt (`three-inference-receipt/v1`)

Issued after the x402 settlement lands, attached to the paid response body as
`inferenceReceipt`, and persisted server-side in `inference_jobs`.

```jsonc
{
	"receiptType": "three-inference-receipt/v1",
	"issuedAt": "2026-08-12T00:00:00.000Z",
	"job": { /* the metered job above, verbatim */ },
	"responseSignature": "4xY…",   // ed25519 by responseSigner over the job core
	"responseSigner": "NodePub…",  // base58 node key (INFERENCE_SIGNING_KEY)
	"payment": {
		"network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // CAIP-2
		"payer": "BuyerWallet…",
		"payTo": "OperatorWallet…",
		"amountAtomics": "5000",     // decimal string, 6-decimal USDC atomics
		"asset": "EPjFWdd5…",        // settlement mint / contract
		"transaction": "5KtR…"       // settlement tx signature / hash
	},
	"signer": "IssuerPub…",        // base58 receipt issuer (INFERENCE_RECEIPT_SIGNING_KEY)
	"signature": "3wQm…"           // ed25519 by signer over everything above
}
```

The receipt signature covers the entire object except `signature` itself.
`payTo` is the wallet that received the settlement: for platform-run
inference that is the platform receiver; for a third-party node operator it
is the operator's own wallet, which is what makes the receipt a proof of
payment *to the operator*.

## Verification procedure

`verifyInferenceReceipt()` (and both verifiers built on it) runs these checks
in order; each is reported individually:

| Check                  | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `shape`                | receiptType, signature, signer, job, payment all present and typed.     |
| `receipt_signature`    | ed25519 verify of `signature` over the receipt core, key `signer`.      |
| `receipt_signer_trusted` | (when a signer is pinned) `signer` equals the pinned key.              |
| `response_signature`   | ed25519 verify of `responseSignature` over the job core, key `responseSigner`. |
| `prompt_binding`       | (when raw prompt supplied) sha256(prompt) equals `job.promptSha256`.    |
| `response_binding`     | (when raw content supplied) sha256(content) equals `job.responseSha256`. |
| `token_totals`         | `tokensUsed == inputTokens + outputTokens`, all non-negative integers.  |
| `payment_fields`       | network, payer, payTo, asset, transaction, amountAtomics all well-formed. |

The HTTP verifier and the CLI add one optional check on top:

| Check                | Meaning                                                              |
| -------------------- | ------------------------------------------------------------------- |
| `onchain_settlement` | `payment.transaction` confirmed on `payment.network` (read-only RPC). |

A receipt is **verified** when every requested check passes. `prompt_binding`
and `response_binding` are optional because a third party may hold only the
receipt, not the raw text; the receipt still proves payment-to-job binding
without them.

## Proving payment for work performed (operator flow)

1. Run paid inference; keep the `inferenceReceipt` from each response.
2. To prove a specific job was paid: `node scripts/inference-receipt-verify.mjs
   receipt.json --prompt "…" --content "…" --onchain`. Exit 0 means the
   receipt signature, the response signature, both content bindings, and the
   on-chain settlement all check out.
3. To audit a stream of jobs server-side: `inference_jobs` is queryable by
   `payer` or `tx_hash` (`api/_lib/inference-jobs.js` `listInferenceJobs`).

## Activation and lanes

- **Test lane (default for proof runs):** Solana devnet. The platform's
  self-hosted facilitator already routes `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`;
  settle against it with devnet USDC and every check above runs identically.
  No real funds move.
- **Mainnet:** the same receipt format with `payment.network` =
  `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (or any EVM lane the rail
  settles). Activation is setting `INFERENCE_SIGNING_KEY` (and optionally a
  distinct `INFERENCE_RECEIPT_SIGNING_KEY`) on the Cloud Run service env, an
  owner-gated deploy step. With the key unset, responses ship unsigned and no
  receipts are issued: that is the rollback position.

## Security notes

- Signing keys are ed25519 and MUST be distinct from every `X402_PAY_TO_*`
  wallet and from `X402_RECEIPT_SIGNING_KEY` (the secp256k1 EIP-712 key).
  These keys only attest; they never custody funds.
- The domain tags are load-bearing: never sign untagged bytes with these
  keys, and never accept an inference artifact without its tag.
- The receipt commits to the settlement transaction but does not itself prove
  confirmation; run the `onchain_settlement` check (or look the tx up) when
  finality matters. An RPC outage must read as "unverifiable", never as
  "confirmed".
