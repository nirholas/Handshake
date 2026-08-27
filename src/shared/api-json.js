// readJson(res): the one correct way to turn an /api response into data.
//
// Money-path callers used to do `fetch(...).then((r) => r.json())` and then
// check `body.error`. Two failure shapes slipped through that: a gateway 502
// whose body is HTML ("Unexpected token <" from JSON.parse, no status in the
// message), and a non-2xx JSON body without an `error` key, which read as
// success and let the flow continue past a rejected prep. This helper throws a
// typed error on either, so every caller lands in its designed error state
// with a message a person can act on.

/**
 * @typedef {Error & { status: number, code: string, data: any }} ApiJsonError
 */

function pickMessage(data, status) {
	if (data && typeof data === 'object') {
		const msg = data.error_description || data.message || data.detail;
		if (typeof msg === 'string' && msg) return msg;
		if (typeof data.error === 'string' && data.error) return data.error;
		if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') return data.error.message;
	}
	if (status === 401) return 'Sign in to continue.';
	if (status === 403) return 'You do not have permission to do that.';
	if (status === 404) return 'That resource was not found.';
	if (status === 429) return 'Too many requests. Wait a moment and try again.';
	if (status >= 500) return 'The server had a problem handling that request. Try again in a moment.';
	return `Request failed (HTTP ${status}).`;
}

function pickCode(data, status) {
	if (data && typeof data === 'object') {
		if (typeof data.error === 'string' && data.error) return data.error;
		if (typeof data.code === 'string' && data.code) return data.code;
		if (data.error && typeof data.error === 'object' && typeof data.error.code === 'string') return data.error.code;
	}
	return `http_${status}`;
}

/**
 * Parse a fetch Response as JSON, throwing a typed error for any non-2xx status
 * or unparseable body.
 *
 * @param {Response} res
 * @returns {Promise<any>}
 * @throws {ApiJsonError}  `status` (HTTP status), `code` (server `error` key or `http_<status>`,
 *   `bad_json` for a 2xx that was not JSON), `data` (the parsed body when it was JSON).
 */
export async function readJson(res) {
	const status = res.status;
	let text = '';
	try {
		text = await res.text();
	} catch (err) {
		throw Object.assign(new Error('The response could not be read. Check your connection and try again.'), {
			status,
			code: `http_${status}`,
			data: null,
			cause: err,
		});
	}
	let data;
	let parsed = false;
	if (text) {
		try {
			data = JSON.parse(text);
			parsed = true;
		} catch {
			parsed = false;
		}
	}
	if (!res.ok) {
		throw Object.assign(new Error(pickMessage(parsed ? data : null, status)), {
			status,
			code: pickCode(parsed ? data : null, status),
			data: parsed ? data : null,
		});
	}
	if (!parsed) {
		if (!text.trim()) return null;
		throw Object.assign(new Error('The server returned an unreadable response. Try again in a moment.'), {
			status,
			code: 'bad_json',
			data: null,
		});
	}
	return data;
}

/** True when `err` was thrown by readJson (or shaped like it). */
export function isApiJsonError(err) {
	return !!err && typeof err.status === 'number' && typeof err.code === 'string';
}
