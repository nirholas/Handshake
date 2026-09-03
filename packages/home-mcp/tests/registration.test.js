// Tool-surface invariants for @three-ws/home-mcp.
//
// Importing src/index.js is side-effect-free: the stdio transport only connects
// when the file is the process entry point, and buildServer() needs no house.
// This file runs offline and never opens a socket, so it is part of the default
// `npm test` rather than something a person has to remember to run.
//
//   npx vitest run packages/home-mcp

import { describe, expect, it } from 'vitest';

import { TOOLS, INSTRUCTIONS, buildServer } from '../src/index.js';
import { refusal, CONFIRM_AT } from '../src/lib/gate.js';
import { config, freshness, standingAllowances } from '../src/lib/home.js';

const EXPECTED = {
	home_overview: { write: false },
	list_entities: { write: false },
	list_macros: { write: false },
	call_service: { write: true },
	run_macro: { write: true },
};

describe('the tool surface', () => {
	it('registers exactly the expected tools', () => {
		expect(TOOLS).toHaveLength(Object.keys(EXPECTED).length);
		expect(new Set(TOOLS.map((t) => t.name))).toEqual(new Set(Object.keys(EXPECTED)));
	});

	it('gives every tool a title, a description, an input schema and complete annotations', () => {
		for (const tool of TOOLS) {
			expect(typeof tool.title, `${tool.name} title`).toBe('string');
			expect(tool.title.length, `${tool.name} title`).toBeGreaterThan(0);
			expect(typeof tool.description, `${tool.name} description`).toBe('string');
			expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
			expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTypeOf('object');
			expect(typeof tool.handler, `${tool.name} handler`).toBe('function');
			expect(tool.annotations, `${tool.name} annotations`).toBeTruthy();
			expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
			expect(typeof tool.annotations.idempotentHint).toBe('boolean');
			expect(typeof tool.annotations.openWorldHint).toBe('boolean');
		}
	});

	it('marks the read tools read-only and the write tools destructive', () => {
		for (const tool of TOOLS) {
			const expected = EXPECTED[tool.name];
			expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(!expected.write);
			expect(tool.annotations.openWorldHint, `${tool.name} talks to a live house`).toBe(true);
			if (expected.write) {
				expect(tool.annotations.destructiveHint, `${tool.name} moves a physical object`).toBe(true);
			} else {
				// The spec ignores destructiveHint when readOnlyHint is true.
				expect(tool.annotations.destructiveHint, `${tool.name} is read-only`).toBeUndefined();
			}
		}
	});
});

describe('the gate, as a schema property', () => {
	it('exposes no confirmation argument on any tool, on any transport', () => {
		// `confirmed: true` is a human saying yes, and this transport has no human
		// in it. A schema that accepted one would be model output wearing a
		// person's clothes. The absence of the field, not validation, is the
		// mechanism: a model cannot set what it was never handed.
		for (const tool of TOOLS) {
			for (const key of Object.keys(tool.inputSchema)) {
				expect(/^confirm/i.test(key), `${tool.name} exposes "${key}"`).toBe(false);
			}
		}
	});

	it('states the gate in the server instructions, so no client can claim it was not told', () => {
		expect(INSTRUCTIONS).toMatch(/refused/i);
		expect(INSTRUCTIONS).toMatch(/no argument overrides/i);
		expect(INSTRUCTIONS).toMatch(/untrusted data/i);
	});

	it('turns a bridge refusal into an answer that names the entity and forbids a retry', () => {
		const err = Object.assign(new Error('"unlock" on lock.front_door cannot be safely undone remotely.'), {
			code: 'needs_confirmation',
			pending: { domain: 'lock', service: 'unlock', risk: 'security', entityId: 'lock.front_door' },
		});
		const out = refusal(err);
		expect(out).toMatchObject({ ok: false, refused: true, risk: 'security', targets: ['lock.front_door'] });
		expect(out.retry).toMatch(/Do not retry/);
		expect(out.how_a_person_confirms.join(' ')).toContain(CONFIRM_AT);
		// The refusal names the entity that was actually refused, so an operator
		// granting a standing allowance cannot mistype it into a different door.
		expect(out.how_a_person_confirms.join(' ')).toContain('HOME_ALLOWED_ENTITIES=lock.front_door');
	});

	it('passes anything that is not a gate refusal straight through', () => {
		expect(refusal(new Error('boom'))).toBeNull();
		expect(refusal(Object.assign(new Error('x'), { code: 'unreachable' }))).toBeNull();
		expect(refusal(undefined)).toBeNull();
	});

	it('points a person at a surface that exists, not at a redirect', () => {
		// /home is a 301 to the homepage. Sending somebody there to confirm an
		// unlock would land them on the marketing page.
		expect(CONFIRM_AT).toBe('https://three.ws/smart-home');
	});
});

describe('the standing allowance', () => {
	it('is per entity, read from the environment, and never inferred', () => {
		const before = process.env.HOME_ALLOWED_ENTITIES;
		try {
			process.env.HOME_ALLOWED_ENTITIES = ' lock.office_door , lock.side_gate ,,';
			expect(config().allowed).toEqual(['lock.office_door', 'lock.side_gate']);
			delete process.env.HOME_ALLOWED_ENTITIES;
			expect(config().allowed).toEqual([]);
		} finally {
			if (before === undefined) delete process.env.HOME_ALLOWED_ENTITIES;
			else process.env.HOME_ALLOWED_ENTITIES = before;
		}
	});

	it('reads back off a bridge without inventing one', () => {
		expect(standingAllowances(null)).toEqual([]);
		expect(standingAllowances({ allowList: { list: () => ['lock.office_door'] } })).toEqual(['lock.office_door']);
	});
});

describe('freshness', () => {
	it('calls a dropped connection stale and says what that means', () => {
		expect(freshness({ connected: true })).toEqual({ connected: true, stale: false, note: null });
		const dropped = freshness({ connected: false });
		expect(dropped).toMatchObject({ connected: false, stale: true });
		expect(dropped.note).toMatch(/not the live house/);
	});

	it('treats a missing bridge as stale rather than as connected', () => {
		expect(freshness(undefined).stale).toBe(true);
	});
});

describe('the server', () => {
	it('registers every tool with its annotations, without a house', () => {
		const server = buildServer();
		const registered = server._registeredTools;
		expect(registered).toBeTruthy();
		for (const tool of TOOLS) {
			expect(registered[tool.name], `${tool.name} not registered`).toBeTruthy();
			expect(registered[tool.name].annotations).toEqual(tool.annotations);
		}
	});
});
