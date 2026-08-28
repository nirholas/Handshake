// The service worker: the only thing here that talks to the network.
//
// The content script never calls three.ws directly. It hands a payload to this
// worker, which owns the credential and the endpoint. That split is what keeps
// the bridge token out of the page: a content script shares an execution
// context with a merchant's own JavaScript, and a token readable there is a
// token belonging to whoever wrote that page.

const API_BASE = 'https://three.ws';
const ANALYZE_URL = `${API_BASE}/api/companion/checkout`;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.type === 'checkout:analyze') {
		analyze(message.payload)
			.then((result) => sendResponse({ result }))
			.catch((err) => sendResponse({ error: toClientError(err) }));
		// Keep the message channel open for the async reply.
		return true;
	}
	if (message?.type === 'checkout:ping') {
		verifyToken()
			.then((state) => sendResponse(state))
			.catch(() => sendResponse({ connected: false }));
		return true;
	}
	return false;
});

async function token() {
	const { bridgeToken = '' } = await chrome.storage.local.get({ bridgeToken: '' });
	return String(bridgeToken).trim();
}

async function analyze(payload) {
	const bridge = await token();
	const headers = { 'content-type': 'application/json' };
	if (bridge) headers.authorization = `Bearer ${bridge}`;

	const res = await fetch(ANALYZE_URL, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
		// Without a bridge token this rides the three.ws session cookie, which
		// the host permission makes available. Either credential resolves to the
		// same account server-side.
		credentials: bridge ? 'omit' : 'include',
	});

	if (res.status === 401) {
		throw Object.assign(new Error('Connect your three.ws account to read checkouts.'), {
			code: 'unauthorized',
		});
	}
	if (res.status === 429) {
		throw Object.assign(new Error('Too many checkout reads for now. Try again shortly.'), {
			code: 'rate_limited',
		});
	}
	if (!res.ok) {
		const detail = await res.json().catch(() => null);
		throw Object.assign(new Error(detail?.message || `three.ws returned ${res.status}.`), {
			code: detail?.code || 'upstream_error',
		});
	}
	return res.json();
}

/** Does the stored credential actually resolve to an account? */
async function verifyToken() {
	const bridge = await token();
	const res = await fetch(`${API_BASE}/api/companion/settings`, {
		headers: bridge ? { authorization: `Bearer ${bridge}` } : {},
		credentials: bridge ? 'omit' : 'include',
	});
	return { connected: res.ok, via: bridge ? 'token' : 'session' };
}

function toClientError(err) {
	return {
		code: err?.code || 'network_error',
		message: err?.message || 'The read did not complete.',
	};
}

// A fresh install lands on the options page once, because an extension that
// silently needs an account and never says so reads as broken.
chrome.runtime.onInstalled.addListener((details) => {
	if (details.reason === 'install') {
		chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
	}
});
