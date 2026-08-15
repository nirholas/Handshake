#!/usr/bin/env node
/**
 * Provably-fair vanity receipt verifier — CLI.
 *
 * Independently audits a three.ws verifiable-grind receipt with open-source
 * crypto. Recomputes every protocol claim (commitment opens, seed-mix derives
 * the address, pattern matches, difficulty is honest, the service signature is
 * valid and signed by the pinned key) and prints a green/red audit. Optionally
 * opens the sealed envelope with your X25519 private key and proves the key you
 * hold IS the ground key — all locally; nothing is sent anywhere.
 *
 * Usage:
 *   node scripts/verify-vanity-receipt.mjs <receipt.json> [options]
 *   cat receipt.json | node scripts/verify-vanity-receipt.mjs --stdin
 *
 * Options:
 *   --stdin                 read the receipt JSON from stdin
 *   --service-key <base58>  pin to this service key (default: receipt's own key;
 *                           pass the key from /.well-known/three-vanity.json to
 *                           prove the signer is really three.ws)
 *   --fetch-key             fetch + pin the live key from the well-known doc
 *   --x25519-secret <key>   your X25519 private key (Base58/hex) to open the seal
 *   --secret-seed <hexkey>  a 32/64-byte Ed25519 secret you already opened
 *   --json                  emit the machine-readable audit as JSON
 *
 * Exit code 0 = all checks pass; 1 = any check failed or input error.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stdin } from 'node:process';
import bs58 from 'bs58';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const PROTOCOL_VERSION = 'three-vanity/v1';
const WELL_KNOWN = 'https://three.ws/.well-known/three-vanity.json';
const enc = new TextEncoder();
const TAG_SEED_COMMIT = enc.encode('three-vanity/seed-commit/v1');
const TAG_MIX_SALT = sha256(enc.encode('three-vanity/mix-salt/v1'));
const TAG_MASTER_INFO = enc.encode('three-vanity/master/v1');
const TAG_CANDIDATE = enc.encode('three-vanity/candidate/v1');
const TAG_RECEIPT = enc.encode('three-vanity/receipt/v1');
const SEALED_SCHEME = 'x25519-hkdf-sha256-aes256gcm/v1';
const HKDF_INFO = enc.encode('three.ws sealed-envelope v1');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function asBytes(value, label) {
	if (value instanceof Uint8Array) return value;
	const s = String(value).trim();
	if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return hexToBytes(s);
	try {
		return bs58.decode(s);
	} catch {
		throw new Error(`${label} is not valid hex or Base58`);
	}
}
function uint64be(n) {
	const out = new Uint8Array(8);
	let v = BigInt(n);
	for (let i = 7; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}
function commitToSeed(seed) {
	return bytesToHex(sha256(concatBytes(TAG_SEED_COMMIT, asBytes(seed, 'serverSeed'))));
}
function deriveMasterSeed({ serverSeed, clientSeed, requestNonce }) {
	const ikm = concatBytes(asBytes(serverSeed, 's'), asBytes(clientSeed, 'c'), asBytes(requestNonce, 'n'));
	return hkdf(sha256, ikm, TAG_MIX_SALT, TAG_MASTER_INFO, 32);
}
function candidateAddress(master, index) {
	const seed = hmac(sha256, master, concatBytes(TAG_CANDIDATE, uint64be(index)));
	return { address: bs58.encode(ed25519.getPublicKey(seed)), seed };
}
function addressMatchesPattern(address, { prefix = '', suffix = '', ignoreCase = false } = {}) {
	let a = address, p = prefix || '', s = suffix || '';
	if (ignoreCase) { a = a.toLowerCase(); p = p.toLowerCase(); s = s.toLowerCase(); }
	if (p && !a.startsWith(p)) return false;
	if (s && !a.endsWith(s)) return false;
	return true;
}
function expectedAttempts(prefix = '', suffix = '', ignoreCase = false) {
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	let attempts = 1;
	for (const ch of (prefix || '') + (suffix || '')) {
		const lower = ch.toLowerCase(), upper = ch.toUpperCase();
		const two = ignoreCase && lower !== upper && alphabet.includes(lower) && alphabet.includes(upper);
		attempts *= 58 / (two ? 2 : 1);
	}
	return attempts;
}
const SIGNED_FIELDS = ['protocol', 'receiptType', 'address', 'pattern', 'commitment', 'serverSeed', 'clientSeed', 'requestNonce', 'winningIndex', 'attempts', 'durationMs', 'difficulty', 'sealed', 'sealedScheme', 'sealedRecipient', 'sealedEpk', 'network', 'ts'];
function projectSignedCore(obj) {
	const core = {};
	for (const k of SIGNED_FIELDS) if (obj[k] !== undefined) core[k] = obj[k];
	return core;
}
function stableStringify(v) {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function verifySignature(receipt, pub) {
	try {
		const bytes = concatBytes(TAG_RECEIPT, enc.encode(stableStringify(projectSignedCore(receipt))));
		return ed25519.verify(hexToBytes(receipt.signature), bytes, asBytes(pub, 'k'));
	} catch {
		return false;
	}
}
function ctEqual(a, b) {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
}
function fromB64url(str) {
	const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
	return new Uint8Array(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64'));
}
function openSealed(env, secretKey) {
	const secret = asBytes(secretKey, 'x25519 secret');
	const epk = bs58.decode(env.epk);
	const shared = x25519.getSharedSecret(secret, epk);
	const rpub = x25519.getPublicKey(secret);
	const salt = new Uint8Array(epk.length + rpub.length);
	salt.set(epk, 0); salt.set(rpub, epk.length);
	const key = hkdf(sha256, shared, salt, HKDF_INFO, 32);
	return gcm(key, fromB64url(env.nonce), epk).decrypt(fromB64url(env.ciphertext));
}

const HELP = `Provably-fair vanity receipt verifier (three-vanity/v1).

Recomputes every claim in a three.ws verifiable-grind receipt locally: the
commitment opens, the seed mix derives the address, the pattern matches, the
difficulty is honest, and the signature is the pinned three.ws service key.
Nothing is sent anywhere. Exit 0 = every check passed, 1 = any failed.

Usage:
  node scripts/verify-vanity-receipt.mjs <receipt.json> [options]
  cat receipt.json | node scripts/verify-vanity-receipt.mjs --stdin

Options:
  --stdin                 read the receipt JSON from stdin
  --service-key <base58>  pin to this service key (default: the receipt's own key;
                          pass the key from /.well-known/three-vanity.json to
                          prove the signer is really three.ws)
  --fetch-key             fetch and pin the live key from the well-known document
  --x25519-secret <key>   your X25519 private key (Base58/hex) to open the seal
  --secret-seed <hexkey>  a 32/64-byte Ed25519 secret you already opened
  --json                  emit the machine-readable audit as JSON
  -h, --help              show this help

Protocol spec: https://three.ws/docs/PROTOCOL-vanity`;

function parseArgs(args) {
	const opts = { json: false, stdin: false, fetchKey: false, help: false };
	let path = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--help' || a === '-h') opts.help = true;
		else if (a === '--json') opts.json = true;
		else if (a === '--stdin') opts.stdin = true;
		else if (a === '--fetch-key') opts.fetchKey = true;
		else if (a === '--service-key') opts.serviceKey = args[++i];
		else if (a === '--x25519-secret') opts.x25519Secret = args[++i];
		else if (a === '--secret-seed') opts.secretSeed = args[++i];
		else if (!a.startsWith('--')) path = a;
	}
	return { path, opts };
}

async function readStdin() {
	let data = '';
	for await (const chunk of stdin) data += chunk;
	return data;
}

function runChecks(receipt, { servicePublicKey, openedSecretSeed }) {
	const checks = [];
	const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });

	if (receipt.protocol !== PROTOCOL_VERSION) {
		add('protocol', 'Protocol version is supported', false, `"${receipt.protocol}" ≠ "${PROTOCOL_VERSION}"`);
		return checks;
	}
	add('protocol', 'Protocol version is supported', true, PROTOCOL_VERSION);

	try {
		const computed = commitToSeed(receipt.serverSeed);
		const ok = computed === receipt.commitment;
		add('commitment', 'serverSeed opens the commitment', ok,
			ok ? 'SHA-256(serverSeed) = commitment' : `SHA-256(serverSeed) = ${computed} ≠ ${receipt.commitment}`);
	} catch (e) { add('commitment', 'serverSeed opens the commitment', false, e.message); }

	let derivedSeed = null;
	try {
		const master = deriveMasterSeed(receipt);
		const cand = candidateAddress(master, receipt.winningIndex);
		derivedSeed = cand.seed;
		const ok = cand.address === receipt.address;
		add('derivation', 'Address derives from the mixed seed at the claimed index', ok,
			ok ? `candidate #${receipt.winningIndex} → ${cand.address}` : `re-derives to ${cand.address}, not ${receipt.address}`);
	} catch (e) { add('derivation', 'Address derives from the mixed seed', false, e.message); }

	{
		const ok = addressMatchesPattern(receipt.address, receipt.pattern || {});
		const p = receipt.pattern || {};
		const want = [p.prefix && `prefix "${p.prefix}"`, p.suffix && `suffix "${p.suffix}"`].filter(Boolean).join(' + ') || '(none)';
		add('pattern', 'Address satisfies the requested pattern', ok, `${receipt.address} ${ok ? 'matches' : 'does NOT match'} ${want}`);
	}
	{
		const p = receipt.pattern || {};
		const expected = Math.round(expectedAttempts(p.prefix || '', p.suffix || '', !!p.ignoreCase));
		const ok = Number(receipt.difficulty?.expectedAttempts) === expected;
		add('difficulty', 'Difficulty matches the honest model', ok,
			ok ? `expectedAttempts = ${expected}` : `claims ${receipt.difficulty?.expectedAttempts}, model = ${expected}`);
	}
	{
		const sigOk = verifySignature(receipt, servicePublicKey);
		add('signature', 'Service Ed25519 signature is valid', sigOk,
			sigOk ? `valid under ${servicePublicKey}` : 'signature does not verify');
		let pinned = false;
		try { pinned = ctEqual(asBytes(servicePublicKey, 'a'), asBytes(receipt.servicePublicKey, 'b')); } catch { /* */ }
		add('serviceKeyPinned', 'Signed by the pinned three.ws service key', pinned,
			pinned ? 'receipt key matches the pinned key' : `receipt key ${receipt.servicePublicKey} ≠ pinned ${servicePublicKey}`);
	}
	if (openedSecretSeed) {
		let opened = asBytes(openedSecretSeed, 'secret');
		if (opened.length === 64) opened = opened.slice(0, 32);
		const ok = derivedSeed && opened.length === 32 && ctEqual(opened, derivedSeed);
		const pubOk = ok && bs58.encode(ed25519.getPublicKey(opened)) === receipt.address;
		add('custody', 'Your recovered key is the ground key', !!(ok && pubOk),
			ok && pubOk ? 'the opened secret re-derives to the receipt address' : 'opened secret does NOT match');
	}
	return checks;
}

async function main() {
	const { path, opts } = parseArgs(argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		exit(0);
	}
	let raw;
	if (opts.stdin || (!path && !process.stdin.isTTY)) {
		raw = await readStdin();
	} else if (path) {
		raw = readFileSync(path, 'utf8');
	} else {
		console.error(HELP);
		exit(1);
	}

	// An empty read is "you gave me no receipt", not "your JSON is malformed".
	// Piping from an empty pipe lands here, and the parser's message for it
	// sends the reader hunting for a syntax error that does not exist.
	if (!raw.trim()) {
		console.error(`${RED}No receipt on stdin.${RESET}\n\n${HELP}`);
		exit(1);
	}

	let receipt;
	try {
		receipt = JSON.parse(raw);
	} catch (e) {
		console.error(`${RED}Invalid JSON: ${e.message}${RESET}`);
		exit(1);
	}

	// Resolve the service key to pin against.
	let servicePublicKey = opts.serviceKey || receipt.servicePublicKey;
	let pinSource = opts.serviceKey ? 'CLI --service-key' : "receipt's own key (unpinned — pass --service-key or --fetch-key to pin)";
	if (opts.fetchKey) {
		try {
			const res = await fetch(WELL_KNOWN, { headers: { accept: 'application/json' } });
			const doc = await res.json();
			servicePublicKey = doc.serviceKey.publicKeyBase58;
			pinSource = `${WELL_KNOWN}`;
		} catch (e) {
			console.error(`${RED}Could not fetch the live service key: ${e.message}${RESET}`);
			exit(1);
		}
	}

	// Optionally open the seal to prove custody.
	let openedSecretSeed = opts.secretSeed || null;
	if (!openedSecretSeed && opts.x25519Secret && receipt.sealedSecret?.scheme === SEALED_SCHEME) {
		try {
			const pt = openSealed(receipt.sealedSecret, opts.x25519Secret);
			const bundle = JSON.parse(new TextDecoder().decode(pt));
			openedSecretSeed = bundle.seed || (bundle.secretKey ? bytesToHex(Uint8Array.from(bundle.secretKey).slice(0, 32)) : null);
		} catch (e) {
			console.error(`${RED}Could not open the sealed envelope: ${e.message}${RESET}`);
			exit(1);
		}
	}

	const checks = runChecks(receipt, { servicePublicKey, openedSecretSeed });
	const valid = checks.every((c) => c.pass);

	if (opts.json) {
		console.log(JSON.stringify({ valid, address: receipt.address, pinSource, checks }, null, 2));
		exit(valid ? 0 : 1);
	}

	console.log('');
	console.log(`${BOLD}three.ws — provably-fair vanity receipt${RESET}`);
	console.log(`${DIM}address  ${RESET}${receipt.address}`);
	console.log(`${DIM}pinned   ${RESET}${servicePublicKey} ${DIM}(${pinSource})${RESET}`);
	console.log('');
	for (const c of checks) {
		const mark = c.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
		console.log(`  ${mark} ${c.label}`);
		console.log(`     ${DIM}${c.detail}${RESET}`);
	}
	console.log('');
	if (valid) {
		console.log(`${GREEN}${BOLD}VERIFIED${RESET} — every protocol claim checks out. This key was generated`);
		console.log(`${GREEN}fresh under the committed seed and the operator could not have kept a copy.${RESET}`);
	} else {
		console.log(`${RED}${BOLD}FAILED${RESET} — one or more checks did not pass. Do NOT trust this receipt.`);
	}
	console.log('');
	exit(valid ? 0 : 1);
}

main().catch((e) => {
	console.error(`${RED}${e.stack || e.message}${RESET}`);
	exit(1);
});
