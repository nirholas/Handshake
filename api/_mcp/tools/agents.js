import { limits } from '../../_lib/rate-limit.js';
import { runAgentDelegation, AgentNotFoundError } from '../../_lib/agent-delegate.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

export const toolDefs = [
	{
		name: 'call_agent',
		title: 'Call agent',
		description:
			'Send a message to another three.ws agent and get its response. Use this to delegate specialized tasks.',
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', description: "The agent's ID" },
				message: { type: 'string', description: 'The message to send' },
			},
			required: ['agent_id', 'message'],
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth) {
			// Same 10/min ceiling as the HTTP delegate endpoint, keyed to the caller.
			const rl = await limits.agentDelegate(auth.userId || auth.rateKey || 'anon');
			if (!rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});

			try {
				const out = await runAgentDelegation({
					toAgentId: args.agent_id,
					message: args.message,
				});
				return {
					content: [{ type: 'text', text: out.response }],
					structuredContent: out,
				};
			} catch (err) {
				if (err instanceof AgentNotFoundError) throw new Error('target agent not found');
				throw err;
			}
		},
	},
];
