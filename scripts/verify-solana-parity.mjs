#!/usr/bin/env node
/**
 * Solana address-parity + on-chain provenance guard.
 *
 * three.ws is a Solana platform. Two classes of on-chain address are hand-copied
 * across dozens of source files and can silently drift apart — every drift is a
 * real bug or a brand-rule violation:
 *
 *   1. The $THREE mint (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump). Canonical
 *      source: api/_lib/env.js → THREE_TOKEN_MINT default. It is ALSO hardcoded
 *      in ~25 other files (api/x402, src/pump, packages config modules,
 *      multiplayer, scripts). CLAUDE.md is absolute: $THREE is the only coin
 *      this platform may reference, and any other coin in source is treated like
 *      a leaked secret. So a hardcoded mint that drifts from the canonical CA —
 *      or any OTHER pump.fun mint baked into real source — is a hard failure.
 *
 *   2. Pump protocol program IDs and well-known Solana programs/mints. Canonical
 *      source: api/_lib/solana/programs.js (PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID,
 *      PUMP_FEE_PROGRAM_ID, WSOL_MINT, …) plus the immutable ecosystem constants
 *      (SPL Token, Token-2022, Memo, Associated-Token, mainnet USDC). A typo'd
 *      token-program ID or a stale pump program ID sends instructions to the
 *      wrong account and every tx fails — caught here at build time, not runtime.
 *
 * Two severities, mirroring scripts/audit-deploy-artifacts.mjs and
 * scripts/verify-onchain-parity.mjs:
 *   - Address drift / a rogue non-$THREE mint — ALWAYS a real config or brand
 *     bug → hard fail (exit 1).
 *   - Live on-chain provenance — a declared account that exists but is the wrong
 *     kind (mint not owned by a token program, program not executable) is a hard
 *     fail; an RPC that is unreachable in CI degrades to a warning so transport
 *     noise never blocks a deploy.
 *
 * Runs standalone (`npm run verify:solana`), in scripts/build-vercel.mjs phase 1
 * alongside audit-deploy-artifacts.mjs, and via tests/solana-parity.test.js.
 *
 * Live provenance is configurable:
 *   VERIFY_SOLANA_LIVE=1     (default — probe the mint + pump programs on mainnet)
 *   VERIFY_SOLANA_LIVE=0     (skip the live check entirely)
 *   The RPC endpoint chain is the platform's own (api/_lib/solana/connection.js),
 *   so SOLANA_RPC_URL, the keyed providers, SOLANA_RPC_FALLBACK_URLS and the
 *   keyless public lanes are all tried in priority order before an account is
 *   reported unreachable.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { solanaRpcEndpoints } from '../api/_lib/solana/connection.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The one and only coin (CLAUDE.md, absolute). The canonical default also lives
// in api/_lib/env.js; loadCanonical() asserts the two agree so this constant can
// never quietly disagree with the running config.
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Solana base58 program addresses are owned by a loader and `executable: true`.
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---------------------------------------------------------------------------
// Canonical address registry — cross-checked against the repo source-of-truth
// files at load time so this script and the running code can never disagree.
// ---------------------------------------------------------------------------

/**
 * Each entry: a set of constant identifiers that, wherever they are assigned a
 * base58 literal in source, MUST hold `address`. `kind` drives the live check.
 */
function canonicalRegistry(pumpIds) {
	return [
		{
			label: '$THREE mint',
			address: THREE_MINT,
			kind: 'token-2022-mint',
			names: ['THREE_MINT', 'THREE_TOKEN_MINT', 'TOKEN_MINT'],
		},
		{
			label: 'Pump bonding-curve program',
			address: pumpIds.PUMP_PROGRAM_ID,
			kind: 'program',
			names: ['PUMP_PROGRAM', 'PUMP_PROGRAM_ID'],
		},
		{
			label: 'PumpSwap AMM program',
			address: pumpIds.PUMP_AMM_PROGRAM_ID,
			kind: 'program',
			names: ['PUMP_AMM_PROGRAM', 'PUMP_AMM_PROGRAM_ID'],
		},
		{
			label: 'PumpFees program',
			address: pumpIds.PUMP_FEE_PROGRAM_ID,
			kind: 'program',
			names: ['PUMP_FEE_PROGRAM', 'PUMP_FEE_PROGRAM_ID'],
		},
		{
			label: 'SPL Token program',
			address: SPL_TOKEN_PROGRAM,
			kind: 'program',
			names: ['TOKEN_PROGRAM', 'TOKEN_PROGRAM_ID', 'SPL_TOKEN_PROGRAM_ID'],
		},
		{
			label: 'Token-2022 program',
			address: TOKEN_2022_PROGRAM,
			kind: 'program',
			names: ['TOKEN_2022_PROGRAM_ID', 'TOKEN2022_PROGRAM_ID'],
		},
		{
			label: 'Memo program',
			address: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
			kind: 'program',
			names: ['MEMO_PROGRAM', 'MEMO_PROGRAM_ID'],
		},
		{
			label: 'Associated-Token program',
			address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
			kind: 'program',
			names: ['ASSOCIATED_TOKEN_PROGRAM_ID', 'ASSOCIATED_TOKEN_PROGRAM'],
		},
		{
			label: 'Wrapped SOL mint',
			address: pumpIds.WSOL_MINT,
			kind: 'token-mint',
			names: ['WSOL_MINT', 'WSOL', 'NATIVE_SOL_MINT', 'SOL_MINT'],
		},
		{
			label: 'USDC (mainnet) mint',
			address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			kind: 'token-mint',
			names: ['USDC_MINT', 'USDC_MAINNET_MINT', 'USDC_SOLANA_MINT'],
		},
	];
}

/**
 * Loads the repo's source-of-truth values and asserts they match the constants
 * above. Returns the canonical registry. Throws on an internal SoT disagreement
 * (e.g. someone changed the env.js default but not this guard).
 */
export async function loadCanonical({ root = ROOT } = {}) {
	// Pump IDs: import the dependency-free SoT module directly.
	const programs = await import(pathToFileURL(resolve(root, 'api/_lib/solana/programs.js')).href);

	// $THREE mint: read the env.js default by regex (importing env.js pulls the
	// whole server config surface; the literal default is all we need).
	const envSrc = readFileSync(resolve(root, 'api/_lib/env.js'), 'utf8');
	const m = envSrc.match(
		/opt\(\s*['"]THREE_TOKEN_MINT['"]\s*,\s*['"]([1-9A-HJ-NP-Za-km-z]{32,44})['"]\s*\)/,
	);
	const envMint = m?.[1];

	const internal = [];
	if (envMint !== THREE_MINT) {
		internal.push(
			`api/_lib/env.js THREE_TOKEN_MINT default ${JSON.stringify(envMint)} != canonical ${THREE_MINT}`,
		);
	}
	if (programs.WSOL_MINT !== 'So11111111111111111111111111111111111111112') {
		internal.push(`api/_lib/solana/programs.js WSOL_MINT drifted: ${programs.WSOL_MINT}`);
	}
	if (internal.length) {
		const err = new Error(
			'canonical source-of-truth disagreement:\n  ' + internal.join('\n  '),
		);
		err.internal = internal;
		throw err;
	}

	return canonicalRegistry(programs);
}

// ---------------------------------------------------------------------------
// Source file enumeration (git index, with on-disk fallback for Vercel's
// .git-less build container — same strategy as audit-deploy-artifacts.mjs)
// ---------------------------------------------------------------------------

const SCAN_EXTS = /\.(js|mjs|ts)$/;
// Generated bundles, vendored deps, and fixtures/tests are allowed to hold
// arbitrary or synthetic addresses — only first-party runtime source is scanned.
const SCAN_SKIP = /(^|\/)(node_modules|dist|dist-lib|build|\.vercel|coverage)\//;
// Minified/vendored third-party blobs (draco, codemirror, ktx2, *.bundle.js) and
// test/fixture/IDL files. The catch-all is the minified-line guard in scanFile().
const SCAN_SKIP_FILE =
	/(\.test\.|\.spec\.|\/fixtures\/|_demo-fixtures|\/idl\/|\.min\.js$|\.bundle\.js$|\/(libs|draco|ktx2|vendor|wasm)\/)/;

export function listSourceFiles({ root = ROOT } = {}) {
	let files;
	try {
		const out = execFileSync('git', ['ls-files'], {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		files = out.split('\n').filter(Boolean);
	} catch {
		files = listOnDisk(root);
	}
	return files.filter(
		(f) => SCAN_EXTS.test(f) && !SCAN_SKIP.test(`/${f}`) && !SCAN_SKIP_FILE.test(`/${f}`),
	);
}

function listOnDisk(root) {
	const out = [];
	const stack = [''];
	const skipDir = new Set([
		'node_modules',
		'.git',
		'dist',
		'dist-lib',
		'build',
		'.vercel',
		'coverage',
	]);
	while (stack.length) {
		const rel = stack.pop();
		let entries;
		try {
			entries = readdirSync(resolve(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (skipDir.has(e.name)) continue;
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) stack.push(r);
			else out.push(r);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Parity / drift scan (deterministic — always runs, always hard-fails)
// ---------------------------------------------------------------------------

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
// A pump.fun mint is a 32–44 char base58 address ending in `pump`, so the prefix
// before `pump` is 28–40 chars. Quoted so we only flag hardcoded literals.
const PUMP_LITERAL = new RegExp(`['"\`](${BASE58}{28,40}pump)['"\`]`, 'g');

/**
 * Scans first-party source for:
 *   - rogue $THREE drift: any hardcoded `…pump` mint literal that is not the
 *     canonical $THREE CA (drift OR a forbidden second coin).
 *   - named-constant drift: any assignment to a canonical constant identifier
 *     whose base58 literal differs from the canonical address.
 *
 * Returns an array of problems — each with file, line, and a precise diff string.
 * Reads files in parallel batches (the overlay FS is latency-bound, not
 * throughput-bound) and scans each file's full text in a single regex pass.
 */
export async function scanForDrift(
	registry,
	{ root = ROOT, files = listSourceFiles({ root }) } = {},
) {
	const problems = [];
	// name → {address,label} lookup for the constant-assignment scan.
	const byName = new Map();
	for (const entry of registry) for (const n of entry.names) byName.set(n, entry);
	const nameAlternation = [...byName.keys()].sort((a, b) => b.length - a.length).join('|');
	// `NAME = … 'BASE58'` or `NAME = new PublicKey('BASE58')`. \b guards against
	// matching USDC_MINT inside USDC_MINT_DEVNET etc.
	const assignRe = new RegExp(
		`\\b(${nameAlternation})\\b\\s*(?::[^=]+)?=\\s*(?:new\\s+PublicKey\\(\\s*)?['"\`](${BASE58}{32,44})['"\`]`,
		'g',
	);

	// Match offsets back to line numbers without a per-line matchAll (which clones
	// the alternation regex for every line of every file — the build-gate killer).
	const lineNumberAt = (newlineOffsets, index) => {
		let lo = 0;
		let hi = newlineOffsets.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (newlineOffsets[mid] < index) lo = mid + 1;
			else hi = mid;
		}
		return lo + 1;
	};
	const lineTextAt = (text, index) => {
		const start = text.lastIndexOf('\n', index - 1) + 1;
		let end = text.indexOf('\n', index);
		if (end === -1) end = text.length;
		return text.slice(start, end);
	};

	const scanText = (rel, text) => {
		if (text.length > 4_000_000) return; // generated bundle

		// Single linear newline scan: feeds both the minified-blob guard (max line
		// length) and offset→line mapping. Avoids the O(n²) /[^\n]{20000}/ regex.
		const newlineOffsets = [];
		let prev = -1;
		let maxLine = 0;
		for (let p = text.indexOf('\n'); p !== -1; p = text.indexOf('\n', p + 1)) {
			newlineOffsets.push(p);
			if (p - prev > maxLine) maxLine = p - prev;
			prev = p;
		}
		if (text.length - prev > maxLine) maxLine = text.length - prev;
		// Authored source never has 20k-char lines; a file that does is a minified
		// blob that slipped past the path filter — skip it.
		if (maxLine > 20_000) return;

		// 1. rogue / drifted $THREE mint — one whole-file pass.
		PUMP_LITERAL.lastIndex = 0;
		for (let mt = PUMP_LITERAL.exec(text); mt; mt = PUMP_LITERAL.exec(text)) {
			if (mt[1] !== THREE_MINT) {
				problems.push({
					type: 'rogue-coin',
					file: rel,
					line: lineNumberAt(newlineOffsets, mt.index),
					detail: `hardcoded pump.fun mint "${mt[1]}" is not the canonical $THREE CA ${THREE_MINT} — $THREE is the only coin (CLAUDE.md); fix or remove`,
				});
			}
		}

		// 2. drifted canonical constant — one whole-file pass.
		assignRe.lastIndex = 0;
		for (let mt = assignRe.exec(text); mt; mt = assignRe.exec(text)) {
			const entry = byName.get(mt[1]);
			const got = mt[2];
			if (entry && got !== entry.address) {
				const lineText = lineTextAt(text, mt.index);
				// A devnet/test variant legitimately differs — skip lines that
				// self-identify as such (e.g. SOLANA_USDC_MINT_DEVNET on its own line).
				if (/devnet|testnet|localnet/i.test(lineText)) continue;
				problems.push({
					type: 'const-drift',
					file: rel,
					line: lineNumberAt(newlineOffsets, mt.index),
					detail: `${mt[1]} = ${got} but canonical ${entry.label} is ${entry.address}`,
				});
			}
		}
	};

	const BATCH = 64;
	for (let i = 0; i < files.length; i += BATCH) {
		await Promise.all(
			files.slice(i, i + BATCH).map(async (rel) => {
				let text;
				try {
					text = await readFile(resolve(root, rel), 'utf8');
				} catch {
					return;
				}
				scanText(rel, text);
			}),
		);
	}
	// Stable order regardless of read-completion races, so a CI diff is reproducible.
	problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	return problems;
}

// ---------------------------------------------------------------------------
// Live on-chain provenance (best-effort — warns on transport error, fails on a
// confirmed wrong-kind account)
// ---------------------------------------------------------------------------

/**
 * Priority-ordered endpoint chain, taken from the platform's own resolver so this
 * guard fails over exactly like the running code does.
 *
 * Reading one endpoint was a silent hole: with the repo's .env loaded, an
 * exhausted HELIUS_API_KEY answered every probe with HTTP 403, so all 10 accounts
 * landed in "unreachable", the whole live check degraded to a warning, and the
 * script still printed "clean" having verified nothing at all.
 */
export function rpcEndpoints(env = process.env) {
	const explicit =
		env.SOLANA_RPC_URL && !/api\.mainnet-beta\.solana\.com/.test(env.SOLANA_RPC_URL)
			? env.SOLANA_RPC_URL
			: null;
	const chain = solanaRpcEndpoints('mainnet', explicit);
	return chain.length ? chain : ['https://api.mainnet-beta.solana.com'];
}

/** Endpoint host only. RPC URLs carry api keys, which must never reach a log. */
function endpointHost(url) {
	try {
		return new URL(url).host;
	} catch {
		return 'rpc';
	}
}

async function rpcAccountInfo(url, address) {
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'getAccountInfo',
				params: [address, { encoding: 'jsonParsed' }],
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		const json = await res.json();
		if (json.error) return { ok: false, error: json.error.message || 'rpc error' };
		return { ok: true, value: json.result?.value ?? null };
	} catch (err) {
		return { ok: false, error: err?.message || 'unreachable' };
	}
}

/**
 * Fetch one account, walking the endpoint chain until a lane answers. `endpoints`
 * is mutated so the lane that served moves to the front: the remaining addresses
 * then start on a lane known to be alive instead of re-paying the timeout of a
 * dead one, which is the difference between a 4s run and a 150s one.
 */
async function getAccountInfo(endpoints, address) {
	const errors = [];
	for (const url of [...endpoints]) {
		const r = await rpcAccountInfo(url, address);
		if (r.ok) {
			const at = endpoints.indexOf(url);
			if (at > 0) endpoints.unshift(...endpoints.splice(at, 1));
			return { ...r, endpoint: endpointHost(url) };
		}
		errors.push(`${endpointHost(url)} ${r.error}`);
	}
	return { ok: false, error: errors.join(' / ') || 'no endpoint configured' };
}

/**
 * For each canonical address, fetch the account and assert it is the right kind:
 *   - program:           exists & executable.
 *   - token-mint:        exists & owned by SPL Token or Token-2022 program.
 *   - token-2022-mint:   exists & owned by the Token-2022 program specifically
 *                        ($THREE is a Token-2022 mint; legacy-token code paths
 *                        for it would derive the wrong ATA).
 */
export async function checkLiveProvenance(registry, { env = process.env } = {}) {
	const endpoints = rpcEndpoints(env);
	const wrong = [];
	const unreachable = [];
	const ok = [];

	for (const entry of registry) {
		const r = await getAccountInfo(endpoints, entry.address);
		const ctx = { ...entry, endpoint: r.endpoint || endpointHost(endpoints[0]) };
		if (!r.ok) {
			unreachable.push({ ...ctx, error: r.error });
			continue;
		}
		if (r.value === null) {
			wrong.push({ ...ctx, reason: 'account does not exist on mainnet' });
			continue;
		}
		const owner = r.value.owner;
		const program = r.value.data?.program;
		if (entry.kind === 'program') {
			if (r.value.executable) ok.push({ ...ctx, note: 'executable' });
			else wrong.push({ ...ctx, reason: `not executable (owner ${owner})` });
		} else if (entry.kind === 'token-2022-mint') {
			if (owner === TOKEN_2022_PROGRAM && program === 'spl-token-2022')
				ok.push({ ...ctx, note: 'token-2022 mint' });
			else
				wrong.push({
					...ctx,
					reason: `expected a Token-2022 mint, got owner ${owner} (${program})`,
				});
		} else if (entry.kind === 'token-mint') {
			if (
				(owner === SPL_TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) &&
				program?.startsWith('spl-token')
			)
				ok.push({ ...ctx, note: `${program} mint` });
			else
				wrong.push({
					...ctx,
					reason: `expected an SPL mint, got owner ${owner} (${program})`,
				});
		}
	}
	return { wrong, unreachable, ok };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const start = Date.now();
	let failed = false;

	let registry;
	try {
		registry = await loadCanonical();
	} catch (err) {
		console.error(`[verify:solana] FAIL — ${err.message}`);
		process.exit(1);
	}

	const problems = await scanForDrift(registry);
	if (problems.length) {
		failed = true;
		const rogue = problems.filter((p) => p.type === 'rogue-coin');
		const drift = problems.filter((p) => p.type === 'const-drift');
		if (rogue.length)
			console.error(
				`[verify:solana] FAIL — ${rogue.length} non-$THREE coin / drifted mint literal(s):`,
			);
		for (const p of rogue) console.error(`  ${p.file}:${p.line} — ${p.detail}`);
		if (drift.length)
			console.error(`[verify:solana] FAIL — ${drift.length} drifted Solana constant(s):`);
		for (const p of drift) console.error(`  ${p.file}:${p.line} — ${p.detail}`);
	} else {
		console.log(
			`[verify:solana] parity OK — $THREE mint + ${registry.length - 1} canonical Solana addresses consistent across all first-party source`,
		);
	}

	const liveOn = (process.env.VERIFY_SOLANA_LIVE ?? '1') !== '0';
	if (liveOn) {
		const { wrong, unreachable, ok } = await checkLiveProvenance(registry);
		for (const e of ok)
			console.log(`[verify:solana] live  ${e.label} ${e.address} — ${e.note}`);
		if (unreachable.length) {
			console.warn(
				`[verify:solana] WARN — ${unreachable.length} account(s) unreachable (network — not failing the build):`,
			);
			for (const u of unreachable) console.warn(`  ${u.label} ${u.address} — ${u.error}`);
		}
		if (wrong.length) {
			failed = true;
			console.error(
				`[verify:solana] FAIL — ${wrong.length} account(s) are the wrong kind on-chain:`,
			);
			for (const w of wrong) console.error(`  ${w.label} ${w.address} — ${w.reason}`);
		}
		console.log(
			`[verify:solana] live check — ${ok.length} verified, ${wrong.length} wrong, ${unreachable.length} unreachable`,
		);
	} else {
		console.log('[verify:solana] live provenance check skipped (VERIFY_SOLANA_LIVE=0)');
	}

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	if (failed) {
		console.error(`\n[verify:solana] failed in ${elapsed}s`);
		process.exit(1);
	}
	console.log(`[verify:solana] clean in ${elapsed}s`);
}
