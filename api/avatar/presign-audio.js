// POST /api/avatar/presign-audio
//
// Returns a presigned PUT URL for uploading an audio file to R2, plus the
// public URL the file will be readable at after upload.  Used by the
// /create/video page so the LongCat worker can fetch the audio via HTTPS
// rather than receiving a raw data URI.
//
// Request body (JSON):
//   filename      string  — original filename, used to derive the extension
//   content_type  string? — MIME type (default: audio/mpeg)
//
// Response 200:
//   {
//     upload_url:   string,   // PUT to this URL (expires in 5 min)
//     public_url:   string,   // read from this URL after upload completes
//     storage_key:  string,   // R2 key, for reference
//   }

import { cors, error, json, wrap } from '../_lib/http.js';
import { getSessionUser } from '../_lib/auth.js';
import { presignUpload, publicUrl } from '../_lib/r2.js';
import { randomUUID } from 'crypto';

const ALLOWED_AUDIO_TYPES = new Set([
	'audio/mpeg',
	'audio/mp3',
	'audio/wav',
	'audio/wave',
	'audio/x-wav',
	'audio/mp4',
	'audio/m4a',
	'audio/x-m4a',
	'audio/aac',
	'audio/ogg',
	'audio/webm',
	'audio/flac',
	'application/octet-stream',
]);

// Map common MIME types to file extensions for the storage key.
function extForType(contentType) {
	const map = {
		'audio/mpeg': 'mp3',
		'audio/mp3': 'mp3',
		'audio/wav': 'wav',
		'audio/wave': 'wav',
		'audio/x-wav': 'wav',
		'audio/mp4': 'mp4',
		'audio/m4a': 'm4a',
		'audio/x-m4a': 'm4a',
		'audio/aac': 'aac',
		'audio/ogg': 'ogg',
		'audio/webm': 'webm',
		'audio/flac': 'flac',
	};
	return map[contentType] || 'bin';
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', `method ${req.method} not allowed`);

	let session;
	try {
		session = await getSessionUser(req);
		if (!session) throw new Error('no session');
	} catch {
		return error(res, 401, 'unauthorized', 'valid session required');
	}

	const userId = session.id ?? session.userId;
	const body = req.body || {};
	const contentType = (body.content_type || 'audio/mpeg').toLowerCase().trim();

	if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
		return error(res, 415, 'unsupported_media_type', `content_type must be an audio MIME type, got: ${contentType}`);
	}

	const ext = extForType(contentType);
	const key = `u/${userId}/audio/${randomUUID()}.${ext}`;

	const uploadUrl = await presignUpload({ key, contentType });
	const pubUrl    = publicUrl(key);

	return json(res, 200, {
		upload_url:  uploadUrl,
		public_url:  pubUrl,
		storage_key: key,
	});
});
