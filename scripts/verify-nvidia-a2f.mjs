#!/usr/bin/env node
// Live verification for the free NVIDIA Audio2Face-3D lane (face MOTION).
//
//   node scripts/verify-nvidia-a2f.mjs --list   # enumerate NVCF functions and
//                                                # print the A2F candidates +
//                                                # their ids (needs NVIDIA_API_KEY)
//   node scripts/verify-nvidia-a2f.mjs           # full round-trip check (needs
//                                                # NVIDIA_API_KEY; NVIDIA_A2F_FUNCTION_ID
//                                                # optional, defaults to
//                                                # A2F_DEFAULT_FUNCTION_ID)
//
// The full check is a self-contained round-trip across the TTS + A2F lanes: it
// synthesizes a known sentence through Magpie TTS (api/_lib/tts-nvidia.js) to get
// real spoken audio, drives that exact audio through Audio2Face-3D
// (api/_lib/a2f-nvidia.js), and asserts the returned blendshape track is real
// facial motion — frames arrive, the ARKit names are present, and the JawOpen
// channel actually opens and closes across the clip (not a frozen face). No
// fixture files are needed and nothing is written to disk.

import { config as dotenv } from 'dotenv';

dotenv({ path: new URL('../.env.local', import.meta.url) });
// .env.local can carry prod flags; clear them so nothing fails closed locally.
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

const listOnly = process.argv.includes('--list');

if (!process.env.NVIDIA_API_KEY) {
	console.error('[a2f] NVIDIA_API_KEY missing from environment/.env.local — cannot verify');
	process.exit(1);
}

const NVCF_FUNCTIONS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/functions';
// NVIDIA publishes the hosted Audio2Face NIM as `ai-a2x-service`, so a hint list
// without `a2x` matches nothing and the run reports no candidates at all.
const A2F_NAME_HINT = /(audio2face|a2f|a2x|audio-2-face|face)/i;

// Printed as the fallback when no function name matches, so the message can
// never drift from the id the lane actually defaults to.
const { A2F_DEFAULT_FUNCTION_ID } = await import('../api/_lib/a2f-nvidia.js');

async function listFunctions() {
	const res = await fetch(NVCF_FUNCTIONS_URL, {
		headers: { authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, accept: 'application/json' },
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`NVCF function list returned ${res.status}: ${detail.slice(0, 300)}`);
	}
	const data = await res.json();
	const functions = Array.isArray(data?.functions) ? data.functions : [];
	const a2f = functions.filter((f) => A2F_NAME_HINT.test(`${f?.name || ''} ${f?.id || ''}`));
	console.log(`[a2f] ${functions.length} NVCF functions visible; ${a2f.length} look like Audio2Face:\n`);
	for (const f of a2f) {
		console.log(`  ${f.id}  ${f.status || ''}  ${f.name || ''}${f.versionId ? `  (v ${f.versionId})` : ''}`);
	}
	if (!a2f.length) {
		console.log(`  (none matched by name; the default stays ${A2F_DEFAULT_FUNCTION_ID}, NVIDIA's hosted ai-a2x-service)`);
	} else {
		console.log('\n[a2f] set NVIDIA_A2F_FUNCTION_ID to one of the ids above to pin a model, then re-run without --list.');
	}
}

async function roundTrip() {
	const { synthesizeNvidiaTts } = await import('../api/_lib/tts-nvidia.js');
	const { animateNvidiaA2F, resolveA2fFunctionId } = await import('../api/_lib/a2f-nvidia.js');

	const sentence = 'Hello! I am a three dot w s avatar, and my face moves with my voice.';
	console.log(`[a2f] using function-id ${resolveA2fFunctionId()}`);
	console.log(`[a2f] synthesizing reference audio via Magpie TTS: "${sentence}"`);
	const t0 = Date.now();
	const tts = await synthesizeNvidiaTts({ text: sentence, voice: 'nova', format: 'wav' });
	if (!tts.audio?.length || tts.audio.toString('ascii', 0, 4) !== 'RIFF') {
		throw new Error('TTS did not return a WAV — cannot build the A2F reference clip');
	}
	console.log(`[a2f]   ${tts.audio.length} bytes of WAV in ${Date.now() - t0} ms`);

	console.log('[a2f] driving Audio2Face-3D with that exact audio…');
	const t1 = Date.now();
	const anim = await animateNvidiaA2F({ wav: tts.audio });
	console.log(
		`[a2f]   ${anim.frameCount} frames @ ~${anim.fps} fps over ${anim.durationSec.toFixed(2)}s ` +
			`(${anim.blendShapeNames.length} blendshapes) in ${Date.now() - t1} ms`,
	);

	if (!anim.frameCount) throw new Error('no animation frames returned');

	// The track must carry the ARKit names and JawOpen must actually move — a
	// frozen JawOpen would mean the lane returned a flat/neutral track.
	const jawIdx = anim.blendShapeNames.findIndex((n) => /jawopen/i.test(n));
	if (jawIdx < 0) throw new Error(`no JawOpen channel among blendshapes: ${anim.blendShapeNames.slice(0, 8).join(', ')}…`);
	let min = Infinity;
	let max = -Infinity;
	for (const f of anim.frames) {
		const v = f.w[jawIdx] ?? 0;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	console.log(`[a2f]   JawOpen range across clip: ${min.toFixed(3)} … ${max.toFixed(3)}`);
	if (max < 0.05) {
		throw new Error(`JawOpen never opened (max ${max.toFixed(3)}) — the face is not moving with the audio`);
	}

	console.log(`[a2f] PASS — real lip-synced facial animation across the TTS + A2F lanes (JawOpen swing ${(max - min).toFixed(3)}).`);
}

try {
	if (listOnly) await listFunctions();
	else await roundTrip();
} catch (e) {
	console.error(`[a2f] FAIL — ${e?.message || e}`);
	process.exit(1);
}
