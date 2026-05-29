/**
 * POST /api/tts/eleven-clone
 *
 * Instant Voice Cloning proxy. Accepts a multipart/form-data upload with:
 *   - audio:       Blob (a single audio sample, ≤10 MB enforced server-side).
 *   - name:        string (voice label, 1..64 chars).
 *   - description: string (optional, ≤500 chars).
 *
 * Forwards to the ElevenLabs SDK (`client.voices.ivc.create(…)`) using the
 * server-side ELEVENLABS_API_KEY. Returns `{ voice_id, name, status }`.
 *
 * Auth: same shape as /api/tts/eleven — a browser session OR a bearer token.
 *
 * Heads-up on quota: Instant Voice Cloning is a paid-tier ElevenLabs feature
 * (Starter+). The free tier returns 401 from voices.ivc.create with
 * `can_not_use_instant_voice_cloning`. We pass that error through as a 502
 * with the upstream body included so the demo log surfaces it verbatim.
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, method, wrap, error, json } from '../_lib/http.js';
import { env } from '../_lib/env.js';

export const config = {
	api: { bodyParser: false },
	maxDuration: 60,
};

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REQUEST_BYTES = 12 * 1024 * 1024; // small headroom for form fields + boundary

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const apiKey = env.ELEVENLABS_API_KEY;
	if (!apiKey)
		return error(res, 503, 'not_configured', 'ElevenLabs is not configured on this server');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');

	const ct = req.headers['content-type'] || '';
	if (!ct.toLowerCase().startsWith('multipart/form-data'))
		return error(res, 415, 'unsupported_media_type', 'content-type must be multipart/form-data');

	const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
	const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
	if (!boundary) return error(res, 400, 'validation_error', 'missing multipart boundary');

	let raw;
	try {
		raw = await readBody(req, MAX_REQUEST_BYTES);
	} catch (err) {
		const status = err.status || 400;
		return error(res, status, status === 413 ? 'payload_too_large' : 'bad_request', err.message);
	}

	let parts;
	try {
		parts = parseMultipart(raw, boundary);
	} catch (err) {
		return error(res, 400, 'validation_error', `multipart parse failed: ${err.message}`);
	}

	const fields = {};
	let audio = null;
	for (const part of parts) {
		if (part.filename) {
			if (!audio && (part.name === 'audio' || part.name === 'file')) audio = part;
		} else {
			fields[part.name] = part.data.toString('utf8');
		}
	}

	if (!audio) return error(res, 400, 'validation_error', 'audio file part is required');
	if (audio.data.length === 0) return error(res, 400, 'validation_error', 'audio file is empty');
	if (audio.data.length > MAX_AUDIO_BYTES)
		return error(res, 413, 'payload_too_large', `audio exceeds ${MAX_AUDIO_BYTES} bytes`);

	const name = String(fields.name || '').trim();
	if (!name) return error(res, 400, 'validation_error', 'name field is required');
	if (name.length > 64) return error(res, 400, 'validation_error', 'name exceeds 64 chars');

	const description = String(fields.description || '').trim().slice(0, 500) || undefined;

	const filename = audio.filename || 'sample.webm';
	const fileType = audio.contentType || guessAudioMime(filename);
	const audioFile = new File([audio.data], filename, { type: fileType });

	const client = new ElevenLabsClient({ apiKey });

	let result;
	try {
		result = await client.voices.ivc.create({
			name,
			description,
			files: [audioFile],
		});
	} catch (err) {
		const status = err?.statusCode || err?.status || 502;
		const body =
			(err?.body && typeof err.body === 'object' ? JSON.stringify(err.body) : err?.body) ||
			err?.message ||
			'upstream error';
		console.error('[tts/eleven-clone] ElevenLabs voices.ivc.create failed', status, body);
		// Pass the upstream body through so the demo surface can show the exact
		// quota / verification message — IVC is a paid-tier feature.
		return json(res, 502, {
			error: 'upstream_error',
			error_description: `ElevenLabs returned ${status}`,
			upstream_status: status,
			upstream_body: body,
		});
	}

	if (!result?.voice_id)
		return error(res, 502, 'upstream_error', 'ElevenLabs response missing voice_id');

	const userId = session?.id ?? bearer.userId;
	if (process.env.TTS_DEBUG === '1') {
		console.log(
			`[tts/eleven-clone] user=${userId} cloned voice "${name}" -> ${result.voice_id} (audio=${audio.data.length}B)`,
		);
	}

	return json(res, 200, {
		voice_id: result.voice_id,
		name,
		status: result.requires_verification ? 'pending_verification' : 'ready',
		requires_verification: !!result.requires_verification,
	});
});

// ── helpers ──────────────────────────────────────────────────────────────────

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on('data', (c) => {
			total += c.length;
			if (total > limit) {
				reject(Object.assign(new Error('payload too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

/**
 * Minimal RFC 7578 multipart parser. Sufficient for the single-file + few
 * scalar fields shape this endpoint accepts. Returns an array of
 * `{ name, filename?, contentType?, data: Buffer }`.
 */
function parseMultipart(buf, boundary) {
	const delim = Buffer.from(`--${boundary}`);
	const crlf = Buffer.from('\r\n');
	const out = [];

	let pos = buf.indexOf(delim);
	if (pos < 0) throw new Error('no opening boundary');
	pos += delim.length;

	while (pos < buf.length) {
		// `--` after the boundary means terminator.
		if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;
		// Skip the CRLF that follows the boundary.
		if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;

		const headersEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos);
		if (headersEnd < 0) throw new Error('malformed part headers');
		const headerStr = buf.slice(pos, headersEnd).toString('utf8');
		const dataStart = headersEnd + 4;

		const nextBoundary = buf.indexOf(crlf.length ? Buffer.concat([crlf, delim]) : delim, dataStart);
		if (nextBoundary < 0) throw new Error('no closing boundary for part');

		const data = buf.slice(dataStart, nextBoundary);

		const part = { name: '', data };
		for (const line of headerStr.split('\r\n')) {
			const idx = line.indexOf(':');
			if (idx < 0) continue;
			const key = line.slice(0, idx).trim().toLowerCase();
			const val = line.slice(idx + 1).trim();
			if (key === 'content-disposition') {
				const nameMatch = val.match(/name="([^"]*)"/i);
				const fileMatch = val.match(/filename="([^"]*)"/i);
				if (nameMatch) part.name = nameMatch[1];
				if (fileMatch) part.filename = fileMatch[1];
			} else if (key === 'content-type') {
				part.contentType = val;
			}
		}

		out.push(part);
		pos = nextBoundary + crlf.length + delim.length;
	}
	return out;
}

function guessAudioMime(filename) {
	const ext = filename.toLowerCase().split('.').pop();
	switch (ext) {
		case 'mp3':
			return 'audio/mpeg';
		case 'wav':
			return 'audio/wav';
		case 'ogg':
			return 'audio/ogg';
		case 'm4a':
		case 'mp4':
			return 'audio/mp4';
		case 'webm':
			return 'audio/webm';
		case 'flac':
			return 'audio/flac';
		default:
			return 'application/octet-stream';
	}
}
