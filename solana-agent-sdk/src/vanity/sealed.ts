/**
 * Open a three.ws sealed envelope (ECIES `x25519-hkdf-sha256-aes256gcm/v1`).
 *
 * Mirror of src/solana/vanity/sealed-envelope.js's openSealed, implemented with
 * @noble (X25519 + HKDF-SHA256 + AES-256-GCM) so it runs identically in Node and
 * the browser without depending on WebCrypto subtle being present. The buyer's
 * X25519 secret key never leaves the caller's process.
 */

import bs58 from "bs58";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes.js";

export const SEALED_ENVELOPE_SCHEME = "x25519-hkdf-sha256-aes256gcm/v1";

const HKDF_INFO = new TextEncoder().encode("three.ws sealed-envelope v1");
const X25519_KEY_BYTES = 32;

export interface SealedEnvelope {
  scheme: string;
  epk: string;
  nonce: string;
  ciphertext: string;
  recipient?: string;
}

function fromBase64url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback.
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const KEY_DECODERS: Record<string, (s: string) => Uint8Array> = {
  hex: (s) => {
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) throw new Error("not hex");
    return Uint8Array.from(s.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  },
  base58: (s) => bs58.decode(s),
  base64url: (s) => fromBase64url(s),
};

/**
 * Parse a 32-byte X25519 key from a Uint8Array, or a Base58 / Base64url / hex
 * string, refusing to guess when the string is genuinely ambiguous.
 *
 * Base58's alphabet is a subset of Base64url's and Base64url spends exactly 43
 * characters on 32 bytes, the same length Base58 uses for the ~5.4% of keys
 * small enough to need only 43 digits. So a bare 43-character string can encode
 * two different keys. Picking one silently is how a buyer ends up unable to open
 * an envelope they paid for, so an unresolvable string throws instead. An
 * explicit `hex:`, `base58:` or `base64url:` prefix always wins.
 *
 * Mirrors src/solana/vanity/sealed-envelope.js.
 */
function parseX25519Key(key: Uint8Array | string, label: string): Uint8Array {
  let bytes: Uint8Array;
  if (key instanceof Uint8Array) {
    bytes = key;
  } else {
    const s = key.trim();
    const explicit = /^(hex|base58|base64url):(.*)$/s.exec(s);
    if (explicit) {
      bytes = KEY_DECODERS[explicit[1]!]!(explicit[2]!.trim());
    } else if (/^[0-9a-fA-F]{64}$/.test(s)) {
      bytes = KEY_DECODERS.hex!(s);
    } else if (/^[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) {
      bytes = KEY_DECODERS.base58!(s);
    } else {
      const found = new Map<string, { name: string; bytes: Uint8Array }>();
      for (const [name, decode] of Object.entries(KEY_DECODERS)) {
        let out: Uint8Array;
        try {
          out = decode(s);
        } catch {
          continue;
        }
        if (out?.length !== X25519_KEY_BYTES) continue;
        found.set([...out].map((b) => b.toString(16).padStart(2, "0")).join(""), { name, bytes: out });
      }
      if (found.size === 1) {
        bytes = [...found.values()][0]!.bytes;
      } else if (found.size === 0) {
        throw new Error(`${label} is not a valid Base58/Base64url/hex 32-byte key`);
      } else {
        const names = [...found.values()].map((v) => v.name).sort();
        throw new Error(
          `${label} is ambiguous: it is a valid ${names.join(" and ")} encoding of two different ` +
            `32-byte keys. Prefix it to be explicit, e.g. "base58:${s}" or "base64url:${s}".`,
        );
      }
    }
  }
  if (bytes.length !== X25519_KEY_BYTES) {
    throw new Error(`${label} must be a 32-byte X25519 key (got ${bytes.length})`);
  }
  return bytes;
}

/** Open a sealed envelope with the recipient's X25519 secret key → plaintext bytes. */
export function openSealed(
  envelope: SealedEnvelope,
  recipientSecretKey: Uint8Array | string,
): Uint8Array {
  if (!envelope || envelope.scheme !== SEALED_ENVELOPE_SCHEME) {
    throw new Error(`unsupported sealed-envelope scheme: ${envelope?.scheme}`);
  }
  const secret = parseX25519Key(recipientSecretKey, "recipient secret key");
  const epk = parseX25519Key(envelope.epk, "ephemeral public key");
  const shared = x25519.getSharedSecret(secret, epk);
  const recipientPub = x25519.getPublicKey(secret);

  const salt = new Uint8Array(epk.length + recipientPub.length);
  salt.set(epk, 0);
  salt.set(recipientPub, epk.length);
  const keyBytes = hkdf(sha256, shared, salt, HKDF_INFO, 32);

  const nonce = fromBase64url(envelope.nonce);
  const ct = fromBase64url(envelope.ciphertext);
  // AAD = ephemeral public key, exactly as the server bound it on seal.
  const aead = gcm(keyBytes, nonce, epk);
  const pt = aead.decrypt(ct);
  keyBytes.fill(0);
  return pt;
}

/** Open a sealed envelope and decode the plaintext as UTF-8 JSON. */
export function openSealedJson<T = unknown>(
  envelope: SealedEnvelope,
  recipientSecretKey: Uint8Array | string,
): T {
  return JSON.parse(new TextDecoder().decode(openSealed(envelope, recipientSecretKey))) as T;
}

/** Generate a throwaway X25519 recipient keypair (Base58). Pass publicKey as sealTo. */
export function generateRecipientKeypair(): { publicKey: string; secretKey: string } {
  // Keep drawing until BOTH Base58 forms are 44 characters.
  //
  // Base64url encodes 32 bytes in exactly 43 characters, and Base58's alphabet
  // is a subset of Base64url's, so a 43-character Base58 key is also a valid
  // Base64url string decoding to a *different* key, and a bare `sealTo=` value
  // cannot say which was meant. 44 characters is unambiguous, and only ~5.4% of
  // keys are short enough to need 43, so this costs ~11% of one extra keygen
  // and keeps the sealed-delivery path exact against every server version.
  // The secret is constrained too: it travels through the same parser when the
  // buyer opens the envelope.
  for (;;) {
    const secret = x25519.utils.randomSecretKey();
    const publicKey = bs58.encode(x25519.getPublicKey(secret));
    const secretKey = bs58.encode(secret);
    if (publicKey.length !== 44 || secretKey.length !== 44) continue;
    return { publicKey, secretKey };
  }
}
