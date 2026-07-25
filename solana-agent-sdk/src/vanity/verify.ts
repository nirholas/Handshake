/**
 * Provably-fair vanity grinding — client verifier + one-call grind client.
 *
 * three.ws's verifiable vanity grinder (`/api/x402/vanity-verifiable`) returns a
 * signed receipt that proves the key was generated fresh under a commit–reveal
 * seed-mixing protocol and never kept. This module reproduces every protocol
 * check from first principles so a buyer trusts nothing in the receipt — it
 * recomputes each claim. Real crypto only: @noble Ed25519 / SHA-256 / HMAC /
 * HKDF, the same primitives the server signs with.
 *
 * Protocol `three-vanity/v1` is documented in docs/PROTOCOL-vanity.md.
 */

import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";

export const VANITY_PROTOCOL_VERSION = "three-vanity/v1";

/**
 * Pinned three.ws vanity service public key (Base58 Ed25519). Verification pins
 * to this by default so a self-signed impostor receipt is rejected.
 *
 * IMPORTANT: this is a *bootstrap* pin. The authoritative key is always the one
 * published at `/.well-known/three-vanity.json` for the deployment that issued
 * your receipt. For production verification, resolve the live key with
 * `fetchServiceKey()` and pass it as `servicePublicKey` — the one-call client
 * (`grindVerifiedVanity`) does this automatically. Update this constant whenever
 * the service key rotates so the offline default stays accurate.
 */
export const THREE_VANITY_SERVICE_KEY = "H8wSgC8JgTadWE4ECVkUdHRywxEygnLbpJjEwcej92NH";

export const THREE_VANITY_WELL_KNOWN = "https://three.ws/.well-known/three-vanity.json";
export const THREE_VANITY_ENDPOINT = "https://three.ws/api/x402/vanity-verifiable";

const enc = new TextEncoder();
const TAG_SEED_COMMIT = enc.encode("three-vanity/seed-commit/v1");
const TAG_MIX_SALT = sha256(enc.encode("three-vanity/mix-salt/v1"));
const TAG_MASTER_INFO = enc.encode("three-vanity/master/v1");
const TAG_CANDIDATE = enc.encode("three-vanity/candidate/v1");
const TAG_RECEIPT = enc.encode("three-vanity/receipt/v1");
const SEED_BYTES = 32;

export interface VanityPattern {
  prefix?: string | null;
  suffix?: string | null;
  ignoreCase?: boolean;
}

export interface VanityReceipt {
  protocol: string;
  receiptType?: string;
  address: string;
  pattern: VanityPattern;
  commitment: string;
  serverSeed: string;
  clientSeed: string;
  requestNonce: string;
  winningIndex: number;
  attempts?: number;
  durationMs?: number;
  difficulty?: { expectedAttempts?: number; model?: string };
  sealed?: boolean;
  sealedRecipient?: string | null;
  sealedEpk?: string | null;
  servicePublicKey: string;
  signature: string;
  signatureScheme?: string;
  ts?: string;
  [k: string]: unknown;
}

export interface VerifyCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface VerifyResult {
  valid: boolean;
  checks: VerifyCheck[];
  address: string;
}

export interface VerifyOptions {
  /** Pinned service public key (Base58/hex). Defaults to THREE_VANITY_SERVICE_KEY. */
  servicePublicKey?: string | Uint8Array;
  /** The 32-byte Ed25519 seed you recovered from the sealed envelope (optional). */
  openedSecretSeed?: Uint8Array | string;
}

function asBytes(value: Uint8Array | string, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return hexToBytes(s);
    try {
      return bs58.decode(s);
    } catch {
      throw new Error(`${label} is not valid hex or Base58`);
    }
  }
  throw new Error(`${label} must be a Uint8Array, hex, or Base58 string`);
}

function uint64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Commitment the server publishes before grinding. */
export function commitToSeed(serverSeed: Uint8Array | string): string {
  const seed = asBytes(serverSeed, "serverSeed");
  if (seed.length !== SEED_BYTES) throw new Error("serverSeed must be 32 bytes");
  return bytesToHex(sha256(concatBytes(TAG_SEED_COMMIT, seed)));
}

/** Fold serverSeed + clientSeed + requestNonce into the 32-byte master seed. */
export function deriveMasterSeed(p: {
  serverSeed: Uint8Array | string;
  clientSeed: Uint8Array | string;
  requestNonce: Uint8Array | string;
}): Uint8Array {
  const ikm = concatBytes(
    asBytes(p.serverSeed, "serverSeed"),
    asBytes(p.clientSeed, "clientSeed"),
    asBytes(p.requestNonce, "requestNonce"),
  );
  return hkdf(sha256, ikm, TAG_MIX_SALT, TAG_MASTER_INFO, SEED_BYTES);
}

/** Deterministic Ed25519 seed for candidate `index`. */
export function candidateSeed(masterSeed: Uint8Array, index: number): Uint8Array {
  return hmac(sha256, masterSeed, concatBytes(TAG_CANDIDATE, uint64be(index)));
}

/** Base58 Solana address for candidate `index`. */
export function candidateAddress(
  masterSeed: Uint8Array,
  index: number,
): { address: string; seed: Uint8Array } {
  const seed = candidateSeed(masterSeed, index);
  return { address: bs58.encode(ed25519.getPublicKey(seed)), seed };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

/** Difficulty model identifiers, mirroring src/solana/vanity/validation.js. */
export const DIFFICULTY_MODEL_V1 = "58^effectiveLength";
export const DIFFICULTY_MODEL_V2 = "base58-exact/v2";
export const DIFFICULTY_MODEL = DIFFICULTY_MODEL_V2;

/** Per-character expected attempts: how many of 58 chars satisfy a position. */
function matchesPerChar(ch: string, ignoreCase: boolean): number {
  if (!ignoreCase) return 1;
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  if (lower !== upper && BASE58_ALPHABET.includes(lower) && BASE58_ALPHABET.includes(upper)) return 2;
  return 1;
}

const KEY_BYTES = 32;
const TOTAL = 1n << BigInt(8 * KEY_BYTES);
const POW58: bigint[] = [1n];
for (let i = 1; i <= 64; i++) POW58.push(POW58[i - 1]! * 58n);
const SCALE = 10n ** 25n;

/**
 * Count the 32-byte values whose Base58 encoding begins with `prefix`.
 *
 * Base58 is a positional encoding of a 256-bit integer, not a string of
 * independent symbols, so the leading character is *not* uniform: 2²⁵⁶/58⁴³ ≈
 * 17.05 means a 44-digit encoding can only lead with one of the first 17
 * symbols, while the ~5.9% of keys short enough for 43 digits can lead with
 * anything. The spread is 58×. Leading '1's are leading zero *bytes*.
 */
function prefixCount(prefix: string): bigint {
  if (!prefix) return TOTAL;
  for (const ch of prefix) if (!BASE58_INDEX.has(ch)) return 0n;

  let zeros = 0;
  while (zeros < prefix.length && prefix[zeros] === "1") zeros++;
  if (zeros > KEY_BYTES) return 0n;
  const rest = prefix.slice(zeros);
  if (rest === "") return TOTAL >> BigInt(8 * zeros);

  const width = KEY_BYTES - zeros;
  if (width < 1) return 0n;
  const lo = 1n << BigInt(8 * (width - 1));
  const hi = 1n << BigInt(8 * width);

  let value = 0n;
  for (const ch of rest) value = value * 58n + BigInt(BASE58_INDEX.get(ch)!);

  let count = 0n;
  for (let pad = 0; pad + rest.length <= 64; pad++) {
    const unit = POW58[pad]!;
    const start = value * unit;
    if (start >= hi) break;
    const end = (value + 1n) * unit;
    const a = start > lo ? start : lo;
    const b = end < hi ? end : hi;
    if (b > a) count += b - a;
  }
  return count;
}

/** Every Base58-valid case spelling of `pattern` (empty when unreachable). */
function caseVariants(pattern: string): string[] {
  let out: string[] = [""];
  for (const ch of pattern) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const set = new Set<string>();
    if (BASE58_INDEX.has(ch)) set.add(ch);
    if (lower !== upper) {
      if (BASE58_INDEX.has(lower)) set.add(lower);
      if (BASE58_INDEX.has(upper)) set.add(upper);
    }
    if (set.size === 0) return [];
    const options = [...set];
    out = out.flatMap((head) => options.map((c) => head + c));
  }
  return out;
}

/**
 * Exact expected attempts for a pattern under the true Base58 distribution.
 * Mirrors src/solana/vanity/base58-distribution.js byte-for-byte; the parity
 * suite proves the two implementations agree.
 */
export function expectedAttempts(prefix = "", suffix = "", ignoreCase = false): number {
  let p = 1;
  if (prefix) {
    const variants = ignoreCase ? caseVariants(prefix) : [prefix];
    if (variants.length === 0) return Infinity;
    let count = 0n;
    for (const variant of variants) count += prefixCount(variant);
    if (count === 0n) return Infinity;
    p *= Number((count * SCALE) / TOTAL) / 1e25;
  }
  for (const ch of suffix || "") {
    p *= matchesPerChar(ch, ignoreCase) / 58;
  }
  return p > 0 ? 1 / p : Infinity;
}

/** The superseded uniform-1/58 model, kept so pre-correction receipts verify. */
export function expectedAttemptsUniform(prefix = "", suffix = "", ignoreCase = false): number {
  let attempts = 1;
  for (const ch of (prefix || "") + (suffix || "")) {
    attempts *= 58 / matchesPerChar(ch, ignoreCase);
  }
  return attempts;
}

/** Resolve the difficulty function a receipt was issued under. */
export function difficultyModel(model?: string) {
  return model === DIFFICULTY_MODEL_V1 ? expectedAttemptsUniform : expectedAttempts;
}

export function addressMatchesPattern(address: string, pattern: VanityPattern): boolean {
  let addr = address;
  let pre = pattern.prefix || "";
  let suf = pattern.suffix || "";
  if (pattern.ignoreCase) {
    addr = addr.toLowerCase();
    pre = pre.toLowerCase();
    suf = suf.toLowerCase();
  }
  if (pre && !addr.startsWith(pre)) return false;
  if (suf && !addr.endsWith(suf)) return false;
  return true;
}

// Exactly the fields the service signs (delivery payload + navigation hints are
// excluded). The verifier projects any receipt down to these before hashing so
// extra response/UI fields never perturb the signature. Must stay in lockstep
// with SIGNED_FIELDS in src/solana/vanity/verifiable-grind.js.
const SIGNED_FIELDS = [
  "protocol",
  "receiptType",
  "address",
  "pattern",
  "commitment",
  "serverSeed",
  "clientSeed",
  "requestNonce",
  "winningIndex",
  "attempts",
  "durationMs",
  "difficulty",
  "sealed",
  "sealedScheme",
  "sealedRecipient",
  "sealedEpk",
  "network",
  "ts",
] as const;

function projectSignedCore(obj: Record<string, unknown>): Record<string, unknown> {
  const core: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) {
    if (obj[k] !== undefined) core[k] = obj[k];
  }
  return core;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function canonicalReceiptBytes(core: Record<string, unknown>): Uint8Array {
  return concatBytes(TAG_RECEIPT, enc.encode(stableStringify(projectSignedCore(core))));
}

/** Verify the receipt's Ed25519 service signature against a public key. */
export function verifyReceiptSignature(
  receipt: VanityReceipt,
  servicePublicKey: string | Uint8Array,
): boolean {
  if (!receipt?.signature) return false;
  try {
    return ed25519.verify(
      hexToBytes(receipt.signature),
      canonicalReceiptBytes(receipt as unknown as Record<string, unknown>),
      asBytes(servicePublicKey, "servicePublicKey"),
    );
  } catch {
    return false;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function sameKey(a: string | Uint8Array, b: string | Uint8Array): boolean {
  try {
    return constantTimeEqual(asBytes(a, "a"), asBytes(b, "b"));
  } catch {
    return false;
  }
}

/**
 * Independently verify a vanity receipt. Recomputes every protocol claim — it
 * trusts nothing in the receipt. Returns a per-check audit plus an overall
 * verdict. Pins to THREE_VANITY_SERVICE_KEY unless `servicePublicKey` is given.
 */
export function verifyVanityReceipt(
  receipt: VanityReceipt,
  opts: VerifyOptions = {},
): VerifyResult {
  const checks: VerifyCheck[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) =>
    checks.push({ id, label, pass, detail });
  const pin = opts.servicePublicKey ?? THREE_VANITY_SERVICE_KEY;

  if (!receipt || typeof receipt !== "object") {
    add("shape", "Receipt is well-formed", false, "receipt is missing or not an object");
    return { valid: false, checks, address: "" };
  }
  if (receipt.protocol !== VANITY_PROTOCOL_VERSION) {
    add("protocol", "Protocol version is supported", false, `"${receipt.protocol}" ≠ "${VANITY_PROTOCOL_VERSION}"`);
    return { valid: false, checks, address: receipt.address || "" };
  }
  add("protocol", "Protocol version is supported", true, VANITY_PROTOCOL_VERSION);

  // 1. Commitment opens to the revealed serverSeed.
  try {
    const computed = commitToSeed(receipt.serverSeed);
    const ok = computed === receipt.commitment;
    add(
      "commitment",
      "serverSeed opens the commitment",
      ok,
      ok
        ? "SHA-256(serverSeed) matches the committed value — the server could not have swapped seeds after grinding"
        : `SHA-256(serverSeed) = ${computed} ≠ committed ${receipt.commitment}`,
    );
  } catch (e) {
    add("commitment", "serverSeed opens the commitment", false, (e as Error).message);
  }

  // 2. Re-derive the master seed + winning candidate; bind to the address.
  let derivedSeed: Uint8Array | null = null;
  try {
    const master = deriveMasterSeed({
      serverSeed: receipt.serverSeed,
      clientSeed: receipt.clientSeed,
      requestNonce: receipt.requestNonce,
    });
    const cand = candidateAddress(master, receipt.winningIndex);
    derivedSeed = cand.seed;
    const ok = cand.address === receipt.address;
    add(
      "derivation",
      "Address derives from the mixed seed at the claimed index",
      ok,
      ok
        ? `candidate #${receipt.winningIndex} re-derives to ${cand.address}`
        : `candidate #${receipt.winningIndex} re-derives to ${cand.address}, not ${receipt.address}`,
    );
  } catch (e) {
    add("derivation", "Address derives from the mixed seed at the claimed index", false, (e as Error).message);
  }

  // 3. Pattern.
  {
    const ok = addressMatchesPattern(receipt.address || "", receipt.pattern || {});
    const p = receipt.pattern || {};
    const want =
      [p.prefix && `prefix "${p.prefix}"`, p.suffix && `suffix "${p.suffix}"`].filter(Boolean).join(" + ") ||
      "(no pattern)";
    add(
      "pattern",
      "Address satisfies the requested pattern",
      ok,
      ok ? `${receipt.address} matches ${want}` : `${receipt.address} does NOT match ${want}`,
    );
  }

  // 4. Difficulty is the honest model, the one the receipt was ISSUED under,
  //    named in its own signed `difficulty.model`. Receipts predating the
  //    Base58 leading-character correction declare v1 and must keep verifying;
  //    an absent field means v1, since every pre-correction receipt used it.
  {
    const p = receipt.pattern || {};
    const model = receipt.difficulty?.model || DIFFICULTY_MODEL_V1;
    const expected = Math.round(difficultyModel(model)(p.prefix || "", p.suffix || "", !!p.ignoreCase));
    const ok = Number(receipt.difficulty?.expectedAttempts) === expected;
    add(
      "difficulty",
      "Difficulty matches the honest model",
      ok,
      ok
        ? `expectedAttempts = ${expected} under ${model}`
        : `claims ${receipt.difficulty?.expectedAttempts}, ${model} model = ${expected}`,
    );
  }

  // 5. Service signature + pinned-key check.
  {
    const sigOk = verifyReceiptSignature(receipt, pin);
    add(
      "signature",
      "Service Ed25519 signature is valid",
      sigOk,
      sigOk ? `valid under the pinned key` : "signature does not verify against the pinned service key",
    );
    const pinned = sameKey(pin, receipt.servicePublicKey);
    add(
      "serviceKeyPinned",
      "Signed by the pinned three.ws service key",
      pinned,
      pinned
        ? `receipt key ${receipt.servicePublicKey} matches the pinned key`
        : `receipt key ${receipt.servicePublicKey} ≠ pinned key — possible impostor`,
    );
  }

  // 6. (Optional) the opened secret is the ground key.
  if (opts.openedSecretSeed) {
    try {
      let opened = asBytes(opts.openedSecretSeed, "openedSecretSeed");
      if (opened.length === 64) opened = opened.slice(0, 32);
      const ok =
        derivedSeed != null && opened.length === 32 && constantTimeEqual(opened, derivedSeed);
      const pubOk = ok && bs58.encode(ed25519.getPublicKey(opened)) === receipt.address;
      add(
        "custody",
        "Your recovered key is the ground key",
        ok && pubOk,
        ok && pubOk
          ? "the secret you opened re-derives to the receipt address — you hold the one and only key"
          : "the opened secret does NOT match the protocol-derived key for this receipt",
      );
    } catch (e) {
      add("custody", "Your recovered key is the ground key", false, (e as Error).message);
    }
  }

  const valid = checks.every((c) => c.pass);
  return { valid, checks, address: receipt.address || "" };
}

/**
 * Fetch the live service public key from /.well-known/three-vanity.json. Use this
 * to pin against the canonical key independently of the SDK constant.
 */
export async function fetchServiceKey(
  wellKnownUrl: string = THREE_VANITY_WELL_KNOWN,
): Promise<string> {
  const res = await fetch(wellKnownUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`well-known fetch failed: ${res.status}`);
  const doc = (await res.json()) as { serviceKey?: { publicKeyBase58?: string } };
  const key = doc?.serviceKey?.publicKeyBase58;
  if (!key) throw new Error("well-known document missing serviceKey.publicKeyBase58");
  return key;
}
