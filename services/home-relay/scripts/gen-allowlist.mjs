/**
 * Writes services/home-relay/allowlist.json from src/protocol.js.
 *
 * The relay enforces the allowlist in JavaScript and the Home Assistant
 * integration enforces it again in Python. Two enforcement points that drift
 * apart would be worse than one, so the Python side reads this generated file
 * rather than transcribing the rules, and tests/home-relay-protocol.test.js
 * fails if this file is stale.
 *
 *   node services/home-relay/scripts/gen-allowlist.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { allowlistManifest } from '../src/protocol.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'allowlist.json');
writeFileSync(out, `${JSON.stringify(allowlistManifest(), null, '\t')}\n`);
console.log(`wrote ${out}`);
