// Scribe (capability bit 2) — research / summarize / write via the LLM router.
// Produces a real text deliverable and proves it with sha256(text). Backed by
// @three-ws/brain over /api/brain/chat, on a free lane that needs no key. Same
// `run<Profession>` contract as work/fetcher.js.

import { buildWorkResult, storeDeliverable, brainChat, jobPrompt } from './_skills.js';

const DEFAULT_SYSTEM =
	'You are a Scribe in the three.ws Agora — a precise, professional writer. ' +
	'Deliver a complete, well-structured response to the task. No preamble, no meta-commentary, ' +
	'no apologies. Write the artifact itself.';

const DEFAULT_BRIEFS = [
	'Write a tight 150-word explainer on why verifiable proof-of-work matters for an agent economy.',
	'Summarize, in 5 crisp bullet points, what makes a 3D asset "rig-ready".',
	'Draft a short, friendly onboarding note for a new citizen joining a digital city.',
	'Explain content-addressed storage (sha256 deliverables) to a non-technical reader in one paragraph.',
];

function briefFor(citizen, job) {
	const explicit = jobPrompt(job);
	if (explicit) return explicit;
	const seed = String(citizen?.agentIdHex || job?.taskPda || '0');
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return DEFAULT_BRIEFS[h % DEFAULT_BRIEFS.length];
}

export async function runScribe({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const prompt = briefFor(citizen, job);
	// A citizen calls /api/brain/chat anonymously, so the lane must be one of the
	// key-free ANON_BRAIN_PROVIDERS. Not the `gpt-oss-120b` platform default: its
	// only route is an OpenRouter free endpoint that measured ~22s to first token
	// against the router's 25s per-attempt budget, so it returns a truncated brief
	// or nothing at all. Nemotron Nano's primary serves directly (~10s, complete
	// artifact), which is what a deliverable needs. Overridable per job.
	const provider = job?.provider || 'nvidia-nemotron-nano';

	log?.(`scribe: writing via ${provider} for "${prompt.slice(0, 80)}"`);
	const { text, meta } = await brainChat(apiBase, {
		provider,
		system: job?.system || DEFAULT_SYSTEM,
		messages: [{ role: 'user', content: prompt }],
		maxTokens: job?.maxTokens || 1200,
	});
	if (!text) throw new Error('scribe: brain returned empty text');

	// The deliverable bytes ARE the proof preimage.
	const bytes = Buffer.from(text, 'utf8');
	const deliverable = await storeDeliverable({
		profession: 'scribe',
		ext: 'md',
		contentType: 'text/markdown; charset=utf-8',
		bytes,
		optional: true,
	});

	return buildWorkResult({
		profession: 'scribe',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: bytes,
		summary: `Wrote a ${text.length.toLocaleString()}-char brief via ${meta?.label || provider}`,
		meta: { prompt, model: meta?.label || meta?.provider || provider, chars: text.length, stored: deliverable.stored },
	});
}

export default runScribe;
