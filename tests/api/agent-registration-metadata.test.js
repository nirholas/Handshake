// buildAgentRegistrationMetadata — the off-chain doc our on-chain Metaplex Agent
// Registry flow pins (api/_lib/onchain-deploy.js -> registerAgentOnce). Regression
// guard: the registry showed three.ws as "x402 Not Supported" / inactive because
// this doc omitted the EIP-8004 signals. These tests lock the truthful shape in.

import { describe, it, expect } from 'vitest';
import {
	buildAgentRegistrationMetadata,
	erc8004RegistryFields,
} from '../../api/_lib/three-brand.js';

const agent = {
	agentId: 'abc123',
	name: 'three.ws',
	description: 'AI-powered 3D model viewer and validation agent.',
};

describe('buildAgentRegistrationMetadata', () => {
	it('keeps the six SDK-required AgentMetadata fields', () => {
		const m = buildAgentRegistrationMetadata(agent);
		for (const k of [
			'type',
			'name',
			'description',
			'services',
			'registrations',
			'supportedTrust',
		]) {
			expect(m[k], `missing required field ${k}`).toBeDefined();
		}
		expect(Array.isArray(m.services)).toBe(true);
		expect(
			m.services.every((s) => typeof s.name === 'string' && typeof s.endpoint === 'string'),
		).toBe(true);
	});

	it('advertises x402 support so the registry does not default to "Not Supported"', () => {
		const m = buildAgentRegistrationMetadata(agent);
		expect(m.x402Support).toBe(true);
		expect(m.active).toBe(true);
		expect(Array.isArray(m.x402Endpoints)).toBe(true);
		expect(m.x402Endpoints.length).toBeGreaterThan(0);
		const ep = m.x402Endpoints[0];
		expect(ep.scheme).toBe('exact');
		expect(ep.networks).toContain('solana');
		expect(String(ep.url)).toMatch(/^https?:\/\//);
	});

	it('declares the EIP-8004 registration-v1 type the Metaplex registry indexes', () => {
		const m = buildAgentRegistrationMetadata(agent);
		const types = Array.isArray(m.type) ? m.type : [m.type];
		expect(types).toContain('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
	});

	it('cross-links the three.ws registry and points at the resolvable agent card', () => {
		const m = buildAgentRegistrationMetadata(agent);
		expect(m.registrations[0]).toEqual({
			agentId: 'abc123',
			agentRegistry: 'https://three.ws',
		});
		expect(m.agentMetadataUri).toMatch(/\/\.well-known\/agent-card\.json$/);
		expect(m.services.some((s) => s.name === 'A2A')).toBe(true);
	});

	it('falls back to a generated description and home url when none supplied', () => {
		const m = buildAgentRegistrationMetadata({ agentId: 7, name: 'Solo' });
		expect(m.description).toContain('Solo');
		expect(m.services.find((s) => s.name === 'web').endpoint).toMatch(/\/agents\/7$/);
	});
});

describe('erc8004RegistryFields', () => {
	// These flat field names must match exactly what the registry subgraph reads in
	// api/agents/8004/agent.js — a rename there silently drops the value to its
	// `?? false` / null default, which is the bug this guards against.
	it('emits active + x402Support so the EVM registry does not show "Not Supported"', () => {
		const f = erc8004RegistryFields('https://three.ws');
		expect(f.active).toBe(true);
		expect(f.x402Support).toBe(true);
		expect(f.supportedTrusts).toContain('reputation');
	});

	it('exposes absolute web/a2a/mcp endpoints under the given origin', () => {
		const f = erc8004RegistryFields('https://three.ws/');
		expect(f.webEndpoint).toBe('https://three.ws');
		expect(f.a2aEndpoint).toBe('https://three.ws/.well-known/agent-card.json');
		expect(f.mcpEndpoint).toBe('https://three.ws/api/mcp');
		expect(f.a2aVersion).toBe('0.3.0');
		expect(f.mcpVersion).toBe('2025-06-18');
	});
});
