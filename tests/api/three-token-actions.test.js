// Handler tests for the database-backed $THREE actions: /burns and /activity.
//
// What happened: both queries selected `display_name` from agent_identities, a
// column that table has never had (it lives on `users`). Every call raised
// `column "display_name" does not exist`, the `.catch(() => [])` beside it turned
// the error into a plausible empty result, and the deploy-burn ledger shipped
// permanently empty while /stats happily reported 3167 deployed agents from the
// sibling count query that did not name the bad column. Nothing in the logs said
// otherwise, because the swallow was silent.
//
// So there are two guards here: a schema guard that reads the columns the handler
// actually names against the columns the schema actually declares (this fails on
// the original code), and behaviour tests for the mapping and the degrade path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HANDLER_PATH = fileURLToPath(new URL('../../api/three-token/[action].js', import.meta.url));
const SRC = readFileSync(HANDLER_PATH, 'utf8');

// ── schema guard ────────────────────────────────────────────────────────────

const SCHEMA_DIR = fileURLToPath(new URL('../../api/_lib/', import.meta.url));
const MIGRATIONS_DIR = `${SCHEMA_DIR}migrations/`;

function schemaSources() {
	const files = [`${SCHEMA_DIR}schema.sql`];
	for (const f of readdirSync(MIGRATIONS_DIR)) {
		if (f.endsWith('.sql')) files.push(`${MIGRATIONS_DIR}${f}`);
	}
	return files.map((f) => readFileSync(f, 'utf8'));
}

// Columns a table is declared to have: the CREATE TABLE body plus every
// additive `alter table <t> add column [if not exists] <col>`.
function declaredColumns(table) {
	const cols = new Set();
	for (const sqlText of schemaSources()) {
		const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\s*\\(`, 'i').exec(sqlText);
		if (create) {
			let depth = 0;
			let end = create.index + create[0].length - 1;
			for (let i = end; i < sqlText.length; i++) {
				if (sqlText[i] === '(') depth++;
				else if (sqlText[i] === ')' && --depth === 0) { end = i; break; }
			}
			const body = sqlText.slice(create.index + create[0].length, end);
			for (const line of body.split('\n')) {
				const m = /^\s*([a-z_][a-z0-9_]*)\s+\S/i.exec(line);
				if (m && !/^(primary|foreign|unique|check|constraint|exclude)$/i.test(m[1])) cols.add(m[1].toLowerCase());
			}
		}
		const alter = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?${table}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)`, 'gi');
		let a;
		while ((a = alter.exec(sqlText))) cols.add(a[1].toLowerCase());
	}
	return cols;
}

// Every `SELECT … FROM …` inside a template literal in the handler source.
function selectStatements(src) {
	const out = [];
	const re = /SELECT\s+([\s\S]*?)\sFROM\s+([\s\S]*?)(?:`|\bWHERE\b|\bORDER\b|\bLIMIT\b|\bGROUP\b)/gi;
	let m;
	while ((m = re.exec(src))) out.push({ list: m[1], from: m[2] });
	return out;
}

// Bare column references in a SELECT list, keyed by the table alias that owns
// them. Skips function calls and expressions, and drops the `AS <alias>` half:
// output aliases are ours to name, input columns are the schema's.
function referencedColumns({ list, from }) {
	const aliases = new Map(); // alias (or table name) → table
	// The alias is optional: `FROM agent_identities` binds the table under its own
	// name, and a required alias here is what let the first draft of this guard
	// pass the very statement it exists to catch.
	const fromRe = /([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*))?/i;
	for (const chunk of from.split(/\bJOIN\b|,/i)) {
		const m = fromRe.exec(chunk.replace(/\bLEFT\b|\bRIGHT\b|\bINNER\b|\bOUTER\b/gi, '').trim());
		if (!m) continue;
		const table = m[1].toLowerCase();
		aliases.set(table, table);
		if (m[2] && !/^(on|using)$/i.test(m[2])) aliases.set(m[2].toLowerCase(), table);
	}
	const refs = [];
	for (const raw of list.split(',')) {
		const item = raw.split(/\bAS\b/i)[0].trim();
		if (!item || item.includes('(') || item === '*') continue;
		const dotted = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i.exec(item);
		if (dotted) {
			const table = aliases.get(dotted[1].toLowerCase());
			if (table) refs.push({ table, column: dotted[2].toLowerCase() });
			continue;
		}
		const bare = /^([a-z_][a-z0-9_]*)$/i.exec(item);
		// A bare column is unambiguous only in a single-table FROM.
		if (bare && new Set(aliases.values()).size === 1) {
			refs.push({ table: [...aliases.values()][0], column: bare[1].toLowerCase() });
		}
	}
	return refs;
}

describe('$THREE handler SQL matches the declared schema', () => {
	it('selects no column agent_identities / agent_revenue_events do not have', () => {
		const known = {
			agent_identities: declaredColumns('agent_identities'),
			agent_revenue_events: declaredColumns('agent_revenue_events'),
		};
		// Sanity: the parser found the tables at all, so a green test means
		// "checked and clean", never "matched nothing".
		expect(known.agent_identities.has('name')).toBe(true);
		expect(known.agent_identities.has('display_name')).toBe(false);
		expect(known.agent_revenue_events.has('gross_amount')).toBe(true);

		const bad = [];
		let checked = 0;
		for (const stmt of selectStatements(SRC)) {
			for (const ref of referencedColumns(stmt)) {
				if (!(ref.table in known)) continue;
				checked++;
				if (!known[ref.table].has(ref.column)) bad.push(`${ref.table}.${ref.column}`);
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(bad).toEqual([]);
	});
});

// ── behaviour ───────────────────────────────────────────────────────────────

vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn() }));
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock('../../api/_lib/token/config.js', () => ({
	TOKEN_MINT: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
}));
vi.mock('../../api/_lib/market/token-market.js', () => ({ fetchTokenMarketData: vi.fn(async () => null) }));
vi.mock('../../api/_lib/coin/three-holders.js', () => ({
	threeHolderBalances: vi.fn(async () => new Map()),
	threeHolderCount: vi.fn(async () => null),
}));
vi.mock('../../api/_lib/token/buyback.js', () => ({ buybackStats: vi.fn(async () => null) }));
vi.mock('../../api/_lib/token/microbuy.js', () => ({ microbuyStats: vi.fn(async () => null) }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));

import { sql } from '../../api/_lib/db.js';
import handler from '../../api/three-token/[action].js';

function makeReq(url) {
	return { url, method: 'GET', headers: {} };
}
function makeRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: null,
		setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
		getHeader(k) { return this._headers[k.toLowerCase()]; },
		end(body) { this._body = body; },
	};
}
const getJson = (res) => JSON.parse(res._body);

// Route each tagged-template query by what it says, so the tests don't depend on
// the order the handler fires them in.
function routeSql(handlers) {
	sql.mockImplementation((strings) => {
		const text = strings.join(' ');
		for (const [needle, respond] of handlers) {
			if (text.includes(needle)) return respond();
		}
		return Promise.resolve([]);
	});
}

describe('GET /api/three-token/burns', () => {
	beforeEach(() => { vi.clearAllMocks(); });
	afterEach(() => { vi.restoreAllMocks(); });

	it('renders the deploy-burn ledger from real agent rows', async () => {
		routeSql([
			['ORDER BY created_at DESC', () => Promise.resolve([
				{ id: 'a1', name: 'Green Galunga', created_at: '2026-08-16T04:58:12.852Z' },
				{ id: 'a2', name: null, created_at: '2026-08-15T21:17:07.046Z' },
			])],
			['count(*)', () => Promise.resolve([{ total: 3167 }])],
		]);
		const res = makeRes();
		await handler(makeReq('/api/three-token/burns'), res);

		expect(res.statusCode).toBe(200);
		const body = getJson(res);
		expect(body.burn_per_deploy).toBe(1000);
		expect(body.total_burned).toBe(3167 * 1000);
		expect(body.burns).toHaveLength(2);
		expect(body.burns[0]).toMatchObject({ id: 'a1', agent_name: 'Green Galunga', amount: 1000, reason: 'agent_deploy' });
		// A nameless agent still gets a label rather than an empty cell.
		expect(body.burns[1].agent_name).toBe('Agent');
	});

	it('degrades to an empty ledger on a query failure, and logs why', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		routeSql([
			['ORDER BY created_at DESC', () => Promise.reject(new Error('column "nope" does not exist'))],
			['count(*)', () => Promise.resolve([{ total: 7 }])],
		]);
		const res = makeRes();
		await handler(makeReq('/api/three-token/burns'), res);

		expect(res.statusCode).toBe(200);
		expect(getJson(res).burns).toEqual([]);
		// The silent swallow is what hid the original bug: the reason must reach the logs.
		expect(logged).toHaveBeenCalled();
		expect(logged.mock.calls.flat().join(' ')).toContain('does not exist');
	});
});

describe('GET /api/three-token/activity', () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it('maps revenue events to USD with the agent name', async () => {
		routeSql([
			['agent_revenue_events', () => Promise.resolve([
				{ id: 'e1', skill: 'render', gross_amount: '2500000', fee_amount: '250000', created_at: '2026-08-16T00:00:00Z', agent_name: 'Pixel' },
				{ id: 'e2', skill: null, gross_amount: null, fee_amount: null, created_at: '2026-08-15T00:00:00Z', agent_name: null },
			])],
		]);
		const res = makeRes();
		await handler(makeReq('/api/three-token/activity'), res);

		const body = getJson(res);
		expect(body.events[0]).toMatchObject({ id: 'e1', type: 'render', gross_usd: 2.5, fee_usd: 0.25, agent_name: 'Pixel' });
		expect(body.events[1]).toMatchObject({ type: 'payment', gross_usd: null, fee_usd: null, agent_name: 'Agent' });
	});
});
