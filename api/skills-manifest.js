// GET /api/skills-manifest — machine-readable manifest of agent skills.
//
// Skill metadata is read from data/_generated/skill-metadata.json, produced
// by scripts/build-skill-metadata.mjs at build time. Importing AgentSkills
// directly here would pull Three.js, @solana, @metaplex-foundation, @coinbase,
// etc. into the deployed function and exceed Vercel's 300mb function limit.

import { readFileSync } from 'fs';
import { cors, json, method, wrap } from './_lib/http.js';
import { buildSkillManifest } from '../src/skill-manifest.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const _skillMetadata = JSON.parse(
	readFileSync(new URL('../data/_generated/skill-metadata.json', import.meta.url), 'utf8'),
);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	return json(
		res,
		200,
		buildSkillManifest({
			agentId: '3d-agent',
			version,
			skills: _skillMetadata,
		}),
		{ 'cache-control': 'public, max-age=60' },
	);
});
