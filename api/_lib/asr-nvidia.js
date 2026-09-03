// Free NVIDIA NIM ASR lane — Riva speech-to-text over NVCF gRPC.
//
// This is the voice-IN sibling of api/_lib/tts-nvidia.js (voice-OUT). It closes
// the avatar voice loop: Magpie TTS already gives every avatar a free voice;
// this lane gives users a free, cross-browser way to TALK to the avatar,
// replacing the browser-only window.webkitSpeechRecognition path (Chrome/Edge
// only, ships user audio to Google) with server-side Riva recognition.
//
// Like Magpie, Riva ASR is hosted as an NVCF gRPC function on
// grpc.nvcf.nvidia.com:443, selected by a `function-id` metadata entry with the
// nvapi key as a bearer `authorization` metadata entry. The wire contract is
// the standard Riva SpeechRecognition service; the proto definitions are
// vendored under ./riva-protos/ and loaded from a generated JSON descriptor
// (asr-descriptor.js — kept separate from the TTS descriptor) so no .proto file
// needs to exist on the serverless filesystem (api/ routes are esbuild-bundled
// in place — scripts/bundle-api.mjs).
//
// ── Function id is configuration, never a guessed constant ───────────────────
// Unlike Magpie's id (live-probed and pinned), the hosted ASR model a deployment
// wants can vary (Parakeet CTC/RNN-T, Canary multilingual, different versions),
// so the NVCF function id is read from NVIDIA_ASR_FUNCTION_ID. Discover the live
// id for your account with `node scripts/verify-nvidia-asr.mjs --list`, which
// enumerates GET api.nvcf.nvidia.com/v2/nvcf/functions and prints the ASR
// candidates. Until it is set, nvidiaAsrConfigured() returns false and callers
// treat the lane as absent — no fake default, no silent misroute.
//
// Error codes match the established provider contract (tts-nvidia.js):
//   invalid_key / rate_limited / invalid_argument / timeout /
//   provider_unreachable / provider_error / not_configured.

import { env } from './env.js';
import asrDescriptor from './riva-protos/asr-descriptor.js';

export const NVIDIA_ASR_HOST = 'grpc.nvcf.nvidia.com:443';
const DEFAULT_TIMEOUT_MS = 30_000;

// Riva ASR's offline Recognize accepts mono audio in one of these container/
// codec encodings (riva_audio.proto AudioEncoding). We expose friendly aliases
// so the endpoint can map a request format onto the proto enum. LINEAR_PCM is
// the cross-browser default: every browser can produce raw 16-bit PCM via Web
// Audio even where MediaRecorder codecs differ.
export const ASR_ENCODINGS = new Map([
	['pcm', 'LINEAR_PCM'], ['wav', 'LINEAR_PCM'], ['linear_pcm', 'LINEAR_PCM'], ['linear16', 'LINEAR_PCM'],
	['flac', 'FLAC'],
	['opus', 'OGGOPUS'], ['ogg', 'OGGOPUS'], ['oggopus', 'OGGOPUS'],
	['mulaw', 'MULAW'], ['ulaw', 'MULAW'],
	['alaw', 'ALAW'],
]);

export function resolveAsrEncoding(encoding) {
	if (!encoding) return 'LINEAR_PCM';
	return ASR_ENCODINGS.get(String(encoding).toLowerCase()) || 'LINEAR_PCM';
}

export function nvidiaAsrConfigured() {
	return Boolean(
		env.NVIDIA_API_KEY &&
			(env.NVIDIA_ASR_FUNCTION_ID || env.NVIDIA_ASR_FUNCTION_ID_MULTILINGUAL),
	);
}

// ── Language routing ────────────────────────────────────────────────────────
// One hosted function does not cover every language. The English-tuned Parakeet
// models reject a non-`en` language_code outright (gRPC 3 INVALID_ARGUMENT), so
// a Mandarin utterance sent to the English pin fails rather than degrading. A
// multilingual model (ai-canary-1b-asr on our account) transcribes the languages
// below, and English at the same quality as the English pin. We therefore keep
// the English pin for `en*` (better casing and punctuation on English) and route
// every other language to the multilingual id when one is configured.
//
// The list is empirical, not aspirational: every tag here was verified by
// synthesizing a sentence in that language and reading back a correct
// transcript (`node scripts/verify-nvidia-asr.mjs --languages`). Languages the
// model rejects (Arabic, Malay, Tamil, Filipino, Norwegian) or garbles
// (Indonesian, Vietnamese, Finnish, Danish, Greek, Hungarian) are deliberately
// absent, so the client never offers a language the lane cannot hear.
export const MULTILINGUAL_ASR_LANGUAGES = [
	'zh-CN',
	'zh-TW',
	'ja-JP',
	'ko-KR',
	'es-ES',
	'fr-FR',
	'de-DE',
	'it-IT',
	'pt-BR',
	'ru-RU',
	'hi-IN',
	'nl-NL',
	'pl-PL',
	'cs-CZ',
];

/** True when `language` is an English tag (the English pin's territory). */
function isEnglish(language) {
	return String(language || '').trim().toLowerCase().startsWith('en');
}

/**
 * NVCF function id to use for `language`, or null when nothing is configured.
 * English (and any language with no multilingual id configured) stays on
 * NVIDIA_ASR_FUNCTION_ID; everything else prefers the multilingual id.
 */
export function asrFunctionIdFor(language) {
	const multilingual = env.NVIDIA_ASR_FUNCTION_ID_MULTILINGUAL || null;
	const primary = env.NVIDIA_ASR_FUNCTION_ID || null;
	if (!isEnglish(language) && multilingual) return multilingual;
	return primary || multilingual;
}

/**
 * BCP-47 tags this deployment can actually recognize, for the capability probe.
 * Always includes en-US (the base lane); the multilingual tags appear only when
 * a multilingual function id is configured.
 */
export function asrLanguages() {
	const langs = env.NVIDIA_ASR_FUNCTION_ID ? ['en-US', 'en-GB'] : [];
	if (env.NVIDIA_ASR_FUNCTION_ID_MULTILINGUAL) {
		if (!langs.length) langs.push('en-US');
		langs.push(...MULTILINGUAL_ASR_LANGUAGES);
	}
	return langs;
}

// Parse a RIFF/WAVE header → { sampleRateHz, channels, pcm } so a WAV upload can
// be handed to Riva as raw LINEAR_PCM with the correct rate. Riva's LINEAR_PCM
// expects header-less little-endian s16 samples; passing the 44-byte RIFF header
// through prepends ~44 bytes of garbage to the first samples and skews the rate
// the model is told. Returns null when the bytes are not a WAV (caller then
// trusts the explicitly-supplied rate/encoding).
export function parseWav(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
	// Walk the chunk list rather than assuming the canonical 44-byte layout —
	// some encoders insert a LIST/fact chunk before `data`.
	let offset = 12;
	let sampleRateHz = 0;
	let channels = 1;
	let pcm = null;
	while (offset + 8 <= buf.length) {
		const id = buf.toString('ascii', offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === 'fmt ' && body + 16 <= buf.length) {
			channels = buf.readUInt16LE(body + 2) || 1;
			sampleRateHz = buf.readUInt32LE(body + 4);
		} else if (id === 'data') {
			pcm = buf.subarray(body, Math.min(body + size, buf.length));
		}
		// Chunks are word-aligned: an odd size carries a trailing pad byte.
		offset = body + size + (size & 1);
	}
	if (!pcm || !sampleRateHz) return null;
	return { sampleRateHz, channels, pcm };
}

// gRPC status code → platform error code (numeric codes so the mapping does not
// depend on the grpc-js import being resolved). Mirrors tts-nvidia.js.
function normalizeGrpcError(err) {
	const code = typeof err?.code === 'number' ? err.code : null;
	const map = {
		3: 'invalid_argument', // bad encoding/rate/language/audio
		4: 'timeout', // DEADLINE_EXCEEDED
		7: 'invalid_key', // PERMISSION_DENIED
		8: 'rate_limited', // RESOURCE_EXHAUSTED (credit-metered free tier)
		14: 'provider_unreachable', // UNAVAILABLE
		16: 'invalid_key', // UNAUTHENTICATED
	};
	const normalized = new Error(
		`NVIDIA Riva ASR failed${code !== null ? ` (gRPC ${code})` : ''}: ${err?.details || err?.message || 'unknown error'}`,
	);
	normalized.code = (code !== null && map[code]) || 'provider_error';
	normalized.grpcCode = code;
	return normalized;
}

// One cached client per warm lambda (the TLS channel is keyless — auth rides in
// per-call metadata). @grpc/grpc-js is imported lazily so non-ASR importers do
// not pay for the dependency at cold start. See tts-nvidia.js for the NVCF
// warm-channel auth caveat that the verify script works around.
let clientPromise = null;
async function getClient() {
	if (!clientPromise) {
		clientPromise = (async () => {
			const [{ default: grpc }, { default: protoLoader }] = await Promise.all([
				import('@grpc/grpc-js'),
				import('@grpc/proto-loader'),
			]);
			const definition = protoLoader.fromJSON(asrDescriptor, {
				keepCase: true,
				longs: Number,
				enums: String,
				defaults: true,
				oneofs: true,
			});
			const pkg = grpc.loadPackageDefinition(definition);
			const Recognition = pkg.nvidia.riva.asr.RivaSpeechRecognition;
			return {
				grpc,
				client: new Recognition(NVIDIA_ASR_HOST, grpc.credentials.createSsl(), {
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

// Transcribe a single utterance on the free NIM lane via the offline Recognize
// RPC (unary — fits a serverless function; no streaming socket to babysit).
//
//   { audio: Buffer, encoding?, sampleRateHz?, language?, maxAlternatives?,
//     automaticPunctuation?, wordTimeOffsets?, model?, timeoutMs?, apiKey? }
//     → { text, confidence, words, language, model, audioProcessed }
//
// `audio` is raw bytes in `encoding`. When a WAV is passed as LINEAR_PCM the
// caller should strip the header first (parseWav) — this function trusts the
// encoding/rate it is given.
//
// Throws Error with .code ∈ not_configured | invalid_key | rate_limited |
// invalid_argument | timeout | provider_unreachable | provider_error.
export async function transcribeNvidiaAsr({
	audio,
	encoding = 'LINEAR_PCM',
	sampleRateHz = 16000,
	language = 'en-US',
	maxAlternatives = 1,
	automaticPunctuation = true,
	wordTimeOffsets = false,
	model = '',
	timeoutMs = DEFAULT_TIMEOUT_MS,
	apiKey,
	functionId: functionIdOverride,
} = {}) {
	const key = apiKey || env.NVIDIA_API_KEY;
	const functionId = functionIdOverride || asrFunctionIdFor(language);
	if (!key || !functionId) {
		const err = new Error(
			!key ? 'NVIDIA_API_KEY not set' : 'NVIDIA_ASR_FUNCTION_ID not set (run scripts/verify-nvidia-asr.mjs --list to discover it)',
		);
		err.code = 'not_configured';
		throw err;
	}
	const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
	if (!bytes.length) {
		const err = new Error('no audio bytes to transcribe');
		err.code = 'invalid_argument';
		throw err;
	}

	const { grpc, client } = await getClient();
	const metadata = new grpc.Metadata();
	metadata.set('function-id', functionId);
	metadata.set('authorization', `Bearer ${key}`);

	const response = await new Promise((resolveCall, rejectCall) => {
		client.recognize(
			{
				config: {
					encoding: ASR_ENCODINGS.get(String(encoding).toLowerCase()) || encoding,
					sample_rate_hertz: sampleRateHz,
					language_code: language,
					max_alternatives: maxAlternatives,
					enable_automatic_punctuation: automaticPunctuation,
					enable_word_time_offsets: wordTimeOffsets,
					...(model ? { model } : {}),
				},
				audio: bytes,
			},
			metadata,
			{ deadline: new Date(Date.now() + timeoutMs) },
			(err, res) => (err ? rejectCall(normalizeGrpcError(err)) : resolveCall(res)),
		);
	});

	// Riva returns sequential results; the offline path currently yields one.
	// Concatenate the top alternative of each result into a single transcript so
	// the caller gets the complete utterance regardless of internal segmentation.
	const results = Array.isArray(response?.results) ? response.results : [];
	const tops = results.map((r) => r?.alternatives?.[0]).filter(Boolean);
	const text = tops.map((a) => a.transcript || '').join(' ').trim();
	const confidence = tops.length ? tops.reduce((s, a) => s + (a.confidence || 0), 0) / tops.length : 0;
	const words = wordTimeOffsets
		? tops.flatMap((a) => (Array.isArray(a.words) ? a.words : []).map((w) => ({
			word: w.word,
			startMs: w.start_time,
			endMs: w.end_time,
			confidence: w.confidence,
		})))
		: [];
	const audioProcessed = results.reduce((m, r) => Math.max(m, r?.audio_processed || 0), 0);
	const detectedLang = tops[0]?.language_code?.[0] || language;

	return { text, confidence, words, language: detectedLang, model: model || 'riva-asr', audioProcessed };
}
