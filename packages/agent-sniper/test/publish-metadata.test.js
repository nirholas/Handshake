import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

// The MCP registry rejects a server.json whose declared version disagrees with
// the npm package it points at, and npm refuses to republish an existing
// version. Both have bitten this org: npm reached 0.1.2 here while
// package.json still read 0.1.0, because publish-time bumps were never
// committed back. The repo could not publish and misreported what was live.
describe('publish metadata stays internally consistent', () => {
	const load = async (f) =>
		JSON.parse(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'));

	it('server.json version tracks package.json', async () => {
		const [pkg, server] = await Promise.all([load('package.json'), load('server.json')]);
		expect(server.version).toBe(pkg.version);
	});

	it('server.json npm package entry tracks package.json', async () => {
		const [pkg, server] = await Promise.all([load('package.json'), load('server.json')]);
		const entry = server.packages?.find(
			(p) => p.registryType === 'npm' && p.identifier === pkg.name,
		);
		expect(entry, `server.json must list an npm entry for ${pkg.name}`).toBeDefined();
		expect(entry.version).toBe(pkg.version);
	});

	it('mcpName ties the npm package to its registry identity', async () => {
		const [pkg, server] = await Promise.all([load('package.json'), load('server.json')]);
		// A mismatch publishes an orphaned registry entry that resolves to nothing.
		expect(pkg.mcpName).toBe(server.name);
	});
});
