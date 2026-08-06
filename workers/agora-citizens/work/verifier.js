// Verifier (capability bit 6) — the trust loop: a citizen that re-derives another
// citizen's proof. It re-downloads the target's deliverable, recomputes sha256,
// compares it to the proofHash recorded on-chain, and produces a real attestation
// (vouch). The attestation is itself a canonical, hashable artifact stored as the
// verifier's own deliverable, so the vouch carries its own proof. Agents checking
// agents' work.
//
// Same `run<Profession>` contract as work/fetcher.js, plus a `vouch` payload the
// engine projects as a `vouched` activity referencing the verified task. The
// engine supplies `job.target = { deliverableUrl, proofHash, taskPda, citizenId,
// profession }` — the completed work this verifier was asked to check.

import { buildWorkResult, storeDeliverable, httpBytes, canonicalJsonBytes, sha256Hex } from './_skills.js';

export async function runVerifier({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const target = job?.target || {};
	const url = target.deliverableUrl;
	const claimed = String(target.proofHash || '')
		.toLowerCase()
		.replace(/^0x/, '');

	if (!url) throw new Error('verifier: target has no deliverableUrl to re-derive');
	if (!/^[0-9a-f]{64}$/.test(claimed)) {
		throw new Error('verifier: target has no valid 32-byte (64-hex) proofHash to compare');
	}

	log?.(`verifier: re-downloading ${url}`);
	const { bytes } = await httpBytes(apiBase, url);
	const recomputed = sha256Hex(bytes);
	const match = recomputed === claimed;
	log?.(`verifier: ${match ? 'PASS' : 'FAIL'} (recomputed ${recomputed.slice(0, 12)}… vs claimed ${claimed.slice(0, 12)}…)`);

	const attestation = {
		kind: 'agora.attestation.v1',
		verifier: citizen?.agentIdHex || citizen?.id || null,
		target: {
			citizenId: target.citizenId || null,
			taskPda: target.taskPda || null,
			profession: target.profession || null,
			deliverableUrl: url,
		},
		claimedProofHash: claimed,
		recomputedProofHash: recomputed,
		bytes: bytes.length,
		verdict: match ? 'pass' : 'fail',
	};
	const attBytes = canonicalJsonBytes(attestation);
	const deliverable = await storeDeliverable({
		profession: 'verifier',
		ext: 'json',
		contentType: 'application/json',
		bytes: attBytes,
		optional: true,
	});

	const out = buildWorkResult({
		profession: 'verifier',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: attBytes,
		// A mismatch prints both hashes IN FULL. Truncated, the two read as
		// identical whenever they diverge past the prefix (a single flipped digit
		// renders as "ca515557e6a2… ≠ ca515557e6a2…"), which makes the one message
		// that has to be unambiguous look like a match. The match case keeps the
		// short form: there is only one value and it is stated in the proof field.
		summary: match
			? `Verified ${target.profession || 'deliverable'}: sha256 matches the on-chain proof (${recomputed.slice(0, 12)}…)`
			: `MISMATCH: recomputed ${recomputed} != on-chain ${claimed}`,
		meta: { stored: deliverable.stored },
	});

	// The engine projects this as a `vouched` activity referencing the verified
	// task (counterparty + proof comparison).
	out.vouch = {
		match,
		verdict: match ? 'pass' : 'fail',
		recomputed,
		claimed,
		targetCitizenId: target.citizenId || null,
		targetTaskPda: target.taskPda || null,
		targetProfession: target.profession || null,
		targetDeliverableUrl: url,
		attestation,
	};
	return out;
}

export default runVerifier;
