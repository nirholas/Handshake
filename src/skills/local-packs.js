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
import { join } from 'path';

// Resolve in a bundle-safe way. scripts/bundle-api.mjs inlines this module into
// each API entry with esbuild, which rewrites `import.meta.url` to the OUTPUT
// file's location (e.g. /var/task/api/chat-skills.js). A `../../`-relative URL
// is correct from this source path (src/skills/) but resolves two levels too
// high from the bundled entry (→ /var/data/...), so the read used to ENOENT in
// production. process.cwd() is /var/task on Vercel and the repo root in dev, and
// the JSON is force-shipped via vercel.json includeFiles (data/_generated/**),
// so the cwd path is correct in both. The original URL path stays as a fallback
// for any caller that runs unbundled from an unexpected cwd.
const REL = 'data/_generated/local-skill-packs.json';
const CANDIDATES = [
	join(process.cwd(), REL),
	new URL('../../' + REL, import.meta.url),
];

let _cached = null;
export function loadLocalSkillPacks() {
	if (_cached) return _cached;
	let lastErr;
	for (const candidate of CANDIDATES) {
		try {
			_cached = JSON.parse(readFileSync(candidate, 'utf8'));
			return _cached;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}
