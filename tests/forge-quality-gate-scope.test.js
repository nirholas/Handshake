// The Forge quality-gate SCOPE decision — which lanes pay for a vision-QA pass.
//
// The default flipped from 'high' (only the paid ceiling is vision-scored, the
// free draft/standard lanes ship whatever the first roll produced) to 'adaptive'
// (the free lanes gain a semantic quality floor, escalating to vision only when
// the cheap deterministic score can't vouch for the mesh). These tests pin that
// contract at the router boundary, including the env overrides ops rely on.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

let qualityGateScope;
let qualityGateAppliesTo;

// The cheap-scorer verdict shapes the router's adaptive decision consumes.
const GOOD = { flag: 'ok', score: 0.9, metrics: { hasTextures: true } };
const MEDIOCRE = { flag: 'ok', score: 0.3, metrics: { hasTextures: true } };
const LOW = { flag: 'low', score: 0.5, metrics: { hasTextures: true } };
const UNTEXTURED = { flag: 'ok', score: 0.9, metrics: { hasTextures: false } };

beforeAll(async () => {
	process.env.NODE_ENV = 'development';
	const mod = await import('../api/forge.js');
	qualityGateScope = mod.qualityGateScope;
	qualityGateAppliesTo = mod.qualityGateAppliesTo;
});

afterEach(() => {
	delete process.env.FORGE_QUALITY_GATE;
	delete process.env.FORGE_QUALITY_ADAPTIVE_MIN;
});

describe('qualityGateScope', () => {
	it('defaults to adaptive', () => {
		expect(qualityGateScope()).toBe('adaptive');
	});

	it('honors explicit high / all / off, and falls back to adaptive on garbage', () => {
		process.env.FORGE_QUALITY_GATE = 'high';
		expect(qualityGateScope()).toBe('high');
		process.env.FORGE_QUALITY_GATE = 'ALL';
		expect(qualityGateScope()).toBe('all');
		process.env.FORGE_QUALITY_GATE = 'off';
		expect(qualityGateScope()).toBe('off');
		process.env.FORGE_QUALITY_GATE = 'nonsense';
		expect(qualityGateScope()).toBe('adaptive');
	});
});

describe('qualityGateAppliesTo — adaptive (default)', () => {
	it('always scores the paid high tier regardless of cheap signal', () => {
		expect(qualityGateAppliesTo('high', GOOD)).toBe(true);
		expect(qualityGateAppliesTo('high', undefined)).toBe(true);
	});

	it('trusts a confidently-good free draft (no vision pass)', () => {
		expect(qualityGateAppliesTo('draft', GOOD)).toBe(false);
		expect(qualityGateAppliesTo('standard', GOOD)).toBe(false);
	});

	it('escalates ambiguous free drafts to vision QA', () => {
		expect(qualityGateAppliesTo('draft', MEDIOCRE)).toBe(true);
		expect(qualityGateAppliesTo('draft', LOW)).toBe(true);
		expect(qualityGateAppliesTo('draft', UNTEXTURED)).toBe(true);
		expect(qualityGateAppliesTo('draft', undefined)).toBe(true);
	});
});

describe('qualityGateAppliesTo — high scope (previous default)', () => {
	it('scores only the high tier, never the free lanes', () => {
		process.env.FORGE_QUALITY_GATE = 'high';
		expect(qualityGateAppliesTo('high', MEDIOCRE)).toBe(true);
		expect(qualityGateAppliesTo('draft', MEDIOCRE)).toBe(false);
		expect(qualityGateAppliesTo('standard', LOW)).toBe(false);
	});
});

describe('qualityGateAppliesTo — all / off', () => {
	it('all scores every tier unconditionally', () => {
		process.env.FORGE_QUALITY_GATE = 'all';
		expect(qualityGateAppliesTo('draft', GOOD)).toBe(true);
		expect(qualityGateAppliesTo('high', undefined)).toBe(true);
	});

	it('off scores nothing', () => {
		process.env.FORGE_QUALITY_GATE = 'off';
		expect(qualityGateAppliesTo('high', MEDIOCRE)).toBe(false);
		expect(qualityGateAppliesTo('draft', LOW)).toBe(false);
	});
});
