// Friends client — the browser-side data layer for the account-level friends
// system (Task 15). It owns the social-graph state (friends, incoming/outgoing
// requests, DM threads, unread counts), talks to the /api/friends endpoints, and
// reconciles live socket events with a polling backstop so the UI is correct
// whether or not the live channel is connected.
//
// Realtime is delivered over whichever Colyseus realm room the player is already
// connected to: the server pushes a 'social' message, the net wrapper forwards
// it here via handleSocial(), and we update state + emit 'change'. The presence
// ticket minted here is what lets that realm room publish the player's presence
// in the first place (see getPresenceTicket).
//
// The panel UI (game/friends-panel.js) is a pure view over this client.

import { apiFetch } from './api.js';

// ── presence ticket ─────────────────────────────────────────────────────────
// Short-lived, account-scoped token the realm room verifies before publishing
// presence. Cached and refreshed lazily; the net layer calls getPresenceTicket()
// on every (re)connect, so an expired ticket self-heals on the next connection.
let _ticket = null;
let _ticketExpEpoch = 0;

export async function getPresenceTicket() {
	const now = Date.now() / 1000;
	if (_ticket && _ticketExpEpoch - now > 60) return _ticket;
	try {
		const res = await apiFetch('/api/friends/presence-ticket', { allowAnonymous: true });
		if (!res.ok) return null;
		const { data } = await res.json();
		if (!data?.token) return null;
		_ticket = data.token;
		_ticketExpEpoch = now + (Number(data.expiresIn) || 600);
		return _ticket;
	} catch {
		return null;
	}
}

const LIST_POLL_MS = 20_000; // presence + unread refresh while the panel is open
const THREAD_POLL_MS = 5_000; // open-thread refresh — backstop for the live push

export class FriendsClient {
	constructor() {
		this.friends = [];
		this.incoming = [];
		this.outgoing = [];
		this.threads = new Map(); // friendId → [{id, from, to, body, ts, mine, read}]
		this.openWith = null; // friendId of the thread currently shown, or null
		this.loaded = false;
		this.loadError = null;

		this._listeners = new Set();
		this._listTimer = null;
		this._threadTimer = null;
		this._active = false; // panel is open → poll
	}

	// ── subscription ───────────────────────────────────────────────────────
	subscribe(fn) {
		this._listeners.add(fn);
		return () => this._listeners.delete(fn);
	}
	_emit() {
		for (const fn of this._listeners) {
			try {
				fn(this);
			} catch (e) {
				console.error('[friends] listener threw:', e);
			}
		}
	}

	// Total unread across all friends — for the HUD badge.
	get totalUnread() {
		return this.friends.reduce((n, f) => n + (f.unread || 0), 0);
	}

	friend(id) {
		return this.friends.find((f) => f.id === id) || null;
	}

	// ── lifecycle ────────────────────────────────────────────────────────────
	// Called when the panel opens: load fresh and begin light polling for
	// presence + unread changes. Idempotent.
	activate() {
		this._active = true;
		this.refresh();
		if (!this._listTimer) this._listTimer = setInterval(() => this.refresh(), LIST_POLL_MS);
	}

	// Called when the panel closes: stop polling. State is retained so reopening
	// is instant; live events still arrive via handleSocial while closed.
	deactivate() {
		this._active = false;
		this._stopListPoll();
		this._stopThreadPoll();
	}

	_stopListPoll() {
		if (this._listTimer) {
			clearInterval(this._listTimer);
			this._listTimer = null;
		}
	}
	_stopThreadPoll() {
		if (this._threadTimer) {
			clearInterval(this._threadTimer);
			this._threadTimer = null;
		}
	}

	// ── graph ─────────────────────────────────────────────────────────────────
	async refresh() {
		try {
			const res = await apiFetch('/api/friends', { allowAnonymous: true });
			if (res.status === 401) {
				this.loadError = 'signin';
				this.loaded = true;
				this._emit();
				return;
			}
			if (!res.ok) throw new Error(`friends ${res.status}`);
			const { data } = await res.json();
			this.friends = data.friends || [];
			this.incoming = data.incoming || [];
			this.outgoing = data.outgoing || [];
			this.loaded = true;
			this.loadError = null;
		} catch (err) {
			this.loadError = 'network';
			this.loaded = true;
			console.warn('[friends] refresh failed:', err?.message);
		}
		this._emit();
	}

	async search(q) {
		const term = String(q || '').trim();
		if (term.length < 2) return [];
		try {
			const res = await apiFetch(`/api/friends/search?q=${encodeURIComponent(term)}`, {
				allowAnonymous: true,
			});
			if (!res.ok) return [];
			const { data } = await res.json();
			return data.results || [];
		} catch {
			return [];
		}
	}

	async _action(action, userId) {
		const res = await apiFetch('/api/friends', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, userId }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			const err = new Error(body.error_description || 'request failed');
			err.code = body.error;
			throw err;
		}
		const { data } = await res.json();
		await this.refresh();
		return data;
	}

	sendRequest(userId) {
		return this._action('request', userId);
	}
	accept(userId) {
		return this._action('accept', userId);
	}
	decline(userId) {
		return this._action('decline', userId);
	}
	remove(userId) {
		return this._action('remove', userId);
	}
	mute(userId) {
		return this._action('mute', userId);
	}
	unmute(userId) {
		return this._action('unmute', userId);
	}

	// ── DM threads ────────────────────────────────────────────────────────────
	async openThread(friendId) {
		this.openWith = friendId;
		await this.loadThread(friendId);
		// Opening a thread reads it server-side; reflect that locally.
		const f = this.friend(friendId);
		if (f && f.unread) {
			f.unread = 0;
			this._emit();
		}
		this._stopThreadPoll();
		if (this._active) {
			this._threadTimer = setInterval(() => this.loadThread(friendId, { quiet: true }), THREAD_POLL_MS);
		}
	}

	closeThread() {
		this.openWith = null;
		this._stopThreadPoll();
		this._emit();
	}

	async loadThread(friendId, { quiet = false } = {}) {
		try {
			const res = await apiFetch(`/api/friends/messages?with=${encodeURIComponent(friendId)}`, {
				allowAnonymous: true,
			});
			if (!res.ok) throw new Error(`thread ${res.status}`);
			const { data } = await res.json();
			this.threads.set(friendId, data.messages || []);
			if (!quiet || this.openWith === friendId) this._emit();
		} catch (err) {
			if (!quiet) console.warn('[friends] thread load failed:', err?.message);
		}
	}

	// Send a DM. Optimism is avoided on purpose: the server enforces friendship,
	// mutes, length, and rate limits, so we surface its result rather than
	// guessing. The sent message is appended on success.
	async sendDM(friendId, body) {
		const text = String(body || '').trim();
		if (!text) return;
		const res = await apiFetch('/api/friends/messages', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ to: friendId, body: text }),
		});
		if (!res.ok) {
			const b = await res.json().catch(() => ({}));
			const err = new Error(b.error_description || 'could not send');
			err.code = b.error;
			throw err;
		}
		const { data } = await res.json();
		if (data.message) {
			const thread = this.threads.get(friendId) || [];
			thread.push({ ...data.message, mine: true, read: true });
			this.threads.set(friendId, thread);
			this._emit();
		}
		return data;
	}

	// ── realtime ────────────────────────────────────────────────────────────
	// Route a 'social' message forwarded from the realm-room socket. Live DMs are
	// appended to the right thread (or bump the unread badge); friend-graph events
	// trigger a refresh so requests/lists update without the user reopening.
	handleSocial(msg) {
		if (!msg || typeof msg !== 'object') return;
		switch (msg.type) {
			case 'dm': {
				const m = msg.message;
				if (!m) return;
				const friendId = m.from;
				const thread = this.threads.get(friendId) || [];
				// Guard against the live push racing a poll that already fetched it.
				if (!thread.some((x) => x.id === m.id)) {
					thread.push({ ...m, mine: false, read: this.openWith === friendId });
					this.threads.set(friendId, thread);
				}
				if (this.openWith === friendId) {
					// Reading it now — clear server-side unread too.
					this.loadThread(friendId, { quiet: true });
				} else {
					const f = this.friend(friendId);
					if (f) f.unread = (f.unread || 0) + 1;
				}
				this._emit();
				break;
			}
			case 'friend_request':
			case 'friend_accept':
				this.refresh();
				break;
			default:
				break;
		}
	}
}

// One shared client per page — the panel and the net wiring both reference it.
let _client = null;
export function friendsClient() {
	if (!_client) _client = new FriendsClient();
	return _client;
}
