// The published `reload_url` examples must actually resolve.
//
// Three surfaces advertise "reload the same body with GET /api/mcp3d/persona":
// the x402 embody endpoint's OUTPUT_EXAMPLE, the service-catalog entry x402scan
// renders, and docs/embody.md. All three used to print a persona id the route
// rejects with 400 (a bare UUID, or a `persona_` id too short for the id
// format), so anyone copying the example got an error instead of a body. These
// tests pin every published example to the same validator the route uses, so
// the next edit cannot silently reintroduce an id that will not resolve.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { isPersonaId } = await import('../../api/_lib/persona-store.js');
const { default: embodyService } = await import('../../api/_lib/service-catalog/services/embody.js');

// Every `?id=` a doc or example hands to the reload route, wherever it appears.
const RELOAD_ID_RE = /\/api\/mcp3d\/persona(?:-identity)?\?id=([^"'\s&)\\]+)/g;

// Placeholders (`<agent_id>`, a `${...}` template hole) are prose, not examples.
const isPlaceholder = (id) => id.startsWith('<') || id.startsWith('$') || id.includes('{');

function reloadIdsIn(text) {
	return [...text.matchAll(RELOAD_ID_RE)]
		.map((m) => decodeURIComponent(m[1]))
		.filter((id) => !isPlaceholder(id));
}

describe('published reload_url examples resolve against GET /api/mcp3d/persona', () => {
	it('the service-catalog entry advertises an id the route accepts', () => {
		const ex = embodyService.outputExample;
		expect(isPersonaId(ex.agent_id)).toBe(true);
		expect(reloadIdsIn(ex.reload_url)).toEqual([ex.agent_id]);
		// The embed URLs point at the real embed route, not a path that 404s.
		expect(ex.profile_url).toContain('/embodiment/embed?persona=');
		expect(ex.embed_html).toContain('/embodiment/embed?persona=');
	});

	it('every reload id printed in api/x402/embody.js is a valid persona id', async () => {
		const src = await fs.readFile(path.join(ROOT, 'api', 'x402', 'embody.js'), 'utf8');
		const ids = reloadIdsIn(src);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(isPersonaId(id)).toBe(true);
	});

	it('every reload id printed in docs/embody.md is a valid persona id', async () => {
		const doc = await fs.readFile(path.join(ROOT, 'docs', 'embody.md'), 'utf8');
		const ids = reloadIdsIn(doc);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(isPersonaId(id)).toBe(true);
	});
});
