import { describe, it, expect } from 'vitest';
import {
	WIDGET_TYPES,
	WIDGET_TYPE_KEYS,
	BRAND_DEFAULTS,
	defaultConfig,
	validateConfig,
	isReady,
	resolveChainId,
	chainLabel,
	CHAIN_SLUGS,
} from '../../src/widget-types.js';

describe('WIDGET_TYPES', () => {
	it('exposes the known widget types', () => {
		expect(WIDGET_TYPE_KEYS.sort()).toEqual(
			[
				'turntable',
				'animation-gallery',
				'talking-agent',
				'passport',
				'hotspot-tour',
				'pumpfun-feed',
				'kol-trades',
				'live-trades-canvas',
				'bonding-curve',
			].sort(),
		);
	});

	it('every entry has label, desc, status, icon', () => {
		for (const key of WIDGET_TYPE_KEYS) {
			const entry = WIDGET_TYPES[key];
			expect(typeof entry.label).toBe('string');
			expect(typeof entry.desc).toBe('string');
			expect(['ready', 'pending']).toContain(entry.status);
			expect(typeof entry.icon).toBe('string');
		}
	});

	it('BRAND_DEFAULTS is frozen', () => {
		expect(Object.isFrozen(BRAND_DEFAULTS)).toBe(true);
	});
});

describe('isReady', () => {
	it('returns true for ready widgets', () => {
		expect(isReady('turntable')).toBe(true);
		expect(isReady('animation-gallery')).toBe(true);
		expect(isReady('talking-agent')).toBe(true);
		expect(isReady('passport')).toBe(true);
		expect(isReady('hotspot-tour')).toBe(true);
	});

	it('returns false for unknown types', () => {
		expect(isReady('bogus')).toBe(false);
	});
});

describe('defaultConfig', () => {
	it('merges BRAND_DEFAULTS with type defaults', () => {
		const cfg = defaultConfig('turntable');
		expect(cfg.background).toBe(BRAND_DEFAULTS.background);
		expect(cfg.rotationSpeed).toBe(0.5);
	});

	it('returns hotspot-tour defaults with empty array', () => {
		const cfg = defaultConfig('hotspot-tour');
		expect(cfg.hotspots).toEqual([]);
	});

	it('throws on unknown type', () => {
		expect(() => defaultConfig('unknown')).toThrow(/unknown widget type/);
	});
});

describe('validateConfig — turntable', () => {
	it('accepts default config', () => {
		expect(() => validateConfig('turntable', defaultConfig('turntable'))).not.toThrow();
	});

	it('rejects rotationSpeed above 10', () => {
		expect(() =>
			validateConfig('turntable', { ...defaultConfig('turntable'), rotationSpeed: 11 }),
		).toThrow(/rotationSpeed/);
	});

	it('rejects negative rotationSpeed', () => {
		expect(() =>
			validateConfig('turntable', { ...defaultConfig('turntable'), rotationSpeed: -1 }),
		).toThrow(/rotationSpeed/);
	});

	it('rejects bad hex color', () => {
		expect(() =>
			validateConfig('turntable', { ...defaultConfig('turntable'), background: 'red' }),
		).toThrow();
	});
});

describe('validateConfig — talking-agent', () => {
	it('accepts default config', () => {
		expect(() => validateConfig('talking-agent', defaultConfig('talking-agent'))).not.toThrow();
	});

	it('requires proxyURL when brainProvider is custom', () => {
		expect(() =>
			validateConfig('talking-agent', {
				...defaultConfig('talking-agent'),
				brainProvider: 'custom',
				proxyURL: '',
			}),
		).toThrow(/proxyURL/);
	});

	it('accepts custom brainProvider with https proxyURL', () => {
		const cfg = validateConfig('talking-agent', {
			...defaultConfig('talking-agent'),
			brainProvider: 'custom',
			proxyURL: 'https://my-proxy.example/chat',
		});
		expect(cfg.proxyURL).toBe('https://my-proxy.example/chat');
	});

	it('rejects http (non-https) proxyURL', () => {
		expect(() =>
			validateConfig('talking-agent', {
				...defaultConfig('talking-agent'),
				proxyURL: 'http://insecure.example',
			}),
		).toThrow();
	});

	it('rejects temperature above 1', () => {
		expect(() =>
			validateConfig('talking-agent', {
				...defaultConfig('talking-agent'),
				temperature: 1.5,
			}),
		).toThrow();
	});
});

describe('validateConfig — passport', () => {
	it('accepts default config', () => {
		expect(() => validateConfig('passport', defaultConfig('passport'))).not.toThrow();
	});

	it('rejects non-numeric agentId', () => {
		expect(() =>
			validateConfig('passport', { ...defaultConfig('passport'), agentId: 'abc' }),
		).toThrow(/agentId/);
	});

	it('rejects malformed wallet address', () => {
		expect(() =>
			validateConfig('passport', { ...defaultConfig('passport'), wallet: '0xnothex' }),
		).toThrow(/wallet/);
	});

	it('accepts valid uint256 agentId', () => {
		const cfg = validateConfig('passport', {
			...defaultConfig('passport'),
			agentId: '12345',
		});
		expect(cfg.agentId).toBe('12345');
	});

	it('rejects refreshIntervalSec above 3600', () => {
		expect(() =>
			validateConfig('passport', { ...defaultConfig('passport'), refreshIntervalSec: 5000 }),
		).toThrow();
	});
});

describe('validateConfig — hotspot-tour', () => {
	it('accepts empty hotspots array', () => {
		expect(() => validateConfig('hotspot-tour', defaultConfig('hotspot-tour'))).not.toThrow();
	});

	it('rejects hotspot with missing position', () => {
		expect(() =>
			validateConfig('hotspot-tour', {
				...defaultConfig('hotspot-tour'),
				hotspots: [{ id: 'a', label: 'Foo' }],
			}),
		).toThrow();
	});

	it('accepts well-formed hotspot', () => {
		const cfg = validateConfig('hotspot-tour', {
			...defaultConfig('hotspot-tour'),
			hotspots: [{ id: 'a', label: 'Foo', position: [0, 1, 2] }],
		});
		expect(cfg.hotspots).toHaveLength(1);
	});

	it('rejects more than 40 hotspots', () => {
		const many = Array.from({ length: 41 }, (_, i) => ({
			id: `h${i}`,
			label: `Hotspot ${i}`,
			position: [0, 0, 0],
		}));
		expect(() =>
			validateConfig('hotspot-tour', { ...defaultConfig('hotspot-tour'), hotspots: many }),
		).toThrow();
	});
});

describe('validateConfig — errors', () => {
	it('throws on unknown type', () => {
		expect(() => validateConfig('unknown', {})).toThrow(/unknown widget type/);
	});

	it('validation errors have code "validation_error"', () => {
		try {
			validateConfig('turntable', { rotationSpeed: 999 });
		} catch (err) {
			expect(err.code).toBe('validation_error');
		}
	});
});

describe('resolveChainId', () => {
	it('returns chainId for known slugs', () => {
		expect(resolveChainId('base')).toBe(8453);
		expect(resolveChainId('base-sepolia')).toBe(84532);
		expect(resolveChainId('ethereum')).toBe(1);
	});

	it('returns numeric ref as-is', () => {
		expect(resolveChainId(1)).toBe(1);
		expect(resolveChainId(8453)).toBe(8453);
	});

	it('parses numeric string', () => {
		expect(resolveChainId('137')).toBe(137);
	});

	it('returns null for unknown slug', () => {
		expect(resolveChainId('bogus-chain')).toBe(null);
	});

	it('returns null for non-string, non-number input', () => {
		expect(resolveChainId(null)).toBe(null);
		expect(resolveChainId(undefined)).toBe(null);
		expect(resolveChainId({})).toBe(null);
	});

	it('is case-insensitive for slugs', () => {
		expect(resolveChainId('BASE')).toBe(CHAIN_SLUGS.base);
	});
});

describe('chainLabel', () => {
	it('returns slug for known chainId', () => {
		expect(chainLabel(8453)).toBe('base');
		expect(chainLabel(1)).toBe('ethereum');
	});

	it('returns fallback for unknown chainId', () => {
		expect(chainLabel(999999)).toBe('chain-999999');
	});
});
