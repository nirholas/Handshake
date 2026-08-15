// Free NVIDIA NIM facial-animation lane — Audio2Face-3D over NVCF gRPC.
//
// This is the face-MOTION sibling of api/_lib/tts-nvidia.js (voice-OUT) and
// api/_lib/asr-nvidia.js (voice-IN). It closes the "talking head" loop: Magpie
// TTS gives every avatar a voice; Audio2Face-3D turns that exact spoken audio
// into a per-frame ARKit blendshape track so the avatar's mouth and face move
// in sync with the words — two named NVIDIA models driving one face.
//
// Like Magpie and Riva, A2F-3D is hosted as an NVCF gRPC function on
// grpc.nvcf.nvidia.com:443, selected by a `function-id` metadata entry with the
// nvapi key as a bearer `authorization` entry. The wire contract is NVIDIA's
// ACE `nvidia_ace.services.a2f_controller.v1.A2FControllerService` — a
// BIDIRECTIONAL streaming `ProcessAudioStream`: the client streams an audio
// header + PCM chunks + an end-of-audio marker; the server streams back an
// animation header (the ordered blendshape names) followed by animation-data
// frames (per-frame blendshape weights with a time code), at 30 fps. The proto
// definitions are vendored under ./a2f-protos/ and loaded from a generated JSON
// descriptor (descriptor.js — kept separate from the Riva descriptors) so no
// .proto file needs to exist on the serverless filesystem (api/ routes are
// esbuild-bundled in place — scripts/bundle-api.mjs).
//
// ── Audio contract ───────────────────────────────────────────────────────────
// A2F-3D is trained on 16 kHz mono 16-bit PCM. Magpie emits 44.1 kHz, so this
// module decodes the WAV, downmixes to mono, and resamples to 16 kHz before
// streaming. The returned blendshape time codes are in SECONDS relative to the
// clip start, independent of the audio sample rate, so the browser plays the
// ORIGINAL Magpie audio and samples the track by the audio element's currentTime
// — lips track the real voice, not a resampled copy.
//
// ── Function id ──────────────────────────────────────────────────────────────
// Unlike Riva ASR (pure config), A2F-3D ships a stable published NVCF function
// id (the "James" model from NVIDIA's official sample — tongue blendshapes
// included), so the lane works out of the box with only NVIDIA_API_KEY set. A
// deployment can pin a different model (Mark/Claire) via NVIDIA_A2F_FUNCTION_ID;
// discover the live ids for your account with
//   node scripts/verify-nvidia-a2f.mjs --list
//
// Error codes match the established provider contract (tts-nvidia.js / asr-nvidia.js):
//   invalid_key / rate_limited / invalid_argument / timeout /
//   provider_unreachable / provider_error / not_configured.

import { env } from './env.js';
import { parseWav } from './asr-nvidia.js';
import a2fDescriptor from './a2f-protos/descriptor.js';

export const NVIDIA_A2F_HOST = 'grpc.nvcf.nvidia.com:443';

// NVCF function id for the hosted Audio2Face NIM (`ai-a2x-service`), the
// published catalog function NVIDIA serves Audio2Face-3D from. It returns the
// full ARKit-52 set plus tongue blendshapes at 30 fps.
//
// The earlier default here was the "James" id from NVIDIA's sample client
// (9327c39f-a361-4e02-bd72-e11b4c9b7b5e). That id stopped resolving: every call
// came back `NOT_FOUND: Function '9327c39f…': Not found for account`, so the
// whole lipsync lane 502'd. Re-verify a replacement the same way this one was
// picked, then update this constant AND the deployment's env var:
//   node scripts/verify-nvidia-a2f.mjs --list   # ids visible to NVIDIA_API_KEY
//   NVIDIA_A2F_FUNCTION_ID=<id> node scripts/verify-nvidia-a2f.mjs
// Per-deployment override stays NVIDIA_A2F_FUNCTION_ID.
export const A2F_DEFAULT_FUNCTION_ID = '462f7853-60e8-474a-9728-7b598e58472c';

// A2F-3D's native inference rate and the rate the audio is resampled to before
// streaming. The model runs 30 inferences per second of audio (→ 30 fps output).
const A2F_SAMPLE_RATE_HZ = 16000;
const A2F_FPS = 30;
const DEFAULT_TIMEOUT_MS = 30_000;
// Bound the clip the lambda will buffer + stream. 60 s of 16 kHz mono s16 is
// ~1.9 MB of PCM and ~1800 frames — generous for avatar speech, small enough
// that one request can't pin a serverless instance.
const MAX_AUDIO_SECONDS = 60;

export function nvidiaA2fConfigured() {
	return Boolean(env.NVIDIA_API_KEY);
}

export function resolveA2fFunctionId(explicit) {
	return explicit || env.NVIDIA_A2F_FUNCTION_ID || A2F_DEFAULT_FUNCTION_ID;
}

// Downmix interleaved s16 PCM to mono. Returns the input untouched when already
// mono. Averaging avoids the +6 dB clipping a naive sum would cause.
function toMonoInt16(pcm, channels) {
	if (channels <= 1) return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
	const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
	const frames = Math.floor(view.length / channels);
	const out = new Int16Array(frames);
	for (let i = 0; i < frames; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += view[i * channels + c];
		out[i] = Math.round(sum / channels);
	}
	return out;
}

// Linear-interpolation resampler for mono s16. Speech feature extraction does
// not need a windowed-sinc kernel; linear keeps formant cues intact at a
// fraction of the cost and introduces no audible artifacts the model cares about.
function resampleInt16(mono, fromRate, toRate) {
	if (fromRate === toRate) return mono;
	const ratio = toRate / fromRate;
	const outLen = Math.max(1, Math.floor(mono.length * ratio));
	const out = new Int16Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const srcPos = i / ratio;
		const i0 = Math.floor(srcPos);
		const i1 = Math.min(i0 + 1, mono.length - 1);
		const frac = srcPos - i0;
		out[i] = Math.round(mono[i0] * (1 - frac) + mono[i1] * frac);
	}
	return out;
}

// gRPC status code → platform error code (numeric codes so the mapping does not
// depend on the grpc-js import being resolved). Mirrors tts-nvidia.js / asr-nvidia.js.
function normalizeGrpcError(err) {
	const code = typeof err?.code === 'number' ? err.code : null;
	const map = {
		3: 'invalid_argument', // bad audio header / encoding
		4: 'timeout', // DEADLINE_EXCEEDED
		7: 'invalid_key', // PERMISSION_DENIED
		8: 'rate_limited', // RESOURCE_EXHAUSTED (credit-metered free tier)
		14: 'provider_unreachable', // UNAVAILABLE
		16: 'invalid_key', // UNAUTHENTICATED
	};
	const normalized = new Error(
		`NVIDIA Audio2Face-3D failed${code !== null ? ` (gRPC ${code})` : ''}: ${err?.details || err?.message || 'unknown error'}`,
	);
	normalized.code = (code !== null && map[code]) || 'provider_error';
	normalized.grpcCode = code;
	return normalized;
}

// One cached client per warm lambda (the TLS channel is keyless — auth rides in
// per-call metadata). @grpc/grpc-js is imported lazily so non-A2F importers do
// not pay for the dependency at cold start. See tts-nvidia.js for the NVCF
// warm-channel auth caveat the verify script works around.
let clientPromise = null;
async function getClient() {
	if (!clientPromise) {
		clientPromise = (async () => {
			const [{ default: grpc }, { default: protoLoader }] = await Promise.all([
				import('@grpc/grpc-js'),
				import('@grpc/proto-loader'),
			]);
			const definition = protoLoader.fromJSON(a2fDescriptor, {
				keepCase: true,
				longs: Number,
				enums: String,
				defaults: true,
				oneofs: true,
			});
			const pkg = grpc.loadPackageDefinition(definition);
			const Service = pkg.nvidia_ace.services.a2f_controller.v1.A2FControllerService;
			return {
				grpc,
				client: new Service(NVIDIA_A2F_HOST, grpc.credentials.createSsl(), {
					// Animation streams come back as many small frames, but the echoed
					// audio + headers can be sizeable on long clips — lift both caps.
					'grpc.max_receive_message_length': 64 * 1024 * 1024,
					'grpc.max_send_message_length': 64 * 1024 * 1024,
				}),
			};
		})().catch((e) => {
			clientPromise = null; // a failed init must not poison the warm lambda
			throw e;
		});
	}
	return clientPromise;
}

// Generate a facial-animation track from spoken audio on the free NIM lane.
//
//   { wav?: Buffer, pcm?: Buffer, sampleRateHz?, channels?, functionId?,
//     faceParams?, blendshapeMultipliers?, timeoutMs?, apiKey? }
//     → { fps, blendShapeNames, frames: [{ t, w }], frameCount, durationSec,
//         sampleRateHz, model, functionId }
//
// Provide EITHER `wav` (a RIFF/WAVE buffer — the Magpie output is passed straight
// through; its header is parsed for rate + channels) OR raw `pcm` (header-less
// little-endian s16) with `sampleRateHz`. `frames[i].t` is the time code in
// seconds relative to the clip start; `frames[i].w` is the blendshape weights in
// the order of `blendShapeNames` (the names come from the model, ARKit naming).
//
// Throws Error with .code ∈ not_configured | invalid_key | rate_limited |
// invalid_argument | timeout | provider_unreachable | provider_error.
export async function animateNvidiaA2F({
	wav,
	pcm,
	sampleRateHz,
	channels = 1,
	functionId,
	faceParams,
	blendshapeMultipliers,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	apiKey,
} = {}) {
	const key = apiKey || env.NVIDIA_API_KEY;
	if (!key) {
		const err = new Error('NVIDIA_API_KEY not set');
		err.code = 'not_configured';
		throw err;
	}

	// ── Normalize the audio to 16 kHz mono s16 ────────────────────────────────
	let monoSrc;
	let srcRate;
	if (Buffer.isBuffer(wav) && wav.length) {
		const parsed = parseWav(wav);
		if (!parsed) {
			const err = new Error('audio is not a valid WAV (no RIFF/WAVE header)');
			err.code = 'invalid_argument';
			throw err;
		}
		monoSrc = toMonoInt16(parsed.pcm, parsed.channels);
		srcRate = parsed.sampleRateHz;
	} else if (Buffer.isBuffer(pcm) && pcm.length) {
		if (!sampleRateHz) {
			const err = new Error('sampleRateHz is required when passing raw pcm');
			err.code = 'invalid_argument';
			throw err;
		}
		monoSrc = toMonoInt16(pcm, channels);
		srcRate = sampleRateHz;
	} else {
		const err = new Error('no audio provided (expected wav or pcm)');
		err.code = 'invalid_argument';
		throw err;
	}

	if (monoSrc.length / srcRate > MAX_AUDIO_SECONDS) {
		const err = new Error(`audio exceeds ${MAX_AUDIO_SECONDS}s limit`);
		err.code = 'invalid_argument';
		throw err;
	}

	const mono16k = resampleInt16(monoSrc, srcRate, A2F_SAMPLE_RATE_HZ);
	// Int16Array → little-endian byte buffer for the proto `bytes` field.
	const audioBytes = Buffer.from(mono16k.buffer, mono16k.byteOffset, mono16k.byteLength);

	const fnId = resolveA2fFunctionId(functionId);
	const { grpc, client } = await getClient();
	const metadata = new grpc.Metadata();
	metadata.set('function-id', fnId);
	metadata.set('authorization', `Bearer ${key}`);

	const header = {
		audio_stream_header: {
			audio_header: {
				audio_format: 'AUDIO_FORMAT_PCM',
				channel_count: 1,
				samples_per_second: A2F_SAMPLE_RATE_HZ,
				bits_per_sample: 16,
			},
			// Clamp output weights to [0,1] so they map straight onto morph target
			// influences without the frontend having to renormalize. Optional
			// per-shape multipliers let a caller dial specific shapes up/down.
			blendshape_params: {
				enable_clamping_bs_weight: true,
				...(blendshapeMultipliers ? { bs_weight_multipliers: blendshapeMultipliers } : {}),
			},
			...(faceParams ? { face_params: { float_params: faceParams } } : {}),
		},
	};

	const result = await new Promise((resolveCall, rejectCall) => {
		let settled = false;
		const fail = (e) => {
			if (settled) return;
			settled = true;
			rejectCall(e instanceof Error && e.code ? e : normalizeGrpcError(e));
		};

		let call;
		try {
			call = client.processAudioStream(metadata, { deadline: new Date(Date.now() + timeoutMs) });
		} catch (e) {
			fail(e);
			return;
		}

		let blendShapeNames = [];
		const frames = [];

		call.on('data', (msg) => {
			if (msg.animation_data_stream_header) {
				const names = msg.animation_data_stream_header.skel_animation_header?.blend_shapes;
				if (Array.isArray(names) && names.length) blendShapeNames = names;
			} else if (msg.animation_data) {
				const weights = msg.animation_data.skel_animation?.blend_shape_weights;
				if (Array.isArray(weights)) {
					for (const frame of weights) {
						frames.push({
							t: Number(frame.time_code) || 0,
							w: Array.isArray(frame.values) ? frame.values.map((v) => clamp01(v)) : [],
						});
					}
				}
			} else if (msg.status && msg.status.code === 'ERROR') {
				// A2F can answer ERROR in-band (e.g. audio-limit) before closing OK.
				fail(Object.assign(new Error(`A2F status ERROR: ${msg.status.message || 'unknown'}`), {
					code: 'provider_error',
				}));
				try { call.cancel(); } catch {}
			}
		});

		call.on('error', fail);

		call.on('end', () => {
			if (settled) return;
			settled = true;
			if (!frames.length) {
				rejectCall(Object.assign(new Error('Audio2Face-3D returned no animation frames'), {
					code: 'provider_error',
				}));
				return;
			}
			// Time codes are strictly increasing; keep them sorted defensively in
			// case the server interleaves frames across animation-data messages.
			frames.sort((a, b) => a.t - b.t);
			resolveCall({ blendShapeNames, frames });
		});

		// Stream: header → audio (1 s chunks, matching NVIDIA's sample cadence) →
		// end-of-audio. Chunking keeps any single gRPC message small; the size is
		// not semantically meaningful to the model.
		try {
			call.write(header);
			const chunkSamples = A2F_SAMPLE_RATE_HZ; // 1 second
			for (let i = 0; i < mono16k.length; i += chunkSamples) {
				const slice = mono16k.subarray(i, Math.min(i + chunkSamples, mono16k.length));
				const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
				call.write({ audio_with_emotion: { audio_buffer: buf } });
			}
			call.write({ end_of_audio: {} });
			call.end();
		} catch (e) {
			fail(e);
		}
	});

	const durationSec = mono16k.length / A2F_SAMPLE_RATE_HZ;
	// Derive the real fps from the frame cadence when we have enough frames;
	// fall back to the documented 30 fps for a 1-frame clip.
	let fps = A2F_FPS;
	if (result.frames.length > 1) {
		const span = result.frames[result.frames.length - 1].t - result.frames[0].t;
		if (span > 0) fps = Math.round((result.frames.length - 1) / span);
	}

	return {
		fps,
		blendShapeNames: result.blendShapeNames,
		frames: result.frames,
		frameCount: result.frames.length,
		durationSec,
		sampleRateHz: A2F_SAMPLE_RATE_HZ,
		model: 'audio2face-3d',
		functionId: fnId,
	};
}

function clamp01(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

// Mirror just enough audio math for the verify script + tests to exercise the
// resampler/downmixer without a live gRPC call.
export const _internals = { toMonoInt16, resampleInt16 };
