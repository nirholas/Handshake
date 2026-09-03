/**
 * The browser half of the `/api/home/*` contract.
 *
 * One place that knows the error shape, the CSRF dance and the SSE framing, so
 * the 3D scene, the 2D fallback and every later home surface read the same
 * table instead of three slightly different ones.
 *
 * Every failure surfaces as a `HomeApiError` carrying the server's `code`, so
 * a caller branches on `needs_confirmation` or `unreachable` rather than on a
 * message string that will be reworded next week.
 */

export class HomeApiError extends Error {
	constructor(code, message, { status = 0, pending = null } = {}) {
		super(message);
		this.name = 'HomeApiError';
		this.code = code;
		this.status = status;
		this.pending = pending;
	}
}

let csrf = null;

async function csrfToken() {
	if (csrf && csrf.expiresAt > Date.now() + 5000) return csrf.token;
	const res = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!res.ok) throw new HomeApiError('unauthorized', 'Sign in to control this home.', { status: res.status });
	const body = await res.json();
	const data = body.data || body;
	csrf = { token: data.token, expiresAt: Date.now() + ((data.expires_in || 3600) - 30) * 1000 };
	return csrf.token;
}

async function request(path, { method = 'GET', body = null, signal } = {}) {
	const headers = { accept: 'application/json' };
	if (body) headers['content-type'] = 'application/json';
	if (method !== 'GET') {
		headers['x-csrf-token'] = await csrfToken();
		// Tokens are single use on this platform; drop the cache after spending one.
		csrf = null;
	}
	let res;
	try {
		res = await fetch(path, { method, headers, credentials: 'include', body: body ? JSON.stringify(body) : undefined, signal });
	} catch (cause) {
		if (cause?.name === 'AbortError') throw cause;
		throw new HomeApiError('unreachable', 'three.ws could not be reached. Check your connection and try again.', { status: 0 });
	}
	const text = await res.text();
	let payload = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		// A proxy error page, not our contract.
	}
	if (!res.ok) {
		const code = payload?.code || payload?.error || 'call_failed';
		const message = payload?.error_description || payload?.message || (typeof payload?.error === 'string' && payload.code ? payload.error : null) || `Request failed (${res.status}).`;
		throw new HomeApiError(code, message, {
			status: res.status,
			pending: payload?.pending || null,
			// A 409 on the floorplan carries the document that won, so the editor
			// can offer a real choice instead of a bare failure.
			current: payload?.current || null,
			field: payload?.field || null,
		});
	}
	return payload;
}

/**
 * The authored floorplan, its version, and what has drifted from the house.
 *
 * A house with no layout answers `{ version: 0, layout: null }`, which is the
 * ordinary state and not an error: the scene falls back to its default grid.
 */
export function getLayout(id, signal) {
	return request(`/api/home/${encodeURIComponent(id)}/layout`, { signal });
}

/**
 * Save the floorplan.
 *
 * `version` is the one the editor loaded, or 0 to create the first layout. A
 * stale version throws a HomeApiError with code `layout_conflict` carrying
 * `current`, which is the document that won; the editor asks the user rather
 * than discarding either side.
 */
export function saveLayout(id, { version, layout }) {
	return request(`/api/home/${encodeURIComponent(id)}/layout`, { method: 'PUT', body: { version, layout } });
}

/** Drop the floorplan and return the scene to its default arrangement. */
export function clearLayout(id) {
	return request(`/api/home/${encodeURIComponent(id)}/layout`, { method: 'DELETE' });
}

/**
 * File a device into a room, in Home Assistant itself.
 *
 * Pass `areaId: null` to take it out of every room. This writes the user's own
 * registry, so the room shows up in their dashboards and their voice assistant
 * too, not only here.
 */
export function assignEntityArea(id, { entityId, areaId }) {
	return request(`/api/home/${encodeURIComponent(id)}/assign`, { method: 'POST', body: { entityId, areaId } });
}

/** The caller's homes, credential free. */
export function listHomes(signal) {
	return request('/api/home', { signal });
}

/** One home plus the current room graph. */
export function getHome(id, signal) {
	return request(`/api/home/${encodeURIComponent(id)}`, { signal });
}

/**
 * Start pairing a home that only exists on a LAN.
 *
 * Most Home Assistant installs cannot be reached from the public internet at
 * all, so for those the house dials out to us instead. This mints the short
 * code the owner types into the three.ws integration inside their Home
 * Assistant; the connection row exists from this moment, in `pending`.
 */
export function startPairing({ label } = {}) {
	return request('/api/home/pair', { method: 'POST', body: { label } });
}

/** A fresh code for a home already waiting, without creating a second home. */
export function refreshPairing(homeId) {
	return request('/api/home/pair', { method: 'POST', body: { homeId } });
}

/**
 * The countdown and the link state. `relay.online` is read from the relay
 * itself, so it answers "is the integration in my house running right now"
 * rather than "did a connection work at some point".
 */
export function pairingStatus(homeId, signal) {
	return request(`/api/home/pair?homeId=${encodeURIComponent(homeId)}`, { signal });
}

/**
 * A gated service call. A guarded action answers 409 with `pending`, which the
 * caller renders as a question next to the thing it would move. `confirmed` is
 * only ever set from a person clicking yes.
 */
export function callService(id, { domain, service, data, confirmed = false }) {
	return request(`/api/home/${encodeURIComponent(id)}/call`, { method: 'POST', body: { domain, service, data, confirmed } });
}

/** A phrase to one of the house's own scenes or scripts. */
export function activatePhrase(id, { phrase, dryRun = false, confirmed = false }) {
	return request(`/api/home/${encodeURIComponent(id)}/activate`, { method: 'POST', body: { phrase, dryRun, confirmed } });
}

/** A standing per-entity allowance, so a repeated yes is not asked forever. */
export function grantEntity(id, { entityId, expiresAt = null }) {
	return request(`/api/home/${encodeURIComponent(id)}/grants`, { method: 'POST', body: { entityId, expiresAt } });
}

// The household: roles, scopes and invitations.
//
// Every one of these answers 403 `role_forbidden` when the caller's role is not
// allowed to do it, and 404 when they are not in the household at all, so the UI
// renders what the server says rather than deciding for itself which buttons a
// role should be shown.

/** The roster, the outstanding invitations, and this caller's own role. */
export function listHousehold(id, signal) {
	return request(`/api/home/${encodeURIComponent(id)}/members`, { signal });
}

/**
 * Invite an email address to a role.
 *
 * The response carries `invite_url` exactly once. The token behind it is stored
 * as a hash, so a link that is not copied now cannot be recovered later, and the
 * UI has to show it at this moment or not at all.
 */
export function inviteToHousehold(id, { email, role, scope = null }) {
	return request(`/api/home/${encodeURIComponent(id)}/members`, { method: 'POST', body: { email, role, ...(scope ? { scope } : {}) } });
}

/** Change what somebody may do, and what they may see. */
export function setHouseholdRole(id, { userId, role, scope = undefined }) {
	return request(`/api/home/${encodeURIComponent(id)}/members`, { method: 'PATCH', body: { user_id: userId, role, ...(scope === undefined ? {} : { scope }) } });
}

/** Remove somebody, and every standing allowance they left behind with them. */
export function removeFromHousehold(id, userId) {
	return request(`/api/home/${encodeURIComponent(id)}/members`, { method: 'DELETE', body: { user_id: userId } });
}

/** Withdraw an invitation nobody has used yet. */
export function revokeHouseholdInvite(id, inviteId) {
	return request(`/api/home/${encodeURIComponent(id)}/members`, { method: 'DELETE', body: { invite_id: inviteId } });
}

/** What an invite link is for, without spending it. No account needed. */
export function inspectInvite(token, signal) {
	return request(`/api/home/invites/${encodeURIComponent(token)}`, { signal });
}

/** Spend it. Requires an account; answers 401 with the invite intact if there is none. */
export function acceptInvite(token) {
	return request(`/api/home/invites/${encodeURIComponent(token)}`, { method: 'POST' });
}

/**
 * The live stream.
 *
 * `EventSource` reconnects on its own with the server's `retry` interval, which
 * is exactly the behaviour a wall display needs: nothing here re-implements a
 * backoff on top of it. What this does add is a watchdog, because a stream that
 * silently stops delivering (a proxy holding a dead socket open) looks
 * identical to a quiet house, and the two must not.
 *
 * @param {string} id
 * @param {{ onGraph: Function, onStatus: Function, onOpen?: Function, onSilence?: Function }} handlers
 * @returns {{ close(): void }}
 */
export function openStream(id, handlers) {
	const url = `/api/home/${encodeURIComponent(id)}/stream`;
	const source = new EventSource(url, { withCredentials: true });
	let watchdog = 0;
	// The server heartbeats every 25 s. Two missed beats plus slack is a stream
	// that is no longer delivering, whatever the socket believes.
	const SILENCE_MS = 70_000;

	const beat = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => handlers.onSilence?.(), SILENCE_MS);
	};

	source.addEventListener('open', () => {
		beat();
		handlers.onOpen?.();
	});
	source.addEventListener('graph', (event) => {
		beat();
		const payload = parse(event.data);
		if (payload) handlers.onGraph(payload);
	});
	source.addEventListener('status', (event) => {
		beat();
		const payload = parse(event.data);
		if (payload) handlers.onStatus(payload);
	});
	source.addEventListener('heartbeat', beat);
	source.addEventListener('error', () => {
		// EventSource fires `error` both for a transient drop it will retry and
		// for a terminal close. `readyState` is the only honest signal of which.
		handlers.onStatus({ status: source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting', stale: true });
	});

	return {
		close() {
			clearTimeout(watchdog);
			source.close();
		},
	};
}

function parse(data) {
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}

/**
 * What this account's plan covers, what it is using, and when it resets.
 *
 * Every dimension comes back whether or not it is near its ceiling: a quota you
 * only learn about at the moment it refuses you is a quota that was never shown.
 */
export function getPlan(signal) {
	return request('/api/home/plan', { signal });
}

/**
 * Pause a home to make room for another one, or bring a paused one back.
 *
 * Pausing is never a disconnect. The row, the stored credential and the action
 * log are all untouched, and a paused home still answers safety actions:
 * locking up, closing a garage or valve and arming an alarm are never refused by
 * a plan.
 *
 * @param {'pause'|'resume'|'preview'} action
 * @param {string} [homeId]
 */
export function changePlanState(action, homeId) {
	return request('/api/home/plan', { method: 'POST', body: { action, home_id: homeId } });
}

// ── The privacy centre (/api/home/privacy) ───────────────────────────────────
//
// Everything three.ws stores about a person's homes: see it, set how long the
// action log lives, download all of it, delete one home or every trace of them
// all. The endpoint is the only place these rows can be read or removed from,
// so this is the only client for it.

/**
 * What we hold about this account right now, plus the inventory that explains
 * each number and the disclosure copy the connect and voice screens render.
 * @param {AbortSignal} [signal]
 */
export function getPrivacy(signal) {
	return request('/api/home/privacy', { signal });
}

/**
 * How long this home keeps its action log.
 *
 * Shortening is always allowed and applies immediately: the response's `purged`
 * count is the rows that went, so a caller can say "142 entries deleted" rather
 * than "within 24 hours". Lengthening past 90 days needs a written reason
 * (`reason_required`) and is capped by the plan (`retention_over_plan`), which
 * are different failures and must be told apart in the UI.
 *
 * @param {string} homeId
 * @param {number} retentionDays
 * @param {string|null} [reason]
 */
export function setRetention(homeId, retentionDays, reason = null) {
	return request('/api/home/privacy', {
		method: 'PATCH',
		body: { homeId, retentionDays, reason },
	});
}

/**
 * Delete one home and everything pointing at it, or every home this account has.
 *
 * This is NOT the disconnect on the manage screen. Disconnecting erases the
 * credential and keeps the record, so an owner can still answer "what did my
 * agent do in my house last Tuesday" about a house they have unplugged. This
 * removes the record too, and there is nothing left to read afterwards.
 *
 * @param {{ scope: 'home'|'all', homeId?: string }} target
 */
export function deleteHomeData(target) {
	return request('/api/home/privacy', { method: 'DELETE', body: target });
}

/**
 * The export URL. Deliberately a plain link rather than a fetch: the response
 * carries a Content-Disposition, so letting the browser navigate to it gives a
 * real Save dialog with a sensible filename, where a fetch would need a blob
 * and an object URL to end up somewhere worse.
 */
export const PRIVACY_EXPORT_URL = '/api/home/privacy?export=1';
