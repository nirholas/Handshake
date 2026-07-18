// Assistant widget core helpers — the frame's authoritative param validator.
// Everything here guards CSS/URL injection from hostile host pages, so the
// hostile-input cases matter as much as the happy paths.

import { describe, it, expect } from 'vitest';
import {
	parseBackground,
	normalizeMode,
	normalizePosition,
	normalizeLane,
	sanitizeAccent,
	isHexColor,
	buildFrameQuery,
	estimateSpeechMs,
	GRADIENT_PRESETS,
	DEFAULT_ACCENT,
	BYOK_DEFAULT_MODELS,
	BYOK_ENDPOINTS,
	FRAME_PARAM_KEYS,
} from '../src/assistant-widget-core.js';

describe('parseBackground', () => {
	it('defaults to transparent for empty/missing values', () => {
		expect(parseBackground(undefined)).toEqual({ kind: 'transparent', css: null });
		expect(parseBackground('')).toEqual({ kind: 'transparent', css: null });
		expect(parseBackground('transparent')).toEqual({ kind: 'transparent', css: null });
		expect(parseBackground('  Transparent  ')).toEqual({ kind: 'transparent', css: null });
	});

	it('accepts hex colors as solid backgrounds', () => {
		expect(parseBackground('#101820')).toEqual({ kind: 'solid', css: '#101820' });
		expect(parseBackground('#FFF')).toEqual({ kind: 'solid', css: '#fff' });
		expect(parseBackground('#11223344')).toEqual({ kind: 'solid', css: '#11223344' });
	});

	it('resolves every named gradient preset', () => {
		for (const [name, [from, to, angle]] of Object.entries(GRADIENT_PRESETS)) {
			expect(parseBackground(name)).toEqual({
				kind: 'gradient',
				css: `linear-gradient(${angle}deg, ${from}, ${to})`,
			});
		}
	});

	it('builds custom gradients from two hex stops and an optional angle', () => {
		expect(parseBackground('gradient:#0b0714,#9d174d')).toEqual({
			kind: 'gradient',
			css: 'linear-gradient(160deg, #0b0714, #9d174d)',
		});
		expect(parseBackground('gradient:#000,#fff,45')).toEqual({
			kind: 'gradient',
			css: 'linear-gradient(45deg, #000, #fff)',
		});
		expect(parseBackground('gradient:#000,#fff,45deg')).toEqual({
			kind: 'gradient',
			css: 'linear-gradient(45deg, #000, #fff)',
		});
	});

	it('normalizes out-of-range gradient angles', () => {
		expect(parseBackground('gradient:#000,#fff,-90').css).toContain('270deg');
		expect(parseBackground('gradient:#000,#fff,720').css).toContain('0deg');
		expect(parseBackground('gradient:#000,#fff,nonsense').css).toContain('160deg');
	});

	it('never interpolates hostile input into CSS', () => {
		const hostile = [
			'url(javascript:alert(1))',
			'red;}body{display:none',
			'gradient:#000,url(x)',
			'gradient:#000',
			'gradient:red,blue',
			'linear-gradient(#000,#fff)',
			'#12345', // wrong hex length
			'rebeccapurple',
		];
		for (const value of hostile) {
			expect(parseBackground(value)).toEqual({ kind: 'transparent', css: null });
		}
	});
});

describe('normalizers', () => {
	it('normalizes mode with a both default', () => {
		expect(normalizeMode('chat')).toBe('chat');
		expect(normalizeMode('SPEAK')).toBe('speak');
		expect(normalizeMode('both')).toBe('both');
		expect(normalizeMode('')).toBe('both');
		expect(normalizeMode('podcast')).toBe('both');
	});

	it('normalizes position with a right default', () => {
		expect(normalizePosition('left')).toBe('left');
		expect(normalizePosition('Right')).toBe('right');
		expect(normalizePosition('center')).toBe('right');
	});

	it('normalizes lane with a free default', () => {
		expect(normalizeLane('groq')).toBe('groq');
		expect(normalizeLane('openrouter')).toBe('openrouter');
		expect(normalizeLane('anthropic')).toBe('free');
		expect(normalizeLane(null)).toBe('free');
	});

	it('sanitizes accent to hex or the default', () => {
		expect(sanitizeAccent('#22c55e')).toBe('#22c55e');
		expect(sanitizeAccent('tomato')).toBe(DEFAULT_ACCENT);
		expect(sanitizeAccent('#22c55e;background:url(x)')).toBe(DEFAULT_ACCENT);
	});

	it('isHexColor accepts 3/6/8-digit hex only', () => {
		expect(isHexColor('#abc')).toBe(true);
		expect(isHexColor('#aabbcc')).toBe(true);
		expect(isHexColor('#aabbccdd')).toBe(true);
		expect(isHexColor('#abcd')).toBe(false);
		expect(isHexColor('abc')).toBe(false);
	});
});

describe('buildFrameQuery', () => {
	it('emits only known keys and round-trips through URLSearchParams', () => {
		const query = buildFrameQuery({
			avatar: 'selfie-girl',
			bg: 'ember',
			mode: 'chat',
			accent: '#f97316',
			name: 'Atelier AI',
			voice: true,
			badge: false,
			evil: 'dropme',
		});
		const params = new URLSearchParams(query);
		expect(params.get('avatar')).toBe('selfie-girl');
		expect(params.get('bg')).toBe('ember');
		expect(params.get('mode')).toBe('chat');
		expect(params.get('name')).toBe('Atelier AI');
		expect(params.get('voice')).toBe('true');
		expect(params.get('badge')).toBe('false');
		expect(params.get('evil')).toBeNull();
	});

	it('skips empty values and clamps long text fields', () => {
		expect(buildFrameQuery({})).toBe('');
		expect(buildFrameQuery({ name: '', greeting: undefined })).toBe('');
		const query = buildFrameQuery({ context: 'x'.repeat(2000) });
		expect(new URLSearchParams(query).get('context')).toHaveLength(500);
	});

	it('keeps FRAME_PARAM_KEYS as the single source of truth', () => {
		for (const key of ['avatar', 'agent', 'bg', 'mode', 'accent', 'name', 'greeting', 'context', 'voice', 'badge', 'targetOrigin']) {
			expect(FRAME_PARAM_KEYS).toContain(key);
		}
	});
});

describe('speech + BYOK constants', () => {
	it('estimates speech duration with a floor', () => {
		expect(estimateSpeechMs('')).toBe(0);
		expect(estimateSpeechMs('hi')).toBe(1800);
		expect(estimateSpeechMs('x'.repeat(150))).toBe(10000);
	});

	it('has a default model and endpoint for every BYOK lane', () => {
		for (const lane of ['groq', 'openrouter']) {
			expect(BYOK_DEFAULT_MODELS[lane]).toBeTruthy();
			expect(BYOK_ENDPOINTS[lane]).toMatch(/^https:\/\//);
		}
	});
});
