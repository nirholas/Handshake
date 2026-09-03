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
	#graph = { floors: [], rooms: [], unassigned: [] };
	#listeners = new Map();
	#rebuildTimer = null;
	#closed = false;

	/**
	 * @param {object} options
	 * @param {string} options.baseUrl the home's base URL, as the user typed it
	 * @param {string} options.token a Home Assistant long-lived access token
	 * @param {boolean} [options.requireSecure] reject plain http for remote hosts
	 * @param {string[]} [options.allowedEntities] entities pre-approved for guarded actions
	 * @param {number} [options.rebuildDelayMs] coalescing window for graph rebuilds
	 */
	constructor(options) {
		const { http } = normalizeBaseUrl(options?.baseUrl, { requireSecure: options?.requireSecure });
		if (!options?.token) throw new HomeBridgeError(ERR.AUTH, 'A Home Assistant long-lived access token is required.');
		this.#options = { ...options, baseUrl: http, rebuildDelayMs: options.rebuildDelayMs ?? 80 };
		this.allowList = createAllowList(options.allowedEntities || []);
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

		const auth = createLongLivedTokenAuth(this.#options.baseUrl, this.#options.token);
		try {
			this.#connection = await createConnection({ auth });
		} catch (err) {
			throw toBridgeError(err, this.#options.baseUrl);
		}

		this.#connection.addEventListener('ready', () => this.#emit('reconnected', undefined));
		this.#connection.addEventListener('disconnected', () => this.#emit('disconnected', undefined));

		this.#registries = await this.#loadRegistries();
		this.#unsubscribers.push(
			subscribeEntities(this.#connection, (entities) => {
				this.#states = entities;
				this.#scheduleRebuild();
			}),
		);

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
		this.#graph = buildHomeGraph({ ...this.#registries, states: this.#states });
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
