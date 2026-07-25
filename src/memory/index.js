// Agent memory — file-based, human-readable, Claude-shaped.
// See specs/MEMORY_SPEC.md
//
// Supported modes (set via `<agent-3d memory="…">` or manifest `memory.mode`):
//
//   none           — ephemeral, no persistence
//   local          — persisted to localStorage[agent:<ns>:memory]
//   remote         — persisted via /api/agent-memory (per-agent, owner-only)
//   ipfs           — read-only manifest-bundled IPFS files
//   encrypted-ipfs — same as ipfs but AES-GCM encrypted with a derived key
//
// Unknown modes fall back to `local` with a single console.warn so a stale
// or typo'd config never breaks <agent-3d> boot.

import { encryptBlob, bytesToBase64, base64ToBytes } from './crypto.js';
import { apiFetch } from '../api.js';
import { log } from '../shared/log.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// Built-in modes — reserved names a custom backend may not shadow.
const RESERVED_MODES = new Set(['none', 'local', 'remote', 'ipfs', 'encrypted-ipfs']);

// Registry of custom backends: mode name -> backend definition.
// See Memory.registerBackend and specs/MEMORY_SPEC.md → "Custom backends".
const BACKENDS = new Map();

function parseFrontmatter(text) {
	const m = text.match(FRONTMATTER_RE);
	if (!m) return { meta: {}, body: text };
	const meta = {};
	for (const line of m[1].split('\n')) {
		const [k, ...rest] = line.split(':');
		if (!k) continue;
		meta[k.trim()] = rest.join(':').trim();
	}
	return { meta, body: m[2] };
}

function stringifyFrontmatter(meta, body) {
	const lines = ['---'];
	for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${v}`);
	lines.push('---', '', body);
	return lines.join('\n');
}

// Pack { nonce: Uint8Array(12), ciphertext: Uint8Array } → single Uint8Array: [12 bytes nonce][ciphertext]
function pack({ nonce, ciphertext }) {
	const out = new Uint8Array(12 + ciphertext.length);
	out.set(nonce, 0);
	out.set(ciphertext, 12);
	return out;
}

export class Memory {
	constructor({ mode = 'local', namespace, index = {}, files = {}, timeline = [], cryptoKey = null, remoteIds = {}, backend = null } = {}) {
		this.mode = mode;
		this.namespace = namespace;
		this.files = new Map(Object.entries(files));
		this.timeline = timeline;
		// `index` accepts either the legacy `{ text }` shape or a bare string
		// (the snapshot contract), so a snapshot round-trips cleanly.
		this.indexText = typeof index === 'string' ? index : index?.text || '';
		this.cryptoKey = cryptoKey;
		// remote mode: filename -> backend entry id, for upsert round-trip
		this._remoteIds = new Map(Object.entries(remoteIds));
		// Custom backend definition when `mode` resolves to a registered backend;
		// null for built-in modes. Drives _persist / recall / save delegation.
		this._backend = backend;
		this._dirty = false;
	}

	/**
	 * Register a custom memory backend so `mode: "<name>"` resolves to it —
	 * the documented way to plug a vector store, episodic log, or any external
	 * store without forking the Memory class.
	 *
	 * @param {string} name - Mode name used in the manifest / `<agent-3d memory>`.
	 *   May not shadow a built-in mode (none/local/remote/ipfs/encrypted-ipfs).
	 * @param {Object} backend
	 * @param {(opts) => Promise<{files?, timeline?, index?}>} backend.load -
	 *   Hydrate persisted state. Receives the full `Memory.load` opts
	 *   (`namespace`, `manifestURI`, `fetchFn`, plus any extras you pass).
	 * @param {(memory: Memory) => void|Promise<void>} [backend.persist] -
	 *   Called after every `write` and `note`. Inspect `memory.files`
	 *   (Map) and `memory.timeline` (array) to ship state to your store.
	 * @param {(query: string, memory: Memory, opts) => Promise<Array>} [backend.recall] -
	 *   Semantic search. Return ranked `{ file, meta, body, score }` hits.
	 *   Falls back to the built-in substring matcher if it throws.
	 */
	static registerBackend(name, backend) {
		if (RESERVED_MODES.has(name))
			throw new Error(`"${name}" is a built-in memory mode and cannot be overridden`);
		if (!backend || typeof backend.load !== 'function')
			throw new Error('memory backend must implement load(opts)');
		BACKENDS.set(name, backend);
	}

	static unregisterBackend(name) {
		return BACKENDS.delete(name);
	}

	static backends() {
		return [...BACKENDS.keys()];
	}

	/**
	 * Load a Memory instance for the given mode. See file header for the
	 * mode table. Unknown modes warn once and fall back to `local`.
	 *
	 * @param {Object} opts
	 * @param {'none'|'local'|'remote'|'ipfs'|'encrypted-ipfs'|string} [opts.mode] -
	 *   A built-in mode, or the name of a backend registered via registerBackend.
	 * @param {string} opts.namespace            - Stable id (usually agent UUID)
	 * @param {string} [opts.manifestURI]        - Required for ipfs / encrypted-ipfs
	 * @param {typeof fetch} [opts.fetchFn]      - Override fetch (tests / SSR)
	 * @param {() => Promise<CryptoKey>} [opts.deriveKey] - Required for encrypted-ipfs
	 * @returns {Promise<Memory>}
	 */
	static async load(opts = {}) {
		const { mode = 'local', namespace, manifestURI, fetchFn, deriveKey } = opts;
		if (mode === 'none') return new Memory({ mode: 'none', namespace });
		if (mode === 'local') return Memory._loadLocal(namespace);
		if (mode === 'remote') return Memory._loadRemote({ namespace, fetchFn });
		if (mode === 'ipfs' || mode === 'encrypted-ipfs') {
			if (mode === 'encrypted-ipfs' && !deriveKey)
				throw new Error('encrypted-ipfs mode requires a deriveKey function');
			return Memory._loadIPFS({ mode, namespace, manifestURI, fetchFn, deriveKey });
		}
		const backend = BACKENDS.get(mode);
		if (backend) return Memory._loadBackend(backend, opts);
		log.warn(`[memory] unknown mode "${mode}"; falling back to "local"`);
		return Memory._loadLocal(namespace);
	}

	static async _loadBackend(backend, opts) {
		const { mode, namespace } = opts;
		let data = {};
		try {
			data = (await backend.load(opts)) || {};
		} catch (e) {
			log.warn(`[memory] backend "${mode}" load failed; starting empty`, e);
		}
		const mem = new Memory({
			mode,
			namespace,
			files: data.files || {},
			timeline: data.timeline || [],
			index: data.index || '',
			backend,
		});
		// Backend supplied files but no index — derive one so MEMORY.md is present.
		if (!mem.indexText && mem.files.size) mem._rebuildIndex();
		return mem;
	}

	static async _loadRemote({ namespace, fetchFn }) {
		const f = fetchFn || fetch.bind(globalThis);
		if (!namespace) return new Memory({ mode: 'remote', namespace });
		try {
			const resp = await f(`/api/agent-memory?agentId=${encodeURIComponent(namespace)}&limit=500`, {
				credentials: 'include',
			});
			if (!resp.ok) return new Memory({ mode: 'remote', namespace });
			const { entries } = await resp.json();
			const files = {};
			const remoteIds = {};
			for (const entry of entries || []) {
				const filename = entry.context?.filename
					|| (entry.id ? `${entry.id}.md` : null);
				if (!filename) continue;
				files[filename] = entry.content || '';
				if (entry.id) remoteIds[filename] = entry.id;
			}
			const mem = new Memory({ mode: 'remote', namespace, files, remoteIds });
			mem._rebuildIndex();
			return mem;
		} catch {
			return new Memory({ mode: 'remote', namespace });
		}
	}

	static _loadLocal(namespace) {
		const key = `agent:${namespace}:memory`;
		try {
			const raw = localStorage.getItem(key);
			if (!raw) return new Memory({ mode: 'local', namespace });
			const data = JSON.parse(raw);
			return new Memory({ mode: 'local', namespace, ...data });
		} catch {
			return new Memory({ mode: 'local', namespace });
		}
	}

	static async _loadIPFS({ mode, namespace, manifestURI, fetchFn, deriveKey }) {
		const isEncrypted = mode === 'encrypted-ipfs';
		const cryptoKey = isEncrypted ? await deriveKey() : null;

		const base = manifestURI.replace(/manifest\.json$/, '');
		try {
			const idxRes = await fetchFn(`${base}memory/MEMORY.md`);
			const indexText = idxRes.ok ? await idxRes.text() : '';
			const files = {};

			if (isEncrypted) {
				// For encrypted-ipfs: links are [filename.md](ipfs://QmCid)
				// Link text is the filename key; href is the IPFS URI to fetch.
				const linkRe = /\[([^\]]*\.md)\]\((ipfs:\/\/[^)]+)\)/g;
				let m;
				while ((m = linkRe.exec(indexText))) {
					const filename = m[1];
					const ipfsUri = m[2];
					try {
						const r = await fetchFn(ipfsUri);
						if (r.ok) files[filename] = await r.text(); // base64-encoded encrypted bytes
					} catch { /* skip missing */ }
				}
				// Decrypt all fetched files. Let DOMException propagate on wrong key.
				for (const filename of Object.keys(files)) {
					const packed = base64ToBytes(files[filename]);
					const iv = packed.slice(0, 12);
					const ciphertext = packed.slice(12);
					const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
					files[filename] = new TextDecoder().decode(buf);
				}
			} else {
				// Plaintext IPFS mode (unchanged): links are [Friendly Name](filename.md)
				const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
				let m;
				while ((m = linkRe.exec(indexText))) {
					const file = m[2];
					try {
						const r = await fetchFn(`${base}memory/${file}`);
						if (r.ok) files[file] = await r.text();
					} catch { /* skip missing */ }
				}
			}

			return new Memory({ mode, namespace, index: { text: indexText }, files, cryptoKey });
		} catch (err) {
			// Re-throw decryption errors so callers can detect wrong-key; swallow fetch/parse failures.
			if (err instanceof DOMException) throw err;
			return new Memory({ mode, namespace, cryptoKey });
		}
	}

	read(key) {
		const file = key.endsWith('.md') ? key : `${key}.md`;
		const raw = this.files.get(file);
		if (!raw) return null;
		return parseFrontmatter(raw);
	}

	write(key, { name, description, type, body, decay }) {
		const file = key.endsWith('.md') ? key : `${key}.md`;
		const now = new Date().toISOString().slice(0, 10);
		const existing = this.files.get(file);
		const created = existing ? parseFrontmatter(existing).meta.created || now : now;
		const meta = { name, description, type, created, updated: now };
		if (decay) meta.decay = decay;
		const raw = stringifyFrontmatter(meta, body || '');
		this.files.set(file, raw);
		this._rebuildIndex();
		this._dirty = true;
		this._persist();
		if (this.mode === 'remote') this._remoteUpsert(file, type, raw);
	}

	note(type, data) {
		const entry = { ts: new Date().toISOString(), type, ...data };
		this.timeline.push(entry);
		// Cap timeline to 1000 entries in-memory
		if (this.timeline.length > 1000) this.timeline = this.timeline.slice(-1000);
		this._dirty = true;
		this._persist();
	}

	async recall(query, opts = {}) {
		// A registered backend can supply real semantic search (vector store);
		// fall back to the built-in substring matcher if it errors.
		if (this._backend?.recall) {
			try {
				return await this._backend.recall(query, this, opts);
			} catch (e) {
				log.warn('[memory] backend recall failed; using substring fallback', e);
			}
		}
		const { limit = 5 } = opts;
		// Placeholder: naive substring match. Real impl: embeddings via runtime.
		const q = query.toLowerCase();
		const hits = [];
		for (const [file, raw] of this.files) {
			const { meta, body } = parseFrontmatter(raw);
			const hay = `${meta.name || ''} ${meta.description || ''} ${body}`.toLowerCase();
			if (hay.includes(q)) hits.push({ file, meta, body, score: hay.split(q).length - 1 });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	_rebuildIndex() {
		const byType = { user: [], feedback: [], project: [], reference: [] };
		for (const [file, raw] of this.files) {
			const { meta } = parseFrontmatter(raw);
			const t = meta.type || 'user';
			if (!byType[t]) byType[t] = [];
			byType[t].push({ file, name: meta.name || file, description: meta.description || '' });
		}
		const lines = ['# Memory', ''];
		const headings = {
			user: '## User',
			feedback: '## Feedback',
			project: '## Project',
			reference: '## Reference',
		};
		for (const [t, items] of Object.entries(byType)) {
			if (!items.length) continue;
			lines.push(headings[t] || `## ${t}`);
			for (const it of items) lines.push(`- [${it.name}](${it.file}) — ${it.description}`);
			lines.push('');
		}
		this.indexText = lines.join('\n');
	}

	// Like _rebuildIndex but uses filename as link text and ipfs://cid as href.
	_rebuildEncryptedIndex(cids) {
		const byType = { user: [], feedback: [], project: [], reference: [] };
		for (const [file, raw] of this.files) {
			const { meta } = parseFrontmatter(raw);
			const t = meta.type || 'user';
			if (!byType[t]) byType[t] = [];
			byType[t].push({ file, description: meta.description || '', cid: cids[file] });
		}
		const lines = ['# Memory', ''];
		const headings = {
			user: '## User',
			feedback: '## Feedback',
			project: '## Project',
			reference: '## Reference',
		};
		for (const [t, items] of Object.entries(byType)) {
			if (!items.length) continue;
			lines.push(headings[t] || `## ${t}`);
			for (const it of items) {
				const href = it.cid ? `ipfs://${it.cid}` : it.file;
				lines.push(`- [${it.file}](${href}) — ${it.description}`);
			}
			lines.push('');
		}
		this.indexText = lines.join('\n');
	}

	_persist() {
		// Custom backend owns persistence — fire-and-forget so write()/note()
		// stay synchronous, matching local/remote semantics.
		if (this._backend?.persist) {
			try {
				Promise.resolve(this._backend.persist(this)).catch((e) =>
					log.warn('[memory] backend persist failed', e),
				);
			} catch (e) {
				log.warn('[memory] backend persist failed', e);
			}
			return;
		}
		if (this.mode !== 'local' || !this.namespace) return;
		const key = `agent:${this.namespace}:memory`;
		const data = {
			index: { text: this.indexText },
			files: Object.fromEntries(this.files),
			timeline: this.timeline.slice(-200), // persist only recent timeline
		};
		try {
			localStorage.setItem(key, JSON.stringify(data));
		} catch (e) {
			log.warn('[memory] persist failed', e);
		}
	}

	// Fire-and-forget upsert of one file to /api/agent-memory.
	// Backend validates type ∈ {user, feedback, project, reference}; falls back to 'project'.
	async _remoteUpsert(file, type, raw) {
		if (!this.namespace) return;
		const validTypes = ['user', 'feedback', 'project', 'reference'];
		const memType = validTypes.includes(type) ? type : 'project';
		const entry = {
			type: memType,
			content: raw,
			context: { filename: file },
		};
		const existingId = this._remoteIds.get(file);
		if (existingId) entry.id = existingId;
		try {
			// allowAnonymous: this background sync swallows failures silently; a 401
			// must stay a silent no-op, not a login redirect.
			const resp = await apiFetch('/api/agent-memory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ agentId: this.namespace, entry }),
				allowAnonymous: true,
			});
			if (!resp.ok) return;
			const { entry: saved } = await resp.json();
			if (saved?.id) this._remoteIds.set(file, saved.id);
		} catch {
			// network unavailable — in-memory state is the fallback
		}
	}

	// Encrypt all files and pin to IPFS. Returns { cids, memoryCid }.
	// For local mode, falls back to synchronous _persist(). Noop for other modes.
	async save() {
		// Custom backend: await its persist so callers can rely on durability.
		if (this._backend?.persist) {
			await this._backend.persist(this);
			this._dirty = false;
			return;
		}
		if (this.mode === 'local') {
			this._persist();
			return;
		}
		if (this.mode === 'remote') {
			for (const [file, raw] of this.files) {
				const { meta } = parseFrontmatter(raw);
				await this._remoteUpsert(file, meta.type, raw);
			}
			this._dirty = false;
			return;
		}
		if (this.mode !== 'encrypted-ipfs') return;
		if (!this.cryptoKey) throw new Error('No cryptoKey — derive key before calling save()');
		if (!this.namespace) throw new Error('namespace required for encrypted-ipfs save');

		const cids = {};
		for (const [filename, content] of this.files) {
			const plainBytes = new TextEncoder().encode(content);
			const { nonce, ciphertext } = await encryptBlob(plainBytes, this.cryptoKey);
			const data = bytesToBase64(pack({ nonce, ciphertext }));
			const resp = await fetch(`/api/agents/${this.namespace}/memory/pin`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ filename, data }),
			});
			if (!resp.ok) throw new Error(`Failed to pin ${filename}: ${resp.status}`);
			const result = await resp.json();
			cids[filename] = result.cid;
		}

		this._rebuildEncryptedIndex(cids);

		// Pin the updated MEMORY.md index (plaintext — it only lists filenames and CIDs).
		const indexData = bytesToBase64(new TextEncoder().encode(this.indexText));
		const indexResp = await fetch(`/api/agents/${this.namespace}/memory/pin`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ filename: 'MEMORY.md', data: indexData }),
		});
		if (!indexResp.ok) throw new Error(`Failed to pin MEMORY.md: ${indexResp.status}`);
		const { cid: memoryCid } = await indexResp.json();

		this._dirty = false;
		return { cids, memoryCid };
	}

	// Budget-aware context serialization for LLM injection
	contextBlock({ maxTokens = 8192 } = {}) {
		// Rough token estimate: 4 chars/token
		const budget = maxTokens * 4;
		const parts = ['# Agent Memory', '', this.indexText];
		let used = parts.join('\n').length;
		// Include top-matching file bodies until budget exhausted
		for (const [file, raw] of this.files) {
			if (used + raw.length > budget) break;
			parts.push('', `## ${file}`, raw);
			used += raw.length;
		}
		if (this.timeline.length) {
			const recent = this.timeline.slice(-20);
			const tl = recent.map((e) => JSON.stringify(e)).join('\n');
			if (used + tl.length < budget) {
				parts.push('', '## Recent timeline', '```', tl, '```');
			}
		}
		return parts.join('\n');
	}

	/**
	 * Canonical serializable snapshot — the `memory/0.1` contract. Synchronous
	 * and JSON-safe, so embedded widgets can persist it to sessionStorage or
	 * postMessage it across reloads, then rehydrate with Memory.fromSnapshot.
	 *
	 * @returns {{version, mode, namespace, index, files, timeline}}
	 */
	snapshot() {
		return {
			version: 'memory/0.1',
			mode: this.mode,
			namespace: this.namespace,
			index: this.indexText,
			files: Object.fromEntries(this.files),
			timeline: this.timeline,
		};
	}

	/**
	 * Rehydrate a Memory from a snapshot() blob. `mode`/`namespace` overrides
	 * win over the snapshot's own values (e.g. restoring into a fresh agent id).
	 *
	 * @param {ReturnType<Memory['snapshot']>} snapshot
	 * @param {{mode?: string, namespace?: string}} [overrides]
	 * @returns {Memory}
	 */
	static fromSnapshot(snapshot = {}, { mode, namespace } = {}) {
		const mem = new Memory({
			mode: mode || snapshot.mode || 'local',
			namespace: namespace || snapshot.namespace,
			index: snapshot.index || '',
			files: snapshot.files || {},
			timeline: snapshot.timeline || [],
		});
		if (!mem.indexText && mem.files.size) mem._rebuildIndex();
		return mem;
	}

	// Async alias for snapshot() — retained for back-compat with the
	// export()/import() pair documented in MEMORY_SPEC.md.
	async export() {
		return this.snapshot();
	}

	async import(blob, { strategy = 'merge' } = {}) {
		if (strategy === 'replace') {
			this.files = new Map(Object.entries(blob.files || {}));
			this.timeline = blob.timeline || [];
		} else {
			for (const [k, v] of Object.entries(blob.files || {})) {
				if (!this.files.has(k)) this.files.set(k, v);
			}
			this.timeline = [...this.timeline, ...(blob.timeline || [])].slice(-1000);
		}
		this._rebuildIndex();
		this._persist();
	}
}
