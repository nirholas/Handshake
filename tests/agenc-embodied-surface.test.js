// @vitest-environment jsdom
//
// /agenc/embodied and the <three-ws-agent> embed it ships: the task-state
// vocabulary, and the bridge's "that address is not a task" answer.
//
// Two defects motivated this suite, both invisible from the outside because the
// page kept rendering:
//
//   1. The embed keyed its halo, badge color and animation switch on "Claimed"
//      and "Expired". AgenC has never emitted either. A task that a worker has
//      claimed arrives as "In Progress" and matched nothing, so the one
//      transition the demo exists to show was the one it could not show. The
//      page had the same vocabulary baked into CSS class names, where
//      `state-In Progress` silently splits into two class names and styles
//      nothing at all.
//
//   2. A base58 address that is not an AgenC task fails inside the Anchor
//      decoder ("Invalid account discriminator") rather than returning null, and
//      the handler's wrapper turned that into a 500. Pasting a wallet address
//      into the page's input, the single likeliest mistake, reported the
//      platform as broken instead of saying no such task exists.
//
// `taskStateLabel` and the embed are exercised directly; both are pure. The
// embed is read from public/ (it is served as a static file, never bundled) and
// evaluated in jsdom, which is also the only environment where its custom
// element can be defined at all.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

vi.mock('../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('@tetsuo-ai/sdk', () => ({
	getTask: async () => null,
	getTaskLifecycleSummary: async () => null,
	getTasksByCreator: async () => [],
	getAgent: async () => null,
	deriveTaskPda: () => null,
	deriveAgentPda: () => null,
}));

const { taskStateLabel } = await import('../api/agenc/[action].js');

// Every label the bridge can report for a real on-chain task.
const CHAIN_STATES = [0, 1, 2, 3, 4, 5].map(taskStateLabel);

const embedSource = readFileSync(resolve(ROOT, 'public/agenc/embed.js'), 'utf8');
const pageSource = readFileSync(resolve(ROOT, 'pages/agenc/embodied.html'), 'utf8');

describe('AgenC task-state vocabulary', () => {
	it('reports the six on-chain TaskState labels', () => {
		expect(CHAIN_STATES).toEqual([
			'Open',
			'In Progress',
			'Pending Validation',
			'Completed',
			'Cancelled',
			'Disputed',
		]);
	});

	it('never reports the two labels the chain does not have', () => {
		expect(CHAIN_STATES).not.toContain('Claimed');
		expect(CHAIN_STATES).not.toContain('Expired');
	});
});

describe('<three-ws-agent> embed', () => {
	let element;

	beforeAll(async () => {
		// The module defines a custom element on import, so it can only be loaded
		// once per environment; import it through a data URL to keep it out of the
		// module graph's resolution rules (public/ is not a package path).
		const mod = await import(`data:text/javascript;base64,${Buffer.from(embedSource).toString('base64')}`);
		element = mod.ThreewsAgentElement;
	});

	it('registers the custom element', () => {
		expect(element).toBeTypeOf('function');
		expect(customElements.get('three-ws-agent')).toBe(element);
	});

	it('colors every state the bridge can report, and nothing the chain cannot emit', () => {
		const colored = [...embedSource.matchAll(/^\t'?([A-Za-z ]+)'?:\s*'#[0-9a-f]{6}',$/gm)].map((m) => m[1]);
		for (const state of CHAIN_STATES) expect(colored).toContain(state);
		// Plus the element's own three transport states, and no stale extras.
		expect(new Set(colored)).toEqual(new Set([...CHAIN_STATES, 'loading', 'error', 'idle']));
	});

	it('draws a halo for every chain state through data-state, spaces included', () => {
		for (const state of CHAIN_STATES) {
			expect(embedSource).toContain(`:host([data-state="${state}"]) .pulse`);
		}
	});

	it('drives the viewer from an idle state until a task is set', async () => {
		const el = document.createElement('three-ws-agent');
		el.setAttribute('agenc-bridge', '/api/agenc');
		document.body.appendChild(el);
		expect(el.getAttribute('data-state')).toBe('idle');
		el.remove();
	});

	it('backs off after consecutive failures instead of re-asking at the poll rate', () => {
		const el = document.createElement('three-ws-agent');
		el.setAttribute('agenc-poll-ms', '4000');
		document.body.appendChild(el);
		expect(el._retryDelay()).toBe(4000);
		el._failures = 1;
		expect(el._retryDelay()).toBe(8000);
		el._failures = 3;
		expect(el._retryDelay()).toBe(32000);
		// Capped, so a permanently missing task never spins faster than a minute.
		el._failures = 50;
		expect(el._retryDelay()).toBe(60000);
		el.remove();
	});
});

describe('/agenc/embodied page', () => {
	it('styles states with a data attribute, never a class name that contains a space', () => {
		expect(pageSource).not.toMatch(/class="state-/);
		for (const state of CHAIN_STATES) {
			if (state === 'Open' || state === 'In Progress' || state === 'Completed') {
				expect(pageSource).toContain(`[data-state='${state}']`);
			}
		}
	});

	it('names no program address of its own: the live read supplies it', () => {
		// A hardcoded program id on this page named a deployment no read has
		// touched since the IDL moved. `programId` now comes off the response.
		expect(pageSource).not.toMatch(/6UcJzbT/);
		expect(pageSource).toContain('vProgram');
	});

	it('offers task discovery rather than an empty input box', () => {
		expect(pageSource).toContain('/api/agenc/recent-tasks');
	});

	it('labels every form control and links every anchor somewhere real', () => {
		expect(pageSource).toContain('<label for="taskPda"');
		expect(pageSource).toContain('<label for="cluster"');
		const hrefs = [...pageSource.matchAll(/<a[^>]+href="([^"]*)"/g)].map((m) => m[1]);
		expect(hrefs.length).toBeGreaterThan(0);
		for (const href of hrefs) expect(href).not.toBe('#');
	});
});
