// The credential gate: every autopilot endpoint is owner-scoped, so a server
// with no THREE_WS_API_KEY must refuse locally rather than fire an
// unauthenticated request and hand the caller a bare upstream 401.
//
// This matters most for the write tools. `execute_proposal` can move real SOL,
// and the failure a misconfigured server produces should name the missing
// variable, not look like a rejected transaction.
//
// No network: every case here is decided before a request is made. The suite is
// only meaningful with THREE_WS_API_KEY unset, which is the default for a
// freshly installed server.
//
// Run: node --test packages/autopilot-mcp/test/credential-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS } from '../src/index.js';
import { THREE_WS_API_KEY } from '../src/config.js';
import { MissingCredentialError } from '../src/lib/api.js';

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const AGENT_ID = '845e4464-1d17-4cac-8990-be3f72bbc38d';
const PROPOSAL_ID = 'p_00000000';

// One representative call per tool, shaped so it would be a valid request if a
// credential were present.
const CALLS = {
	get_autopilot_config: { agentId: AGENT_ID },
	set_autopilot_config: { agentId: AGENT_ID, enabled: true },
	generate_proposals: { agentId: AGENT_ID },
	list_proposals: { agentId: AGENT_ID },
	dryrun_proposal: { agentId: AGENT_ID, proposalId: PROPOSAL_ID },
	adjust_proposal: { agentId: AGENT_ID, proposalId: PROPOSAL_ID, params: {} },
	execute_proposal: { agentId: AGENT_ID, proposalId: PROPOSAL_ID, confirm: true },
	dismiss_proposal: { agentId: AGENT_ID, proposalId: PROPOSAL_ID },
	undo_action: { agentId: AGENT_ID, proposalId: PROPOSAL_ID },
	list_autopilot_activity: {},
	compute_trust: { agentId: AGENT_ID },
};

test('THREE_WS_API_KEY defaults to empty, so the gate under test is armed', () => {
	assert.equal(THREE_WS_API_KEY, '', 'unset THREE_WS_API_KEY before running this suite');
});

test('every registered tool has a case in this suite', () => {
	assert.deepEqual(TOOLS.map((t) => t.name).sort(), Object.keys(CALLS).sort());
});

for (const [name, args] of Object.entries(CALLS)) {
	test(`${name} refuses locally with missing_credential`, async () => {
		const started = Date.now();
		await assert.rejects(
			() => byName[name].handler(args),
			(err) => {
				assert.ok(err instanceof MissingCredentialError, `${name} must throw MissingCredentialError`);
				assert.equal(err.code, 'missing_credential');
				assert.equal(err.status, 401);
				assert.match(err.message, /THREE_WS_API_KEY/, 'the message must name the variable to set');
				return true;
			},
		);
		// A local refusal, not a round trip that happened to fail.
		assert.ok(Date.now() - started < 1000, `${name} must refuse before any request`);
	});
}

test('the funds-moving tool refuses on the credential, not silently on confirm', async () => {
	// `execute_proposal` has two independent guards: this server's credential and
	// the backend's confirmation gate. With no credential the call must never
	// reach the network, whether or not confirm was passed.
	for (const confirm of [true, false, undefined]) {
		await assert.rejects(
			() => byName.execute_proposal.handler({ agentId: AGENT_ID, proposalId: PROPOSAL_ID, confirm }),
			(err) => err.code === 'missing_credential',
		);
	}
});
