#!/usr/bin/env node
/**
 * On-chain end-to-end smoke harness — the standing verification net for the
 * three.ws on-chain stack (EVM ERC-8004 identity/validation/reputation + x402,
 * Solana pump.fun launch/trade + agent_invocation).
 *
 * Each subsystem is unit-tested in isolation; nothing else exercises the whole
 * agent lifecycle in one pass. A regression in the seam between two systems
 * (a registry address drift, a stale ABI, a broken pin endpoint, an unfunded
 * relayer, an undeployed program) only shows up in production. This script runs
 * the full path against testnet/devnet and exits non-zero on any break.
 *
 * Design principles:
 *   - Read-only steps run everywhere (CI included) with no secrets and stay green.
 *   - Value steps (anything that broadcasts a transaction) SKIP — not FAIL — with
 *     a precise reason when their funded signer / deployment / credential is
 *     absent. Provide the credentials and the same step turns PASS/FAIL.
 *   - Testnet/devnet only by default. `--mainnet-readonly` adds read-only mainnet
 *     checks (parity, bytecode) and NEVER broadcasts value.
 *   - Synthetic signers/mints only. The only coin this platform references is
 *     $THREE; this harness never touches a real third-party token or wallet.
 *   - Real endpoints/SDKs are reused; nothing here is mocked.
 *
 * Usage:
 *   node scripts/onchain-smoke.mjs                  # all 8 steps (read-only subset runs, value steps SKIP)
 *   node scripts/onchain-smoke.mjs --only=parity    # one step by key
 *   node scripts/onchain-smoke.mjs --only=1,2,3     # several by number
 *   node scripts/onchain-smoke.mjs --list           # list step keys
 *   node scripts/onchain-smoke.mjs --mainnet-readonly
 *   node scripts/onchain-smoke.mjs --json           # machine-readable summary on stdout
 *   node --env-file=.env scripts/onchain-smoke.mjs  # load credentials from .env (Node 20+)
 *
 * Credentials (all optional — absence ⇒ the dependent step SKIPs):
 *   SMOKE_EVM_PRIVATE_KEY        funded Base-Sepolia signer (steps 2,3,4; step 3 needs it to own the agent)
 *   SMOKE_EVM_PRIVATE_KEY_2      second funded signer for the reputation feedback (step 4)
 *   SMOKE_EVM_CHAIN_ID           EVM testnet chainId (default 84532 / Base Sepolia)
 *   SMOKE_AGENT_ID               reuse an existing agentId for steps 3/4 without re-registering
 *   SMOKE_PIN_BASE_URL           deployed API origin for /api/erc8004/pin (else GLB+card use self-contained data: URIs)
 *   SMOKE_AUTH_COOKIE            session cookie for pin + pump endpoints (these require a logged-in session)
 *   SMOKE_BASE_URL               deployed API origin for the Solana + x402 HTTP steps
 *   SMOKE_SOLANA_PRIVATE_KEY     funded devnet signer (bs58) for pump launch/trade + agent_invocation
 *   SMOKE_SOLANA_AGENT_ID        agent_identities UUID to launch under (step 5; distinct from the numeric EVM agentId)
 *   SMOKE_SOLANA_MINT            reuse an existing devnet mint for the trade step without launching (step 6)
 *   SMOKE_X402_NAME              a resolvable @handle / .sol name for the x402 pay-by-name prep (step 7)
 *   SOLANA_RPC_URL_DEVNET        devnet RPC (default https://api.devnet.solana.com)
 *
 * Exit code: 0 when no step FAILED (SKIP is not a failure), 1 otherwise.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { Wallet, Contract } from 'ethers';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
	IDENTITY_REGISTRY_ABI,
	REPUTATION_REGISTRY_ABI,
	VALIDATION_REGISTRY_ABI,
	REGISTRY_DEPLOYMENTS as SDK_DEPLOYMENTS,
} from '../sdk/src/erc8004/abi.js';
import { REGISTRY_DEPLOYMENTS as SRC_DEPLOYMENTS } from '../src/erc8004/abi.js';
import { CHAIN_BY_ID } from '../api/_lib/erc8004-chains.js';
import { evmFallbackProvider } from '../api/_lib/evm/rpc.js';
import { buildRegistrationJSON } from '../src/erc8004/registration-json.js';
import {
	responseForPassed,
	responsePassed,
	validationRequestHash,
} from '../src/erc8004/validation-report.js';
import { normalizeGatewayURL } from '../src/ipfs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Anchor's default placeholder. A configured id equal to this one means no real
// program id was ever chosen; step 8 also probes the cluster, because a real id
// in source still says nothing about whether the program is deployed.
const AGENT_INVOCATION_PLACEHOLDER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

const ERC8004_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const THREEWS_CARD_TYPE = 'https://three.ws/.well-known/3d-agent-card.schema.json';
const VALIDATION_KIND = 'glb-schema';

// Live-bytecode probe targets for the parity step (Base mainnet + Base Sepolia).
const BYTECODE_PROBE_CHAINS = [8453, 84532];

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);

const STATUS = {
	PASS: { label: 'PASS', icon: '✓', paint: green },
	FAIL: { label: 'FAIL', icon: '✗', paint: red },
	SKIP: { label: 'SKIP', icon: '○', paint: yellow },
};

const pass = (detail, extra) => ({ status: 'PASS', detail, extra });
const fail = (detail, extra) => ({ status: 'FAIL', detail, extra });
const skip = (detail, extra) => ({ status: 'SKIP', detail, extra });

function fmtMs(ms) {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Synthetic fixtures (real, valid bytes — never mocked)
// ---------------------------------------------------------------------------

/** A real, minimal, structurally-valid binary glTF (GLB) container. */
function buildSyntheticGlb() {
	const gltf = {
		asset: { version: '2.0', generator: 'three.ws onchain-smoke synthetic' },
		scene: 0,
		scenes: [{ name: 'smoke' }],
		nodes: [],
	};
	const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
	const pad = (4 - (jsonBuf.length % 4)) % 4;
	const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);

	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0); // magic 'glTF'
	header.writeUInt32LE(2, 4); // version
	header.writeUInt32LE(12 + 8 + jsonChunk.length, 8); // total length

	const chunkHeader = Buffer.alloc(8);
	chunkHeader.writeUInt32LE(jsonChunk.length, 0);
	chunkHeader.writeUInt32LE(0x4e4f534a, 4); // chunk type 'JSON'

	return Buffer.concat([header, chunkHeader, jsonChunk]);
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Reject after `ms` so a hung RPC/HTTP call degrades instead of blocking the run. */
function withTimeout(promise, ms, label) {
	let timer;
	const guard = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// URI fetch (data: / ipfs:// / http(s))
// ---------------------------------------------------------------------------

async function fetchUriBytes(uri) {
	if (uri.startsWith('data:')) {
		const comma = uri.indexOf(',');
		const header = uri.slice(5, comma);
		const payload = uri.slice(comma + 1);
		if (/;base64/i.test(header)) return Buffer.from(payload, 'base64');
		return Buffer.from(decodeURIComponent(payload), 'utf8');
	}
	const url = uri.startsWith('ipfs://') ? normalizeGatewayURL(uri, 0) : uri;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

const fetchUriJson = async (uri) => JSON.parse((await fetchUriBytes(uri)).toString('utf8'));

/**
 * Pin bytes to permanent storage. Uses the real /api/erc8004/pin endpoint when a
 * session is configured; otherwise falls back to a self-contained data: URI built
 * from the real bytes (content-addressable by the same sha256 we assert on-chain).
 */
async function pinBytes(buf, contentType, cfg) {
	if (cfg.pinBaseUrl && cfg.authCookie) {
		const res = await fetch(`${cfg.pinBaseUrl}/api/erc8004/pin`, {
			method: 'POST',
			headers: { 'content-type': contentType, cookie: cfg.authCookie },
			body: buf,
		});
		if (!res.ok) throw new Error(`pin ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const data = await res.json();
		const url = data.url || data.uri;
		if (!url) throw new Error('pin endpoint returned no url');
		return url;
	}
	return `data:${contentType};base64,${buf.toString('base64')}`;
}

async function httpJson(method, url, { cookie, body } = {}) {
	const headers = {};
	if (cookie) headers.cookie = cookie;
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* non-JSON body surfaced verbatim below */
	}
	return { ok: res.ok, status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Card schema validation
// ---------------------------------------------------------------------------

let _validateCard = null;
async function getCardValidator() {
	if (_validateCard) return _validateCard;
	const schema = JSON.parse(
		await readFile(resolve(ROOT, 'public/.well-known/3d-agent-card.schema.json'), 'utf8'),
	);
	const ajv = new Ajv2020({ strict: false, allErrors: true });
	addFormats(ajv);
	_validateCard = ajv.compile(schema);
	return _validateCard;
}

// ---------------------------------------------------------------------------
// Step 1 — Address parity
// ---------------------------------------------------------------------------

const normAddr = (a) => (a && String(a).trim() ? String(a).trim().toLowerCase() : null);

/** Compare the three hand-maintained address sources; return a list of problems. */
function inlineParityProblems() {
	const problems = [];
	const ids = new Set(
		[...Object.keys(SRC_DEPLOYMENTS), ...Object.keys(SDK_DEPLOYMENTS)].map(Number),
	);
	for (const id of ids) {
		const src = SRC_DEPLOYMENTS[id];
		const sdk = SDK_DEPLOYMENTS[id];
		if (!src || !sdk) {
			problems.push(
				`chain ${id}: present only in ${src ? 'src/erc8004/abi.js' : 'sdk/src/erc8004/abi.js'}`,
			);
			continue;
		}
		for (const slot of ['identityRegistry', 'reputationRegistry', 'validationRegistry']) {
			const a = normAddr(src[slot]);
			const b = normAddr(sdk[slot]);
			if (a !== b) problems.push(`chain ${id} ${slot}: src=${a} sdk=${b}`);
		}
		// The api server mirror carries identity (`registry`) + validation only.
		const api = CHAIN_BY_ID[id];
		if (api) {
			if (normAddr(api.registry) !== normAddr(src.identityRegistry)) {
				problems.push(
					`chain ${id} identityRegistry: api=${normAddr(api.registry)} src=${normAddr(src.identityRegistry)}`,
				);
			}
			if (normAddr(api.validationRegistry) !== normAddr(src.validationRegistry)) {
				problems.push(
					`chain ${id} validationRegistry: api=${normAddr(api.validationRegistry)} src=${normAddr(src.validationRegistry)}`,
				);
			}
		}
	}
	return problems;
}

async function stepParity(cfg) {
	// Prefer the dedicated task-05 guard when present — it owns address parity, the
	// drift trap, and the live-bytecode sweep, and is also wired into the Vercel
	// build. Delegating avoids two divergent parity implementations.
	const parityScript = resolve(ROOT, 'scripts/verify-onchain-parity.mjs');
	if (existsSync(parityScript)) {
		// Default to the offline address-parity check (deterministic, no egress) so
		// CI never blocks on RPC transport noise. The live bytecode sweep — which
		// hits up to 5 RPCs × 12s per address — is opt-in via --mainnet-readonly.
		const liveChains = cfg.mainnetReadonly
			? process.env.VERIFY_ONCHAIN_CHAINS || '8453,84532'
			: 'none';
		const r = spawnSync(process.execPath, [parityScript], {
			encoding: 'utf8',
			timeout: 90_000,
			env: { ...process.env, VERIFY_ONCHAIN_CHAINS: liveChains },
		});
		if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) {
			// Network sweep hung — fall back to the offline inline parity so the
			// drift assertion still runs deterministically.
			const problems = inlineParityProblems();
			if (problems.length) {
				return fail(`${problems.length} mismatch(es): ${problems.slice(0, 4).join('; ')}`);
			}
			return pass(
				'address parity OK (inline; verify-onchain-parity.mjs live sweep timed out)',
			);
		}
		if (r.status !== 0) {
			const tail = ((r.stdout || '') + (r.stderr || ''))
				.trim()
				.split('\n')
				.slice(-3)
				.join(' | ');
			return fail(`verify-onchain-parity.mjs exited ${r.status}: ${tail}`);
		}
		return pass(
			`address parity OK via verify-onchain-parity.mjs${cfg.mainnetReadonly ? ' (+ live bytecode sweep)' : ''}`,
		);
	}

	// Fallback (task-05 script absent): inline parity across the three sources …
	const problems = inlineParityProblems();
	if (problems.length) {
		return fail(`${problems.length} address mismatch(es): ${problems.slice(0, 4).join('; ')}`);
	}
	// … plus a bounded live bytecode probe on Base mainnet + Base Sepolia. An empty
	// code result is a real FAIL; a network error/timeout degrades to a warning.
	const probes = [];
	for (const id of BYTECODE_PROBE_CHAINS) {
		const addr = SDK_DEPLOYMENTS[id]?.identityRegistry;
		if (!addr) continue;
		try {
			const provider = await evmFallbackProvider(id);
			const code = await withTimeout(provider.getCode(addr), 8000, `getCode chain ${id}`);
			if (!code || code === '0x')
				return fail(`chain ${id}: identityRegistry ${addr} has no bytecode`);
			probes.push(`${id}:code✓`);
		} catch (err) {
			probes.push(`${id}:rpc-skip(${(err.message || 'network').slice(0, 24)})`);
		}
	}
	return pass(
		`address parity OK (inline)${probes.length ? ` · bytecode ${probes.join(' ')}` : ''}`,
	);
}

/**
 * Compose a three.ws 3D Agent Card (the ERC-8004 registration base from
 * buildRegistrationJSON, plus the v1 `model` superset the card schema requires).
 */
function buildCard({ name, description, glbUrl, agentId, chainId, registryAddr, glbSha, glbSize }) {
	const base = buildRegistrationJSON({
		name,
		description,
		glbUrl,
		imageUrl: '',
		agentId,
		chainId,
		registryAddr,
		services: [],
		x402Support: true,
	});
	return {
		...base,
		type: [ERC8004_TYPE, THREEWS_CARD_TYPE],
		model: { uri: glbUrl, format: 'gltf-binary', sha256: glbSha, sizeBytes: glbSize },
	};
}

// ---------------------------------------------------------------------------
// Step 2 — EVM register (Base Sepolia)
// ---------------------------------------------------------------------------

async function stepEvmRegister(cfg, ctx) {
	const chainId = cfg.evmChainId;
	const dep = SDK_DEPLOYMENTS[chainId];
	if (!dep || !dep.identityRegistry) {
		return skip(`no Identity Registry configured for chain ${chainId}`);
	}
	if (!cfg.evmKey) {
		return skip('no funded EVM signer — set SMOKE_EVM_PRIVATE_KEY (Base-Sepolia)');
	}

	const provider = await evmFallbackProvider(chainId);
	const signer = new Wallet(cfg.evmKey, provider);
	const balance = await provider.getBalance(signer.address);
	if (balance === 0n) {
		return skip(
			`signer ${signer.address} has 0 balance on chain ${chainId} — fund it from a faucet`,
		);
	}

	const registry = new Contract(dep.identityRegistry, IDENTITY_REGISTRY_ABI, signer);

	// 1. Synthetic GLB + its sha256 (the independent byte-identity proof).
	const glb = buildSyntheticGlb();
	const glbSha = sha256hex(glb);
	const glbUrl = await pinBytes(glb, 'model/gltf-binary', cfg);

	// 2. register(seedURI) → Registered event → agentId.
	const tx = await registry['register(string)'](glbUrl);
	const receipt = await tx.wait();
	const registered = receipt.logs
		.map((l) => {
			try {
				return registry.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e && e.name === 'Registered');
	if (!registered) return fail('register() mined but no Registered event found');
	const agentId = Number(registered.args.agentId);

	// 3. Build the 3D Agent Card (ERC-8004 base + the v1 `model` superset) and pin.
	const card = buildCard({
		name: 'three.ws smoke agent',
		description:
			'Synthetic agent minted by scripts/onchain-smoke.mjs against testnet. Not a product launch.',
		glbUrl,
		agentId,
		chainId,
		registryAddr: dep.identityRegistry,
		glbSha,
		glbSize: glb.length,
	});
	const cardUri = await pinBytes(
		Buffer.from(JSON.stringify(card), 'utf8'),
		'application/json',
		cfg,
	);

	// 4. setAgentURI → point the on-chain pointer at the final card.
	await (await registry.setAgentURI(agentId, cardUri)).wait();

	// 5. tokenURI round-trip + schema validation + sha256 byte-identity.
	const onchainUri = await registry.tokenURI(agentId);
	if (onchainUri !== cardUri) return fail('tokenURI did not round-trip to the pinned card URI');

	const fetched = await fetchUriJson(onchainUri);
	const validate = await getCardValidator();
	if (!validate(fetched)) {
		const msg = (validate.errors || [])
			.slice(0, 3)
			.map((e) => `${e.instancePath || '/'} ${e.message}`)
			.join('; ');
		return fail(`card failed 3d-agent-card.schema.json: ${msg}`);
	}
	if (fetched.model.sha256 !== glbSha) {
		return fail(`card model.sha256 ${fetched.model.sha256} != GLB sha256 ${glbSha}`);
	}
	const modelBytes = await fetchUriBytes(fetched.model.uri);
	if (sha256hex(modelBytes) !== glbSha) {
		return fail('re-fetched model bytes do not hash to model.sha256');
	}

	// Hand the registered identity to steps 3 + 4.
	ctx.evm = { chainId, agentId, registryAddr: dep.identityRegistry, signer, provider, glbSha };
	return pass(`agentId=${agentId} · tokenURI round-trips · card valid · model.sha256 matches`, {
		agentId,
		registerTx: tx.hash,
	});
}

// ---------------------------------------------------------------------------
// Step 3 — EVM validation attestation
// ---------------------------------------------------------------------------

function buildValidationReport(glbSha) {
	// The canonical glb-schema report shape (see src/erc8004/validation-report.js):
	// zero errors ⇒ passing. Deterministic key order keeps hashReport reproducible.
	return {
		kind: VALIDATION_KIND,
		spec: 'erc-8004/validation/glb-schema@1',
		validatedAt: new Date().toISOString(),
		uri: 'synthetic://onchain-smoke.glb',
		validator: { name: 'three.ws onchain-smoke', tool: 'scripts/onchain-smoke.mjs' },
		byteCheck: { sha256: glbSha, byteLength: null },
		issues: { numErrors: 0, numWarnings: 0, numInfos: 0, numHints: 0, messages: [] },
	};
}

async function stepEvmValidation(cfg, ctx) {
	const chainId = ctx.evm?.chainId ?? cfg.evmChainId;
	const dep = SDK_DEPLOYMENTS[chainId];
	if (!dep || !dep.validationRegistry) {
		return skip(`no Validation Registry deployed on chain ${chainId}`);
	}
	const agentId = ctx.evm?.agentId ?? cfg.agentId;
	if (agentId == null) {
		return skip('no agentId — run step 2 in the same invocation or set SMOKE_AGENT_ID');
	}
	if (!cfg.evmKey) {
		return skip('no funded signer: set SMOKE_EVM_PRIVATE_KEY (it must own the agent to open a request)');
	}

	const provider = ctx.evm?.provider ?? (await evmFallbackProvider(chainId));
	const signer = ctx.evm?.signer ?? new Wallet(cfg.evmKey, provider);
	const registry = new Contract(dep.validationRegistry, VALIDATION_REGISTRY_ABI, signer);

	const glbSha = ctx.evm?.glbSha ?? sha256hex(buildSyntheticGlb());
	const report = buildValidationReport(glbSha);
	const { keccak256, toUtf8Bytes } = await import('ethers');
	const proofHash = keccak256(toUtf8Bytes(JSON.stringify(report)));
	const score = responseForPassed(true);
	const requestHash = validationRequestHash({ chainId, agentId, seed: proofHash, kind: VALIDATION_KIND });

	// The registry is request/response based: the agent's owner opens a request
	// naming a validator, and only that validator may answer it. This signer
	// registered the agent in step 2, so it plays both roles.
	let existing = null;
	try {
		existing = await registry.getValidationStatus(requestHash);
	} catch {
		existing = null;
	}

	let requestTx = null;
	if (!existing) {
		try {
			requestTx = await registry.validationRequest(signer.address, agentId, '', requestHash);
			await requestTx.wait();
		} catch (err) {
			const reason = err.shortMessage || err.reason || err.message || 'revert';
			if (/not authorized/i.test(reason)) {
				return skip(`signer ${signer.address} does not own agent ${agentId} (${reason})`);
			}
			return fail(`validationRequest failed: ${reason}`);
		}
	} else if (existing[0].toLowerCase() !== signer.address.toLowerCase()) {
		return skip(`request ${requestHash} is addressed to validator ${existing[0]}, not ${signer.address}`);
	}

	let tx;
	try {
		tx = await registry.validationResponse(requestHash, score, '', proofHash, VALIDATION_KIND);
		await tx.wait();
	} catch (err) {
		return fail(`validationResponse failed: ${err.shortMessage || err.reason || err.message || 'revert'}`);
	}

	// Read the verdict back the way the badge does.
	try {
		const status = await registry.getValidationStatus(requestHash);
		if (status[3] !== proofHash) {
			return fail(`getValidationStatus responseHash ${status[3]} != recorded ${proofHash}`);
		}
		if (status[4] !== VALIDATION_KIND) {
			return fail(`getValidationStatus tag "${status[4]}" != "${VALIDATION_KIND}"`);
		}
		if (!responsePassed(status[2])) {
			return fail(`getValidationStatus response ${status[2]} reads as a failure`);
		}
	} catch (err) {
		return fail(`getValidationStatus read failed: ${err.shortMessage || err.message}`);
	}

	const summary = await registry
		.getSummary(agentId, [signer.address], VALIDATION_KIND)
		.catch(() => null);
	if (summary && Number(summary[0]) < 1) {
		return fail(`getSummary count is ${summary[0]} after recording a validation`);
	}

	return pass(`attestation recorded for agentId=${agentId} on request ${requestHash.slice(0, 10)}`, {
		validationRequestTx: requestTx?.hash ?? null,
		validationTx: tx.hash,
		requestHash,
		proofHash,
	});
}

// ---------------------------------------------------------------------------
// Step 4 — EVM reputation feedback
// ---------------------------------------------------------------------------

async function stepEvmReputation(cfg, ctx) {
	const chainId = ctx.evm?.chainId ?? cfg.evmChainId;
	const dep = SDK_DEPLOYMENTS[chainId];
	if (!dep || !dep.reputationRegistry) {
		return skip(`no Reputation Registry deployed on chain ${chainId}`);
	}
	const agentId = ctx.evm?.agentId ?? cfg.agentId;
	if (agentId == null) {
		return skip('no agentId — run step 2 in the same invocation or set SMOKE_AGENT_ID');
	}
	// Feedback must come from a DIFFERENT signer than the agent owner (a registry
	// typically rejects self-review), so step 4 needs a dedicated second signer.
	if (!cfg.evmKey2) {
		return skip('no second funded signer — set SMOKE_EVM_PRIVATE_KEY_2 to submit feedback');
	}

	const provider = ctx.evm?.provider ?? (await evmFallbackProvider(chainId));
	const reviewer = new Wallet(cfg.evmKey2, provider);
	if ((await provider.getBalance(reviewer.address)) === 0n) {
		return skip(`reviewer ${reviewer.address} has 0 balance on chain ${chainId} — fund it`);
	}

	const reader = new Contract(dep.reputationRegistry, REPUTATION_REGISTRY_ABI, provider);
	let countBefore;
	try {
		[, countBefore] = await reader.getReputation(agentId);
	} catch (err) {
		return fail(`getReputation read failed: ${err.shortMessage || err.message}`);
	}

	const writer = new Contract(dep.reputationRegistry, REPUTATION_REGISTRY_ABI, reviewer);
	let tx;
	try {
		tx = await writer.submitFeedback(agentId, 5, 'onchain-smoke synthetic feedback');
		await tx.wait();
	} catch (err) {
		const reason = err.shortMessage || err.reason || err.message || 'revert';
		if (/self|already|reviewed/i.test(reason)) {
			return skip(`feedback rejected (${reason}) — use a fresh reviewer signer`);
		}
		return fail(`submitFeedback failed: ${reason}`);
	}

	const [, countAfter] = await reader.getReputation(agentId);
	if (countAfter <= countBefore) {
		return fail(`reputation count did not increment (${countBefore} -> ${countAfter})`);
	}
	return pass(
		`feedback from ${reviewer.address.slice(0, 10)}… · count ${countBefore} -> ${countAfter}`,
		{
			reputationTx: tx.hash,
		},
	);
}

// ---------------------------------------------------------------------------
// Solana helpers (lazy-loaded so the EVM/read-only path needs no Solana deps)
// ---------------------------------------------------------------------------

async function loadSolana() {
	const web3 = await import('@solana/web3.js');
	const bs58 = (await import('bs58')).default;
	return { ...web3, bs58 };
}

function solanaKeypairFrom(sol, bs58Secret) {
	const { Keypair, bs58 } = sol;
	const bytes = bs58.decode(bs58Secret);
	return Keypair.fromSecretKey(bytes);
}

// ---------------------------------------------------------------------------
// Step 5 — Solana launch (devnet)
// ---------------------------------------------------------------------------

async function stepSolanaLaunch(cfg, ctx) {
	const missing = [];
	if (!cfg.baseUrl) missing.push('SMOKE_BASE_URL');
	if (!cfg.authCookie) missing.push('SMOKE_AUTH_COOKIE');
	if (!cfg.solanaKey) missing.push('SMOKE_SOLANA_PRIVATE_KEY');
	if (!cfg.solanaAgentId) missing.push('SMOKE_SOLANA_AGENT_ID');
	if (missing.length) {
		return skip(
			`devnet value step — set ${missing.join(', ')} (funded devnet wallet linked to the account)`,
		);
	}

	const sol = await loadSolana();
	const { Connection, VersionedTransaction } = sol;
	const wallet = solanaKeypairFrom(sol, cfg.solanaKey);
	const conn = new Connection(cfg.solanaRpcDevnet, 'confirmed');

	// 1. launch-prep — server builds the unsigned tx + (server-ground) mint key.
	const prep = await httpJson('POST', `${cfg.baseUrl}/api/pump/launch-prep`, {
		cookie: cfg.authCookie,
		body: {
			agent_id: cfg.solanaAgentId,
			wallet_address: wallet.publicKey.toBase58(),
			name: 'three.ws smoke',
			symbol: 'SMOKE',
			uri: `${cfg.baseUrl}/.well-known/3d-agent-card.schema.json`,
			network: 'devnet',
			coin_type: 'regular',
			sol_buy_in: 0,
		},
	});
	if (!prep.ok)
		return fail(
			`launch-prep ${prep.status}: ${prep.json?.message || prep.text?.slice(0, 160)}`,
		);

	const { prep_id, mint, mint_secret_key_b64, tx_base64 } = prep.json;
	const txn = VersionedTransaction.deserialize(Buffer.from(tx_base64, 'base64'));

	// 2. Co-sign with the server-supplied mint keypair + the user wallet, broadcast.
	const signers = [wallet];
	if (mint_secret_key_b64) {
		signers.push(sol.Keypair.fromSecretKey(Buffer.from(mint_secret_key_b64, 'base64')));
	}
	txn.sign(signers);
	const sig = await conn.sendRawTransaction(txn.serialize(), { skipPreflight: false });
	await conn.confirmTransaction(sig, 'confirmed');

	// 3. launch-confirm — server records the pump_agent_mints row.
	const confirm = await httpJson('POST', `${cfg.baseUrl}/api/pump/launch-confirm`, {
		cookie: cfg.authCookie,
		body: { prep_id, tx_signature: sig },
	});
	if (!confirm.ok)
		return fail(
			`launch-confirm ${confirm.status}: ${confirm.json?.message || confirm.text?.slice(0, 160)}`,
		);

	ctx.solana = { mint, wallet };
	return pass(`launched mint ${mint.slice(0, 8)}… on devnet · pump_agent_mints row recorded`, {
		mint,
		launchSig: sig,
	});
}

// ---------------------------------------------------------------------------
// Step 6 — Solana trade (devnet)
// ---------------------------------------------------------------------------

async function stepSolanaTrade(cfg, ctx) {
	const mint = ctx.solana?.mint || cfg.solanaMint;
	const missing = [];
	if (!cfg.baseUrl) missing.push('SMOKE_BASE_URL');
	if (!cfg.authCookie) missing.push('SMOKE_AUTH_COOKIE');
	if (!cfg.solanaKey) missing.push('SMOKE_SOLANA_PRIVATE_KEY');
	if (!mint) missing.push('a mint (run step 5 first or set SMOKE_SOLANA_MINT)');
	if (missing.length) return skip(`devnet value step — needs ${missing.join(', ')}`);

	const sol = await loadSolana();
	const { Connection, VersionedTransaction } = sol;
	const wallet = ctx.solana?.wallet || solanaKeypairFrom(sol, cfg.solanaKey);
	const conn = new Connection(cfg.solanaRpcDevnet, 'confirmed');

	const solAmount = 0.001;
	const prep = await httpJson('POST', `${cfg.baseUrl}/api/pump/buy-prep`, {
		cookie: cfg.authCookie,
		body: {
			mint,
			wallet_address: wallet.publicKey.toBase58(),
			sol: solAmount,
			network: 'devnet',
		},
	});
	if (!prep.ok)
		return fail(`buy-prep ${prep.status}: ${prep.json?.message || prep.text?.slice(0, 160)}`);

	const txn = VersionedTransaction.deserialize(Buffer.from(prep.json.tx_base64, 'base64'));
	txn.sign([wallet]);
	const sig = await conn.sendRawTransaction(txn.serialize(), { skipPreflight: false });
	await conn.confirmTransaction(sig, 'confirmed');

	// buy-confirm verifies the tx on-chain; route comes back from buy-prep.
	const confirm = await httpJson('POST', `${cfg.baseUrl}/api/pump/buy-confirm`, {
		cookie: cfg.authCookie,
		body: {
			mint,
			network: 'devnet',
			tx_signature: sig,
			wallet_address: wallet.publicKey.toBase58(),
			sol: solAmount,
			route: prep.json.route,
		},
	});
	if (!confirm.ok)
		return fail(
			`buy-confirm ${confirm.status}: ${confirm.json?.message || confirm.text?.slice(0, 160)}`,
		);

	return pass(`bought ${mint.slice(0, 8)}… on devnet · confirmed sig ${sig.slice(0, 10)}…`, {
		tradeSig: sig,
	});
}

// ---------------------------------------------------------------------------
// Step 7 — x402 pay-by-name (resolve + prep build, never broadcasts)
// ---------------------------------------------------------------------------

async function stepX402PayByName(cfg) {
	if (!cfg.baseUrl)
		return skip('no SMOKE_BASE_URL — x402 pay-by-name runs against the deployed API');
	if (!cfg.x402Name) {
		return skip(
			'no SMOKE_X402_NAME — set a resolvable @handle or .sol name to exercise the prep build',
		);
	}

	// 1. Resolve the name (read-only).
	const resolved = await httpJson(
		'GET',
		`${cfg.baseUrl}/api/x402/pay-by-name?name=${encodeURIComponent(cfg.x402Name)}`,
	);
	if (!resolved.ok) {
		return fail(
			`resolve "${cfg.x402Name}" -> ${resolved.status}: ${resolved.json?.message || resolved.text?.slice(0, 120)}`,
		);
	}
	const recipient = resolved.json?.data?.address;
	if (!recipient) return fail(`resolve returned no address for "${cfg.x402Name}"`);

	// 2. Build a payment with a fresh synthetic payer — mode=prep only, NO broadcast.
	const sol = await loadSolana();
	const payer = cfg.x402Payer || sol.Keypair.generate().publicKey.toBase58();
	const prep = await httpJson('POST', `${cfg.baseUrl}/api/x402/pay-by-name`, {
		body: { name: cfg.x402Name, amount_usdc: 0.01, mode: 'prep', payer_wallet: payer },
	});
	if (!prep.ok) {
		return fail(
			`prep build -> ${prep.status}: ${prep.json?.message || prep.text?.slice(0, 120)}`,
		);
	}
	const txB64 = prep.json?.data?.tx_base64 || prep.json?.tx_base64;
	if (!txB64) return fail('prep build returned no tx_base64');

	return pass(
		`resolved "${cfg.x402Name}" -> ${recipient.slice(0, 8)}… · prep tx built (not broadcast)`,
	);
}

// ---------------------------------------------------------------------------
// Step 8 — Solana agent_invocation (devnet)
// ---------------------------------------------------------------------------

async function stepSolanaInvoke(cfg) {
	// Program id + invocation path both come from the API runtime module, which is
	// the code production actually signs with and needs no build step. The earlier
	// read went through the published SDK's dist/, a gitignored build artifact, so
	// a clean checkout failed this step on a missing file rather than reporting
	// anything about the chain.
	const { AGENT_INVOCATION_PROGRAM_ID: programId, recordInvocationReceipt } = await import(
		'../api/_lib/agent-invocation-onchain.js'
	);
	if (!programId || programId === AGENT_INVOCATION_PLACEHOLDER) {
		return skip(
			'agent_invocation program id is still the Anchor placeholder; deploy the program first',
		);
	}

	const sol = await loadSolana();
	const { Connection } = sol;
	const conn = new Connection(cfg.solanaRpcDevnet, 'confirmed');

	// An id in source is not a deployment: ask the cluster before claiming either
	// way, so an undeployed program reads as the SKIP this harness promises rather
	// than as a confusing send failure once a signer is supplied.
	const programInfo = await conn.getAccountInfo(new sol.PublicKey(programId));
	if (!programInfo?.executable) {
		return skip(
			`agent_invocation ${programId.slice(0, 8)} not deployed to devnet; anchor deploy --provider.cluster devnet (contracts/agent-invocation)`,
		);
	}
	if (!cfg.solanaKey) {
		return skip(
			`no funded devnet invoker — set SMOKE_SOLANA_PRIVATE_KEY (program ${programId.slice(0, 8)}…)`,
		);
	}

	const invoker = solanaKeypairFrom(sol, cfg.solanaKey);
	const target = sol.Keypair.generate(); // synthetic target authority

	const { signature: sig } = await recordInvocationReceipt({
		invokerKeypair: invoker,
		targetAuthority: target.publicKey,
		skillName: 'onchain-smoke',
		parameters: JSON.stringify({ harness: 'scripts/onchain-smoke.mjs' }),
		network: 'devnet',
		programId,
		connection: conn,
	});

	// Assert the SkillInvoked event is in the confirmed tx's program logs.
	const txInfo = await conn.getTransaction(sig, {
		commitment: 'confirmed',
		maxSupportedTransactionVersion: 0,
	});
	if (!txInfo || txInfo.meta?.err) {
		return fail(`invoke_skill tx ${sig} not confirmed cleanly`);
	}
	const logs = txInfo.meta?.logMessages || [];
	const sawEvent = logs.some((l) => /SkillInvoked|Program data:/.test(l));
	if (!sawEvent) return fail('invoke_skill confirmed but no SkillInvoked event in logs');

	return pass(
		`invoke_skill confirmed on devnet · SkillInvoked emitted · sig ${sig.slice(0, 10)}…`,
		{ invokeSig: sig },
	);
}

// ---------------------------------------------------------------------------
// Step registry + runner
// ---------------------------------------------------------------------------

const STEPS = [
	{ key: 'parity', num: 1, title: 'Address parity', run: stepParity },
	{ key: 'evm-register', num: 2, title: 'EVM register (Base Sepolia)', run: stepEvmRegister },
	{ key: 'evm-validation', num: 3, title: 'EVM validation attestation', run: stepEvmValidation },
	{ key: 'evm-reputation', num: 4, title: 'EVM reputation feedback', run: stepEvmReputation },
	{ key: 'solana-launch', num: 5, title: 'Solana launch (devnet)', run: stepSolanaLaunch },
	{ key: 'solana-trade', num: 6, title: 'Solana trade (devnet)', run: stepSolanaTrade },
	{ key: 'x402-payname', num: 7, title: 'x402 pay-by-name (prep)', run: stepX402PayByName },
	{
		key: 'solana-invoke',
		num: 8,
		title: 'Solana agent_invocation (devnet)',
		run: stepSolanaInvoke,
	},
];

function parseArgs(argv) {
	const args = { only: null, mainnetReadonly: false, json: false, list: false, help: false };
	for (const a of argv) {
		if (a === '--list') args.list = true;
		else if (a === '--json') args.json = true;
		else if (a === '--mainnet-readonly') args.mainnetReadonly = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else if (a.startsWith('--only='))
			args.only = a
				.slice('--only='.length)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
	}
	return args;
}

function buildConfig(args) {
	return {
		mainnetReadonly: args.mainnetReadonly,
		evmChainId: Number(process.env.SMOKE_EVM_CHAIN_ID || 84532),
		evmKey: process.env.SMOKE_EVM_PRIVATE_KEY || null,
		evmKey2: process.env.SMOKE_EVM_PRIVATE_KEY_2 || null,
		agentId: process.env.SMOKE_AGENT_ID != null ? Number(process.env.SMOKE_AGENT_ID) : null,
		solanaAgentId: process.env.SMOKE_SOLANA_AGENT_ID || null,
		pinBaseUrl: (process.env.SMOKE_PIN_BASE_URL || '').replace(/\/$/, '') || null,
		authCookie: process.env.SMOKE_AUTH_COOKIE || null,
		baseUrl: (process.env.SMOKE_BASE_URL || '').replace(/\/$/, '') || null,
		solanaKey: process.env.SMOKE_SOLANA_PRIVATE_KEY || null,
		solanaMint: process.env.SMOKE_SOLANA_MINT || null,
		solanaRpcDevnet: process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com',
		x402Name: process.env.SMOKE_X402_NAME || null,
		x402Payer: process.env.SMOKE_X402_PAYER || null,
	};
}

function selectSteps(only) {
	if (!only) return STEPS;
	const picked = STEPS.filter((s) => only.includes(s.key) || only.includes(String(s.num)));
	const unknown = only.filter((o) => !STEPS.some((s) => s.key === o || String(s.num) === o));
	if (unknown.length) {
		console.error(red(`Unknown step(s): ${unknown.join(', ')}`));
		console.error(dim(`Valid keys: ${STEPS.map((s) => `${s.num}:${s.key}`).join(', ')}`));
		process.exit(2);
	}
	return picked;
}

function printTable(results) {
	const w = { num: 3, step: 34, status: 6, time: 7 };
	const line = (n, step, status, time, detail) =>
		`${String(n).padEnd(w.num)} ${step.padEnd(w.step)} ${status.padEnd(w.status)} ${time.padEnd(w.time)} ${detail}`;

	console.log('');
	console.log(bold(line('#', 'Step', 'Status', 'Time', 'Detail')));
	console.log(dim('─'.repeat(96)));
	for (const r of results) {
		const s = STATUS[r.status];
		console.log(
			line(r.num, r.title, s.paint(`${s.icon} ${s.label}`), fmtMs(r.ms), dim(r.detail || '')),
		);
	}
	console.log(dim('─'.repeat(96)));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'On-chain end-to-end smoke harness. See the file header for credentials and flags.',
		);
		console.log(`Steps: ${STEPS.map((s) => `${s.num}:${s.key}`).join(', ')}`);
		return 0;
	}
	if (args.list) {
		for (const s of STEPS) console.log(`${s.num}  ${s.key.padEnd(16)} ${s.title}`);
		return 0;
	}

	const cfg = buildConfig(args);
	const steps = selectSteps(args.only);
	const ctx = {};

	console.log(bold('On-chain end-to-end smoke harness'));
	console.log(
		dim(
			`mode=${cfg.mainnetReadonly ? 'mainnet-readonly' : 'testnet/devnet'} · evmChain=${cfg.evmChainId} · steps=${steps.map((s) => s.num).join(',')}`,
		),
	);
	console.log('');

	const results = [];
	for (const step of steps) {
		process.stdout.write(dim(`→ [${step.num}] ${step.title} … `));
		const t0 = Date.now();
		let res;
		try {
			res = await step.run(cfg, ctx);
		} catch (err) {
			res = fail(err.shortMessage || err.message || String(err));
		}
		const ms = Date.now() - t0;
		const s = STATUS[res.status];
		console.log(s.paint(`${s.icon} ${res.status}`) + dim(` (${fmtMs(ms)})`));
		results.push({ num: step.num, key: step.key, title: step.title, ms, ...res });
	}

	printTable(results);

	const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
	const summary = `${counts.PASS || 0} pass · ${counts.SKIP || 0} skip · ${counts.FAIL || 0} fail`;
	console.log(
		(counts.FAIL ? red : green)(bold(summary)) +
			(counts.SKIP
				? dim('  (skips need funded signers / deployed deps / credentials — see headers)')
				: ''),
	);

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					summary: counts,
					results: results.map(({ extra, ...r }) => ({ ...r, ...(extra || {}) })),
				},
				null,
				2,
			),
		);
	}

	return counts.FAIL ? 1 : 0;
}

// Run only when invoked directly — importing the module (e.g. from the CI unit
// test) exposes the pure helpers without executing the harness.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(red(`\nharness crashed: ${err.stack || err.message}`));
			process.exit(1);
		});
}

export {
	STEPS,
	inlineParityProblems,
	buildSyntheticGlb,
	sha256hex,
	buildCard,
	getCardValidator,
	ERC8004_TYPE,
	THREEWS_CARD_TYPE,
};
