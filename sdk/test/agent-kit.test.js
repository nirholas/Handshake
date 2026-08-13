/**
 * AgentKit core-path tests: the README quickstart flow.
 *
 * Runs the real panel against a jsdom document (no shims): construct,
 * mount, message roundtrip through onMessage, manifests, dispose.
 * jsdom globals are installed before the SDK is imported because
 * panel.js samples `window` at module load.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let AgentKit;

before(async () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', {
		url: 'https://myapp.example/',
	});
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	({ AgentKit } = await import('../src/index.js'));
});

function makeAgent(overrides = {}) {
	return new AgentKit({
		name: 'My Agent',
		description: 'Does cool stuff',
		endpoint: 'https://myapp.example',
		onMessage: async (text) => `You said: ${text}`,
		...overrides,
	});
}

test('constructor requires name and endpoint', () => {
	assert.throws(() => new AgentKit({ endpoint: 'https://x.example' }), /name is required/);
	assert.throws(() => new AgentKit({ name: 'X' }), /endpoint is required/);
});

test('quickstart: mount attaches the panel and toggle button to the DOM', () => {
	const agent = makeAgent();
	const ret = agent.mount(document.body);

	assert.equal(ret, agent, 'mount() is chainable');
	const panel = document.querySelector('.ak-panel');
	const toggle = document.querySelector('.ak-toggle');
	assert.ok(panel, 'panel element mounted');
	assert.ok(toggle, 'toggle button mounted');
	assert.equal(panel.querySelector('.ak-title').textContent, 'My Agent');
	assert.match(
		panel.querySelector('.ak-message.ak-agent').textContent,
		/Hi! I'm My Agent/,
		'default welcome message rendered',
	);

	agent.dispose();
});

test('open() shows the panel, close() hides it', () => {
	const agent = makeAgent().mount(document.body);
	const panel = document.querySelector('.ak-panel');

	assert.equal(panel.style.display, 'none', 'panel starts hidden');
	agent.open();
	assert.equal(panel.style.display, 'flex');
	agent.close();
	assert.equal(panel.style.display, 'none');

	agent.dispose();
});

test('sending a message routes through onMessage and renders the reply', async () => {
	const seen = [];
	const agent = makeAgent({
		voice: false,
		onMessage: async (text) => {
			seen.push(text);
			return `You said: ${text}`;
		},
	}).mount(document.body);

	const input = document.querySelector('.ak-input');
	input.value = 'hello';
	document.querySelector('.ak-send').click();

	// _respond awaits the onMessage promise; give the microtask queue a turn.
	await new Promise((r) => setTimeout(r, 0));

	assert.deepEqual(seen, ['hello'], 'onMessage received the typed text');
	const messages = [...document.querySelectorAll('.ak-message')].map((el) => el.textContent);
	assert.ok(messages.includes('hello'), 'user message rendered');
	assert.ok(messages.includes('You said: hello'), 'agent reply rendered');

	agent.dispose();
});

test('addMessage appends a message with the given role', () => {
	const agent = makeAgent().mount(document.body);
	agent.addMessage('ak-user', 'typed elsewhere');

	const el = [...document.querySelectorAll('.ak-message.ak-user')].pop();
	assert.equal(el.textContent, 'typed elsewhere');

	agent.dispose();
});

test('dispose removes the panel and toggle from the DOM', () => {
	const agent = makeAgent().mount(document.body);
	agent.dispose();

	assert.equal(document.querySelector('.ak-panel'), null);
	assert.equal(document.querySelector('.ak-toggle'), null);
});

test('manifests() returns the three .well-known documents from config', () => {
	const agent = makeAgent({
		image: 'https://myapp.example/logo.png',
		version: '2.1.0',
		org: 'Example Org',
		skills: [{ id: 'summarize', name: 'Summarize' }],
	});

	const { agentRegistration, agentCard, aiPlugin } = agent.manifests({
		openapiUrl: 'https://myapp.example/.well-known/openapi.yaml',
	});

	assert.equal(
		agentRegistration.type,
		'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
	);
	assert.equal(agentRegistration.name, 'My Agent');
	assert.deepEqual(agentRegistration.services[0], {
		name: 'web',
		endpoint: 'https://myapp.example',
	});
	assert.ok(
		agentRegistration.services.some((s) => s.name === 'MCP'),
		'openapiUrl adds an MCP service entry',
	);

	assert.equal(agentCard.name, 'My Agent');
	assert.equal(agentCard.url, 'https://myapp.example');
	assert.equal(agentCard.version, '2.1.0');
	assert.equal(agentCard.provider.organization, 'Example Org');
	assert.equal(agentCard.skills.length, 1);

	assert.equal(aiPlugin.api.url, 'https://myapp.example/.well-known/openapi.yaml');
});
