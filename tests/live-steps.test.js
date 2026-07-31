/**
 * Live steps - the runnable API cards embedded in documentation.
 *
 * public/live-steps.js ships as a classic script (like tutorials-manifest.js),
 * so these tests evaluate the real shipped file in a sandbox and exercise the
 * exported surface. That keeps the security invariants under test in the exact
 * artifact the browser loads, rather than in a parallel copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(join(ROOT, 'public/live-steps.js'), 'utf8');

function load() {
	const sandbox = { window: {} };
	vm.createContext(sandbox);
	vm.runInContext(SOURCE, sandbox, { filename: 'live-steps.js' });
	return sandbox.window.LiveSteps;
}

const LiveSteps = load();

describe('live-steps registry', () => {
	it('loads and exposes the documented surface', () => {
		expect(LiveSteps).toBeTruthy();
		for (const name of ['STEPS', 'validateRegistry', 'redact', 'buildUrl', 'mount']) {
			expect(typeof LiveSteps[name]).not.toBe('undefined');
		}
		expect(LiveSteps.STEPS.length).toBeGreaterThan(0);
	});

	it('every registered request is a read-only GET', () => {
		for (const step of LiveSteps.STEPS) {
			if (step.kind !== 'request') continue;
			expect(step.method).toBe('GET');
		}
	});

	it('every registered path is a literal same-origin /api path', () => {
		for (const step of LiveSteps.STEPS) {
			if (step.kind !== 'request') continue;
			expect(step.path.startsWith('/api/')).toBe(true);
			expect(step.path).not.toContain('..');
			expect(step.path).not.toContain('//');
			// A template in the path would let markdown steer the request.
			expect(step.path).not.toContain('{');
			expect(step.path).not.toContain(':');
		}
	});

	it('every step carries reader-facing copy and a reference link', () => {
		for (const step of LiveSteps.STEPS) {
			expect(step.title.length).toBeGreaterThan(4);
			expect(step.summary.length).toBeGreaterThan(20);
			expect(step.docs.startsWith('/')).toBe(true);
		}
	});
});

describe('validateRegistry rejects unsafe entries', () => {
	const base = {
		id: 'x',
		kind: 'request',
		method: 'GET',
		path: '/api/version',
		title: 'x',
		summary: 'x',
		docs: '/docs/',
		inputs: [],
		exports: {},
	};

	it('refuses a method other than GET', () => {
		expect(() => LiveSteps.validateRegistry([{ ...base, method: 'POST' }])).toThrow(/read-only/);
	});

	it('refuses an absolute URL as the path', () => {
		expect(() => LiveSteps.validateRegistry([{ ...base, path: 'https://evil.test/api/x' }])).toThrow(
			/unsafe path/,
		);
	});

	it('refuses a traversal path', () => {
		expect(() => LiveSteps.validateRegistry([{ ...base, path: '/api/../admin' }])).toThrow(
			/unsafe path/,
		);
	});

	it('refuses a protocol-relative path', () => {
		expect(() => LiveSteps.validateRegistry([{ ...base, path: '//evil.test/api' }])).toThrow(
			/unsafe path/,
		);
	});

	it('refuses duplicate ids', () => {
		expect(() => LiveSteps.validateRegistry([base, base])).toThrow(/duplicate/);
	});

	it('refuses an input name that is not a plain identifier', () => {
		expect(() =>
			LiveSteps.validateRegistry([{ ...base, inputs: [{ name: 'a b', label: 'x', value: '' }] }]),
		).toThrow(/unsafe input name/);
	});

	it('refuses a step that consumes a variable nothing earlier produces', () => {
		expect(() =>
			LiveSteps.validateRegistry([
				{ ...base, kind: 'derive', derive: 'siwsMessage', uses: ['nonce'] },
			]),
		).toThrow(/no earlier step exports/);
	});

	it('refuses a derivation that is not implemented in code', () => {
		expect(() =>
			LiveSteps.validateRegistry([
				{ ...base, exports: { nonce: 'nonce' } },
				{ ...base, id: 'y', kind: 'derive', derive: 'notAThing', uses: ['nonce'] },
			]),
		).toThrow(/unknown derivation/);
	});

	it('accepts the shipped registry', () => {
		expect(LiveSteps.validateRegistry(LiveSteps.STEPS)).toBe(true);
	});
});

describe('buildUrl', () => {
	const step = {
		path: '/api/agents/public',
		inputs: [{ name: 'limit', label: 'limit', value: '3' }],
	};

	it('appends inputs as encoded query values', () => {
		expect(LiveSteps.buildUrl(step, { limit: '5' })).toBe('/api/agents/public?limit=5');
	});

	it('drops blank inputs rather than sending an empty parameter', () => {
		expect(LiveSteps.buildUrl(step, { limit: '  ' })).toBe('/api/agents/public');
		expect(LiveSteps.buildUrl(step, {})).toBe('/api/agents/public');
	});

	it('cannot be steered off the path by a hostile input value', () => {
		const url = LiveSteps.buildUrl(step, { limit: '../../admin?x=1#y' });
		expect(url.startsWith('/api/agents/public?')).toBe(true);
		expect(url).not.toContain('/admin');
		expect(url).toContain('limit=..%2F..%2Fadmin%3Fx%3D1%23y');
	});

	it('ignores values for parameters the step does not declare', () => {
		expect(LiveSteps.buildUrl(step, { limit: '2', secret: 'nope' })).toBe(
			'/api/agents/public?limit=2',
		);
	});
});

describe('redact', () => {
	it('hides session-shaped fields and counts them', () => {
		const { value, count } = LiveSteps.redact({
			nonce: 'keep-me',
			csrf: 'hide-me',
			user: { sid: 'hide-me-too', email: 'keep@example.com' },
		});
		expect(count).toBe(2);
		expect(value.nonce).toBe('keep-me');
		expect(value.csrf).not.toBe('hide-me');
		expect(value.user.sid).not.toBe('hide-me-too');
		expect(value.user.email).toBe('keep@example.com');
	});

	it('walks arrays', () => {
		const { value, count } = LiveSteps.redact({ sessions: [{ token: 'a' }, { token: 'b' }] });
		expect(count).toBe(2);
		expect(value.sessions.every((s) => s.token !== 'a' && s.token !== 'b')).toBe(true);
	});

	it('leaves an already-empty field alone rather than inventing a secret', () => {
		const { value, count } = LiveSteps.redact({ token: null, csrf: '' });
		expect(count).toBe(0);
		expect(value.token).toBe(null);
		expect(value.csrf).toBe('');
	});

	it('does not mutate the input, so exports still read real values', () => {
		const raw = { csrf: 'real-value' };
		LiveSteps.redact(raw);
		expect(raw.csrf).toBe('real-value');
	});
});

describe('explainFailure', () => {
	it('names a cause and a next move for every branch', () => {
		for (const status of [0, 401, 404, 429, 500]) {
			const text = LiveSteps.explainFailure(status, null);
			expect(text.length).toBeGreaterThan(30);
		}
		expect(LiveSteps.explainFailure(0, null)).toMatch(/offline|blocking/i);
		expect(LiveSteps.explainFailure(429, null)).toMatch(/rate limited/i);
	});

	it('surfaces the API error description when there is one', () => {
		expect(LiveSteps.explainFailure(400, { error_description: 'limit must be a number' })).toContain(
			'limit must be a number',
		);
	});
});

describe('the SIWS message derivation', () => {
	const message = LiveSteps.DERIVATIONS.siwsMessage({
		domain: 'three.ws',
		uri: 'https://three.ws',
		nonce: 'TEST_NONCE',
		address: 'YourWa11etAddress',
	});
	const lines = message.split('\n');

	it('opens with the domain from the nonce response, not the page host', () => {
		expect(lines[0]).toBe('three.ws wants you to sign in with your Solana account:');
	});

	it('keeps both structural blank lines the verify parser depends on', () => {
		expect(lines[1]).toBe('YourWa11etAddress');
		expect(lines[2]).toBe('');
		expect(lines[4]).toBe('');
	});

	it('uses a Solana network name for Chain ID, never an EIP-155 number', () => {
		expect(message).toContain('Chain ID: mainnet');
		expect(message).not.toMatch(/Chain ID: \d/);
	});

	it('carries the nonce and a five minute expiry window', () => {
		expect(message).toContain('Nonce: TEST_NONCE');
		const issued = Date.parse(message.match(/Issued At: (.+)/)[1]);
		const expires = Date.parse(message.match(/Expiration Time: (.+)/)[1]);
		expect(expires - issued).toBe(5 * 60 * 1000);
	});

	it('falls back to a visible placeholder when no address is supplied', () => {
		const anon = LiveSteps.DERIVATIONS.siwsMessage({
			domain: 'three.ws',
			uri: 'https://three.ws',
			nonce: 'N',
		});
		expect(anon.split('\n')[1]).toBe('<your-solana-address>');
	});
});

describe('shipped documentation only references registered steps', () => {
	function walk(dir, out = []) {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full, out);
			else if (name.endsWith('.md')) out.push(full);
		}
		return out;
	}

	const ids = new Set(LiveSteps.STEPS.map((s) => s.id));
	const blocks = [];
	for (const file of walk(join(ROOT, 'docs'))) {
		const md = readFileSync(file, 'utf8');
		const re = /```live\n([\s\S]*?)```/g;
		let m;
		while ((m = re.exec(md)) !== null) blocks.push({ file, body: m[1] });
	}

	it('finds live blocks in the docs', () => {
		expect(blocks.length).toBeGreaterThan(0);
	});

	it('every live block is valid JSON naming a registered step', () => {
		for (const block of blocks) {
			const spec = JSON.parse(block.body);
			expect(ids.has(spec.step), `${block.file} references unknown step "${spec.step}"`).toBe(true);
		}
	});
});
