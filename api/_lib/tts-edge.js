// @ts-check
// Free Microsoft Edge (Read Aloud) TTS lane: synthesis + the live voice list.
//
// Same unofficial WebSocket protocol as the edge-tts Python package
// (pypi.org/project/edge-tts): no API key, no account, no vendor bill, ~500
// neural voices across ~100 locales. That makes it the platform's zero-cost
// default lane, and the only lane an anonymous visitor can drive without a
// credit balance.
//
// Shared by the legacy per-provider proxy (api/tts/edge.js) and the unified
// router (api/_lib/voice-providers.js) so the protocol quirks below live in
// exactly one place.

import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// speech.platform.bing.com is the host the readaloud protocol actually lives
// on. speech.microsoft.com (used previously) serves the Speech Studio web app,
// which answers every path with a 200 HTML page, hence the constant
// "Unexpected server response: 200" handshake failures.
const WSS_BASE = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
// Must track the Edg/ version in WS_HEADERS' User-Agent below. The endpoint
// 403s GEC versions it considers stale, so bump this alongside edge-tts
// releases (their constants.py carries the current known-good value).
const CHROMIUM_FULL_VERSION = '143.0.3650.75';

// e.g. "en-US-AriaNeural", "zh-CN-XiaoxiaoNeural"
export const EDGE_VOICE_RE = /^[a-zA-Z]{2,8}-[a-zA-Z]{2,8}-[a-zA-Z]{5,50}$/;
export const EDGE_RATE_RE = /^[+-]\d+%$/;
export const EDGE_PITCH_RE = /^[+-]\d+Hz$/;
export const EDGE_DEFAULT_VOICE = 'en-US-AriaNeural';

// Sec-MS-GEC DRM token, required by the readaloud endpoint since late 2024.
// SHA-256 of the current Windows file time (100ns ticks since 1601-01-01,
// rounded DOWN to the nearest 5 minutes) concatenated with the client token,
// same scheme the edge-tts reference implementation ships. Handshakes without
// it are intermittently rejected with a non-101 response ("Unexpected server
// response: 200").
function secMsGecToken() {
	const WIN_EPOCH_SECONDS = 11_644_473_600; // 1601-01-01 → 1970-01-01
	let seconds = Math.floor(Date.now() / 1000) + WIN_EPOCH_SECONDS;
	seconds -= seconds % 300;
	// seconds → 100ns ticks would overflow Number; appending seven zeros is the
	// same multiplication by 10^7 done in string space.
	return createHash('sha256')
		.update(`${seconds}0000000${TRUSTED_CLIENT_TOKEN}`)
		.digest('hex')
		.toUpperCase();
}

const WS_HEADERS = {
	Pragma: 'no-cache',
	'Cache-Control': 'no-cache',
	Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
	'Accept-Encoding': 'gzip, deflate, br, zstd',
	'Accept-Language': 'en-US,en;q=0.9',
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
};

function isoTimestamp() {
	return new Date().toISOString().replace(/\.\d+/, '.000');
}

function mkId() {
	return randomUUID().replace(/-/g, '');
}

function buildSsml(voice, text, rate, pitch) {
	const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
		`<voice name='${voice}'>` +
		`<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc}</prosody>` +
		`</voice></speak>`
	);
}

/**
 * One synthesis attempt over the readaloud WebSocket.
 * @returns {Promise<Buffer>} the complete mp3 clip.
 */
export function synthesizeEdgeOnce(voice, text, rate = '+0%', pitch = '+0Hz') {
	return new Promise((resolve, reject) => {
		const connId = mkId();
		const url =
			`${WSS_BASE}&Sec-MS-GEC=${secMsGecToken()}` +
			`&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${connId}`;
		const ws = new WebSocket(url, { headers: WS_HEADERS });

		const chunks = [];
		let finished = false;

		const timeout = setTimeout(() => {
			if (!finished) {
				ws.terminate();
				reject(new Error('edge-tts synthesis timed out'));
			}
		}, 30_000);

		ws.on('open', () => {
			const configMsg =
				`X-Timestamp:${isoTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
				JSON.stringify({
					context: {
						synthesis: {
							audio: {
								metadataoptions: {
									sentenceBoundaryEnabled: 'false',
									wordBoundaryEnabled: 'false',
								},
								outputFormat: AUDIO_FORMAT,
							},
						},
					},
				});
			ws.send(configMsg);

			const requestId = mkId();
			const ssmlMsg =
				`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${isoTimestamp()}\r\nPath:ssml\r\n\r\n` +
				buildSsml(voice, text, rate, pitch);
			ws.send(ssmlMsg);
		});

		ws.on('message', (data, isBinary) => {
			if (!isBinary) {
				const msg = data.toString();
				if (msg.includes('Path:turn.end')) {
					finished = true;
					clearTimeout(timeout);
					ws.close();
					resolve(Buffer.concat(chunks));
				}
				return;
			}
			// Binary frame: first 2 bytes = big-endian header length, then header, then audio.
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			const headerLen = buf.readUInt16BE(0);
			const header = buf.subarray(2, 2 + headerLen).toString();
			if (header.includes('Path:audio')) {
				chunks.push(buf.subarray(2 + headerLen));
			}
		});

		ws.on('error', (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		ws.on('close', (code) => {
			clearTimeout(timeout);
			if (!finished) reject(new Error(`edge-tts WebSocket closed unexpectedly (${code})`));
		});
	});
}

/**
 * Synthesize with one retry. Microsoft's endpoint intermittently rejects the
 * WebSocket upgrade with an HTTP 200 instead of a 101 (a transient handshake
 * failure that almost always clears on an immediate second attempt.
 * @returns {Promise<Buffer>}
 */
export async function synthesizeEdge(voice, text, rate = '+0%', pitch = '+0Hz') {
	let lastErr = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await synthesizeEdgeOnce(voice, text, rate, pitch);
		} catch (err) {
			lastErr = err;
			if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw lastErr;
}

// ── Voice catalog ────────────────────────────────────────────────────────────
// Microsoft publishes the full neural voice list at a plain HTTPS endpoint, so
// the catalog is always live rather than a hardcoded snapshot that rots. It
// changes on Microsoft's release cadence (weeks), hence the long TTL.

const VOICE_TTL_MS = 6 * 60 * 60 * 1000;
let voiceCache = null; // { at: epochMs, voices: [...] }

/**
 * Normalize one upstream entry to the platform's shared voice shape.
 * Upstream fields: ShortName, FriendlyName, Gender, Locale, VoiceTag.
 */
function normalizeEdgeVoice(v) {
	const tag = v.VoiceTag || {};
	// FriendlyName is "Microsoft Aria Online (Natural) - English (United States)";
	// the middle word is the only part worth showing in a picker.
	const short = String(v.ShortName || '');
	const display = short.split('-').slice(2).join('-').replace(/Neural$/, '') || short;
	return {
		id: short,
		name: display,
		provider: 'edge',
		gender: String(v.Gender || '').toLowerCase() || null,
		locale: v.Locale || null,
		language: v.Locale ? String(v.Locale).split('-')[0] : null,
		labels: {
			categories: Array.isArray(tag.ContentCategories) ? tag.ContentCategories : [],
			personalities: Array.isArray(tag.VoicePersonalities) ? tag.VoicePersonalities : [],
		},
		preview_url: null,
	};
}

/**
 * The live Edge neural voice catalog, cached per warm instance.
 * @returns {Promise<{ voices: Array, cached: boolean }>}
 * @throws {Error & { status:number }} 502 when Microsoft is unreachable.
 */
export async function listEdgeVoices({ force = false } = {}) {
	if (!force && voiceCache && Date.now() - voiceCache.at < VOICE_TTL_MS) {
		return { voices: voiceCache.voices, cached: true };
	}

	let resp;
	try {
		resp = await fetch(
			`${VOICE_LIST_URL}&Sec-MS-GEC=${secMsGecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`,
			{ headers: WS_HEADERS, signal: AbortSignal.timeout(10_000) },
		);
	} catch (e) {
		throw Object.assign(new Error('Could not reach the Edge voice list'), { status: 502, cause: e });
	}
	if (!resp.ok) {
		throw Object.assign(new Error(`Edge voice list returned ${resp.status}`), { status: 502 });
	}

	const data = await resp.json();
	const voices = (Array.isArray(data) ? data : [])
		.filter((v) => v && typeof v.ShortName === 'string' && EDGE_VOICE_RE.test(v.ShortName))
		.map(normalizeEdgeVoice);

	voiceCache = { at: Date.now(), voices };
	return { voices, cached: false };
}
