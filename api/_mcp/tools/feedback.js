// MCP feedback tools: read the queue, and compile a report into a failing test.
//
// This is the agent-facing end of the loop that starts when a visitor tells the
// corner companion something is broken. An agent connected to /api/mcp can ask
// what is broken, then ask for the reproduction, and what comes back is not a
// description of the bug but a Playwright spec that fails while the bug exists.
// That is the difference between an agent that reads a bug report and an agent
// that can verify it fixed one.
//
// The boundary from docs/feedback.md holds here exactly as it does everywhere
// else: these tools are READ-ONLY. A feedback body is untrusted text typed by
// anyone on the internet, so nothing an agent reads through this surface can
// change a status, edit the product, or trigger any write. An agent that wants
// to act on a report opens a pull request a human merges.

import { sql } from '../../_lib/db.js';
import { isAdminUser } from '../../_lib/admin.js';
import { compileToPlaywright, narrate, replayConfidence } from '../../../packages/witness/src/compile.js';

const BASE_URL = process.env.WITNESS_REPRO_BASE_URL || 'https://three.ws';

// The queue exposes raw visitor text and internal route topology, so it is held
// to the same admin gate the /feedback page and the REST endpoints use. A
// pay-per-call x402 principal has no account at all and is refused here.
async function requireAdminAuth(auth) {
	if (!auth?.userId) return null;
	const [user] = await sql`select id, wallet_address, is_admin from users where id = ${auth.userId}`;
	if (!user) return null;
	return (await isAdminUser(user)) ? user : null;
}

function refusal() {
	return {
		content: [
			{
				type: 'text',
				text: 'The feedback queue is limited to platform admins. Connect with a three.ws admin account over OAuth.',
			},
		],
		isError: true,
	};
}

function asText(value) {
	return { content: [{ type: 'text', text: value }] };
}

export const toolDefs = [
	{
		name: 'list_feedback',
		title: 'List feedback',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			'What visitors reported is broken, grouped into one row per distinct problem, loudest first. Each row carries the severity, the subsystem, how many people hit it, and whether a recorded session exists that can be compiled into a failing test with get_feedback_repro. Admin only.',
		inputSchema: {
			type: 'object',
			properties: {
				status: {
					type: 'string',
					enum: ['open', 'new', 'triaged', 'accepted', 'dismissed', 'fixed', 'all'],
					default: 'open',
				},
				replayable_only: {
					type: 'boolean',
					default: false,
					description: 'Only clusters that carry a recorded session, which are the ones an agent can verify a fix against.',
				},
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
			},
			additionalProperties: false,
		},
		scope: 'feedback:read',
		async handler(args, auth) {
			if (!(await requireAdminAuth(auth))) return refusal();
			const { listClusters } = await import('../../_lib/feedback/store.js');
			const clusters = await listClusters({ status: args.status || 'open', limit: args.limit || 20 });
			const rows = args.replayable_only ? clusters.filter((c) => c.traced > 0) : clusters;
			if (!rows.length) {
				return asText(
					args.replayable_only
						? 'No open reports carry a recorded session yet.'
						: 'Nothing open. No unresolved feedback in the queue.',
				);
			}
			const lines = rows.map((c) => {
				const bits = [
					`severity ${c.severity ?? 0}`,
					`${c.reports} report(s) from ${c.reporters} person/people`,
					c.subsystem || 'unknown subsystem',
					c.route || '',
					c.traced > 0 ? `replayable (confidence ${c.replay_confidence ?? 0}/100, latest ${c.latest_id})` : 'no recorded session',
				].filter(Boolean);
				return `- ${c.summary || '(no summary yet)'}\n  ${bits.join(' | ')}\n  cluster: ${c.cluster_key}`;
			});
			return asText(`${rows.length} cluster(s):\n\n${lines.join('\n\n')}`);
		},
	},
	{
		name: 'get_feedback_repro',
		title: 'Compile a feedback report into a failing test',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			'Compile one feedback report into a runnable Playwright spec from the session the visitor actually recorded. The spec asserts the reported failure is GONE, so it is red while the bug exists and green once it is fixed: use it to reproduce the bug before changing anything, and to prove the change worked. Returns the spec source, the narrated steps, and a replay-confidence score. Admin only, read-only.',
		inputSchema: {
			type: 'object',
			properties: {
				report_id: { type: 'string', format: 'uuid' },
				base_url: {
					type: 'string',
					description: 'Origin the replay runs against. Defaults to production; pass a local dev origin to run it against a working copy.',
				},
			},
			required: ['report_id'],
			additionalProperties: false,
		},
		scope: 'feedback:read',
		async handler(args, auth) {
			if (!(await requireAdminAuth(auth))) return refusal();
			const { reportWithTrace } = await import('../../_lib/feedback/store.js');
			const report = await reportWithTrace(args.report_id);
			if (!report) return asText(`No feedback report with id ${args.report_id}.`);
			if (!report.trace) {
				return asText(
					`Report ${args.report_id} has no recorded session, so there is nothing to replay. Reports filed before the recorder shipped, or from a browser that opted out, arrive without one. The written report still stands on its own.`,
				);
			}
			const compiled = compileToPlaywright(report.trace, {
				title: report.summary || report.body || 'reported issue',
				baseUrl: args.base_url || BASE_URL,
				reportId: report.id,
			});
			const confidence = replayConfidence(report.trace);
			const steps = narrate(report.trace);
			return asText(
				[
					`Reproduction for report ${report.id}`,
					`Replay confidence: ${confidence.score}/100. ${confidence.note}`,
					'',
					'What the visitor did:',
					...steps.map((s) => `  ${s}`),
					'',
					`Save as tests/repros/${compiled.filename} and run it. It is red until the bug is fixed.`,
					'',
					compiled.source,
				].join('\n'),
			);
		},
	},
];
