// scripts/lib/veo.mjs
//
// Minimal Vertex AI Veo client: submit a text-to-video job, poll it to
// completion, and hand back the GCS URIs of the rendered clips.
//
// Veo is a long-running operation API: `:predictLongRunning` returns an
// operation name immediately, and the result is only readable by POSTing that
// name back to `:fetchPredictOperation`. There is no GET form and no global
// operations collection, which is why this file exists rather than a raw curl.
//
// Auth comes from the ambient gcloud user credential (`gcloud auth
// print-access-token`). In this workspace that credential dies on a short
// Workspace reauth policy, so every call surfaces a 401 as a clear
// "reauthenticate" error instead of a generic HTTP failure.
//
// Usage:
//   import { generateVideos } from './lib/veo.mjs';
//   const clips = await generateVideos({
//     prompts: ['a slow push through a dark server hall'],
//     storageUri: 'gs://three-ws-veo/run-1/',
//   });
//   // -> [{ prompt, gcsUri }]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECT = process.env.GCP_PROJECT || 'aerial-vehicle-466722-p5';
const LOCATION = process.env.GCP_REGION || 'us-central1';
const DEFAULT_MODEL = process.env.VEO_MODEL || 'veo-3.0-generate-001';

const BASE = (model) =>
	`https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}` +
	`/locations/${LOCATION}/publishers/google/models/${model}`;

// Veo renders any text in frame as garbled pseudo-glyphs, so every prompt is
// paired with this. Real figures are composited afterwards as vector-crisp
// typography — never generated.
export const NO_TEXT_NEGATIVE =
	'text, letters, numbers, words, captions, subtitles, watermark, logo, ' +
	'signage, user interface, charts, graphs, people, faces, hands';

async function accessToken() {
	try {
		const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token']);
		return stdout.trim();
	} catch (err) {
		throw new Error(
			'Could not mint a GCP access token. The workspace credential has expired ' +
				'(Workspace reauth policy) — run `gcloud auth login`, then retry.\n' +
				String(err.stderr || err.message || err),
		);
	}
}

async function callVertex(url, body, token) {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (res.status === 401 || res.status === 403) {
		throw new Error(
			`Vertex AI rejected the credential (${res.status}). Run \`gcloud auth login\` and retry.\n${text}`,
		);
	}
	if (!res.ok) {
		throw new Error(`Vertex AI ${res.status} on ${url}\n${text}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Vertex AI returned non-JSON:\n${text.slice(0, 800)}`);
	}
}

// Submit one prompt. Returns the operation name to poll.
export async function submit({
	prompt,
	storageUri,
	model = DEFAULT_MODEL,
	durationSeconds = 8,
	aspectRatio = '16:9',
	resolution = '1080p',
	generateAudio = false,
	negativePrompt = NO_TEXT_NEGATIVE,
	token,
}) {
	const parameters = {
		sampleCount: 1,
		aspectRatio,
		durationSeconds,
		resolution,
		generateAudio,
		negativePrompt,
	};
	if (storageUri) parameters.storageUri = storageUri;

	const op = await callVertex(
		`${BASE(model)}:predictLongRunning`,
		{ instances: [{ prompt }], parameters },
		token,
	);
	if (!op.name) throw new Error(`Veo did not return an operation name: ${JSON.stringify(op)}`);
	return op.name;
}

// Poll one operation until it reports done. Veo jobs typically land in 1-3
// minutes; the ceiling here is deliberately generous because a cold model can
// take longer, and a half-rendered batch is worse than a slow one.
export async function poll({
	operationName,
	model = DEFAULT_MODEL,
	token,
	intervalMs = 10_000,
	timeoutMs = 15 * 60_000,
	onTick = () => {},
}) {
	const deadline = Date.now() + timeoutMs;
	let ticks = 0;
	for (;;) {
		const res = await callVertex(
			`${BASE(model)}:fetchPredictOperation`,
			{ operationName },
			token,
		);
		if (res.done) {
			if (res.error) {
				throw new Error(`Veo job failed: ${JSON.stringify(res.error)}`);
			}
			return res.response ?? {};
		}
		if (Date.now() > deadline) {
			throw new Error(`Veo job timed out after ${Math.round(timeoutMs / 1000)}s: ${operationName}`);
		}
		onTick(++ticks);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

// Pull every GCS URI out of a finished Veo response. The field name has moved
// between Veo revisions (`videos[].gcsUri` vs `generatedSamples[].video.uri`),
// so both shapes are handled rather than assuming one.
export function extractUris(response) {
	const out = [];
	for (const v of response?.videos ?? []) {
		if (v?.gcsUri) out.push(v.gcsUri);
	}
	for (const s of response?.generatedSamples ?? []) {
		const uri = s?.video?.uri ?? s?.video?.gcsUri;
		if (uri) out.push(uri);
	}
	return out;
}

// Submit every prompt up front, then poll them together. Veo bills and queues
// per job, so fanning out is both faster and no more expensive than serial.
export async function generateVideos({
	prompts,
	storageUri,
	model = DEFAULT_MODEL,
	log = console.log,
	...opts
}) {
	const token = await accessToken();

	const ops = [];
	for (const [i, prompt] of prompts.entries()) {
		// Each clip gets its own prefix so a rerun never collides with a prior take.
		const uri = storageUri ? `${storageUri.replace(/\/$/, '')}/clip-${i + 1}/` : undefined;
		const name = await submit({ prompt, storageUri: uri, model, token, ...opts });
		log(`  submitted clip ${i + 1}/${prompts.length}`);
		ops.push({ prompt, name, index: i });
	}

	const results = await Promise.all(
		ops.map(async (op) => {
			const response = await poll({
				operationName: op.name,
				model,
				token,
				onTick: (t) => {
					if (t % 3 === 0) log(`  clip ${op.index + 1} still rendering (${t * 10}s)`);
				},
			});
			const uris = extractUris(response);
			if (!uris.length) {
				// A finished job with no video almost always means the prompt tripped a
				// safety filter; surface the raw response so the cause is visible.
				throw new Error(
					`Clip ${op.index + 1} finished with no video. Response: ${JSON.stringify(response).slice(0, 600)}`,
				);
			}
			log(`  clip ${op.index + 1} done -> ${uris[0]}`);
			return { prompt: op.prompt, index: op.index, gcsUri: uris[0] };
		}),
	);

	return results.sort((a, b) => a.index - b.index);
}
