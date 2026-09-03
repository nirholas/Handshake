import {
	callService,
	createConnection,
	createLongLivedTokenAuth,
	ERR_CANNOT_CONNECT,
	ERR_CONNECTION_LOST,
	ERR_INVALID_AUTH,
	ERR_INVALID_HTTPS_TO_HTTP,
	subscribeEntities,
} from 'home-assistant-js-websocket';

import { ERR, HomeBridgeError } from './errors.js';
import { resolveIntent } from './intents.js';
import { buildHomeGraph, domainOf } from './rooms.js';
import { classifyCall, createAllowList } from './safety.js';
import { normalizeBaseUrl } from './url.js';

/**
 * One live connection to one home.
 *
 * The state channel is Home Assistant's own WebSocket API through the
 * first-party `home-assistant-js-websocket` client, which reconnects and
 * resubscribes on its own. Everything above it (the room graph, the safety
 * gate, intent resolution) is a pure function of what arrives on that socket,
 * so a reconnect restores the whole surface without special cases.
 */
export class HomeBridge {
	#options;
	#connection = null;
	#unsubscribers = [];
	#states = {};
	#registries = { floors: [], areas: [], devices: [], entities: [] };
	#config = null;
	#graph = { floors: [], rooms: [], unassigned: [], temperatureUnit: null };
	#listeners = new Map();
	#rebuildTimer = null;
	#registryTimer = null;
	#closed = false;

	/**
	 * @param {object} options
	 * @param {string} [options.baseUrl] the home's base URL, as the user typed it.
	 *   Required for a direct connection; unused when a transport is supplied.
	 * @param {string} [options.token] a Home Assistant long-lived access token.
	 *   Required for a direct connection; a relayed home has none, by design.
	 * @param {{ createSocket: Function, endpoint?: string, relayId?: string }} [options.transport]
	 *   an alternative way to reach this house, in place of dialling its URL.
	 *   `createRelayTransport` in transport-relay.js builds the one the dial-out
	 *   add-on uses, for the majority of installs that only exist on a LAN. It is
	 *   an EITHER/OR with baseUrl + token: a relayed home authenticates inside the
	 *   house and three.ws never holds a Home Assistant credential for it.
	 * @param {Function} [options.createSocket] a `home-assistant-js-websocket`
	 *   socket factory, for a server that must pin the connection to addresses it
	 *   already validated (see api/_lib/home-url-guard.js). Browser callers omit it.
	 * @param {boolean} [options.requireSecure] reject plain http for remote hosts
	 * @param {string[]} [options.allowedEntities] entities pre-approved for guarded actions
	 * @param {number} [options.rebuildDelayMs] coalescing window for graph rebuilds
	 */
	constructor(options) {
		const transport = options?.transport;
		if (transport && typeof transport.createSocket !== 'function') {
			throw new HomeBridgeError(ERR.BAD_URL, 'A transport must provide createSocket().');
		}
		// A relayed home has no URL of ours to dial and no token for us to hold,
		// so both checks below belong to the direct path only.
		const baseUrl = transport
			? transport.endpoint || `relay:${transport.relayId || 'home'}`
			: normalizeBaseUrl(options?.baseUrl, { requireSecure: options?.requireSecure }).http;
		if (!transport && !options?.token) throw new HomeBridgeError(ERR.AUTH, 'A Home Assistant long-lived access token is required.');
		this.#options = { ...options, baseUrl, rebuildDelayMs: options.rebuildDelayMs ?? 80 };
		this.allowList = createAllowList(options.allowedEntities || []);
	}

	/** How this bridge reaches its house: 'direct' or 'relay'. */
	get transport() {
		return this.#options.transport ? 'relay' : 'direct';
	}

	get baseUrl() {
		return this.#options.baseUrl;
	}

	get connected() {
		return Boolean(this.#connection?.connected);
	}

	/**
	 * The Home Assistant version this instance reported during the handshake, or
	 * null before connect(). Measured from the socket, never guessed: the connect
	 * screen and the capability record both have to state what the house actually
	 * is, and a version is how a support conversation starts.
	 */
	get haVersion() {
		return this.#connection?.haVersion || null;
	}

	/** The registries as loaded at connect: floors, areas, devices, entities. */
	get registries() {
		return this.#registries;
	}

	/** The room graph the 3D scene renders. Rebuilt on every state burst. */
	get graph() {
		return this.#graph;
	}

	/**
	 * The temperature unit this house measures in, as the instance itself
	 * reports it ('\u00b0C' or '\u00b0F'), or null before connect(). Read, never
	 * guessed: a browser locale says where the reader is, not what the
	 * thermostat is set to, and an American house browsed from Berlin is still
	 * in Fahrenheit.
	 */
	get temperatureUnit() {
		return this.#config?.unit_system?.temperature || null;
	}

	/** Raw entity states, keyed by entity id. */
	get states() {
		return this.#states;
	}

	on(event, handler) {
		if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
		this.#listeners.get(event).add(handler);
		return () => this.off(event, handler);
	}

	off(event, handler) {
		this.#listeners.get(event)?.delete(handler);
	}

	#emit(event, payload) {
		for (const handler of this.#listeners.get(event) || []) {
			try {
				handler(payload);
			} catch (err) {
				// A listener that throws must not take the socket down with it.
				if (event !== 'error') this.#emit('error', err);
			}
		}
	}

	/** Opens the state channel and loads the registries. Resolves once the graph is ready. */
	async connect() {
		if (this.#closed) throw new HomeBridgeError(ERR.NOT_CONNECTED, 'This bridge was closed. Create a new one.');
		if (this.#connection) return this.#graph;

		// Either seam of `home-assistant-js-websocket`: `auth` makes it dial the
		// house itself, `createSocket` hands it a socket we opened. Everything
		// after this line is identical for both, which is the whole point.
		const connectionOptions = this.#options.transport
			? { createSocket: this.#options.transport.createSocket }
			: {
					auth: createLongLivedTokenAuth(this.#options.baseUrl, this.#options.token),
					// A server dialling a user-supplied URL supplies its own socket
					// factory so the connection is pinned to the addresses its SSRF
					// guard validated. In the browser there is nothing to pin and the
					// option is simply absent.
					...(this.#options.createSocket ? { createSocket: this.#options.createSocket } : {}),
				};
		try {
			this.#connection = await createConnection(connectionOptions);
		} catch (err) {
			throw toBridgeError(err, this.#options.baseUrl);
		}

		guardSubscriptions(this.#connection, (err) =>
			this.#emit('error', toBridgeError(err, this.#options.baseUrl, 'A state subscription could not be established.')),
		);

		this.#connection.addEventListener('ready', () => this.#emit('reconnected', undefined));
		this.#connection.addEventListener('disconnected', () => this.#emit('disconnected', undefined));

		[this.#registries, this.#config] = await Promise.all([this.#loadRegistries(), this.#loadConfig()]);
		this.#unsubscribers.push(
			subscribeEntities(this.#connection, (entities) => {
				this.#states = entities;
				this.#scheduleRebuild();
			}),
		);
		await this.#watchRegistries();

		await this.#waitForFirstStates();
		this.#rebuild();
		this.#emit('ready', this.#graph);
		return this.#graph;
	}

	async #waitForFirstStates() {
		if (Object.keys(this.#states).length) return;
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			const stop = this.on('graph', () => {
				clearTimeout(timer);
				stop();
				resolve();
			});
		});
	}

	/**
	 * Keep the registries live.
	 *
	 * They were loaded once, at connect, and never again. Everything the room
	 * graph is made of lives in them: which room an entity is in, what a room is
	 * called, which floor it is on. So renaming a room, creating one, or filing a
	 * device into an area changed nothing on screen until the pooled socket
	 * happened to be recycled, which is minutes later or never. A user who just
	 * assigned their kitchen light to the kitchen watched nothing happen.
	 *
	 * Home Assistant announces every one of those changes on the same socket. We
	 * listen, reload the four lists once per burst, and rebuild.
	 *
	 * The reload is coalesced because assigning ten entities to an area emits ten
	 * events, and each reload is four round trips.
	 */
	async #watchRegistries() {
		const events = [
			'area_registry_updated',
			'device_registry_updated',
			'entity_registry_updated',
			'floor_registry_updated',
		];
		for (const event_type of events) {
			try {
				const stop = await this.#connection.subscribeEvents(() => this.#scheduleRegistryReload(), event_type);
				this.#unsubscribers.push(stop);
			} catch {
				// An instance too old to know one of these events is not broken; it
				// just keeps the connect-time registries for that dimension.
			}
		}
	}

	#scheduleRegistryReload() {
		if (this.#registryTimer) return;
		this.#registryTimer = setTimeout(async () => {
			this.#registryTimer = null;
			if (this.#closed || !this.#connection) return;
			try {
				this.#registries = await this.#loadRegistries();
			} catch {
				// A failed reload keeps the last good registries rather than emptying
				// the house, which is the rule everywhere else in this file too.
				return;
			}
			this.#rebuild();
		}, this.#options.registryReloadDelayMs ?? 400);
	}

	async #loadRegistries() {
		// floor_registry landed after the other three. An instance without it is
		// not broken, it just has no floors, so a failure here degrades to [].
		const [floors, areas, devices, entities] = await Promise.all([
			this.#list('config/floor_registry/list'),
			this.#list('config/area_registry/list'),
			this.#list('config/device_registry/list'),
			this.#list('config/entity_registry/list'),
		]);
		return { floors, areas, devices, entities };
	}

	// get_config carries the unit system, and it is the only place the house
	// states its own units. An instance that refuses it (an old core, a relay
	// that filters the message) leaves the unit null, and the scene falls back
	// to a bare degree sign rather than inventing a unit it cannot verify.
	async #loadConfig() {
		try {
			const result = await this.#connection.sendMessagePromise({ type: 'get_config' });
			return result && typeof result === 'object' ? result : null;
		} catch {
			return null;
		}
	}

	async #list(type) {
		try {
			const result = await this.#connection.sendMessagePromise({ type });
			return Array.isArray(result) ? result : [];
		} catch {
			return [];
		}
	}

	#scheduleRebuild() {
		if (this.#rebuildTimer) return;
		this.#rebuildTimer = setTimeout(() => {
			this.#rebuildTimer = null;
			this.#rebuild();
		}, this.#options.rebuildDelayMs);
	}

	#rebuild() {
		this.#graph = buildHomeGraph({
			...this.#registries,
			states: this.#states,
			temperatureUnit: this.temperatureUnit,
		});
		this.#emit('graph', this.#graph);
	}

	/**
	 * Call a Home Assistant service, subject to the physical-action gate.
	 *
	 * @param {string} domain e.g. "light"
	 * @param {string} service e.g. "turn_on"
	 * @param {object} [data] service data, including entity_id
	 * @param {{ confirmed?: boolean }} [options] confirmed:true is the user's
	 *   explicit yes for a guarded action. Never set it from model output.
	 */
	async call(domain, service, data = {}, options = {}) {
		this.#assertConnected();
		const entityId = firstEntityId(data);
		const verdict = classifyCall({
			domain,
			service,
			entityId,
			attributes: entityId ? this.#states[entityId]?.attributes : undefined,
		});

		if (verdict.guarded && !options.confirmed && !(entityId && this.allowList.has(entityId))) {
			const err = new HomeBridgeError(ERR.NEEDS_CONFIRMATION, verdict.reason);
			err.pending = { domain, service, data, risk: verdict.risk, entityId };
			throw err;
		}

		try {
			return await callService(this.#connection, domain, service, data);
		} catch (err) {
			throw toBridgeError(err, this.#options.baseUrl, `${domain}.${service} failed.`);
		}
	}

	/** Every scene and script in the house, as intent candidates. */
	macros() {
		const out = [];
		for (const [entityId, state] of Object.entries(this.#states)) {
			const domain = domainOf(entityId);
			if (domain !== 'scene' && domain !== 'script') continue;
			out.push({
				entityId,
				name: state.attributes?.friendly_name || entityId,
				kind: domain,
				aliases: [],
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * "Good night" to a real scene in this house, then run it.
	 *
	 * @param {string} phrase
	 * @param {{ confirmed?: boolean, dryRun?: boolean }} [options]
	 * @returns {Promise<{ ran: boolean, match: object|null }>}
	 */
	async activate(phrase, options = {}) {
		this.#assertConnected();
		const match = resolveIntent(phrase, this.macros());
		if (!match) return { ran: false, match: null };
		if (options.dryRun) return { ran: false, match };
		await this.call(match.kind, 'turn_on', { entity_id: match.entityId }, options);
		return { ran: true, match };
	}

	#assertConnected() {
		if (!this.#connection || this.#closed) {
			throw new HomeBridgeError(ERR.NOT_CONNECTED, 'Call connect() before using this bridge.');
		}
	}

	close() {
		this.#closed = true;
		if (this.#rebuildTimer) clearTimeout(this.#rebuildTimer);
		this.#rebuildTimer = null;
		if (this.#registryTimer) clearTimeout(this.#registryTimer);
		this.#registryTimer = null;
		for (const stop of this.#unsubscribers) {
			try {
				stop();
			} catch {
				// An unsubscribe that fails on an already dead socket is not an error.
			}
		}
		this.#unsubscribers = [];
		this.#connection?.close();
		this.#connection = null;
		this.#listeners.clear();
	}
}

/**
 * Stop a flapping house from killing the process.
 *
 * `home-assistant-js-websocket` re-establishes its subscriptions after a
 * reconnect in `Connection._setSocket`:
 *
 *     info.subscribe().then((unsub) => { info.unsubscribe = unsub; info.resolve(); });
 *
 * There is no rejection handler on that promise. A house whose uplink flaps can
 * drop the socket again while the resubscribe command is still in flight, the
 * command rejects with a `{ type: "result", success: false }` frame, and the
 * rejection reaches the process unobserved. Under Node's default
 * `--unhandled-rejections=throw` that TERMINATES the process, so one flapping
 * house takes down every other house's connection on the same server. Reproduced
 * against a real Home Assistant by scenario 2 of scripts/home-chaos.mjs, which
 * crashed exactly this way at the fifth flap.
 *
 * The bug is upstream and is reported there (see the package README). Until a
 * fix lands, this closes it at the one seam we own: the connection object the
 * library uses. `info.subscribe` is `() => this.subscribeMessage(...)`, which
 * resolves the method off the instance at call time, so replacing it here covers
 * the reconnect path as well as the first subscribe.
 *
 * The failure is REPORTED, not swallowed: it reaches the bridge's `error` event
 * with a real message. The resolved value is a no-op unsubscribe, which keeps
 * the library's own bookkeeping intact so the same subscription is retried on
 * the next `ready`.
 *
 * @param {object} connection a home-assistant-js-websocket Connection
 * @param {(err: unknown) => void} onError
 */
export function guardSubscriptions(connection, onError) {
	const report = (err) => {
		try {
			onError(err);
		} catch {
			// An error reporter that throws must not become the crash it exists to prevent.
		}
	};

	const original = connection.subscribeMessage.bind(connection);
	connection.subscribeMessage = (callback, message, options) =>
		original(callback, message, options).then(
			// BOTH ends of the subscription need this, and the second one is easy
			// to miss. `getCollection` tears a subscription down with
			// `unsubProm.then((unsub) => unsub())`, also with no catch, and
			// `info.unsubscribe` sends an `unsubscribe_events` command that rejects
			// the same way when the socket is already going. Guarding only the
			// subscribe leaves the process dying on close instead of on connect.
			(unsubscribe) => () => {
				try {
					const result = unsubscribe();
					if (result && typeof result.then === 'function') result.then(undefined, report);
					return result;
				} catch (err) {
					report(err);
					return undefined;
				}
			},
			(err) => {
				report(err);
				return () => {};
			},
		);
	return connection;
}

function firstEntityId(data) {
	const id = data?.entity_id;
	if (Array.isArray(id)) return id[0];
	return typeof id === 'string' ? id : undefined;
}

/**
 * The HA client throws bare numeric error codes. Translate them once, here, into
 * something a connect screen can actually say to a person.
 */
export function toBridgeError(err, baseUrl, prefix = '') {
	if (err instanceof HomeBridgeError) return err;
	const code = typeof err === 'number' ? err : err?.code;
	const say = (text) => (prefix ? `${prefix} ${text}` : text);
	switch (code) {
		case ERR_INVALID_AUTH:
			return new HomeBridgeError(ERR.AUTH, say('Home Assistant rejected that access token. Create a new long-lived token in your profile and try again.'), err);
		case ERR_CANNOT_CONNECT:
		case ERR_CONNECTION_LOST:
			return new HomeBridgeError(ERR.UNREACHABLE, say(`Could not reach ${baseUrl}. If it is only on your home network, three.ws cannot route to it: use your remote https URL.`), err);
		case ERR_INVALID_HTTPS_TO_HTTP:
			return new HomeBridgeError(ERR.BAD_URL, say('A page served over https cannot connect to a plain http home. Use your remote https URL.'), err);
		default:
			return new HomeBridgeError(ERR.CALL_FAILED, say(err?.message || String(err)), err);
	}
}
