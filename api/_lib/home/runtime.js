// The bridge runtime: one pool of live Home Assistant connections per process.
//
// `packages/home-bridge` opens one WebSocket per HomeBridge and holds it. This
// module decides who holds those sockets, for how long, and what happens when
// the house, the credential, or the container goes away.
//
// The three facts about our own deployment that shape every choice here were
// read off the running service, not assumed
// (`gcloud run services describe three-ws-api --region us-central1`):
//
//   * `minScale=6`, `maxScale=100`. There are always several instances and any
//     one of them may be recycled at any time.
//   * `sessionAffinity=false`. Two requests from the same browser land on
//     arbitrary instances, so a pooled socket is NEVER guaranteed to be there
//     for the next call. It is a cache with a good hit rate inside one request
//     and across the life of one SSE stream, and nothing more.
//   * `cpu-throttling=true`. Outside a request an instance gets close to no CPU,
//     so a background timer fires late or not at all and a held socket stops
//     draining frames. Eviction therefore runs on a timer AND opportunistically
//     on every acquire, and a pooled graph is always treated as possibly stale.
//
// The consequence, stated once so no caller has to rediscover it: the house is
// the source of truth, this pool is a cache, and a cold instance reopening in a
// few hundred milliseconds is the normal path rather than a failure.

import { ERR, HomeBridge, HomeBridgeError } from '@three-ws/home-bridge';

import {
	getConnection,
	getDecryptedToken,
	HOME_STATUS,
	listAllowedEntities,
	recordHandshake,
} from './store.js';

/**
 * Codes `acquire` adds to the bridge package's `ERR` vocabulary, so the route
 * layer in order 03 maps ONE union of codes instead of two tables.
 */
export const HOME_RUNTIME_ERR = Object.freeze({
	/** No such home for this user. Maps to 404, never 403: see store.getConnection. */
	NOT_FOUND: 'home_not_found',
	/** The home was disconnected; its ciphertext is gone and cannot be replayed. */
	REVOKED: 'home_revoked',
	/** Too many consecutive connect failures. Fails fast instead of timing out. */
	BREAKER_OPEN: 'home_breaker_open',
});

/** Long enough that a page navigation or a chat turn reuses the socket, short enough that an abandoned tab does not hold a stranger's house open. */
const IDLE_MS = 90_000;
/** A house behind a slow tunnel is common; a hang is not. */
const CONNECT_TIMEOUT_MS = 15_000;
/** A socket plus a state map is roughly 1 to 3 MB of heap for a large house. */
const DEFAULT_MAX_CONNECTIONS = 200;
/** Consecutive connect failures that open the breaker for one home. */
const BREAKER_THRESHOLD = 5;
/** How long a revoked token or an offline house stops being retried on every page load. */
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** The sweep cadence. Advisory only under CPU throttling, which is why acquire sweeps too. */
const SWEEP_MS = 30_000;

/**
 * Build a runtime over injectable dependencies.
 *
 * Every dependency defaults to the real one. Tests construct their own runtime
 * with a counting bridge factory instead of mutating a global, so two test files
 * can never leak pool state into each other.
 *
 * @param {object} [deps]
 * @param {(input: { baseUrl: string, token: string, allowedEntities: string[] }) => object} [deps.createBridge]
 * @param {typeof getConnection} [deps.getConnection]
 * @param {typeof getDecryptedToken} [deps.getDecryptedToken]
 * @param {typeof listAllowedEntities} [deps.listAllowedEntities]
 * @param {typeof recordHandshake} [deps.recordHandshake]
 * @param {() => number} [deps.now]
 * @param {number} [deps.maxConnections]
 * @param {number} [deps.idleMs]
 * @param {number} [deps.connectTimeoutMs]
 */
export function createHomeRuntime(deps = {}) {
	const createBridge = deps.createBridge || ((input) => new HomeBridge(input));
	const readConnection = deps.getConnection || getConnection;
	const readCredential = deps.getDecryptedToken || getDecryptedToken;
	const readAllowed = deps.listAllowedEntities || listAllowedEntities;
	const writeHandshake = deps.recordHandshake || recordHandshake;
	const now = deps.now || (() => Date.now());
	const maxConnections = deps.maxConnections ?? readMaxConnections();
	const idleMs = deps.idleMs ?? IDLE_MS;
	const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

	/** homeId -> pool entry. Keyed by home, not by user: a home has exactly one owner. */
	const entries = new Map();
	/** homeId -> { failures, openedUntil } */
	const breakers = new Map();
	let sweepTimer = null;

	/**
	 * Check out a live bridge for one home.
	 *
	 * @param {string} homeId
	 * @param {string} userId the caller, proved by the route layer. Ownership is
	 *   re-checked in SQL here, so a runtime call can never be the place an
	 *   ownership check was forgotten.
	 * @returns {Promise<{ bridge: object, release: () => void, entry: object }>}
	 */
	async function acquire(homeId, userId) {
		// Under CPU throttling the interval below is unreliable, so every acquire
		// pays for one cheap sweep. It is a Map walk over at most `maxConnections`.
		evictIdle(now());

		const breaker = breakers.get(homeId);
		if (breaker && breaker.openedUntil > now()) {
			const seconds = Math.ceil((breaker.openedUntil - now()) / 1000);
			throw new HomeBridgeError(
				HOME_RUNTIME_ERR.BREAKER_OPEN,
				`This home failed to connect ${breaker.failures} times in a row, so three.ws stopped retrying for ${seconds} more seconds. Check that it is online and that its access token is still valid, then reconnect it.`,
			);
		}

		const existing = entries.get(homeId);
		if (existing) {
			existing.refs += 1;
			try {
				await existing.ready;
			} catch (err) {
				existing.refs -= 1;
				throw err;
			}
			return handle(existing);
		}

		const credential = await loadCredential(homeId, userId);
		const pooled = entries.size < maxConnections;
		const entry = openEntry({ homeId, userId, credential, pooled });
		if (pooled) entries.set(homeId, entry);

		try {
			await entry.ready;
		} catch (err) {
			entries.delete(homeId);
			throw err;
		}
		startSweep();
		return handle(entry);
	}

	/**
	 * The shape every caller should use. Releases in a `finally`, so a throwing
	 * callback can never leak a socket.
	 *
	 * @template T
	 * @param {string} homeId
	 * @param {string} userId
	 * @param {(bridge: object) => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	async function withHome(homeId, userId, fn) {
		const { bridge, release } = await acquire(homeId, userId);
		try {
			return await fn(bridge);
		} finally {
			release();
		}
	}

	/**
	 * The current room graph, without holding a reference past the call. A page
	 * load wants this; an SSE stream wants `subscribe`.
	 *
	 * @param {string} homeId
	 * @param {string} userId
	 * @returns {Promise<{ graph: object, stale: boolean, connected: boolean, status: string }>}
	 */
	async function snapshot(homeId, userId) {
		return withHome(homeId, userId, (bridge) => {
			const entry = entries.get(homeId);
			return {
				graph: bridge.graph,
				stale: entry ? entry.stale : false,
				connected: Boolean(bridge.connected),
				status: entry ? entry.status : HOME_STATUS.CONNECTED,
			};
		});
	}

	/**
	 * A live subscription, for SSE. Holds a reference for its whole lifetime, so
	 * the socket stays open while a browser is watching and starts its idle clock
	 * the moment the last watcher leaves.
	 *
	 * The listener is called immediately with the current graph, then on every
	 * rebuild and on every connectivity change. It is NEVER called with an empty
	 * graph because the socket dropped: a user watching their 3D home sees it go
	 * grey and stale, never watches their house vanish.
	 *
	 * @param {string} homeId
	 * @param {string} userId
	 * @param {(event: { graph: object, stale: boolean, connected: boolean, status: string }) => void} onGraph
	 * @returns {Promise<() => void>} unsubscribe
	 */
	async function subscribe(homeId, userId, onGraph) {
		const { bridge, release, entry } = await acquire(homeId, userId);
		entry.subscribers.add(onGraph);
		let live = true;

		try {
			onGraph(eventFor(entry, bridge));
		} catch (err) {
			console.warn('[home-runtime] a subscriber threw on its first event', { homeId, error: err?.message });
		}

		return () => {
			if (!live) return;
			live = false;
			entry.subscribers.delete(onGraph);
			release();
		};
	}

	/**
	 * Close every pooled connection whose last reference was released more than
	 * the idle window ago. Exported so a test drives it deterministically rather
	 * than waiting out a wall clock.
	 *
	 * @param {number} [at] the current time in ms
	 * @returns {number} how many connections were closed
	 */
	function evictIdle(at = now()) {
		let closed = 0;
		for (const [homeId, entry] of entries) {
			if (entry.refs > 0) continue;
			if (entry.idleSince === null || at - entry.idleSince < idleMs) continue;
			closeEntry(entry);
			entries.delete(homeId);
			closed += 1;
		}
		if (!entries.size) stopSweep();
		return closed;
	}

	/**
	 * The health probe's view of this instance. Shaped for order 13.
	 * @returns {{ open: number, subscribers: number, pooledCap: number, breakersOpen: number, byStatus: Record<string, number> }}
	 */
	function stats() {
		const byStatus = {};
		let subscribers = 0;
		for (const entry of entries.values()) {
			byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
			subscribers += entry.subscribers.size;
		}
		let breakersOpen = 0;
		for (const breaker of breakers.values()) if (breaker.openedUntil > now()) breakersOpen += 1;
		return { open: entries.size, subscribers, pooledCap: maxConnections, breakersOpen, byStatus };
	}

	/**
	 * Drop one home's connection right now, whatever is still holding it.
	 *
	 * Revoking a home destroys its credential, but a socket opened a minute
	 * earlier is already authenticated and would keep delivering that house's
	 * state to any open SSE stream until the idle window expired. That is the
	 * difference between "disconnected" and "disconnected in ninety seconds", and
	 * only one of those is what the button said. `acquire` cannot re-open it
	 * afterwards: the store filters revoked rows, so the next checkout is a 404.
	 *
	 * @param {string} homeId
	 * @returns {boolean} true when this instance was holding one
	 */
	function closeHome(homeId) {
		const entry = entries.get(homeId);
		if (!entry) return false;
		entries.delete(homeId);
		closeEntry(entry);
		if (!entries.size) stopSweep();
		return true;
	}

	/**
	 * Close every connection this process holds. Wired to SIGTERM: a container
	 * that dies without closing leaves the user's Home Assistant holding dead
	 * connections until its own timeout expires.
	 * @returns {number} how many were closed
	 */
	function closeAll() {
		const count = entries.size;
		for (const entry of entries.values()) closeEntry(entry);
		entries.clear();
		stopSweep();
		return count;
	}

	async function loadCredential(homeId, userId) {
		const row = await readConnection(homeId, userId);
		if (!row) {
			throw new HomeBridgeError(
				HOME_RUNTIME_ERR.NOT_FOUND,
				'That home is not connected to this account.',
			);
		}

		let credential;
		try {
			credential = await readCredential(homeId, userId);
		} catch (cause) {
			// A ciphertext that will not decrypt is an account problem the user can
			// fix by reconnecting, not a 500. Say so, and mark the row so the
			// connect screen can explain it without opening a socket of its own.
			await writeHandshake(homeId, {
				status: HOME_STATUS.AUTH_FAILED,
				statusDetail: 'The stored access token could not be read. Reconnect this home to store a new one.',
			}).catch(() => null);
			throw new HomeBridgeError(ERR.AUTH, 'The stored access token for this home could not be read. Reconnect the home to store a new one.', cause);
		}

		if (!credential) {
			throw new HomeBridgeError(
				HOME_RUNTIME_ERR.REVOKED,
				'This home was disconnected. Reconnect it to control it again.',
			);
		}
		return credential;
	}

	function openEntry({ homeId, userId, credential, pooled }) {
		const entry = {
			homeId,
			userId,
			pooled,
			bridge: null,
			refs: 1,
			idleSince: null,
			openedAt: now(),
			stale: false,
			status: HOME_STATUS.PENDING,
			lastGraph: { floors: [], rooms: [], unassigned: [] },
			subscribers: new Set(),
			closed: false,
		};

		entry.ready = (async () => {
			const allowedEntities = await readAllowed(homeId).catch(() => []);
			const bridge = createBridge({ baseUrl: credential.baseUrl, token: credential.token, allowedEntities });
			entry.bridge = bridge;
			wireEvents(entry, bridge);

			try {
				const graph = await withTimeout(
					bridge.connect(),
					connectTimeoutMs,
					() => new HomeBridgeError(
						ERR.UNREACHABLE,
						`${credential.baseUrl} did not answer within ${Math.round(connectTimeoutMs / 1000)} seconds. If it is only on your home network, three.ws cannot route to it: use your remote https URL, or connect the three.ws add-on.`,
					),
				);
				entry.lastGraph = graph || entry.lastGraph;
				entry.status = HOME_STATUS.CONNECTED;
				entry.stale = false;
				onConnectSuccess(homeId, entry, bridge);
				return bridge;
			} catch (err) {
				entry.closed = true;
				try {
					bridge.close();
				} catch {
					// Closing a bridge that never opened is not an error.
				}
				onConnectFailure(homeId, err);
				throw err;
			}
		})();

		return entry;
	}

	function wireEvents(entry, bridge) {
		bridge.on('graph', (graph) => {
			// Never overwrite a real graph with an empty one. An empty house is
			// legitimate, but an empty burst arriving on a dying socket is not, and
			// the user must not watch their home vanish.
			if (graph) entry.lastGraph = graph;
			entry.stale = false;
			notify(entry, bridge);
		});
		bridge.on('disconnected', () => {
			entry.stale = true;
			entry.status = HOME_STATUS.UNREACHABLE;
			notify(entry, bridge);
		});
		bridge.on('reconnected', () => {
			entry.stale = false;
			entry.status = HOME_STATUS.CONNECTED;
			notify(entry, bridge);
		});
		bridge.on('error', (err) => {
			// Once per socket, not once per message: a malformed burst must not be
			// able to fill the log.
			if (entry.loggedError) return;
			entry.loggedError = true;
			console.warn('[home-runtime] bridge reported an error', { homeId: entry.homeId, error: err?.message || String(err) });
		});
	}

	function notify(entry, bridge) {
		if (!entry.subscribers.size) return;
		const event = eventFor(entry, bridge);
		for (const listener of entry.subscribers) {
			try {
				listener(event);
			} catch (err) {
				console.warn('[home-runtime] a subscriber threw', { homeId: entry.homeId, error: err?.message });
			}
		}
	}

	function eventFor(entry, bridge) {
		return {
			graph: entry.lastGraph,
			stale: entry.stale,
			connected: Boolean(bridge?.connected),
			status: entry.status,
		};
	}

	function onConnectSuccess(homeId, entry, bridge) {
		breakers.delete(homeId);
		const graph = entry.lastGraph;
		// Measured from the socket that just opened, never inferred. The store
		// merges capabilities, so writing the WebSocket half here cannot erase the
		// MCP half that verify.js measured at connect time.
		writeHandshake(homeId, {
			status: HOME_STATUS.CONNECTED,
			statusDetail: null,
			capabilities: {
				websocket: true,
				entityCount: Object.keys(bridge.states || {}).length,
				areaCount: graph?.rooms?.length ?? 0,
				floorCount: graph?.floors?.length ?? 0,
				haVersion: bridge.haVersion ?? null,
				measuredAt: new Date().toISOString(),
			},
		}).catch((err) => {
			console.warn('[home-runtime] handshake record dropped', { homeId, error: err?.message });
		});
	}

	function onConnectFailure(homeId, err) {
		const breaker = breakers.get(homeId) || { failures: 0, openedUntil: 0 };
		breaker.failures += 1;
		if (breaker.failures >= BREAKER_THRESHOLD) breaker.openedUntil = now() + BREAKER_COOLDOWN_MS;
		breakers.set(homeId, breaker);

		const status = err?.code === ERR.AUTH ? HOME_STATUS.AUTH_FAILED : HOME_STATUS.UNREACHABLE;
		writeHandshake(homeId, {
			status,
			statusDetail: breaker.openedUntil > now()
				? `${err?.message || 'This home did not answer.'} three.ws has paused retries for five minutes.`
				: err?.message || 'This home did not answer.',
		}).catch(() => null);
	}

	function handle(entry) {
		let released = false;
		return {
			bridge: entry.bridge,
			entry,
			release() {
				if (released) return;
				released = true;
				entry.refs -= 1;
				if (entry.refs > 0) return;
				entry.idleSince = now();
				// A connection that was never admitted to the pool (past the cap) has
				// nobody to evict it later, so it closes the moment it is done.
				if (!entry.pooled) closeEntry(entry);
			},
		};
	}

	function closeEntry(entry) {
		if (entry.closed) return;
		entry.closed = true;
		entry.subscribers.clear();
		try {
			entry.bridge?.close();
		} catch (err) {
			console.warn('[home-runtime] close threw on an already dead socket', { homeId: entry.homeId, error: err?.message });
		}
	}

	function startSweep() {
		if (sweepTimer) return;
		sweepTimer = setInterval(() => evictIdle(now()), SWEEP_MS);
		// Never hold the process open for a cache.
		sweepTimer.unref?.();
	}

	function stopSweep() {
		if (!sweepTimer) return;
		clearInterval(sweepTimer);
		sweepTimer = null;
	}

	return { acquire, withHome, snapshot, subscribe, evictIdle, stats, closeHome, closeAll };
}

function readMaxConnections() {
	const raw = Number(process.env.HOME_MAX_CONNECTIONS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CONNECTIONS;
}

function withTimeout(promise, ms, makeError) {
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(makeError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The process-wide runtime every endpoint should use. */
const runtime = createHomeRuntime();

export const acquire = runtime.acquire;
export const withHome = runtime.withHome;
export const snapshot = runtime.snapshot;
export const subscribe = runtime.subscribe;
export const evictIdle = runtime.evictIdle;
export const stats = runtime.stats;
export const closeHome = runtime.closeHome;
export const closeAll = runtime.closeAll;

// Cloud Run sends SIGTERM before it recycles a container. Closing here is the
// difference between a clean disconnect and the user's Home Assistant holding
// dead sockets until its own timeout expires. Registered once, and never in a
// test process, which imports createHomeRuntime directly.
if (!process.env.VITEST) {
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.once(signal, () => {
			const closed = closeAll();
			if (closed) console.log(`[home-runtime] closed ${closed} home connections on ${signal}`);
		});
	}
}
