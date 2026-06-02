#!/usr/bin/env node
// @nirholas/ibm-watsonx-mcp — stdio MCP server for IBM watsonx.ai.
//
// Exposes IBM Granite (and any model in your watsonx.ai account) as MCP tools:
// chat, raw text generation, embeddings, tokenization, and model discovery.
//
// Architecture: this process talks DIRECTLY to the watsonx.ai as-a-Service REST
// API using YOUR IBM Cloud credentials. It mints an IAM bearer token from your
// API key, caches it until just before expiry, and scopes every inference call
// to your project (or deployment space). There is no intermediary backend and
// no mock path — all data comes from IBM. Configure via environment variables:
//
//   WATSONX_API_KEY       (required) IBM Cloud API key  → https://cloud.ibm.com/iam/apikeys
//   WATSONX_PROJECT_ID    (required, or WATSONX_SPACE_ID) watsonx.ai project id
//   WATSONX_URL           (optional) region host, default https://us-south.ml.cloud.ibm.com
//   WATSONX_MODEL_ID      (optional) default chat/gen model, default ibm/granite-3-8b-instruct
//   WATSONX_EMBED_MODEL_ID(optional) default embedding model
//   WATSONX_API_VERSION   (optional) REST version date, default 2024-05-31
//
// Run standalone:  WATSONX_API_KEY=... WATSONX_PROJECT_ID=... npx @nirholas/ibm-watsonx-mcp
// Inspect:         npx -y @modelcontextprotocol/inspector npx @nirholas/ibm-watsonx-mcp

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, WatsonxClient, WatsonxError } from './watsonx.js';
import { buildTools } from './tools.js';

const SERVER_NAME = 'three.ws-ibm-watsonx-mcp';
const SERVER_VERSION = '0.1.0';

async function main() {
	// Fail fast and clearly if credentials are missing — the message names the
	// exact env var and where to get its value.
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		process.stderr.write(`[ibm-watsonx-mcp] configuration error: ${err.message}\n`);
		process.exit(1);
		return;
	}

	const client = new WatsonxClient(config);
	const tools = buildTools(client);
	const byName = new Map(tools.map((t) => [t.definition.name, t]));

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: { tools: { listChanged: false } },
			instructions:
				'IBM watsonx.ai tools powered by Granite foundation models. Use watsonx_chat ' +
				'for conversational completions, watsonx_generate for raw prompt completion with ' +
				'decoding control, watsonx_embed for embedding vectors, watsonx_tokenize to count ' +
				'tokens before a call, and watsonx_list_models to discover available models. ' +
				`Default model: ${config.chatModel}. All calls use your own IBM Cloud account.`,
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => t.definition),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const tool = byName.get(name);
		if (!tool) {
			return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
		}
		try {
			return await tool.handler(args || {});
		} catch (err) {
			// Surface the real upstream cause (IBM status + message) rather than a
			// generic failure, so the client can act on auth/quota/model errors.
			const text =
				err instanceof WatsonxError
					? `${err.message}${err.detail ? ` (${JSON.stringify(err.detail)})` : ''}`
					: `Tool ${name} failed: ${err.message}`;
			return { isError: true, content: [{ type: 'text', text }] };
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[ibm-watsonx-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready — ${tools.length} tools, ` +
			`model ${config.chatModel} @ ${config.url}\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`[ibm-watsonx-mcp] fatal: ${err?.stack || err}\n`);
	process.exit(1);
});
