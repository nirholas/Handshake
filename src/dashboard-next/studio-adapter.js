/**
 * Per-agent Studio adapter (dashboard-next)
 * =========================================
 * The Agent Studio sub-studios (Money, Trading Brain, …) are written against a
 * `studio` object — the singleton in `src/studio/agent-studio-store.js`. That
 * singleton loads only the caller's OWN `me` agent, so it can't back a dashboard
 * that mounts those panels for many different agents at once.
 *
 * This adapter implements the exact slice of that contract the Money Studio + its
 * Trading Brain actually use — `agent` (getter), `patch`, `emit`/`on`,
 * `emitMarket`/`onMarket`, `commit`, `destroy` — for a single agent, seeded from a
 * plain `/api/agents/:id` record (no AgentIdentity / memory load). Persistence is
 * the same debounced, optimistic `PUT /api/agents/:id` via the shared `apiFetch`
 * (CSRF + cookies handled), with rollback on failure.
 *
 *   import { StudioAdapter } from '../studio-adapter.js';
 *   const adapter = new StudioAdapter(agentRecord);   // agentRecord = (await get(`/api/agents/${id}`)).agent
 *   mountMoneyStudio(host, { studio: adapter });
 *   // later: adapter.destroy();
 */

import { apiFetch } from '../api.js';

const DEBOUNCE_MS = 600;

// Fields the studio owns on the agent record and is allowed to PUT — mirrors the
// WRITABLE set in agent-studio-store.js so an accidental patch can't try to write
// a read-only/derived column.
const WRITABLE = new Set(['name', 'description', 'avatarId', 'skills', 'meta', 'personaPrompt', 'homeUrl']);

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `src` into `dst` for plain objects; arrays and scalars replace.
// Pure (never mutates inputs). Intentionally self-contained so the dashboard stays
// decoupled from the studio store's internals.
function deepMerge(dst, src) {
	const out = Array.isArray(dst) ? [...dst] : { ...dst };
	for (const [k, v] of Object.entries(src)) {
		if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
		else out[k] = isPlainObject(v) ? deepMerge({}, v) : v;
	}
	return out;
}

// Map a decorated `/api/agents/:id` record (snake_case on the wire) into the
// camelCase snapshot the sub-studios read — same shape AgentStudioStore exposes.
function snapshotFromRecord(rec) {
	return {
		id: rec.id,
		name: rec.name || 'Agent',
		description: rec.description || '',
		avatarId: rec.avatar_id || rec.avatarId || null,
		homeUrl: rec.home_url || rec.homeUrl || (rec.id ? `/agents/${rec.id}` : ''),
		skills: [...(rec.skills || [])],
		meta: structuredClone(rec.meta || {}),
		personaPrompt: rec.persona_prompt ?? rec.personaPrompt ?? '',
		updatedAt: rec.updated_at || rec.updatedAt || null,
		isOwner: typeof rec.isOwner === 'boolean' ? rec.isOwner : Boolean(rec.user_id),
	};
}

export class StudioAdapter {
	/** @param {object} agentRecord — the `agent` object from `/api/agents/:id`. */
	constructor(agentRecord) {
		this._record = snapshotFromRecord(agentRecord || {});
		this._optimistic = null;
		this._events = new Map();
		this._marketListeners = new Set();
		this._flushTimer = null;
		this._inflight = null;
		this._destroyed = false;
	}

	// ── Reactive read ─────────────────────────────────────────────────────────

	get agent() {
		return this._optimistic ? deepMerge(this._record, this._optimistic) : this._record;
	}

	get isLoaded() {
		return !!this._record?.id;
	}

	// ── Domain event bus ──────────────────────────────────────────────────────

	on(event, fn) {
		if (!this._events.has(event)) this._events.set(event, new Set());
		this._events.get(event).add(fn);
		return () => this._events.get(event)?.delete(fn);
	}

	emit(event, data) {
		const set = this._events.get(event);
		if (!set) return;
		for (const fn of set) {
			try { fn(data); } catch (e) { console.error(`[studio-adapter] '${event}' listener threw`, e); }
		}
	}

	// ── Market events ─────────────────────────────────────────────────────────
	// Presence (<agent-presence>) isn't on the dashboard, so emitMarket is a sink
	// for any listeners the panels register — never a crash for the callers.

	emitMarket(evt) {
		for (const fn of this._marketListeners) {
			try { fn(evt); } catch (e) { console.error('[studio-adapter] market listener threw', e); }
		}
	}

	onMarket(fn) {
		this._marketListeners.add(fn);
		return () => this._marketListeners.delete(fn);
	}

	// ── Optimistic patch + debounced persist ──────────────────────────────────

	patch(partial) {
		if (this._destroyed || !isPlainObject(partial) || !this._record?.id) return;
		const clean = {};
		for (const [k, v] of Object.entries(partial)) {
			if (WRITABLE.has(k)) clean[k] = v;
			else console.warn(`[studio-adapter] patch ignored unknown field: ${k}`);
		}
		if (!Object.keys(clean).length) return;
		this._optimistic = this._optimistic ? deepMerge(this._optimistic, clean) : deepMerge({}, clean);
		this.emit('save:pending');
		if (this._flushTimer) clearTimeout(this._flushTimer);
		this._flushTimer = setTimeout(() => { this.commit().catch(() => {}); }, DEBOUNCE_MS);
	}

	async commit() {
		if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
		if (this._inflight) {
			await this._inflight.catch(() => {});
			if (this._optimistic) return this.commit();
			return this._record;
		}
		if (!this._optimistic || !this._record?.id) return this._record;

		const pending = this._optimistic;
		this._optimistic = null;
		const baseline = this._record;
		const optimisticRecord = deepMerge(baseline, pending);
		this._record = optimisticRecord;

		// Build the PUT body from changed fields only, camelCase → snake_case. `meta`
		// is always sent whole (the server shallow-merges top-level meta keys, so this
		// preserves sibling bags like onchain/token while replacing meta.studio).
		const body = {};
		if ('name' in pending) body.name = optimisticRecord.name;
		if ('description' in pending) body.description = optimisticRecord.description;
		if ('avatarId' in pending) body.avatar_id = optimisticRecord.avatarId;
		if ('skills' in pending) body.skills = optimisticRecord.skills;
		if ('homeUrl' in pending) body.home_url = optimisticRecord.homeUrl;
		if ('personaPrompt' in pending) body.persona_prompt = optimisticRecord.personaPrompt;
		if ('meta' in pending) body.meta = optimisticRecord.meta;

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
				// Server is authoritative for derived fields; keep our optimistic values
				// for what we just wrote so a slow round-trip doesn't visibly snap back.
				this._record = {
					...optimisticRecord,
					meta: agent?.meta ? deepMerge(optimisticRecord.meta, agent.meta) : optimisticRecord.meta,
					personaPrompt: typeof agent?.persona_prompt === 'string' ? agent.persona_prompt : optimisticRecord.personaPrompt,
					updatedAt: agent?.updated_at || agent?.updatedAt || optimisticRecord.updatedAt,
				};
				this.emit('save:ok');
				return this._record;
			} catch (err) {
				// Roll back the optimistic edit and surface for the UI (toast). The edit
				// is dropped on purpose so the UI reflects true server state.
				this._record = baseline;
				this.emit('error', { op: 'patch', error: err, status: err.status });
				console.error('[studio-adapter] patch PUT failed, rolled back:', err.message);
				throw err;
			} finally {
				this._inflight = null;
			}
		})();

		return this._inflight;
	}

	destroy() {
		this._destroyed = true;
		if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
		this._events.clear();
		this._marketListeners.clear();
	}
}

export default StudioAdapter;
