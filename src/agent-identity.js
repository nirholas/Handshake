/**
 * Agent Identity
 * --------------
 * Every agent deserves a body, a place, a name, and a history.
 * This module is that. It persists to localStorage + backend,
 * links to an ERC-8004 on-chain presence, and maintains a signed
 * action log — the agent's provenance trail.
 *
 * Think of it as the agent's passport + diary.
 */

import { AgentMemory } from './agent-memory.js';

const STORAGE_KEY = 'agent_identity';

// Single-use CSRF token cache. Required by /api/agents PUT/PATCH/DELETE +
// /api/agents/:id/wallet on the server. Token is burned on consumption.
let _csrfToken = null;
async function getCsrfToken() {
	if (_csrfToken) return _csrfToken;
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json();
		_csrfToken = j?.data?.token || null;
		return _csrfToken;
	} catch {
		return null;
	}
}

async function csrfHeaders() {
	const csrf = await getCsrfToken();
	_csrfToken = null;
	return csrf ? { 'x-csrf-token': csrf } : {};
}

/**
 * @typedef {Object} AgentRecord
 * @property {string}   id
 * @property {string}   name
 * @property {string}   [description]
 * @property {string}   [avatarId]      — R2 avatar UUID
 * @property {string}   [homeUrl]       — /agent/:id
 * @property {string}   [walletAddress]
 * @property {number}   [chainId]
 * @property {string[]} skills          — enabled skill names
 * @property {Object}   meta
 * @property {number}   createdAt
 * @property {boolean}  isRegistered    — ERC-8004 on-chain
 */

export class AgentIdentity {
	/**
	 * @param {{ userId?: string, agentId?: string, autoLoad?: boolean }} [opts]
	 */
	constructor({ userId = null, agentId = null, autoLoad = true } = {}) {
		this.userId = userId;
		this._record = null;
		this._loaded = false;
		this._backendConfirmed = false; // true only when backend returned a valid agent
		this._owned = false; // true only when the signed-in session OWNS this agent
		this._loadPromise = null; // re-entrancy guard
		this.memory = null;

		// Pre-seed agentId from arg or storage so callers can use it synchronously
		this._agentId = agentId || this._readStoredId();

		if (autoLoad) this._loadAsync();
	}

	// ── Public getters ────────────────────────────────────────────────────────

	get id() {
		return this._record?.id || this._agentId;
	}
	get name() {
		return this._record?.name || 'Agent';
	}
	get description() {
		return this._record?.description || '';
	}
	get avatarId() {
		return this._record?.avatarId || null;
	}
	get homeUrl() {
		return this._record?.homeUrl || (this.id ? `/agent/${this.id}` : null);
	}
	get walletAddress() {
		return this._record?.walletAddress || null;
	}
	get chainId() {
		return this._record?.chainId || null;
	}
	get skills() {
		return this._record?.skills || [];
	}
	get meta() {
		return this._record?.meta || {};
	}
	get isLoaded() {
		return this._loaded;
	}
	get isRegistered() {
		return Boolean(this._record?.isRegistered);
	}
	get isOwner() {
		return this._record?.isOwner ?? null;
	}

	// ── Load + Save ───────────────────────────────────────────────────────────

	async load() {
		await this._loadAsync();
	}

	async save() {
		if (!this._record) return;
		this._persist();
		try {
			const csrf = await csrfHeaders();
			const resp = await fetch(`/api/agents/${this._record.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', ...csrf },
				credentials: 'include',
				body: JSON.stringify({
					name: this._record.name,
					description: this._record.description,
					avatar_id: this._record.avatarId,
					skills: this._record.skills,
					meta: this._record.meta,
				}),
			});
			if (resp.ok) {
				const { agent } = await resp.json();
				this._record = _normalise(agent);
				this._persist();
			}
		} catch {
			/* localStorage is authoritative */
		}
	}

	/**
	 * Update identity fields locally and push to backend.
	 * @param {Partial<AgentRecord>} patch
	 */
	async update(patch) {
		if (!this._record) await this._loadAsync();
		Object.assign(this._record, patch);
		await this.save();
	}

	// ── Wallet ────────────────────────────────────────────────────────────────

	async linkWallet(address, chainId) {
		await this.update({ walletAddress: address, chainId });
		try {
			const csrf = await csrfHeaders();
			await fetch(`/api/agents/${this.id}/wallet`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...csrf },
				credentials: 'include',
				body: JSON.stringify({ wallet_address: address, chain_id: chainId }),
			});
		} catch {}
	}

	async unlinkWallet() {
		await this.update({ walletAddress: null, chainId: null });
		try {
			const csrf = await csrfHeaders();
			await fetch(`/api/agents/${this.id}/wallet`, {
				method: 'DELETE',
				headers: csrf,
				credentials: 'include',
			});
		} catch {}
	}

	// ── Action History ────────────────────────────────────────────────────────

	/**
	 * Append an action to the agent's signed history.
	 * Fire-and-forget — never blocks the caller.
	 * @param {import('./agent-protocol.js').ActionPayload} action
	 */
	recordAction(action) {
		if (!this._backendConfirmed) return; // no session — skip to avoid 401 noise
		if (!this._owned) return; // viewing someone else's agent — backend would 403
		fetch('/api/agent-actions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				agent_id: this.id,
				type: action.type,
				payload: action.payload,
				source_skill: action.sourceSkill || null,
			}),
		}).catch(() => {}); // non-critical
	}

	/**
	 * Fetch recent actions from backend.
	 * @param {{ limit?: number, cursor?: string }} [opts]
	 * @returns {Promise<Object[]>}
	 */
	async getActionHistory({ limit = 50, cursor } = {}) {
		if (!this._owned) return []; // action log is owner-only — backend returns 403 otherwise
		try {
			const params = new URLSearchParams({ agent_id: this.id, limit: String(limit) });
			if (cursor) params.set('cursor', cursor);
			const resp = await fetch(`/api/agent-actions?${params}`, { credentials: 'include' });
			if (!resp.ok) return [];
			const { actions } = await resp.json();
			return actions || [];
		} catch {
			return [];
		}
	}

	// ── ERC-8004 Registration ────────────────────────────────────────────────

	/**
	 * Register this agent on-chain via the ERC-8004 registry.
	 * @param {{ glbFile: File, name?: string, description?: string, apiToken?: string, onStatus?: Function }} [opts]
	 */
	async register({ glbFile, name, description, apiToken, onStatus } = {}) {
		const { registerAgent } = await import('./erc8004/agent-registry.js');
		const result = await registerAgent({
			glbFile,
			name: name || this.name,
			description: description || this.description,
			apiToken,
			onStatus,
		});
		await this.update({ isRegistered: true, meta: { ...this.meta, erc8004: result } });
		return result;
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	async _loadAsync() {
		if (this._loadPromise) return this._loadPromise;
		this._loadPromise = this.__doLoad();
		try { await this._loadPromise; } finally { this._loadPromise = null; }
	}

	async __doLoad() {
		this._backendConfirmed = false;
		this._owned = false;

		// 1. Try localStorage first (instant) — backendSync disabled until confirmed
		const local = this._readLocal();
		if (local) {
			this._record = local;
			this._agentId = local.id;
			this._loaded = true;
			this.memory = new AgentMemory(local.id, { backendSync: false, embedFn: _makeEmbedFn(local.id) });
		}

		// 2. Try backend (authoritative if user is signed in)
		// Only probe a specific agent ID if it was previously confirmed by the backend.
		// Locally-synthesised IDs will never exist in the DB, so use /me to avoid 404 noise.
		try {
			const agentId = this._agentId;
			const storedConfirmed = this._record?.backendConfirmed;
			const url = (agentId && storedConfirmed) ? `/api/agents/${agentId}` : '/api/agents/me';
			const resp = await fetch(url, { credentials: 'include' });

			if (resp.ok) {
				const { agent } = await resp.json();
				// Server returns { agent: null } for anonymous /me — treat as
				// "no server identity" and fall through to local-only.
				if (agent) {
					this._record = _normalise(agent);
					this._agentId = this._record.id;
					this._loaded = true;
					this._backendConfirmed = true;
					// `/api/agents/:id` is a public read — it confirms the agent
					// EXISTS, not that we own it. Owner-only fields (is_owner) tell
					// us whether the signed-in session may write to its action log.
					this._owned = agent.is_owner === true;
					this._persist();
					if (!this.memory) {
						this.memory = new AgentMemory(this._record.id, { backendSync: true, embedFn: _makeEmbedFn(this._record.id) });
					} else {
						// Agent confirmed in backend — enable sync and pull latest
						this.memory.backendSync = true;
						this.memory._syncFromBackend();
					}
					return;
				}
			}

			// Any non-2xx or a 2xx with null agent → use local record if we have
			// one, otherwise synthesize a local-only identity. Tolerant of 5xx
			// so a backend blip doesn't brick the avatar for the visitor.
			if (!this._record) {
				this._record = _makeDefault(this._agentId);
				this._agentId = this._record.id;
				this._loaded = true;
				this._persist();
				this.memory = new AgentMemory(this._agentId, { backendSync: false, embedFn: _makeEmbedFn(this._agentId) });
			}
		} catch {
			// Offline — use local record if we have one
			if (!this._record) {
				this._record = _makeDefault(this._agentId);
				this._agentId = this._record.id;
				this._loaded = true;
				this._persist();
				this.memory = new AgentMemory(this._agentId, { backendSync: false, embedFn: _makeEmbedFn(this._agentId) });
			}
		}
	}

	_readStoredId() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) return JSON.parse(raw).id || null;
		} catch {}
		return null;
	}

	_readLocal() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	_persist() {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this._record));
		} catch {}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _makeEmbedFn(agentId) {
	return async (text) => {
		const resp = await fetch(`/api/agents/${agentId}/embed`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ text }),
		});
		if (!resp.ok) throw new Error(`embed ${resp.status}`);
		const { embedding } = await resp.json();
		return embedding;
	};
}

function _uuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function _makeDefault(existingId) {
	return {
		id: existingId || _uuid(),
		name: 'Agent',
		description: 'A 3D AI agent',
		avatarId: null,
		homeUrl: null,
		walletAddress: null,
		chainId: null,
		skills: ['greet', 'present-model', 'validate-model', 'remember', 'think'],
		meta: {},
		createdAt: Date.now(),
		isRegistered: false,
		isOwner: false,
	};
}

function _normalise(apiRecord) {
	return {
		id: apiRecord.id,
		name: apiRecord.name || 'Agent',
		description: apiRecord.description || '',
		avatarId: apiRecord.avatar_id || apiRecord.avatarId || null,
		homeUrl: apiRecord.home_url || apiRecord.homeUrl || `/agent/${apiRecord.id}`,
		walletAddress: apiRecord.wallet_address || apiRecord.walletAddress || null,
		chainId: apiRecord.chain_id || apiRecord.chainId || null,
		skills: apiRecord.skills || [],
		meta: apiRecord.meta || {},
		createdAt: apiRecord.created_at
			? new Date(apiRecord.created_at).getTime()
			: apiRecord.createdAt || Date.now(),
		isRegistered: Boolean(apiRecord.erc8004_agent_id || apiRecord.isRegistered),
		// Server decorates owner-only fields (user_id, wallet_address, system_prompt,
		// etc.) only when the requester owns the agent — see api/agents.js decorate().
		// Use user_id presence as the canonical owner signal so visitor flows don't
		// trigger owner-only requests (e.g. /solana, /eth-vanity) and get 401s.
		isOwner: typeof apiRecord.isOwner === 'boolean'
			? apiRecord.isOwner
			: Boolean(apiRecord.user_id),
		backendConfirmed: true,
	};
}
