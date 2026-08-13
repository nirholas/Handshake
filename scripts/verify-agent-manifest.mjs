#!/usr/bin/env node
/**
 * Verify a signed three.ws agent manifest, independently.
 *
 * This script talks to public IPFS gateways, not to three.ws, and does every
 * cryptographic check locally. Nothing here needs an account, an API key, or our
 * permission — which is the entire point of signing manifests in the first place.
 *
 *   node scripts/verify-agent-manifest.mjs --cid bafy...
 *   node scripts/verify-agent-manifest.mjs --file ./manifest.json
 *   node scripts/verify-agent-manifest.mjs --agent <uuid>            # resolve the CID first
 *   node scripts/verify-agent-manifest.mjs --cid bafy... --issuer 6Yb...   # pin the signer
 *   node scripts/verify-agent-manifest.mjs --cid bafy... --json      # machine-readable
 *
 * Exit codes: 0 verified, 1 verification failed, 2 could not fetch or parse.
 *
 * Spec: specs/AGENT_MANIFEST.md (§ Signed envelope). Docs: docs/agent-manifest.md.
 */

import { readFile } from 'node:fs/promises';
import { verifyAgentManifest, sha256Hex } from '../api/_lib/agent-manifest-sign.js';
import { fetchFromGateways } from '../api/_lib/ipfs-pin.js';

const TIMEOUT_MS = 15000;

function parseArgs(argv) {
	const out = { json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') out.json = true;
		else if (arg === '--help' || arg === '-h') out.help = true;
		else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
	}
	return out;
}

const USAGE = `Verify a signed three.ws agent manifest.

  --cid <cid>        fetch the envelope from public IPFS gateways
  --file <path>      verify a local envelope file instead
  --agent <uuid>     look up the agent's current CID, then verify it
  --issuer <base58>  require this exact signing identity
  --origin <url>     API origin for --agent (default https://three.ws)
  --json             print the result as JSON
`;

// The gateway list and the concurrent read live in api/_lib/ipfs-pin.js, which
// is dependency-free, so this script shares exactly the retrieval path the
// platform uses without dragging in a database client.
async function loadFromIPFS(cid) {
	const { text, gateway } = await fetchFromGateways(cid);
	return { envelope: JSON.parse(text), from: gateway };
}

async function resolveAgentCid(agentId, origin) {
	const url = `${origin.replace(/\/$/, '')}/api/agents/${agentId}/manifest/signed`;
	const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
	const data = await resp.json();
	if (!data.cid) throw new Error(`agent ${agentId} has a signed manifest but no IPFS CID yet`);
	return data.cid;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || (!args.cid && !args.file && !args.agent)) {
		console.log(USAGE);
		process.exit(args.help ? 0 : 2);
	}

	let envelope;
	let source;
	try {
		if (args.file) {
			envelope = JSON.parse(await readFile(args.file, 'utf8'));
			source = args.file;
		} else {
			const cid = args.cid || (await resolveAgentCid(args.agent, args.origin || 'https://three.ws'));
			const got = await loadFromIPFS(cid);
			envelope = got.envelope;
			source = got.from;
		}
	} catch (err) {
		console.error(`could not load the manifest: ${err.message}`);
		process.exit(2);
	}

	const verdict = verifyAgentManifest(envelope, args.issuer ? { issuer: args.issuer } : {});
	const instructions = envelope?.manifest?.brain?.instructions;
	const promptHashOk =
		instructions && typeof instructions.text === 'string'
			? sha256Hex(instructions.text) === String(instructions.sha256 || '').toLowerCase()
			: null;

	const result = {
		source,
		verified: verdict.valid,
		reason: verdict.reason,
		issuer: verdict.issuer,
		digest: verdict.digest,
		signedAt: envelope?.signedAt || null,
		agentId: envelope?.manifest?.id?.agentId || null,
		name: envelope?.manifest?.name || null,
		promptSha256: instructions?.sha256 || null,
		promptHashMatches: promptHashOk,
		promptChars: typeof instructions?.text === 'string' ? instructions.text.length : null,
	};

	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(`source        ${result.source}`);
		console.log(`agent         ${result.name || '(unnamed)'}  ${result.agentId || ''}`);
		console.log(`issuer        ${result.issuer || '(none)'}`);
		console.log(`signed at     ${result.signedAt || '(none)'}`);
		console.log(`digest        ${result.digest || '(none)'}`);
		console.log(`prompt        ${result.promptChars ?? 0} chars, sha256 ${result.promptSha256 || '(none)'}`);
		console.log(`prompt hash   ${promptHashOk === null ? 'n/a' : promptHashOk ? 'matches' : 'MISMATCH'}`);
		console.log(`result        ${result.verified ? 'VERIFIED' : 'FAILED'} (${result.reason})`);
		if (!args.issuer && result.verified) {
			console.log('\nnote: the signature is valid for the issuer above. Pass --issuer to require a specific one.');
		}
	}

	process.exit(result.verified ? 0 : 1);
}

main();
