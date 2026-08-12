/**
 * Agent Studio — shared reactive store (P0 foundation)
 * ====================================================
 *
 * ── Integration notes for P1–P5 ──────────────────────────────────────────────
 * This singleton (`studio`) is the one integration seam every sub-studio binds
 * to. It wraps the existing `AgentIdentity` (load + memory + id) — it does NOT
 * replace it. Read the live agent through `studio.agent` (a plain reactive
 * snapshot: { id, name, description, avatarId, skills[], meta, personaPrompt,
 * updatedAt }) and the real `AgentIdentity` (for memory, action log, on-chain)
 * through `studio.identity`.
 *
 * Persist by calling `studio.patch(partial)` — it deep-merges optimistically,
 * notifies subscribers synchronously, and flushes a debounced (~600ms) real
 * `PUT /api/agents/:id` via the shared `apiFetch` (CSRF + cookie handled).
 * Failed PUTs roll back the optimistic edit and emit `'error'`. Writes also
 * flush immediately on tab change (`visibilitychange`) and `beforeunload`, and
 * you can force a flush with `studio.commit()` (returns a Promise).
 *
 * Namespacing: each sub-studio owns ONE key under `meta.studio` —
 *   P1 → meta.studio.brain   P2 → meta.studio.memory
 *   P3 → meta.studio.body     P4 → meta.studio.trading
 * Patch only your key (`studio.patch({ meta: { studio: { brain: {...} } } })`);
 * the deep-merge preserves sibling bags. After mutating your domain, call
 * `studio.emit('brain:change', data)` so other studios + presence can react;
 * subscribe to others' domains with `studio.on('wallet:change', fn)`.
 *
 * Live avatar without persisting: `studio.preview(partial)` overlays a partial
 * onto `studio.agent` (and notifies subscribers) WITHOUT writing to the server —
 * use it for "try this outfit/emotion" interactions; `studio.clearPreview()`
 * drops the overlay. Market/trade events flow through `studio.emitMarket(evt)` /
 * `studio.onMarket(fn)` and are mapped to avatar reactions by `<agent-presence>`.
 *
 * The store is framework-agnostic (no React/DOM deps) so it works on every page.
 *
 * ── P0 FOUNDATION ADDENDUM (routing, presence, server contract) ──────────────
 * • Route: the Studio shell lives at /agent-studio (pages/agent-studio.html →
 *   src/studio/studio-shell.js). Each tab is an empty <section
 *   data-studio-mount="brain|memory|body|money|skills"> with a designed empty
 *   state — mount your sub-studio there and remove its `.studio-empty`. The shell
 *   fires document `studio-shell:ready` (detail:{ studio, agent }) once loaded.
 * • Presence: <agent-presence> (src/studio/agent-presence.js) renders this same
 *   live agent anywhere (modes: stage|companion|mini) and auto-syncs to this
 *   store. It maps `studio.emitMarket({ type })` events to avatar reactions — so
 *   P4/P5 only need to emit (e.g. 'snipe:filled', 'position:down'); the avatar
 *   celebrates/worries with no extra wiring.
 * • Server: PUT /api/agents/:id persists meta.studio. Write ONLY your domain
 *   namespace (brain|memory|body|money|trading|skills) — the server whitelists
 *   top-level keys (api/agents.js validateStudioMeta) and size-limits the bag;
 *   an unknown key 400s. The decorated record exposes `updated_at` for reconcile.
 */

import { AgentIdentity } from '../agent-identity.js';
import { apiFetch } from '../api.js';

const DEBOUNCE_MS = 600;

// Fields the studio owns on the agent record and is allowed to PUT. Keeping this
// explicit prevents an accidental patch from trying to write a read-only/derived
// column.
const WRITABLE = new Set(['name', 'description', 'avatarId', 'skills', 'meta', 'personaPrompt', 'homeUrl']);

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `src` into `dst` for plain objects; arrays and scalars replace.
// Returns a new object (never mutates inputs) so optimistic snapshots stay frozen.
function deepMerge(dst, src) {
	const out = Array.isArray(dst) ? [...dst] : { ...dst };
	for (const [k, v] of Object.entries(src)) {
		if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
		else out[k] = isPlainObject(v) ? deepMerge({}, v) : v;
	}
	return out;
}

class AgentStudioStore {
	constructor() {
		/** @type {AgentIdentity|null} */
		this.identity = null;
		this._record = null; // last committed snapshot (server-authoritative baseline)
		this._optimistic = null; // pending un-flushed local edits, merged over _record
		this._preview = null; // ephemeral overlay (never persisted)
		this._subscribers = new Set();
		this._events = new Map(); // event name → Set<fn>
		this._marketListeners = new Set();
		this._loadPromise = null;

		this._flushTimer = null;
		this._inflight = null; // Promise of the current PUT
		this._pendingResolve = null; // resolves the commit() promise once the next flush lands

		this._bindLifecycle();
	}

	// ── Load ────────────────────────────────────────────────────────────────

	/**
	 * Load the caller's agent (auto-creates a default via /api/agents/me).
	 * @param {{ agentId?: string }} [opts]
	 */
	async load({ agentId = null } = {}) {
		if (this._loadPromise) return this._loadPromise;
		this._loadPromise = (async () => {
			try {
				this.identity = new AgentIdentity({ agentId, autoLoad: false });
				await this.identity.load();
				// AgentIdentity never throws on a dead backend: it falls back to a
				// localStorage copy, or synthesises a default whose id exists nowhere
				// on the server. Editing that record looks normal and silently fails
				// on every PUT, so the studio treats it as a load failure instead.
				// Callers then render their real, retryable error state.
				if (!this.identity.backendConfirmed) {
					throw Object.assign(new Error('agent could not be confirmed with the server'), {
						code: 'not_confirmed',
					});
				}
				this._record = this._snapshotFromIdentity();
				this._notify();
				return this._record;
			} catch (err) {
				// Clear so the next load() call retries rather than returning this stale
				// rejected promise forever (which would break the shell's retry button).
				this._loadPromise = null;
				throw err;
			}
		})();
		return this._loadPromise;
	}

	_snapshotFromIdentity() {
		const id = this.identity;
		return {
			id: id.id,
			name: id.name,
			description: id.description,
			avatarId: id.avatarId,
			skills: [...(id.skills || [])],
			meta: structuredClone(id.meta || {}),
			personaPrompt: id._record?.persona_prompt || '',
			updatedAt: id._record?.updated_at || null,
			isOwner: id.isOwner,
		};
	}

	// ── Reactive read ─────────────────────────────────────────────────────────

	/** The live agent snapshot: committed baseline + optimistic edits + preview overlay. */
	get agent() {
		let view = this._record || {};
		if (this._optimistic) view = deepMerge(view, this._optimistic);
		if (this._preview) view = deepMerge(view, this._preview);
		return view;
	}

	get isLoaded() {
		return !!this._record;
	}

	/** Convenience accessor for this agent's brain graph bag (P1). */
	get brain() {
		return this.agent.meta?.studio?.brain || null;
	}

	/**
	 * Subscribe to any change to the live agent snapshot (patch, preview, reconcile).
	 * @param {(agent:object)=>void} fn
	 * @returns {()=>void} unsubscribe
	 */
	subscribe(fn) {
		this._subscribers.add(fn);
		if (this._record) {
			try { fn(this.agent); } catch (e) { console.error('[studio] subscriber threw', e); }
		}
		return () => this._subscribers.delete(fn);
	}

	_notify() {
		const snap = this.agent;
		for (const fn of this._subscribers) {
			try { fn(snap); } catch (e) { console.error('[studio] subscriber threw', e); }
		}
	}

	// ── Domain event bus ────────────────────────────────────────────────────

	on(event, fn) {
		if (!this._events.has(event)) this._events.set(event, new Set());
		this._events.get(event).add(fn);
		return () => this._events.get(event)?.delete(fn);
	}

	emit(event, data) {
		const set = this._events.get(event);
		if (!set) return;
		for (const fn of set) {
			try { fn(data); } catch (e) { console.error(`[studio] '${event}' listener threw`, e); }
		}
	}

	// ── Market / trade events (presence reacts) ───────────────────────────────

	emitMarket(evt) {
		for (const fn of this._marketListeners) {
			try { fn(evt); } catch (e) { console.error('[studio] market listener threw', e); }
		}
	}

	onMarket(fn) {
		this._marketListeners.add(fn);
		return () => this._marketListeners.delete(fn);
	}

	// ── Ephemeral preview (no persist) ─────────────────────────────────────────

	preview(partial) {
		if (!isPlainObject(partial)) return;
		this._preview = this._preview ? deepMerge(this._preview, partial) : deepMerge({}, partial);
		this._notify();
	}

	clearPreview() {
		if (!this._preview) return;
		this._preview = null;
		this._notify();
	}

	// ── Optimistic patch + debounced persist ───────────────────────────────────

	/**
	 * Optimistically merge `partial` into the agent and schedule a debounced PUT.
	 * @param {Partial<{name,description,avatarId,skills,meta,personaPrompt,homeUrl}>} partial
	 */
	patch(partial) {
		if (!isPlainObject(partial) || !this._record) return;
		const clean = {};
		for (const [k, v] of Object.entries(partial)) {
			if (WRITABLE.has(k)) clean[k] = v;
			else console.warn(`[studio] patch ignored unknown field: ${k}`);
		}
		if (!Object.keys(clean).length) return;
		this._optimistic = this._optimistic ? deepMerge(this._optimistic, clean) : deepMerge({}, clean);
		this._notify();
		this._scheduleFlush();
		// Any domain editing the agent drives the shell's single save indicator.
		this.emit('save:pending');
	}

	_scheduleFlush() {
		if (this._flushTimer) clearTimeout(this._flushTimer);
		this._flushTimer = setTimeout(() => this.commit(), DEBOUNCE_MS);
	}

	/**
	 * Flush any pending optimistic edits to the server immediately.
	 * @returns {Promise<object|null>} the reconciled agent snapshot (or null if nothing pending)
	 */
	async commit() {
		if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
		// Coalesce concurrent flushes: wait for the in-flight PUT, then flush whatever
		// accumulated since.
		if (this._inflight) {
			await this._inflight.catch(() => {});
			if (this._optimistic) return this.commit();
			return this._record;
		}
		if (!this._optimistic || !this._record?.id) return this._record;

		const pending = this._optimistic;
		this._optimistic = null;
		const baseline = this._record; // rollback target
		const optimisticRecord = deepMerge(baseline, pending);
		this._record = optimisticRecord; // adopt optimistically so subscribers stay consistent

		const body = this._toApiBody(pending, optimisticRecord);

		this._inflight = (async () => {
			try {
				const resp = await apiFetch(`/api/agents/${baseline.id}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!resp.ok) {
					const detail = await resp.json().catch(() => ({}));
					throw Object.assign(new Error(detail?.error?.message || `PUT ${resp.status}`), { status: resp.status });
				}
				const { agent } = await resp.json();
				this._reconcile(agent, optimisticRecord);
				this.emit('save:ok');
				return this._record;
			} catch (err) {
				// Roll back the optimistic edit; re-queue nothing (the edit is lost on
				// purpose so the UI reflects the true server state). Surface for the UI.
				this._record = baseline;
				this._notify();
				this.emit('error', { op: 'patch', error: err, status: err.status });
				console.error('[studio] patch PUT failed, rolled back:', err.message);
				throw err;
			} finally {
				this._inflight = null;
				if (this._pendingResolve) { this._pendingResolve(); this._pendingResolve = null; }
			}
		})();

		return this._inflight;
	}

	// Build the PUT body from the changed fields, mapping camelCase → API snake_case.
	// `meta` is always sent in full (the server shallow-merges top-level meta keys,
	// so sending the whole object preserves sibling bags like onchain/token/wallet
	// while replacing meta.studio with our current view).
	_toApiBody(pending, record) {
		const body = {};
		if ('name' in pending) body.name = record.name;
		if ('description' in pending) body.description = record.description;
		if ('avatarId' in pending) body.avatar_id = record.avatarId;
		if ('skills' in pending) body.skills = record.skills;
		if ('homeUrl' in pending) body.home_url = record.homeUrl;
		if ('personaPrompt' in pending) body.persona_prompt = record.personaPrompt;
		if ('meta' in pending) body.meta = record.meta;
		return body;
	}

	// Reconcile the server response with our optimistic record. The server is
	// authoritative for derived fields (updated_at); we keep our optimistic values
	// for anything we just wrote so a slow round-trip doesn't visibly "snap back".
	_reconcile(serverAgent, optimisticRecord) {
		const serverUpdated = serverAgent?.updated_at || serverAgent?.updatedAt || null;
		this._record = {
			...optimisticRecord,
			meta: serverAgent?.meta ? deepMerge(optimisticRecord.meta, serverAgent.meta) : optimisticRecord.meta,
			personaPrompt: typeof serverAgent?.persona_prompt === 'string'
				? serverAgent.persona_prompt
				: optimisticRecord.personaPrompt,
			updatedAt: serverUpdated,
		};
		// Keep the underlying AgentIdentity's persisted record in sync so other
		// consumers reading `studio.identity` (e.g. the memory layer) see fresh meta.
		if (this.identity?._record) {
			this.identity._record.meta = this._record.meta;
			this.identity._record.persona_prompt = this._record.personaPrompt;
			try { this.identity._persist(); } catch {}
		}
		this._notify();
	}

	_bindLifecycle() {
		if (typeof document === 'undefined') return;
		const flush = () => { if (this._optimistic) this.commit().catch(() => {}); };
		// visibilitychange→hidden is the reliable "page is going away" signal (fires
		// on tab switch, navigation, and close before the page tears down) and lets
		// the real CSRF-bearing apiFetch PUT complete. A plain sendBeacon can't carry
		// the single-use CSRF token, so it would 403 — we don't ship that path.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') flush();
		});
		window.addEventListener('pagehide', flush);
	}
}

export const studio = new AgentStudioStore();
export default studio;
