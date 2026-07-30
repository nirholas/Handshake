// The generated MCP tool catalog (public/mcp-catalog.json).
//
// The catalog is what /mcp-tools renders and what an agent fetches to discover
// the whole tool surface in one request, so a wrong field here is a wrong answer
// given to every caller. `npm run audit:mcp-catalog` already fails the build when
// the committed file drifts from source; these tests pin the properties that a
// regenerate would happily preserve if the generator itself were wrong.

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

const catalog = JSON.parse(readFileSync('public/mcp-catalog.json', 'utf8'));

describe('MCP tool catalog', () => {
	it('covers every tool with a resolved server', () => {
		expect(catalog.tools.length).toBeGreaterThan(200);
		expect(catalog.counts.tools).toBe(catalog.tools.length);

		// An unresolved server means a new tool directory landed that the
		// generator's path map does not know about, which would render as a raw
		// file path in the UI.
		const unknown = catalog.tools.filter((t) => t.server.id === 'unknown');
		expect(unknown.map((t) => t.source)).toEqual([]);
	});

	it('derives the safety class from the annotations, consistently', () => {
		for (const tool of catalog.tools) {
			const { readOnlyHint, destructiveHint } = tool.annotations;
			const expected =
				readOnlyHint === true ? 'read' : destructiveHint === true ? 'irreversible' : 'write';
			expect(tool.safety, `${tool.name} safety class`).toBe(expected);
		}
	});

	it('never labels a read-only tool as irreversible, or vice versa', () => {
		for (const tool of catalog.tools) {
			if (tool.safety === 'read') expect(tool.annotations.readOnlyHint).toBe(true);
			if (tool.safety === 'irreversible') {
				expect(tool.annotations.readOnlyHint).not.toBe(true);
				expect(tool.annotations.destructiveHint).toBe(true);
			}
		}
	});

	it('agrees with its own summary counts', () => {
		const tally = (predicate) => catalog.tools.filter(predicate).length;
		expect(catalog.counts.read).toBe(tally((t) => t.safety === 'read'));
		expect(catalog.counts.write).toBe(tally((t) => t.safety === 'write'));
		expect(catalog.counts.irreversible).toBe(tally((t) => t.safety === 'irreversible'));
		expect(catalog.counts.free).toBe(tally((t) => t.price.free));
		expect(catalog.counts.paid).toBe(tally((t) => !t.price.free));
		expect(catalog.counts.free + catalog.counts.paid).toBe(catalog.tools.length);
		expect(catalog.counts.servers).toBe(catalog.servers.length);
	});

	it('prices every paid tool with a real number, tiered ones included', () => {
		const paid = catalog.tools.filter((t) => !t.price.free);
		expect(paid.length).toBeGreaterThan(0);
		for (const tool of paid) {
			expect(tool.price.usd, `${tool.name} price`).toBeGreaterThan(0);
			expect(Number.isFinite(tool.price.usd)).toBe(true);
		}
		// A tier-priced tool resolves against the real forge tier table rather than
		// falling through to "free", which is what a literal-only reader would do.
		const tiered = catalog.tools.find((t) => t.price.tiers);
		expect(tiered).toBeDefined();
		expect(tiered.price.tiers.length).toBeGreaterThan(1);
		for (const tier of tiered.price.tiers) expect(tier.usd).toBeGreaterThan(0);
		// Tiers are ordered cheapest first so the UI can quote a "from" price.
		const usd = tiered.price.tiers.map((t) => t.usd);
		expect([...usd].sort((a, b) => a - b)).toEqual(usd);
	});

	it('reads a description for all but the handful composed at request time', () => {
		const missing = catalog.tools.filter((t) => !t.description);
		// Those few must say so, so the page can explain the blank instead of
		// rendering an empty card.
		for (const tool of missing) expect(tool.descriptionIsDynamic).toBe(true);
		expect(missing.length).toBeLessThan(catalog.tools.length * 0.05);
	});

	it('gives every tool a name unique within its server', () => {
		const seen = new Set();
		for (const tool of catalog.tools) {
			const key = `${tool.server.id}::${tool.name}`;
			expect(seen.has(key), `duplicate ${key}`).toBe(false);
			seen.add(key);
		}
	});

	it('counts the tools each server reports', () => {
		for (const server of catalog.servers) {
			const actual = catalog.tools.filter((t) => t.server.id === server.id).length;
			expect(actual, `${server.id} tool count`).toBe(server.tools);
		}
	});
});
