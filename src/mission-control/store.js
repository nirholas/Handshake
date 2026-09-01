/**
 * Mission Control — central store.
 *
 * Owns the cockpit's shared, cross-pane state: the live feed ring buffer, the
 * active filter set, the current selection, buy-size presets, the trading agent
 * + network, and named saved views (persisted per signed-in user). Panes read
 * from here and mutate through the typed mutators, which emit on the shared bus
 * so every pane stays in sync without reaching into one another.
 */

const FEED_CAP = 300; // hard cap on retained feed rows — bounds memory on a fast stream
const VIEWS_KEY = 'mc:views:v1';
const PRESETS_KEY = 'mc:presets:v1';
const EXPRESS_KEY = 'mc:express:v1';

export const DEFAULT_FILTERS = Object.freeze({
	source: 'live', // 'live' | 'signals' | 'radar'
	query: '', // free-text on name/symbol/mint
	minIntel: 0, // 0..100 quality/intel score floor
	verdict: 'any', // 'any' | 'allow' | 'warn' — firewall verdict floor (block always hidden when set)
	smartOnly: false, // only rows with ≥1 smart-money buyer
	socialsOnly: false, // only rows with at least one social link
	mcBand: 'any', // 'any' | 'nano' | 'micro' | 'small' | 'mid' — market-cap band
});

export const SIZE_PRESETS_DEFAULT = [0.1, 0.25, 0.5, 1];

const MC_BANDS = {
	nano: [0, 10_000],
	micro: [10_000, 50_000],
	small: [50_000, 250_000],
	mid: [250_000, Infinity],
};

function readLocal(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch {
		return fallback;
	}
}
function writeLocal(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable (private mode / quota) — non-fatal */
	}
}

export function createStore({ bus, userId = 'anon', signedIn = false }) {
	const order = []; // mints, newest first
	const rows = new Map(); // mint -> row
	let filters = { ...DEFAULT_FILTERS };
	let selectedMint = null;
	let agent = null; // active trading agent record
	let network = 'mainnet';
	let sizePresets = sanitizePresets(readLocal(PRESETS_KEY, SIZE_PRESETS_DEFAULT));
	let activeSize = sizePresets[1] ?? sizePresets[0] ?? 0.1;
	let expressMint = readLocal(EXPRESS_KEY, {}); // { [agentId]: true } — confirm-on-first-use satisfied

	const viewsNs = `${VIEWS_KEY}:${userId}`;

	function sanitizePresets(arr) {
		const nums = (Array.isArray(arr) ? arr : SIZE_PRESETS_DEFAULT)
			.map(Number)
			.filter((n) => Number.isFinite(n) && n > 0)
			.slice(0, 6);
		return nums.length ? nums : [...SIZE_PRESETS_DEFAULT];
	}

	function bandOf(mcUsd) {
		if (mcUsd == null) return null;
		for (const [name, [lo, hi]] of Object.entries(MC_BANDS)) {
			if (mcUsd >= lo && mcUsd < hi) return name;
		}
		return null;
	}

	function matchesFilters(row) {
		const f = filters;
		if (f.query) {
			const q = f.query.toLowerCase();
			const hay = `${row.name || ''} ${row.symbol || ''} ${row.mint || ''}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		if (f.minIntel > 0) {
			const score = row.intel?.quality_score;
			if (score == null || score < f.minIntel) return false;
		}
		if (f.verdict !== 'any') {
			const v = row.safety?.verdict;
			if (!v) return false;
			if (v === 'block') return false;
			if (f.verdict === 'allow' && v !== 'allow') return false;
			// 'warn' admits allow + warn (block already excluded)
		}
		if (f.smartOnly && !(row.smart?.count > 0)) return false;
		if (f.socialsOnly && !(row.twitter || row.telegram || row.website)) return false;
		if (f.mcBand !== 'any' && bandOf(row.market_cap_usd) !== f.mcBand) return false;
		return true;
	}

	return {
		// ── feed ──────────────────────────────────────────────────────────────
		/** Insert or merge a feed row (keyed by mint). Returns the stored row. */
		upsertRow(partial) {
			const mint = partial.mint;
			if (!mint) return null;
			const existing = rows.get(mint);
			if (existing) {
				Object.assign(existing, partial);
				bus.emit('feed:update', existing);
				return existing;
			}
			const row = { firstSeen: Date.now(), ...partial };
			rows.set(mint, row);
			order.unshift(mint);
			// Evict the oldest beyond the cap (but never the selected row).
			while (order.length > FEED_CAP) {
				const drop = order[order.length - 1];
				if (drop === selectedMint) {
					// move selection-protected row up one and drop the next-oldest
					order.splice(order.length - 1, 1);
					order.splice(order.length - 1, 0, drop);
					break;
				}
				order.pop();
				rows.delete(drop);
			}
			bus.emit('feed:add', row);
			return row;
		},
		/** Patch enrichment onto a row without reordering. */
		enrichRow(mint, patch) {
			const row = rows.get(mint);
			if (!row) return null;
			Object.assign(row, patch);
			bus.emit('feed:update', row);
			return row;
		},
		getRow: (mint) => rows.get(mint) || null,
		/** All rows passing the active filters, newest first. */
		visibleRows() {
			const out = [];
			for (const mint of order) {
				const row = rows.get(mint);
				if (row && matchesFilters(row)) out.push(row);
			}
			return out;
		},
		allRowsCount: () => order.length,
		resetFeed() {
			order.length = 0;
			rows.clear();
			bus.emit('feed:reset');
		},
		matchesFilters,
		bandOf,

		// ── filters ───────────────────────────────────────────────────────────
		getFilters: () => ({ ...filters }),
		setFilters(patch) {
			filters = { ...filters, ...patch };
			bus.emit('filters', { ...filters });
		},
		resetFilters() {
			filters = { ...DEFAULT_FILTERS };
			bus.emit('filters', { ...filters });
		},

		// ── selection ─────────────────────────────────────────────────────────
		getSelected: () => selectedMint,
		select(mint) {
			if (mint === selectedMint) return;
			selectedMint = mint;
			bus.emit('select', mint);
		},

		// ── session / agent / network ─────────────────────────────────────────
		/** Whether a user is signed in (drives the sign-in vs create-wallet CTAs). */
		isSignedIn: () => signedIn,
		getAgent: () => agent,
		setAgent(next) {
			agent = next;
			bus.emit('agent', agent);
		},
		getNetwork: () => network,
		setNetwork(net) {
			network = net === 'devnet' ? 'devnet' : 'mainnet';
			bus.emit('network', network);
		},

		// ── size presets ──────────────────────────────────────────────────────
		getPresets: () => [...sizePresets],
		getActiveSize: () => activeSize,
		setActiveSize(sol) {
			const n = Number(sol);
			if (Number.isFinite(n) && n > 0) {
				activeSize = n;
				bus.emit('size', activeSize);
			}
		},
		setPresets(arr) {
			sizePresets = sanitizePresets(arr);
			writeLocal(PRESETS_KEY, sizePresets);
			if (!sizePresets.includes(activeSize)) activeSize = sizePresets[0];
			bus.emit('presets', [...sizePresets]);
		},

		// ── express (confirm-on-first-use) ──────────────────────────────────────
		isExpress: (agentId) => !!expressMint[agentId],
		setExpress(agentId) {
			expressMint = { ...expressMint, [agentId]: true };
			writeLocal(EXPRESS_KEY, expressMint);
			bus.emit('express', { agentId, on: true });
		},
		toggleExpress(agentId) {
			const on = !expressMint[agentId];
			expressMint = { ...expressMint, [agentId]: on };
			writeLocal(EXPRESS_KEY, expressMint);
			bus.emit('express', { agentId, on });
			return on;
		},

		// ── saved views (named filter sets, per user) ───────────────────────────
		listViews: () => readLocal(viewsNs, []),
		saveView(name) {
			const views = readLocal(viewsNs, []).filter((v) => v.name !== name);
			views.unshift({ name, filters: { ...filters }, savedAt: Date.now() });
			writeLocal(viewsNs, views.slice(0, 24));
			bus.emit('views', views);
			return views;
		},
		applyView(name) {
			const view = readLocal(viewsNs, []).find((v) => v.name === name);
			if (!view) return false;
			filters = { ...DEFAULT_FILTERS, ...view.filters };
			bus.emit('filters', { ...filters });
			return true;
		},
		deleteView(name) {
			const views = readLocal(viewsNs, []).filter((v) => v.name !== name);
			writeLocal(viewsNs, views);
			bus.emit('views', views);
			return views;
		},
	};
}
