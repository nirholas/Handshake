//! WASM-backed Solana ed25519 vanity address grinder.
//!
//! Exposes a single `grind` function callable from JS. Each call tries up to
//! `batch` keypairs derived deterministically from `start_seed` by treating
//! the low 4 bytes of the seed as a little-endian counter; the JS caller is
//! expected to supply a fresh cryptographically-random 32-byte `start_seed`
//! for each batch so resulting keys are unpredictable.
//!
//! Returns `null` if no match is found in the batch, or a `{ secretKey,
//! publicKey }` object on match. The 64-byte `secretKey` matches Solana's
//! standard layout: `[32-byte seed][32-byte public key]`, compatible with
//! `Keypair.fromSecretKey()` in `@solana/web3.js`.
//!
//! The hot loop derives each pubkey via raw curve25519-dalek primitives
//! (`SHA-512(seed)`, clamp, `scalar * G`, compress): exactly the ed25519
//! keypair derivation but without constructing the full `SigningKey` struct
//! that ed25519-dalek would normally hand back. The output pubkey is
//! bit-for-bit identical to `ed25519_dalek::SigningKey::from_bytes(seed)
//! .verifying_key().to_bytes()`, which the native test suite proves.

use curve25519_dalek::edwards::EdwardsPoint;
use js_sys::{Object, Reflect, Uint8Array};
use sha2::{Digest, Sha512};
use wasm_bindgen::prelude::*;

#[inline(always)]
fn pubkey_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha512::new();
    h.update(seed);
    let digest = h.finalize();

    let mut scalar_bytes = [0u8; 32];
    scalar_bytes.copy_from_slice(&digest[..32]);

    // mul_base_clamped internally applies the ed25519 clamp (clear 3 low bits,
    // clear high bit, set 254th bit) and multiplies by the basepoint, exactly
    // what `ed25519_dalek::SigningKey::from_bytes(seed).verifying_key()` does,
    // minus the SigningKey-struct overhead we don't need for grinding.
    EdwardsPoint::mul_base_clamped(scalar_bytes)
        .compress()
        .to_bytes()
}

/// A successful grind: the 64-byte Solana secret key (`[seed][pubkey]`) and
/// the base58 address it controls.
struct GrindHit {
    secret_key: [u8; 64],
    public_key: String,
}

/// The batch loop behind `grind`, kept free of wasm-bindgen types so the
/// native test suite can drive it directly.
fn grind_batch(
    prefix: &str,
    suffix: &str,
    ignore_case: bool,
    batch: u32,
    start_seed: &[u8; 32],
) -> Option<GrindHit> {
    let want_prefix: Vec<u8> = if ignore_case {
        prefix.to_lowercase().into_bytes()
    } else {
        prefix.as_bytes().to_vec()
    };
    let want_suffix: Vec<u8> = if ignore_case {
        suffix.to_lowercase().into_bytes()
    } else {
        suffix.as_bytes().to_vec()
    };
    let p_len = want_prefix.len();
    let s_len = want_suffix.len();

    let mut seed = *start_seed;
    let base_counter = u32::from_le_bytes([seed[0], seed[1], seed[2], seed[3]]);

    for i in 0..batch {
        let counter = base_counter.wrapping_add(i);
        seed[..4].copy_from_slice(&counter.to_le_bytes());

        let pub_bytes = pubkey_from_seed(&seed);

        let addr_string = bs58::encode(&pub_bytes).into_string();
        let addr = addr_string.as_bytes();

        let prefix_ok = if p_len == 0 {
            true
        } else if addr.len() < p_len {
            false
        } else if ignore_case {
            eq_ignore_ascii_case(&addr[..p_len], &want_prefix)
        } else {
            &addr[..p_len] == want_prefix.as_slice()
        };
        if !prefix_ok {
            continue;
        }

        let suffix_ok = if s_len == 0 {
            true
        } else if addr.len() < s_len {
            false
        } else if ignore_case {
            eq_ignore_ascii_case(&addr[addr.len() - s_len..], &want_suffix)
        } else {
            &addr[addr.len() - s_len..] == want_suffix.as_slice()
        };
        if !suffix_ok {
            continue;
        }

        let mut secret_key = [0u8; 64];
        secret_key[..32].copy_from_slice(&seed);
        secret_key[32..].copy_from_slice(&pub_bytes);

        return Some(GrindHit {
            secret_key,
            public_key: addr_string,
        });
    }

    None
}

#[wasm_bindgen]
pub fn grind(
    prefix: &str,
    suffix: &str,
    ignore_case: bool,
    batch: u32,
    start_seed: &[u8],
) -> JsValue {
    let Ok(seed) = <&[u8; 32]>::try_from(start_seed) else {
        return JsValue::NULL;
    };

    match grind_batch(prefix, suffix, ignore_case, batch, seed) {
        None => JsValue::NULL,
        Some(hit) => {
            let secret_array = Uint8Array::new_with_length(64);
            secret_array.copy_from(&hit.secret_key);

            let result = Object::new();
            Reflect::set(&result, &JsValue::from_str("secretKey"), &secret_array.into())
                .expect("set secretKey");
            Reflect::set(
                &result,
                &JsValue::from_str("publicKey"),
                &JsValue::from_str(&hit.public_key),
            )
            .expect("set publicKey");
            result.into()
        }
    }
}

fn eq_ignore_ascii_case(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .all(|(x, y)| x.eq_ignore_ascii_case(y))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic per-test seeds: SHA-512 of a label, truncated to 32 bytes.
    fn seed_from_label(label: &str) -> [u8; 32] {
        let mut h = Sha512::new();
        h.update(label.as_bytes());
        let digest = h.finalize();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&digest[..32]);
        seed
    }

    #[test]
    fn pubkey_derivation_is_bit_for_bit_ed25519_dalek() {
        for i in 0..64u32 {
            let seed = seed_from_label(&format!("parity-{i}"));
            let expected = ed25519_dalek::SigningKey::from_bytes(&seed)
                .verifying_key()
                .to_bytes();
            assert_eq!(pubkey_from_seed(&seed), expected, "seed #{i}");
        }
    }

    #[test]
    fn grind_finds_prefix_and_returns_solana_secret_key_layout() {
        // 'A' sits in base58's high-probability leading bucket, so a large
        // deterministic batch always lands a hit.
        let start = seed_from_label("prefix-hunt");
        let hit = grind_batch("A", "", false, 50_000, &start)
            .expect("a 50k batch always finds a leading 'A'");

        assert!(hit.public_key.starts_with('A'), "got {}", hit.public_key);

        // secretKey = [32-byte seed][32-byte pubkey], and the embedded pubkey
        // re-derives from the embedded seed.
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&hit.secret_key[..32]);
        let derived = pubkey_from_seed(&seed);
        assert_eq!(&hit.secret_key[32..], &derived[..]);
        assert_eq!(bs58::encode(&derived).into_string(), hit.public_key);
    }

    #[test]
    fn grind_matches_suffix_and_ignore_case() {
        let start = seed_from_label("suffix-hunt");
        let hit = grind_batch("", "q", true, 200_000, &start)
            .expect("a 200k batch always finds a q/Q suffix");
        let last = hit.public_key.chars().last().unwrap();
        assert!(last.eq_ignore_ascii_case(&'q'), "got {}", hit.public_key);
    }

    #[test]
    fn grind_returns_none_when_batch_misses() {
        let start = seed_from_label("miss");
        // An 8-char prefix has ~1 in 58^8 odds per attempt; a 10-key batch
        // cannot hit it.
        assert!(grind_batch("AAAAAAAA", "", false, 10, &start).is_none());
    }

    #[test]
    fn counter_wraps_without_panicking() {
        let mut start = seed_from_label("wrap");
        start[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        // Just proving the wrapping counter path is exercised; any outcome is
        // fine as long as it does not panic.
        let _ = grind_batch("AAAAAAAA", "", false, 16, &start);
    }
}
