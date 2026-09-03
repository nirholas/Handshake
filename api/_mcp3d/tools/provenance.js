// Verifiable 3D provenance — MCP tools.
//
//   • verify_provenance(glb_url | hash) — FREE, read-only, public. Recomputes the
//     GLB content hash, looks up the signed credential, checks the signature and
//     (if anchored) the on-chain anchor, and returns verified | tampered | unknown
//     with the chain of custody. ZERO payment/wallet/coin surface, so it ships on
//     the OpenAI free track. It is the authenticity check anyone can run.
//
//   • anchor_provenance(glb_url, …) — PAID, Claude/web3 track. Signs a content
//     credential with the three.ws issuer key, anchors its hash on Solana, and
//     stores the full credential in R2 addressed by the GLB hash. Real hashing,
//     real signature, real on-chain write. destructiveHint:false.
//
// Spec: specs/PROVENANCE_3D.md. Pure core: api/_lib/provenance-3d.js.

import { fetchSafePublicUrl } from '../../_lib/ssrf-guard.js';
import { getObjectBuffer, putObject } from '../../_lib/r2.js';
import { env } from '../../_lib/env.js';
import {
	sha256Hex,
	buildCredential,
	signCredential,
	credentialHash,
	decideVerdict,
	provenanceKey,
	explorerTxUrl,
} from '../../_lib/provenance-3d.js';
import { anchorCredentialHash, confirmAnchor } from '../../_lib/provenance-anchor.js';
import { gradeSimReadiness, signedGradeSubset } from '../../_lib/sim-readiness.js';
import { getGrade, putGrade } from '../../_lib/sim-readiness-store.js';

const MAX_GLB_BYTES = 64 * 1024 * 1024; // 64 MB — a generous ceiling for a single asset.

function toolError(message, code) {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: { error: true, code: code || 'error', message },
		isError: true,
	};
}

// Fetch GLB bytes over an SSRF-guarded request and return them with their
// sha256 (hex). Anchoring signs a physics grade over the same bytes, so the
// buffer is handed back rather than dropped: one fetch, two claims about
// provably identical content.
async function fetchGlbBytes(glbUrl) {
	const res = await fetchSafePublicUrl(glbUrl, { redirect: 'follow' }, { maxBytes: MAX_GLB_BYTES });
	if (!res.ok) throw new Error(`could not fetch the model (${res.status})`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (!buf.length) throw new Error('the model URL returned no data');
	return { buf, glbSha256: sha256Hex(buf) };
}

async function hashGlbBytes(glbUrl) {
	return (await fetchGlbBytes(glbUrl)).glbSha256;
}

// The signed grade for these exact bytes: the cached one when it exists at the
// current grader version, otherwise a fresh grade that is also cached for the
// free endpoint. Best-effort by design. A credential without a grade is a
// complete, valid credential; a credential carrying a grade nobody could
// compute would not be.
async function signableGrade(buf, glbSha256, glbUrl) {
	try {
		const hit = await getGrade(glbSha256);
		if (hit) return signedGradeSubset(hit.report);
		const started = Date.now();
		const report = await gradeSimReadiness(buf);
		await putGrade({
			glbSha256,
			report,
			sourceUrl: glbUrl,
			sizeBytes: buf.length,
			gradeMs: Date.now() - started,
		});
		return signedGradeSubset(report);
	} catch (err) {
		console.warn('[provenance] simulation-readiness grade unavailable for this anchor:', err?.message);
		return null;
	}
}

async function readEnvelope(glbSha256) {
	try {
		const buf = await getObjectBuffer(provenanceKey(glbSha256));
		if (!buf) return null;
		return JSON.parse(buf.toString('utf8'));
	} catch {
		return null;
	}
}

// Public subset of a credential — never expose anything beyond the documented,
// human-facing provenance fields.
function publicCredential(c) {
	if (!c) return null;
	return {
		version: c.version,
		glbSha256: c.glbSha256,
		createdAt: c.createdAt,
		...(c.creator ? { creator: c.creator } : {}),
		...(c.prompt ? { prompt: c.prompt } : {}),
		...(c.model ? { model: c.model } : {}),
		...(c.provider ? { provider: c.provider } : {}),
		...(Array.isArray(c.lineage) ? { lineage: c.lineage } : {}),
		...(c.simReadiness ? { simReadiness: c.simReadiness } : {}),
	};
}

async function handleVerify(args) {
	const glbUrl = typeof args.glb_url === 'string' ? args.glb_url.trim() : '';
	const hashArg = typeof args.hash === 'string' ? args.hash.trim().toLowerCase() : '';
	let glbSha256 = '';
	if (glbUrl) {
		try {
			glbSha256 = await hashGlbBytes(glbUrl);
		} catch (err) {
			return toolError(err.message || 'could not read the model to verify it', 'fetch_failed');
		}
	} else if (/^[0-9a-f]{64}$/.test(hashArg)) {
		glbSha256 = hashArg;
	} else {
		return toolError('Provide glb_url (an https .glb) or a 64-char hex hash to verify.', 'invalid_input');
	}

	const envelope = await readEnvelope(glbSha256);
	const verdict = decideVerdict(glbSha256, envelope);

	// Confirm the anchor on-chain when the record carries one (best-effort — a down
	// RPC never turns a verified asset into an error).
	let anchor = null;
	if (envelope?.anchor?.signature) {
		const onChain = await confirmAnchor(envelope.anchor.signature, envelope.anchor.cluster);
		anchor = {
			tx: envelope.anchor.signature,
			cluster: envelope.anchor.cluster || 'devnet',
			explorerUrl: explorerTxUrl(envelope.anchor.signature, envelope.anchor.cluster || 'devnet'),
			confirmed: onChain === true,
			...(onChain === null ? { confirmationUnavailable: true } : {}),
		};
	}

	const badge = verdict.status === 'verified' ? 'Verified · three.ws' : verdict.status === 'tampered' ? 'Tampered' : 'Unverified';
	return {
		content: [{ type: 'text', text: `${badge} — ${verdict.reason}.` }],
		structuredContent: {
			status: verdict.status,
			reason: verdict.reason,
			badge,
			glbSha256,
			credentialVersion: verdict.version || null,
			credential: publicCredential(envelope?.credential),
			issuer: envelope?.issuer || null,
			anchor,
		},
	};
}

async function handleAnchor(args) {
	const glbUrl = typeof args.glb_url === 'string' ? args.glb_url.trim() : '';
	if (!/^https:\/\//i.test(glbUrl)) return toolError('Provide an https URL to the .glb to credential.', 'invalid_input');

	let glbSha256;
	let glbBytes;
	try {
		({ buf: glbBytes, glbSha256 } = await fetchGlbBytes(glbUrl));
	} catch (err) {
		return toolError(err.message || 'could not read the model to credential it', 'fetch_failed');
	}

	const cluster = args.network === 'mainnet' ? 'mainnet' : 'devnet';
	const credential = buildCredential({
		glbSha256,
		simReadiness: await signableGrade(glbBytes, glbSha256, glbUrl),
		createdAt: new Date().toISOString(),
		assetId: args.asset_id,
		creator: args.creator,
		prompt: args.prompt,
		model: args.model,
		provider: args.provider,
		lineage: Array.isArray(args.lineage) ? args.lineage : undefined,
	});

	// Sign with the issuer key. Absent key → a clean, honest error (no fake credential).
	let signed;
	try {
		const { decodeAttesterSecret } = await import('../../_lib/attest-event.js');
		const secret = decodeAttesterSecret(process.env.ATTEST_AGENT_SECRET_KEY || '');
		if (!secret) throw new Error('issuer key missing');
		signed = signCredential(credential, secret);
	} catch {
		return toolError('The provenance issuer key is not configured on this deployment, so this asset cannot be credentialed here.', 'issuer_key_missing');
	}

	const credHash = credentialHash(credential);

	// Anchor the hash on-chain (real Solana write). A missing key / unfunded issuer
	// surfaces as a coded error — never a fabricated transaction.
	let anchorResult;
	try {
		anchorResult = await anchorCredentialHash({ credentialHash: credHash, glbSha256, cluster });
	} catch (err) {
		return toolError(err.message || 'the on-chain anchor could not be written', err.code || 'anchor_failed');
	}

	// Store the full signed, anchored credential in R2 addressed by the GLB hash so
	// verify_provenance can find it for anyone.
	const envelope = {
		credential,
		signature: signed.signature,
		issuer: signed.issuer,
		credentialHash: credHash,
		anchor: { signature: anchorResult.signature, cluster: anchorResult.cluster },
	};
	try {
		await putObject({
			key: provenanceKey(glbSha256),
			body: Buffer.from(JSON.stringify(envelope), 'utf8'),
			contentType: 'application/json',
		});
	} catch (err) {
		return toolError('The credential was signed and anchored but could not be stored for public verification. Please retry.', 'store_failed');
	}

	return {
		content: [
			{
				type: 'text',
				text: `Credentialed and anchored on Solana ${anchorResult.cluster}. Verify anytime with verify_provenance. Anchor: ${explorerTxUrl(anchorResult.signature, anchorResult.cluster)}`,
			},
		],
		structuredContent: {
			status: 'anchored',
			glbSha256,
			credentialHash: credHash,
			issuer: signed.issuer,
			anchor: {
				tx: anchorResult.signature,
				cluster: anchorResult.cluster,
				explorerUrl: explorerTxUrl(anchorResult.signature, anchorResult.cluster),
			},
		},
	};
}

export const toolDefs = [
	{
		name: 'verify_provenance',
		title: 'Verify a 3D model authenticity (content credential)',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		description:
			'Verify whether a 3D model (GLB) carries a genuine three.ws content credential and was not tampered with. ' +
			'Recomputes the model’s content hash, checks the signed credential and its on-chain anchor, and returns ' +
			'verified, tampered, or unknown — with who created it, from what prompt, by which model, and when. Free and ' +
			'public: no account, no payment. Pass glb_url (an https .glb) or a known content hash.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of the .glb to verify.' },
				hash: { type: 'string', description: 'A known 64-char hex sha256 of the GLB (alternative to glb_url).' },
			},
		},
		handler: (args) => handleVerify(args),
	},
	{
		name: 'anchor_provenance',
		title: 'Anchor a signed content credential for a 3D model',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		description:
			'Issue a signed content credential for a generated 3D model (GLB) and anchor its hash on Solana, so anyone ' +
			'can later verify authenticity and tampering for free with verify_provenance. Records creator, prompt, ' +
			'model/provider, lineage, timestamp, and the GLB content hash. Also signs the asset\u2019s simulation-readiness ' +
			'grade (verdict, volume, real-world size, inertia tensor) when it can be computed, so the physics claim is ' +
			'as forge-proof as the authorship claim. Real signature, real on-chain anchor.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['glb_url'],
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of the .glb to credential.' },
				creator: { type: 'string', maxLength: 200, description: 'Creator identity (account or wallet) to record.' },
				prompt: { type: 'string', maxLength: 1000, description: 'The generating prompt to record.' },
				model: { type: 'string', maxLength: 120, description: 'The generation model (e.g. "TRELLIS").' },
				provider: { type: 'string', maxLength: 120, description: 'The generation provider (e.g. "nvidia").' },
				asset_id: { type: 'string', maxLength: 200, description: 'Optional platform asset id.' },
				lineage: { type: 'array', items: { type: 'string' }, description: 'Optional parent lineage (content hashes or asset ids).' },
				network: { type: 'string', enum: ['devnet', 'mainnet'], description: 'Anchor cluster (default devnet).' },
			},
		},
		// Paid — priced in api/_mcp3d/pricing.js (TOOL_PRICING.anchor_provenance). A
		// three.ws principal runs it operator-funded; an x402 caller pays per anchor.
		handler: (args) => handleAnchor(args),
	},
];
