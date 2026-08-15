// MCP tool definitions for the Alibaba Cloud DashScope MCP server.
//
// Each entry pairs an MCP tool definition (name, title, annotations, and a Zod
// raw shape as the input schema) with a handler that maps validated arguments
// onto a DashScopeClient call. The SDK validates against the shape before the
// handler runs, so handlers trust their inputs and let DashScopeError propagate:
// the server maps those to MCP tool errors carrying the upstream cause.

import { z } from 'zod';

const generativeAnnotations = {
	readOnlyHint: true,
	openWorldHint: true,
	idempotentHint: false,
};
const deterministicAnnotations = {
	readOnlyHint: true,
	openWorldHint: true,
	idempotentHint: true,
};

function jsonResult(structured, summary) {
	const text = summary
		? `${summary}\n\n${JSON.stringify(structured, null, 2)}`
		: JSON.stringify(structured, null, 2);
	return { content: [{ type: 'text', text }], structuredContent: structured };
}

const samplingShape = {
	max_tokens: z
		.number()
		.int()
		.min(1)
		.max(32768)
		.optional()
		.describe('Maximum tokens to generate.'),
	temperature: z
		.number()
		.min(0)
		.max(2)
		.optional()
		.describe('Sampling temperature. 0 is greedy/deterministic.'),
	top_p: z.number().min(0).max(1).optional().describe('Nucleus sampling probability mass.'),
};

export function buildTools(client) {
	return [
		{
			name: 'qwen_chat',
			title: 'Qwen Chat',
			annotations: generativeAnnotations,
			description:
				'Chat completion with an Alibaba Cloud Qwen model via DashScope. ' +
				'Pass a list of role/content messages and get the assistant reply plus ' +
				'token usage. Defaults to qwen-plus; use qwen-max for highest quality, ' +
				'qwen-turbo for fastest/cheapest, or qwen-long for very large contexts.',
			inputSchema: {
				messages: z
					.array(
						z.object({
							role: z.enum(['system', 'user', 'assistant']),
							content: z.string().min(1),
						}),
					)
					.min(1)
					.describe('Conversation so far, oldest first.'),
				model: z
					.string()
					.optional()
					.describe(
						'Override the model id. Options: qwen-max, qwen-plus (default), ' +
							'qwen-turbo, qwen-long, qwen-max-latest.',
					),
				...samplingShape,
			},
			handler: async (args) => {
				const result = await client.chat(args.messages, {
					model: args.model,
					maxTokens: args.max_tokens,
					temperature: args.temperature,
					topP: args.top_p,
				});
				return jsonResult(result, result.text);
			},
		},

		{
			name: 'qwen_embed',
			title: 'Qwen Text Embeddings',
			annotations: deterministicAnnotations,
			description:
				'Generate text embeddings using Alibaba Cloud text-embedding models. ' +
				'Returns a float vector per input string. Useful for semantic search, ' +
				'clustering, and RAG retrieval. Defaults to text-embedding-v3 (1024-dim).',
			inputSchema: {
				inputs: z
					.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
					.describe('One string or an array of strings to embed.'),
				model: z
					.string()
					.optional()
					.describe(
						'Embedding model id (default: text-embedding-v3). ' +
							'Alternatives: text-embedding-v2, text-embedding-async-v3.',
					),
				dimensions: z
					.number()
					.int()
					.min(64)
					.max(2048)
					.optional()
					.describe(
						'Output vector dimensions. text-embedding-v3 supports 64 to 2048 (default 1024).',
					),
			},
			handler: async (args) => {
				const inputs = Array.isArray(args.inputs) ? args.inputs : [args.inputs];
				const result = await client.embed(inputs, {
					model: args.model,
					dimensions: args.dimensions,
				});
				return jsonResult(
					result,
					`Embedded ${result.inputCount} string(s) with ${result.model}: ${result.dimensions}-dim vectors.`,
				);
			},
		},

		{
			name: 'qwen_list_models',
			title: 'List DashScope Models',
			annotations: deterministicAnnotations,
			description:
				'List the models available on this DashScope account. ' +
				'Returns model ids, owners, and creation timestamps.',
			inputSchema: {},
			handler: async () => {
				const models = await client.listModels();
				return jsonResult(
					{ count: models.length, models },
					`${models.length} models available on this DashScope account.`,
				);
			},
		},
	];
}
