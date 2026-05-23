// Reads the precomputed SKILL.md pack list produced by
// scripts/build-local-skill-packs.mjs at build time.
//
// Why precomputed: scanning the four pack dirs at runtime required deriving
// REPO_ROOT from `new URL('../..', import.meta.url)`. Vercel's @vercel/nft
// tracer treats that root pointer as a needed asset and bundles the entire
// repo into every function that imports this module, blowing past the 300mb
// function limit. Pointing only at the generated JSON file keeps the trace
// scoped to a single small artifact.
//
// Packs are the Claude-style format: YAML frontmatter + markdown body. The
// body becomes a "knowledge skill" the chat injects into the system prompt;
// the agent reads it and follows the embedded instructions.

import { readFileSync } from 'fs';

let _cached = null;
export function loadLocalSkillPacks() {
	if (_cached) return _cached;
	_cached = JSON.parse(
		readFileSync(
			new URL('../../data/_generated/local-skill-packs.json', import.meta.url),
			'utf8',
		),
	);
	return _cached;
}
