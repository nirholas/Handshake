// browse-marketplace.mjs: walk the public three.ws marketplace end to end with
// three free, read-only tools.
//
//   1. agent_categories  which categories exist, and how many agents in each
//   2. browse_agents     page the most popular agents in the biggest category
//   3. agent_detail      expand the first card into its full record
//   4. browse_skills     the skills catalog side of the same catalog
//
// Every call hits the live public /api/marketplace and /api/skills endpoints.
// Nothing here needs a key, a signer, or a payment, and nothing here writes:
// publishing an agent or a skill is the authenticated HTTP write path, which
// this MCP server deliberately does not expose.
//
//   node examples/browse-marketplace.mjs
//   node examples/browse-marketplace.mjs programming
//   node examples/browse-marketplace.mjs "" "code review"
//
// Arg 1 pins a category slug (default: the category with the most agents).
// Arg 2 adds a free-text query.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS'];

const [categoryArg, queryArg] = process.argv.slice(2);

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Unwrap an MCP tool result's JSON payload from its text content block. */
function payload(result) {
	const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, raw: text };
	}
}

/** Call a tool and fail loudly rather than continuing on half-data. */
async function call(client, name, args) {
	const data = payload(await client.callTool({ name, arguments: args }));
	if (!data.ok) {
		throw new Error(`${name} failed: ${data.message || data.error || data.raw || 'unknown error'}`);
	}
	return data;
}

function truncate(text, max) {
	const one = String(text ?? '').replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'marketplace-mcp-browse-example', version: '1.0.0' });
await client.connect(transport);

try {
	// ── 1. agent_categories ────────────────────────────────────────────────
	const cats = await call(client, 'agent_categories', {});
	const ranked = [...cats.categories].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
	console.log(`\nagent_categories: ${ranked.length} categories, ${cats.total} published agents`);
	for (const cat of ranked.slice(0, 5)) {
		console.log(`  ${String(cat.count).padStart(5)}  ${cat.slug}`);
	}

	const category = categoryArg || ranked[0]?.slug;

	// ── 2. browse_agents ───────────────────────────────────────────────────
	const browseArgs = { sort: 'popular', limit: 5 };
	if (category) browseArgs.category = category;
	if (queryArg) browseArgs.q = queryArg;
	const page = await call(client, 'browse_agents', browseArgs);
	console.log(
		`\nbrowse_agents: category=${category ?? 'any'} q=${queryArg || 'none'} sort=popular limit=5`,
	);
	console.log(`  ${page.items.length} card(s), next_cursor=${page.next_cursor ?? 'null'}`);
	for (const agent of page.items) {
		const rating = agent.rating_count ? `${agent.rating_avg} from ${agent.rating_count}` : 'unrated';
		console.log(`  - ${agent.name}  [${agent.category}]  ${agent.views_count} views, ${rating}`);
		console.log(`      ${truncate(agent.description, 90)}`);
	}

	// ── 3. agent_detail ────────────────────────────────────────────────────
	const first = page.items[0];
	if (!first) {
		console.log('\nagent_detail: skipped, that filter returned no cards');
	} else {
		const detail = await call(client, 'agent_detail', { id: first.id });
		const agent = detail.agent;
		console.log(`\nagent_detail: ${agent.id}`);
		console.log(`  name:     ${agent.name}`);
		console.log(`  category: ${agent.category}`);
		console.log(`  tags:     ${(agent.tags ?? []).join(', ') || 'none'}`);
		console.log(`  skills:   ${(agent.skills ?? []).join(', ') || 'none'}`);
		console.log(`  avatar:   ${agent.avatar_glb_url ?? 'none'}`);
		console.log(`  greeting: ${truncate(agent.greeting, 90) || 'none'}`);
	}

	// ── 4. browse_skills ───────────────────────────────────────────────────
	const skills = await call(client, 'browse_skills', { sort: 'popular', limit: 5 });
	console.log(`\nbrowse_skills: sort=popular limit=5`);
	for (const skill of skills.skills) {
		const price = skill.price_per_call_usd ? `$${skill.price_per_call_usd}/call` : 'free';
		console.log(`  - ${skill.name}  [${skill.category}]  ${skill.install_count ?? 0} installs, ${price}`);
	}

	console.log('\nAll four calls were read-only. Nothing was published, purchased, or modified.');
} finally {
	await client.close();
}
