// The MCP annotation-safety gate (scripts/lib/mcp-safety-check.mjs).
//
// MCP clients read a tool's `annotations` to decide whether to run it without
// asking the user, so a tool that mutates while advertising `readOnlyHint: true`
// turns a client's auto-approve path into an unattended state change. The gate
// checks those hints against what each handler actually does.
//
// These tests exist because a gate that has only ever been seen passing is a
// gate nobody knows works. Each fixture under tests/fixtures/mcp-safety/ commits
// one specific sin, and the clean fixture reproduces the two false-positive
// shapes that made a name-based heuristic unusable here.

import { describe, it, expect } from 'vitest';

import { checkTool, extractTools } from '../scripts/lib/mcp-safety-check.mjs';

const FIXTURES = 'tests/fixtures/mcp-safety';
const NO_EXEMPTIONS = new Map();

/** Extract one fixture's single tool, failing loudly if the shape changed. */
function toolFrom(fixture) {
	const { parseError, tools } = extractTools(`${FIXTURES}/${fixture}`);
	expect(parseError).toBeUndefined();
	expect(tools).toHaveLength(1);
	return tools[0];
}

const check = (tool, exemptions = NO_EXEMPTIONS) =>
	checkTool(tool, `fixture: ${tool.name}`, exemptions);

describe('MCP annotation safety gate', () => {
	it('rejects a readOnlyHint:true tool whose handler writes to the database', () => {
		const tool = toolFrom('read-only-with-db-write.js');
		expect(tool.evidence).toContain('db-write');

		const { violations } = check(tool);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain('readOnlyHint:true');
		expect(violations[0]).toContain('db-write');
	});

	it('rejects a fund-sending tool that declares destructiveHint:false', () => {
		const tool = toolFrom('spend-not-destructive.js');
		expect(tool.evidence).toContain('tx-send');

		const { violations } = check(tool);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain('destructiveHint:false');
		expect(violations[0]).toContain('cannot be undone');
	});

	it('rejects a tool that declares no annotations at all', () => {
		const tool = toolFrom('missing-annotations.js');
		expect(tool.annotations.kind).toBe('missing');

		const { violations } = check(tool);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain('no annotations');
	});

	it('passes a genuinely read-only tool, whatever its name suggests', () => {
		// "resolve" and "open" both read as mutations to a name-based classifier,
		// and this fixture imports a writer it never calls. Neither is evidence.
		const tool = toolFrom('clean-read.js');
		expect(tool.evidence).toEqual([]);
		expect(check(tool).violations).toEqual([]);
	});

	it('reads annotations from a name-keyed overlay map with spreads', () => {
		// The pump.fun server declares TOOLS and TOOL_ANNOTATIONS as separate
		// exports; an inline-only reader would call all 25 of its tools unannotated.
		const tool = toolFrom('overlay-annotations.js');
		expect(tool.annotations.kind).toBe('resolved');
		expect(tool.annotations.values.readOnlyHint).toBe(true);
		expect(tool.annotations.values.destructiveHint).toBe(false);
		expect(check(tool).violations).toEqual([]);
	});

	it('honors a reviewed exemption, and only for the named tool and evidence', () => {
		const tool = toolFrom('read-only-with-db-write.js');

		const exempt = check(tool, new Map([['fixture_read_only_write:db-write', 'cache fill']]));
		expect(exempt.violations).toEqual([]);
		expect(exempt.exempted).toEqual(['fixture_read_only_write (db-write)']);

		// An exemption for a different evidence class must not silence this one.
		const mismatched = check(tool, new Map([['fixture_read_only_write:tx-send', 'unrelated']]));
		expect(mismatched.violations).toHaveLength(1);
	});
});
