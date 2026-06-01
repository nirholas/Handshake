// Social hub — the multiplayer server's half of the account-level friends
// system. It owns two responsibilities, both keyed to the verified account id
// (a users.id UUID resolved from a presence ticket), NOT the ephemeral Colyseus
// sessionId, so presence and delivery survive realm changes and reconnects:
//
//   1. Presence. While an account has at least one connected realm-room client,
//      `presence:<uid>` is written to Upstash Redis with a short TTL and
//      refreshed on a heartbeat. The Vercel friends API reads these keys to show
//      a friend's online/offline + current realm — accurately across separate
//      realm-room instances, and self-healing if this process dies (the TTL
//      lapses instead of pinning a ghost online forever).
//
//   2. Live delivery. A per-account registry of connected clients lets the
//      internal /internal/notify webhook (called by the API after it persists a
//      DM or friend event) push the event to every socket that account has open.
//      Offline recipients are covered by the durable Postgres queue the client
//      drains on next login, so nothing is ever lost.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.three_KV_REST_API_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.three_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || '';
const PRESENCE_PREFIX = 'presence:';
const PRESENCE_TTL_SEC = 75; // refreshed every 30s; lapses ~45s after a hard drop
const HEARTBEAT_MS = 30_000;

class SocialHub {
	constructor() {
		// uid → Map(client → realmLabel). One account can hold several sockets
		// (a second tab, or /walk + /play at once); we track each so delivery
		// fans out and presence only clears when the last one leaves.
		this._byUid = new Map();
		this._redis = null;
		this._redisReady = null;
		if (REDIS_URL && REDIS_TOKEN) {
			this._redisReady = import('@upstash/redis')
				.then(({ Redis }) => {
					this._redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
					console.log('[social-hub] presence: Upstash Redis');
				})
				.catch((err) => {
					this._redis = null;
					console.error('[social-hub] Redis unreachable — presence will not be visible to the friends API:', err?.message);
				});
		} else {
			console.log('[social-hub] presence DISABLED (set UPSTASH_REDIS_REST_URL/_TOKEN to publish presence)');
		}
		// One shared heartbeat refreshes every online account's TTL.
		this._heartbeat = setInterval(() => this._refreshAll(), HEARTBEAT_MS);
		if (typeof this._heartbeat.unref === 'function') this._heartbeat.unref();
	}

	// A realm room calls this on join once it has verified the presence ticket.
	register(uid, client, realm) {
		if (!uid || !client) return;
		let clients = this._byUid.get(uid);
		if (!clients) {
			clients = new Map();
			this._byUid.set(uid, clients);
		}
		clients.set(client, realm || null);
		this._writePresence(uid, realm);
	}

	// Realm room calls this on leave. Presence clears only when the account has
	// no remaining sockets anywhere.
	unregister(uid, client) {
		const clients = this._byUid.get(uid);
		if (!clients) return;
		clients.delete(client);
		if (clients.size === 0) {
			this._byUid.delete(uid);
			this._clearPresence(uid);
		} else {
			// Still online elsewhere — keep presence on a realm that's still live.
			const realm = [...clients.values()].pop();
			this._writePresence(uid, realm);
		}
	}

	// Push an event to every socket the account has open. Returns true if at
	// least one client received it (the API uses this to report live delivery).
	deliver(uid, type, payload = {}) {
		const clients = this._byUid.get(uid);
		if (!clients || clients.size === 0) return false;
		let sent = 0;
		for (const client of clients.keys()) {
			try {
				client.send('social', { type, ...payload });
				sent++;
			} catch (err) {
				console.warn('[social-hub] deliver failed:', err?.message);
			}
		}
		return sent > 0;
	}

	isOnline(uid) {
		const clients = this._byUid.get(uid);
		return !!(clients && clients.size > 0);
	}

	async _writePresence(uid, realm) {
		if (!this._redisReady) return;
		try {
			await this._redisReady;
			if (!this._redis) return;
			await this._redis.set(
				PRESENCE_PREFIX + uid,
				JSON.stringify({ realm: realm || null, ts: Date.now() }),
				{ ex: PRESENCE_TTL_SEC },
			);
		} catch (err) {
			console.warn('[social-hub] presence write failed:', err?.message);
		}
	}

	async _clearPresence(uid) {
		if (!this._redisReady) return;
		try {
			await this._redisReady;
			if (!this._redis) return;
			await this._redis.del(PRESENCE_PREFIX + uid);
		} catch (err) {
			console.warn('[social-hub] presence clear failed:', err?.message);
		}
	}

	// Re-stamp the TTL for every still-connected account so a long-lived session
	// never lapses to "offline" while the socket is open.
	_refreshAll() {
		if (!this._byUid.size) return;
		for (const [uid, clients] of this._byUid) {
			const realm = [...clients.values()].pop();
			this._writePresence(uid, realm);
		}
	}
}

// One hub shared by every room in the process — that shared registry is what
// lets a DM reach an account no matter which realm room it's connected through.
export const socialHub = new SocialHub();
