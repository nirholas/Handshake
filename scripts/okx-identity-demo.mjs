#!/usr/bin/env node
// Run the Agent Identity Studio pipeline for the demo identities in
// data/agent-identities.json, REAL runs of the production pipeline (the same
// module the /api/okx/3d/identity-studio endpoint executes), driven locally:
//
//   node --env-file=.env.local scripts/okx-identity-demo.mjs [slug] [--force]
//
// Needs the S3_* (R2) vars from .env.local; generation/rig/render all run on
// the deployed three.ws surfaces. Results (render URLs, GLB URLs, rig
// verification) are written back into data/agent-identities.json, which powers
// the /agent-identities showcase page. Rigging is VERIFIED programmatically:
// the rigged GLB must contain a skin with joints and skinned primitives with
// JOINTS_0 + WEIGHTS_0 attributes, or the run is recorded as failed.

process.env.JWT_SECRET ||= 'okx-identity-local-demo'; // job tokens are local-only here

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_PATH = resolve(import.meta.dirname, '../data/agent-identities.json');
// Overridable so a batch run can outlast the rig lane's rate-limit backoff
// windows (the paid mcp3d:generate bucket is 30/h per IP; a single 429 parks the
// job for up to 5 min). Defaults suit a single, unthrottled run.
const POLL_MS = Number(process.env.IDENTITY_DEMO_POLL_MS) || 5000;
const TIMEOUT_MS = Number(process.env.IDENTITY_DEMO_TIMEOUT_MS) || 15 * 60 * 1000;

const { createIdentityJob, advanceIdentityJob, describeIdentityJob } = await import(
	'../api/_okx3d/identity.js'
);

// Parse a GLB's JSON chunk and assert real rigging: bones AND skin weights.
async function verifyRiggedGlb(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) throw new Error(`GLB fetch ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
	const jsonLen = buf.readUInt32LE(12);
	if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
	const doc = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
	const joints = (doc.skins || []).reduce((n, s) => n + (s.joints?.length || 0), 0);
	const skinnedPrims = (doc.meshes || [])
		.flatMap((m) => m.primitives || [])
		.filter((p) => p.attributes && 'JOINTS_0' in p.attributes && 'WEIGHTS_0' in p.attributes);
	if (!doc.skins?.length) throw new Error('no skins in GLB');
	if (joints < 10) throw new Error(`only ${joints} joints`);
	if (!skinnedPrims.length) throw new Error('no primitives carry JOINTS_0/WEIGHTS_0');
	return {
		bytes: buf.length,
		skins: doc.skins.length,
		joints,
		skinnedPrimitives: skinnedPrims.length,
		generator: doc.asset?.generator || null,
	};
}

async function runIdentity(entry) {
	console.log(`\n━━ ${entry.agentName} (${entry.kind}) ━━`);
	const started = Date.now();
	const { jobId, state: initial } = await createIdentityJob({
		agentName: entry.agentName,
		brief: entry.brief,
		styleHints: entry.styleHints,
	});
	console.log(`job ${jobId.slice(0, 24)}… | prompt: ${initial.prompt.effective}`);

	let state = initial;
	while (Date.now() - started < TIMEOUT_MS) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		state = await advanceIdentityJob(state.id);
		const desc = describeIdentityJob(state);
		process.stdout.write(
			`\r  ${desc.stage} (${desc.progress.renders_done}/${desc.progress.renders_total} renders)   `,
		);
		if (desc.status === 'done' || desc.status === 'failed') break;
	}
	console.log('');
	const desc = describeIdentityJob(state);
	if (desc.status !== 'done') {
		throw new Error(`run ended ${desc.status}: ${JSON.stringify(desc.last_error || 'timeout')}`);
	}
	const rig = await verifyRiggedGlb(desc.deliverables.rigged_glb_url);
	console.log(
		`  ✓ done in ${Math.round((Date.now() - started) / 1000)}s, rig verified: ` +
			`${rig.joints} joints, ${rig.skinnedPrimitives} skinned primitives, ${Math.round(rig.bytes / 1024)}KB`,
	);
	return {
		jobIdPrefix: jobId.slice(0, 16),
		prompt: state.prompt.effective,
		directed: Boolean(state.prompt.directed),
		backend: state.gen.backend,
		pfp: desc.deliverables.pfp,
		fullBody: desc.deliverables.full_body,
		riggedGlbUrl: desc.deliverables.rigged_glb_url,
		meshGlbUrl: desc.deliverables.mesh_glb_url,
		viewerUrl: desc.deliverables.viewer_url,
		poseStudioUrl: desc.deliverables.pose_studio_url,
		rigVerification: rig,
		durationSeconds: Math.round((Date.now() - started) / 1000),
		completedAt: new Date().toISOString(),
	};
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.find((a) => !a.startsWith('--'));

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
let failures = 0;
for (const entry of data.identities) {
	if (only && entry.slug !== only) continue;
	if (entry.result && !force) {
		console.log(`skip ${entry.slug} (already has a result; --force to rerun)`);
		continue;
	}
	try {
		entry.result = await runIdentity(entry);
		writeFileSync(DATA_PATH, JSON.stringify(data, null, '\t') + '\n');
	} catch (err) {
		failures += 1;
		console.error(`  ✗ ${entry.slug} failed: ${err.message}`);
	}
}
console.log(`\n${data.identities.filter((e) => e.result).length}/${data.identities.length} identities complete`);
process.exit(failures ? 1 : 0);
