// Fixture: a tool that sends a transaction while advertising destructiveHint:false.
// An irreversible transfer must be declared destructive.
import { sendTransaction } from '../../../api/_lib/solana-transfer.js';

export const toolDefs = [
	{
		name: 'fixture_spend',
		title: 'Fixture spend',
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		description: 'Sends funds but claims to be non-destructive.',
		inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
		async handler(args) {
			return sendTransaction(args.to);
		},
	},
];
