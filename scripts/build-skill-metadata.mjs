#!/usr/bin/env node
/**
 * Generate data/_generated/skill-metadata.json from AgentSkills.list().
 *
 * Why: api/chat-skills.js and api/skills-manifest.js only need skill metadata
 * (name, description, inputSchema, mcpExposed). Importing AgentSkills at
 * runtime drags in Three.js, @solana, @metaplex-foundation, @coinbase, etc.
 * via the registered skill modules — pushing the deployed Vercel function
 * over the 300mb hard limit. The build-time generator pays that import cost
 * here, then the function reads a small JSON file at runtime.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSkills } from '../src/agent-skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outFile = resolve(root, 'data/_generated/skill-metadata.json');

const noop = () => {};
const stub = { emit: noop, on: noop, off: noop, add: noop, query: () => [] };
const skills = new AgentSkills(stub, stub);

const entries = skills.list().map((s) => ({
	name: s.name,
	description: s.description || '',
	mcpExposed: !!s.mcpExposed,
	inputSchema: s.inputSchema || { type: 'object', properties: {} },
	animationHint: s.animationHint || null,
}));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(entries, null, '\t') + '\n');

console.log(`[build-skill-metadata] wrote ${entries.length} skills → ${outFile}`);
