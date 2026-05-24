/**
 * Agent Action Protocol
 * ---------------------
 * The zero-dependency event bus that every module speaks through.
 * Every action emitted here is visible — agents are not invisible JSON.
 *
 * Actions flow: Skills → Protocol → Avatar (renders) + Identity (logs) + Memory (stores)
 */

export const ACTION_TYPES = {
	SPEAK: 'speak', // agent says something (text + sentiment)
	THINK: 'think', // agent is processing (internal monologue)
	GESTURE: 'gesture', // named body gesture (point, wave, nod, shrug)
	EMOTE: 'emote', // direct emotion injection (concern, celebrate…)
	LOOK_AT: 'look-at', // agent looks at a world position or object
	PERFORM_SKILL: 'perform-skill', // a skill is starting execution
	SKILL_DONE: 'skill-done', // a skill finished (success + result payload)
	SKILL_ERROR: 'skill-error', // a skill failed
	SENTIMENT_ANALYZED: 'sentiment-analyzed', // sentiment analysis was performed
	REMEMBER: 'remember', // agent stored a memory
	SIGN: 'sign', // agent signs an action with its wallet
	LOAD_START: 'load-start', // model/asset loading started
	LOAD_PROGRESS: 'load-progress', // model/asset download progress (bytes)
	LOAD_END: 'load-end', // model/asset loading finished
	VALIDATE: 'validate', // validation result (errors, warnings, hints)
	PRESENCE: 'presence', // agent came online / went idle
	PROTOCOL_ERROR: 'protocol-error', // emitted by the rate limiter on cascade detection
	INTERRUPTED: 'interrupted', // user spoke while agent was mid-TTS
	PERMISSIONS_REDEEM_START: 'permissions.redeem.start',
	PERMISSIONS_REDEEM_SUCCESS: 'permissions.redeem.success',
	PERMISSIONS_REDEEM_ERROR: 'permissions.redeem.error',
	NOTIFY: 'notify', // avatar walks into frame, delivers a message, retreats
};

// NOTE: 'brain:stream' and 'skill:tool-start' are Runtime EventTarget events, not protocol bus actions.
// They flow via runtime.dispatchEvent() and are re-dispatched on the host element as composed CustomEvents.
// Listen on the host element: element.addEventListener('brain:stream', handler)
//                             element.addEventListener('skill:tool-start', handler)

/**
 * @typedef {Object} ActionPayload
 * @property {string} type        — one of ACTION_TYPES
 * @property {Object} payload     — action-specific data
 * @property {number} timestamp   — Date.now()
 * @property {string} agentId     — identity id of the emitting agent
 * @property {string} [sourceSkill] — skill name if emitted by a skill
 */

/**
 * @typedef {{ mode: 'passthrough' }} PassthroughPolicy
 * @typedef {{ mode: 'throttle', leading: boolean, intervalMs: number }} ThrottlePolicy
 * @typedef {{ mode: 'debounce', intervalMs: number }} DebouncePolicy
 * @typedef {{ mode: 'coalesce', windowMs: number, key: (payload: Object) => string, merge: (a: Object, b: Object) => Object }} CoalescePolicy
 * @typedef {PassthroughPolicy|ThrottlePolicy|DebouncePolicy|CoalescePolicy} ThrottlePolicySpec
 */

// Default per-type policies for animation-driving events.
// Everything else passes through unchanged.
const _DEFAULT_POLICIES = [
	['gesture', { mode: 'throttle', leading: true, intervalMs: 600 }],
	[
		'emote',
		{
			mode: 'coalesce',
			windowMs: 150,
			key: (p) => p.trigger ?? 'default',
			merge: (a, b) => ({ ...b, weight: Math.max(a.weight ?? 0, b.weight ?? 0) }),
		},
	],
	['look-at', { mode: 'debounce', intervalMs: 100 }],
	// GLTFLoader's onProgress can fire dozens of times per second during a
	// fast download — without a policy it trips the burst rate-limiter and
	// floods the bus with protocol-error events. Coalesce to ~10fps,
	// keeping only the most-recent bytes-loaded so the progress bar
	// reflects the latest state.
	[
		'load-progress',
		{
			mode: 'coalesce',
			windowMs: 100,
			key: () => 'progress',
			merge: (_a, b) => b,
		},
	],
];

export class AgentProtocol extends EventTarget {
	constructor() {
		super();
		this._history = [];
		this._maxHistory = 200;

		// Coalescing / throttle policies
		this._policies = new Map(_DEFAULT_POLICIES);
		// Per-type runtime state for throttle/debounce/coalesce
		this._throttleState = new Map();
		// Suppressed event counters (post-policy, not emitted)
		this._droppedCounts = new Map();

		// Burst rate-limiter — absolute runaway protection for passthrough events
		this._counters = new Map(); // eventType → { count, windowStart }
		this._throttled = new Set(); // event types currently rate-limited
		this._limits = {
			'perform-skill': 10,
			emote: 20,
			speak: 5,
			'*': 100,
		};
		this._windowMs = 100;
		this._cooldownMs = 1000;

		/** Set to true at runtime to log all emits and bypass all policies. */
		this.debug = false;
	}

	/**
	 * Emit a typed action to all listeners.
	 * @param {Omit<ActionPayload, 'timestamp'>} action
	 */
	emit(action) {
		if (this.debug) {
			console.log(`[agent-protocol] ${Date.now()} ${action.type}`, action.payload);
			this._doEmit(action);
			return;
		}

		const policy = this._policies.get(action.type) ?? { mode: 'passthrough' };

		if (policy.mode === 'passthrough') {
			// Passthrough events go through the burst rate-limiter.
			if (this._isThrottled(action.type)) {
				console.warn(`[agent-protocol] rate-limited: ${action.type} — too many events`);
				return;
			}
			this._doEmit(action);
		} else {
			this._applyPolicy(policy, action);
		}
	}

	/**
	 * Override the throttle policy for a specific event type on this instance.
	 * Cancels any pending state (timers, coalesce buckets) for the type.
	 * @param {string} type
	 * @param {ThrottlePolicySpec} policy
	 */
	setThrottlePolicy(type, policy) {
		const state = this._throttleState.get(type);
		if (state?.timerId !== undefined) {
			clearTimeout(state.timerId);
		}
		this._throttleState.delete(type);
		this._policies.set(type, policy);
	}

	/**
	 * Number of events of this type that were suppressed (dropped) by the throttle layer.
	 * @param {string} type
	 * @returns {number}
	 */
	droppedCount(type) {
		return this._droppedCounts.get(type) ?? 0;
	}

	// ─── Policy dispatch ──────────────────────────────────────────────────────

	_applyPolicy(policy, action) {
		switch (policy.mode) {
			case 'throttle':
				this._applyThrottle(policy, action);
				break;
			case 'debounce':
				this._applyDebounce(policy, action);
				break;
			case 'coalesce':
				this._applyCoalesce(policy, action);
				break;
		}
	}

	// Leading-edge throttle: fire on first event in the interval, drop the rest.
	_applyThrottle(policy, action) {
		const now = performance.now();
		let state = this._throttleState.get(action.type);
		if (!state) {
			state = { lastFiredAt: -Infinity };
			this._throttleState.set(action.type, state);
		}

		if (now - state.lastFiredAt >= policy.intervalMs) {
			state.lastFiredAt = now;
			this._doEmit(action);
		} else {
			this._incrementDropped(action.type);
		}
	}

	// Trailing-edge debounce: only the last event in the quiet window is emitted.
	_applyDebounce(policy, action) {
		const type = action.type;
		let state = this._throttleState.get(type);
		if (!state) {
			state = {};
			this._throttleState.set(type, state);
		}

		if (state.timerId !== undefined) {
			clearTimeout(state.timerId);
			// Previous pending action is superseded and dropped.
			this._incrementDropped(type);
		}

		state.pendingAction = action;
		state.timerId = setTimeout(() => {
			const s = this._throttleState.get(type);
			if (s) {
				const pending = s.pendingAction;
				delete s.timerId;
				delete s.pendingAction;
				this._doEmit(pending);
			}
		}, policy.intervalMs);
	}

	// Coalesce: within the window, merge events by key; emit one per key at window end.
	// The merge function receives (existing_payload, new_payload) and returns the merged payload.
	_applyCoalesce(policy, action) {
		const type = action.type;
		let state = this._throttleState.get(type);
		if (!state) {
			state = { buckets: new Map() };
			this._throttleState.set(type, state);
		}

		const key = policy.key(action.payload ?? {});
		const existing = state.buckets.get(key);

		if (existing) {
			const merged = policy.merge(existing.payload ?? {}, action.payload ?? {});
			state.buckets.set(key, { ...action, payload: merged });
			// Incoming event merged into existing bucket — the raw event is suppressed.
			this._incrementDropped(type);
		} else {
			state.buckets.set(key, { ...action, payload: action.payload ?? {} });
		}

		if (state.timerId === undefined) {
			state.timerId = setTimeout(() => {
				const s = this._throttleState.get(type);
				if (s) {
					for (const pending of s.buckets.values()) {
						this._doEmit(pending);
					}
					s.buckets.clear();
					delete s.timerId;
				}
			}, policy.windowMs);
		}
	}

	_incrementDropped(type) {
		this._droppedCounts.set(type, (this._droppedCounts.get(type) ?? 0) + 1);
	}

	// ─── Core emit (post-policy) ──────────────────────────────────────────────

	_doEmit(action) {
		const full = {
			type: action.type,
			payload: action.payload ?? {},
			timestamp: Date.now(),
			agentId: action.agentId ?? 'default',
			sourceSkill: action.sourceSkill ?? null,
		};

		this._history.push(full);
		if (this._history.length > this._maxHistory) {
			this._history.shift();
		}

		this.dispatchEvent(new CustomEvent(full.type, { detail: full }));
		this.dispatchEvent(new CustomEvent('*', { detail: full }));
	}

	// ─── Burst rate-limiter (passthrough events only) ─────────────────────────

	_isThrottled(type) {
		if (this._throttled.has(type)) return true;

		const now = Date.now();
		const counter = this._counters.get(type) || { count: 0, windowStart: now };

		if (now - counter.windowStart > this._windowMs) {
			counter.count = 1;
			counter.windowStart = now;
			this._counters.set(type, counter);
			return false;
		}

		counter.count++;
		this._counters.set(type, counter);

		const limit = this._limits[type] ?? this._limits['*'];
		if (counter.count > limit) {
			this._throttle(type);
			return true;
		}
		return false;
	}

	_throttle(type) {
		this._throttled.add(type);
		if (type !== 'protocol-error') {
			this._dispatchDirect('protocol-error', {
				code: 'rate_limited',
				eventType: type,
				message: `Event type "${type}" rate-limited — too many emissions in ${this._windowMs}ms`,
			});
		}
		setTimeout(() => {
			this._throttled.delete(type);
			this._counters.delete(type);
		}, this._cooldownMs);
	}

	// Bypasses all policies and the rate limiter — only for internal protocol-error emission.
	_dispatchDirect(type, payload) {
		const full = {
			type,
			payload,
			timestamp: Date.now(),
			agentId: 'protocol',
			sourceSkill: null,
		};
		this._history.push(full);
		if (this._history.length > this._maxHistory) this._history.shift();
		this.dispatchEvent(new CustomEvent(type, { detail: full }));
		this.dispatchEvent(new CustomEvent('*', { detail: full }));
	}

	// ─── Subscription API ─────────────────────────────────────────────────────

	/**
	 * Subscribe to a specific action type (or '*' for all).
	 * @param {string} type
	 * @param {(action: ActionPayload) => void} handler
	 */
	on(type, handler) {
		this._wrap(type, handler, false);
	}

	/**
	 * Subscribe once.
	 * @param {string} type
	 * @param {(action: ActionPayload) => void} handler
	 */
	once(type, handler) {
		this._wrap(type, handler, true);
	}

	/**
	 * Unsubscribe. Must pass the same handler reference as used in on().
	 * @param {string} type
	 * @param {Function} handler
	 */
	off(type, handler) {
		if (handler.__protocolWrapped) {
			this.removeEventListener(type, handler.__protocolWrapped);
		} else {
			this.removeEventListener(type, handler);
		}
	}

	/** @returns {ActionPayload[]} Recent action history (newest last) */
	get history() {
		return this._history.slice();
	}

	/** Returns last N actions of a given type */
	recent(type, n = 10) {
		return this._history.filter((a) => a.type === type).slice(-n);
	}

	_wrap(type, handler, once) {
		const wrapped = (e) => handler(e.detail);
		handler.__protocolWrapped = wrapped;
		if (once) {
			this.addEventListener(type, wrapped, { once: true });
		} else {
			this.addEventListener(type, wrapped);
		}
	}
}

// Singleton — import this everywhere
export const protocol = new AgentProtocol();
export default protocol;
