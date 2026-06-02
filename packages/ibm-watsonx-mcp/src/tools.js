// Tool surface for the IBM watsonx.ai MCP server.
//
// Each entry pairs an MCP tool definition (name + JSON-Schema input) with a
// handler that maps validated arguments onto a WatsonxClient call and shapes
// the response into MCP content. Handlers trust their inputs (the schema is the
// boundary) and let WatsonxError propagate — the server turns those into MCP
// tool errors with the real upstream cause.

// Shared decoding parameters reused by chat and generate.
const samplingProps = {
	max_tokens: {
		type: 'integer',
		minimum: 1,
		maximum: 4096,
		description: 'Maximum number of tokens to generate.',
	},
	temperature: {
		type: 'number',
		minimum: 0,
		maximum: 2,
		description: 'Sampling temperature. 0 is greedy/deterministic.',
	},
	top_p: { type: 'number', minimum: 0, maximum: 1, description: 'Nucleus sampling probability mass.' },
};

// Build a chat `parameters` object from loose tool args, omitting unset keys.
function chatParams({ max_tokens, temperature, top_p }) {
	const p = {};
	if (max_tokens != null) p.max_tokens = max_tokens;
	if (temperature != null) p.temperature = temperature;
	if (top_p != null) p.top_p = top_p;
	return Object.keys(p).length ? p : undefined;
}

// Render a JSON object as a pretty MCP text block plus structuredContent, so
// both humans and programmatic clients get a usable result.
function jsonResult(structured, summary) {
	const text = summary ? `${summary}\n\n${JSON.stringify(structured, null, 2)}` : JSON.stringify(structured, null, 2);
	return { content: [{ type: 'text', text }], structuredContent: structured };
}

export function buildTools(client) {
	return [
		{
			definition: {
				name: 'watsonx_chat',
				description:
					'Chat completion with an IBM Granite (or other watsonx.ai) model. Pass a ' +
					'list of role/content messages and get the assistant reply plus token usage.',
				inputSchema: {
					type: 'object',
					properties: {
						messages: {
							type: 'array',
							minItems: 1,
							description: 'Conversation so far, oldest first.',
							items: {
								type: 'object',
								properties: {
									role: { type: 'string', enum: ['system', 'user', 'assistant'] },
									content: { type: 'string' },
								},
								required: ['role', 'content'],
							},
						},
						model: {
							type: 'string',
							description: 'Override the model id (default: the server WATSONX_MODEL_ID).',
						},
						...samplingProps,
					},
					required: ['messages'],
				},
			},
			handler: async (args) => {
				const result = await client.chat(args.messages, {
					model: args.model,
					parameters: chatParams(args),
				});
				return jsonResult(result, result.text);
			},
		},

		{
			definition: {
				name: 'watsonx_generate',
				description:
					'Raw text generation from a single prompt (no chat templating). Use for ' +
					'completion-style tasks and fine decoding control via greedy or sampling.',
				inputSchema: {
					type: 'object',
					properties: {
						input: { type: 'string', description: 'The prompt to complete.' },
						model: { type: 'string', description: 'Override the model id.' },
						max_new_tokens: { type: 'integer', minimum: 1, maximum: 4096 },
						temperature: { type: 'number', minimum: 0, maximum: 2 },
						decoding_method: {
							type: 'string',
							enum: ['greedy', 'sample'],
							description: 'greedy is deterministic; sample uses temperature/top_p.',
						},
						stop_sequences: {
							type: 'array',
							items: { type: 'string' },
							description: 'Generation halts when any of these strings is produced.',
						},
					},
					required: ['input'],
				},
			},
			handler: async (args) => {
				const parameters = {};
				if (args.max_new_tokens != null) parameters.max_new_tokens = args.max_new_tokens;
				if (args.temperature != null) parameters.temperature = args.temperature;
				if (args.decoding_method) parameters.decoding_method = args.decoding_method;
				if (args.stop_sequences?.length) parameters.stop_sequences = args.stop_sequences;
				const result = await client.generate(args.input, {
					model: args.model,
					parameters: Object.keys(parameters).length ? parameters : undefined,
				});
				return jsonResult(result, result.text);
			},
		},

		{
			definition: {
				name: 'watsonx_embed',
				description:
					'Generate embedding vectors for one or more texts using an IBM Granite ' +
					'embedding model. Returns one vector per input plus the vector dimensionality.',
				inputSchema: {
					type: 'object',
					properties: {
						inputs: {
							type: 'array',
							minItems: 1,
							maxItems: 1000,
							items: { type: 'string' },
							description: 'Texts to embed.',
						},
						model: { type: 'string', description: 'Override the embedding model id.' },
					},
					required: ['inputs'],
				},
			},
			handler: async (args) => {
				const result = await client.embed(args.inputs, { model: args.model });
				return jsonResult(
					result,
					`Embedded ${result.inputCount} input(s) into ${result.dimensions}-dim vectors using ${result.model}.`,
				);
			},
		},

		{
			definition: {
				name: 'watsonx_tokenize',
				description:
					'Count tokens (and optionally return them) for a text against a model ' +
					"tokenizer. Use to budget context and cost before a generation call.",
				inputSchema: {
					type: 'object',
					properties: {
						input: { type: 'string' },
						model: { type: 'string', description: 'Override the model id.' },
						return_tokens: {
							type: 'boolean',
							default: false,
							description: 'Include the token strings, not just the count.',
						},
					},
					required: ['input'],
				},
			},
			handler: async (args) => {
				const result = await client.tokenize(args.input, {
					model: args.model,
					returnTokens: Boolean(args.return_tokens),
				});
				return jsonResult(result, `${result.tokenCount} tokens (${result.model}).`);
			},
		},

		{
			definition: {
				name: 'watsonx_list_models',
				description:
					'List the foundation models available to your watsonx.ai account and region. ' +
					'Optionally filter by supported function, e.g. text_generation or embedding.',
				inputSchema: {
					type: 'object',
					properties: {
						filter: {
							type: 'string',
							description:
								'Filter expression, e.g. "function_text_generation" or "function_embedding".',
						},
						limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
					},
				},
			},
			handler: async (args) => {
				const models = await client.listModels({ filter: args.filter, limit: args.limit });
				return jsonResult({ count: models.length, models }, `${models.length} model(s) available.`);
			},
		},
	];
}
