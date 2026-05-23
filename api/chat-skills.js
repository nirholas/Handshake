// GET /api/chat-skills - rich local-skill feed for the chat Skills modal.
//
// Returns a normalized list that combines:
//   1. Agent-runtime skills (66+) - MCP-exposed handlers, surfaced as
//      installable tool packs whose clientDefinition.body POSTs to /api/mcp.
//   2. SKILL.md packs on disk (.agents/skills, pump-fun-skills,
//      public/skills, examples/skills) - surfaced as knowledge skills
//      whose body is injected into the system prompt on install.
//
// Skill metadata is read from data/_generated/skill-metadata.json, produced
// by scripts/build-skill-metadata.mjs at build time. Importing AgentSkills
// directly here would pull Three.js, @solana, @metaplex-foundation, @coinbase,
// etc. into the deployed function and exceed Vercel's 300mb function limit.

import { readFileSync } from 'fs';
import { cors, json, method, wrap } from './_lib/http.js';
import { loadLocalSkillPacks } from '../src/skills/local-packs.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const _skillMetadata = JSON.parse(
	readFileSync(new URL('../data/_generated/skill-metadata.json', import.meta.url), 'utf8'),
);

function mcpToolNameFor(skillName) {
	return `skill_${skillName.replace(/[-.]/g, '_')}`;
}

function buildClientToolFor(skill) {
	const mcpName = mcpToolNameFor(skill.name);
	const inputSchema = skill.inputSchema || { type: 'object', properties: {} };
	const argsList = Object.entries(inputSchema.properties || {}).map(([k, p]) => ({
		name: k,
		type: p.type || 'any',
		description: p.description || '',
	}));
	const body = [
		"const _r = await fetch('/api/mcp', {",
		"  method: 'POST',",
		"  headers: { 'content-type': 'application/json' },",
		"  credentials: 'include',",
		'  body: JSON.stringify({',
		"    jsonrpc: '2.0', id: 1, method: 'tools/call',",
		`    params: { name: ${JSON.stringify(mcpName)}, arguments: args || {} },`,
		'  }),',
		'});',
		'const _t = await _r.text();',
		'let _d = null; try { _d = _t ? JSON.parse(_t) : null; } catch {}',
		"if (!_r.ok) return JSON.stringify({ error: (_d && (_d.error?.message || _d.error)) || ('HTTP ' + _r.status) });",
		'if (_d && _d.error) return JSON.stringify({ error: _d.error.message || _d.error });',
		'const _c = _d && _d.result && _d.result.content;',
		"if (Array.isArray(_c)) return _c.map(x => x.text || JSON.stringify(x)).join('\\n');",
		'return JSON.stringify(_c ?? _d ?? null, null, 2);',
	].join('\n');
	return {
		clientDefinition: {
			id: `local-skill-${skill.name}`,
			name: skill.name,
			description: skill.description,
			arguments: argsList,
			body,
		},
		type: 'function',
		function: {
			name: skill.name,
			description: skill.description,
			parameters: inputSchema,
		},
	};
}

function buildAgentRuntimeEntries() {
	const out = [];
	for (const skill of _skillMetadata) {
		if (!skill.description) continue;
		const base = {
			id: `local:agent-runtime:${skill.name}`,
			source: 'agent-runtime',
			category: 'agent-runtime',
			name: skill.name,
			slug: skill.name,
			description: skill.description,
			mcp_exposed: !!skill.mcpExposed,
		};
		if (skill.mcpExposed) {
			out.push({ ...base, kind: 'tool', schema_json: [buildClientToolFor(skill)] });
		} else {
			out.push({ ...base, kind: 'tool', schema_json: [], unavailable: true });
		}
	}
	return out;
}

let _cache = null;
function build() {
	if (_cache) return _cache;
	const runtime = buildAgentRuntimeEntries();
	const packs = loadLocalSkillPacks();
	const all = [...runtime, ...packs];
	_cache = {
		agent: { id: '3d-agent', version },
		skills: all,
		sources: {
			'agent-runtime': runtime,
			'agentic-wallet': packs.filter((p) => p.source === 'agentic-wallet'),
			'pump-fun-skills': packs.filter((p) => p.source === 'pump-fun-skills'),
			'public-skills': packs.filter((p) => p.source === 'public-skills'),
			examples: packs.filter((p) => p.source === 'examples'),
		},
	};
	return _cache;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	return json(res, 200, build(), { 'cache-control': 'public, max-age=60' });
});
