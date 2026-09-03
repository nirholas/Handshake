// The backpressure ladder for the Home lane.
//
// One instance of this process holds live WebSocket connections to real houses
// and fans their state out to browsers over SSE. Both of those are long lived,
// so this lane runs out of room in a way a request/response lane never does:
// not as a spike in latency, but as a wall.
//
// This module is where that wall is decided, and it is deliberately separate
// from the pool that hits it. The pool (api/_lib/home/runtime.js) owns sockets;
// this owns the policy, so the policy is a pure function of counters and can be
// tested exhaustively without a single socket.
//
// The ladder, in order. The system degrades in latency and in features, never
// in correctness and never in safety:
//
//   1. Under the per-instance cap ......... normal. Everything pooled.
//   2. At the cap .......................... a new acquisition gets a
//                                            short-lived UNPOOLED connection.
//                                            Slower, and correct.
//   3. Under database pressure ............. reads serve from the in-memory
//                                            graph. Writes still go through,
//                                            because a write is somebody
//                                            pressing a button.
//   4. Under severe load ................... SSE stream admission is limited
//                                            BEFORE action admission is. A user
//                                            who asks to unlock a door gets
//                                            served before a user who is
//                                            watching a dashboard.
//   5. Beyond that ......................... 503 with retry-after, and a
//                                            designed UI state. Never a silent
//                                            hang, never a half-applied action.
//
// The one thing that never moves:
//
//   THE GATE NEVER DEGRADES. No load condition may cause a guarded action to
//   skip its confirmation. `requiresConfirmation` below is computed from the
//   request alone and never reads a counter, and when there is no room left the
//   action is SHED, never waved through. If shedding load would require
//   weakening the gate, we shed the action instead.

/** The rungs, in the order the system climbs them. */
export const RUNG = Object.freeze({
	NORMAL: 'normal',
	UNPOOLED: 'unpooled',
	DEGRADED_READ: 'degraded_read',
	SHED_STREAMS: 'shed_streams',
	SHED: 'shed',
});

/** Where a read may be served from. */
export const READ_SOURCE = Object.freeze({
	DATABASE: 'database',
	GRAPH: 'graph',
});

/**
 * Defaults, every one of them derived from a measurement in
 * docs/ops/home-operations.md rather than picked to look round. Change them there
 * and here together, or the document stops being true.
 */
export const ADMISSION_DEFAULTS = Object.freeze({
	/** Pooled live house connections per instance. */
	maxPooled: 600,
	/** Short-lived connections opened past the pool cap, at any one moment. */
	maxUnpooled: 60,
	/** Concurrent SSE subscribers per instance. */
	maxStreams: 900,
	/** Actions in flight at any one moment. */
	maxInflightActions: 120,
	/**
	 * The fraction of action capacity at which streams stop being admitted.
	 *
	 * This number is the whole of rung 4. Below it, a dashboard and a door
	 * compete on equal terms; above it, the door wins. It is deliberately well
	 * under 1 so that streams have already stopped being accepted by the time
	 * actions are anywhere near their own ceiling.
	 */
	streamYieldRatio: 0.75,
	/** What a shed response tells the client to wait, in seconds. */
	retryAfterSeconds: 5,
});

/**
 * Does this request need a human to say yes?
 *
 * Exported on its own, and taking no controller and no counters, because that
 * is the guarantee: there is no load state you can pass to this function,
 * because it does not accept one.
 *
 * @param {{ guarded?: boolean, confirmed?: boolean, allowed?: boolean }} request
 *   `guarded` comes from classifyCall/classifyMcpCall in the home-bridge safety
 *   module. `confirmed` is a human's explicit yes and is never set from model
 *   output. `allowed` is a standing per-entity grant the user created earlier.
 * @returns {boolean}
 */
export function requiresConfirmation({ guarded = false, confirmed = false, allowed = false } = {}) {
	return Boolean(guarded) && !confirmed && !allowed;
}

/**
 * @typedef {object} AdmissionVerdict
 * @property {boolean} admitted
 * @property {string} rung which rung of the ladder produced this verdict
 * @property {string} reason human readable, safe to show a user
 * @property {number|null} retryAfterSeconds set only on a refusal
 * @property {boolean} [requiresConfirmation] actions only; never load dependent
 * @property {'pooled'|'unpooled'|null} [connection] acquisitions only
 * @property {string} [source] reads only; where the answer came from
 */

/**
 * A per-instance admission controller.
 *
 * It is a counter and a policy, nothing else: no timers, no I/O, no globals. The
 * runtime increments and decrements it around work it actually does, and asks it
 * before starting work it might not be able to finish.
 *
 * @param {Partial<typeof ADMISSION_DEFAULTS>} [limits]
 */
export function createAdmissionController(limits = {}) {
	const config = { ...ADMISSION_DEFAULTS, ...limits };
	for (const key of ['maxPooled', 'maxUnpooled', 'maxStreams', 'maxInflightActions']) {
		if (!Number.isFinite(config[key]) || config[key] < 0) {
			throw new TypeError(`admission: ${key} must be a non-negative number, got ${config[key]}`);
		}
	}

	let pooled = 0;
	let unpooled = 0;
	let streams = 0;
	let inflightActions = 0;
	let databaseHealthy = true;

	const counters = {
		streamsShed: 0,
		actionsShed: 0,
		unpooledOpened: 0,
		acquisitionsShed: 0,
		degradedReads: 0,
	};

	/** The floor above which a stream yields its place to an action. */
	const streamYieldFloor = () => config.maxInflightActions * config.streamYieldRatio;

	function rung() {
		if (inflightActions >= config.maxInflightActions) return RUNG.SHED;
		if (streams >= config.maxStreams || inflightActions >= streamYieldFloor()) return RUNG.SHED_STREAMS;
		if (!databaseHealthy) return RUNG.DEGRADED_READ;
		if (pooled >= config.maxPooled) return RUNG.UNPOOLED;
		return RUNG.NORMAL;
	}

	const refuse = (reason, at) => ({ admitted: false, rung: at, reason, retryAfterSeconds: config.retryAfterSeconds });

	return {
		config,

		/**
		 * Take a connection slot for a house.
		 *
		 * Rung 1 hands back a pooled slot. Rung 2 hands back an unpooled one,
		 * which the caller must close as soon as it is done rather than keeping:
		 * that is the whole difference, and it is why the verdict says which one
		 * it gave you instead of leaving you to guess.
		 *
		 * @returns {AdmissionVerdict}
		 */
		acquire() {
			if (pooled < config.maxPooled) {
				pooled++;
				return { admitted: true, rung: RUNG.NORMAL, connection: 'pooled', reason: '', retryAfterSeconds: null };
			}
			if (unpooled < config.maxUnpooled) {
				unpooled++;
				counters.unpooledOpened++;
				return {
					admitted: true,
					rung: RUNG.UNPOOLED,
					connection: 'unpooled',
					reason: 'This instance is at its pooled connection cap, so this home got a short-lived connection. It works the same and takes longer to open.',
					retryAfterSeconds: null,
				};
			}
			counters.acquisitionsShed++;
			return {
				...refuse('This region is at capacity for live homes right now. Your home is not disconnected; try again in a moment.', RUNG.SHED),
				connection: null,
			};
		},

		/** @param {'pooled'|'unpooled'} kind */
		release(kind) {
			if (kind === 'unpooled') unpooled = Math.max(0, unpooled - 1);
			else pooled = Math.max(0, pooled - 1);
		},

		/**
		 * May a browser open an SSE state stream?
		 *
		 * This is the first thing to go, on purpose. A dashboard that stops
		 * updating is an inconvenience; a door that will not lock is not.
		 *
		 * @returns {AdmissionVerdict}
		 */
		admitStream() {
			if (streams >= config.maxStreams) {
				counters.streamsShed++;
				return refuse('This instance is streaming as many homes as it can. The page will reconnect on its own.', RUNG.SHED_STREAMS);
			}
			if (inflightActions >= streamYieldFloor()) {
				counters.streamsShed++;
				return refuse('Live updates are paused while this instance finishes the actions people asked for. The page will reconnect on its own.', RUNG.SHED_STREAMS);
			}
			streams++;
			return { admitted: true, rung: rung(), reason: '', retryAfterSeconds: null };
		},

		closeStream() {
			streams = Math.max(0, streams - 1);
		},

		/**
		 * May an action run, and does it need a human first?
		 *
		 * The two questions are answered independently and that separation is the
		 * safety property. `requiresConfirmation` is a pure function of the
		 * request; `admitted` is a function of load. A saturated instance can
		 * refuse an action outright and it can never confirm one.
		 *
		 * @param {{ guarded?: boolean, confirmed?: boolean, allowed?: boolean }} [request]
		 * @returns {AdmissionVerdict}
		 */
		admitAction(request = {}) {
			const needsHuman = requiresConfirmation(request);
			if (inflightActions >= config.maxInflightActions) {
				counters.actionsShed++;
				return {
					...refuse('This instance is busy. Nothing was sent to your home, so nothing is half done. Try again in a moment.', RUNG.SHED),
					requiresConfirmation: needsHuman,
				};
			}
			inflightActions++;
			return { admitted: true, rung: rung(), reason: '', retryAfterSeconds: null, requiresConfirmation: needsHuman };
		},

		finishAction() {
			inflightActions = Math.max(0, inflightActions - 1);
		},

		/**
		 * Rung 3. The database being unreachable is a read problem, not a write
		 * problem: the live graph in this process already holds every entity
		 * state a read wants, and a write is somebody pressing a button and has
		 * to be attempted regardless.
		 *
		 * @param {boolean} healthy
		 */
		setDatabaseHealthy(healthy) {
			databaseHealthy = Boolean(healthy);
		},

		/** @returns {AdmissionVerdict} where a state read should be served from */
		admitRead() {
			if (databaseHealthy) {
				return { admitted: true, rung: rung(), source: READ_SOURCE.DATABASE, reason: '', retryAfterSeconds: null };
			}
			counters.degradedReads++;
			return {
				admitted: true,
				rung: RUNG.DEGRADED_READ,
				source: READ_SOURCE.GRAPH,
				reason: 'Showing live state from this instance. Saved history is briefly unavailable.',
				retryAfterSeconds: null,
			};
		},

		/**
		 * Rung 3, the other half. A write is never served from a degraded path
		 * and is never silently dropped: it is attempted, and if it fails the
		 * caller reports a designed error.
		 */
		writePolicy() {
			return { attempt: true, persistAudit: databaseHealthy };
		},

		/** Everything an operator or a metric needs, in one object. */
		snapshot() {
			return {
				rung: rung(),
				databaseHealthy,
				pooled,
				unpooled,
				streams,
				inflightActions,
				limits: { ...config },
				saturation: {
					pooled: config.maxPooled ? pooled / config.maxPooled : 1,
					streams: config.maxStreams ? streams / config.maxStreams : 1,
					actions: config.maxInflightActions ? inflightActions / config.maxInflightActions : 1,
				},
				counters: { ...counters },
			};
		},
	};
}

/**
 * The ladder as data, so the operations doc and any status page render the same
 * thing the code does rather than a prose copy of it that drifts.
 */
export function describeLadder(limits = {}) {
	const config = { ...ADMISSION_DEFAULTS, ...limits };
	return [
		{ rung: 1, id: RUNG.NORMAL, trigger: `pooled connections < ${config.maxPooled}`, behaviour: 'Everything pooled. No degradation.' },
		{ rung: 2, id: RUNG.UNPOOLED, trigger: `pooled connections at ${config.maxPooled}`, behaviour: 'New acquisitions get a short-lived unpooled connection. Slower, correct.' },
		{ rung: 3, id: RUNG.DEGRADED_READ, trigger: 'database unreachable', behaviour: 'Reads serve from the in-memory graph. Writes still go through; their audit rows are buffered.' },
		{ rung: 4, id: RUNG.SHED_STREAMS, trigger: `actions in flight at ${Math.floor(config.maxInflightActions * config.streamYieldRatio)} of ${config.maxInflightActions}, or streams at ${config.maxStreams}`, behaviour: 'SSE stream admission stops. Action admission continues.' },
		{ rung: 5, id: RUNG.SHED, trigger: `actions in flight at ${config.maxInflightActions}`, behaviour: `503 with retry-after ${config.retryAfterSeconds}s. Nothing is half applied, and no guarded action is ever waved through.` },
	];
}
