// Coverage for api/sign.js: the text → American Sign Language endpoint, and
// for the per-word timeline the compiler now reports underneath it.
//
// What matters here is not that the handler returns 200. It is that the numbers
// it returns describe the clip it returns: the timeline has to tile the whole
// utterance in order, every letter of a fingerspelled word has to sit inside
// that word's span, and the clip's own duration has to agree with both. A
// caption track built from a timeline that drifts from the animation is worse
// than no caption track, so those invariants are asserted directly.
//
// The compiler is pure and in-process (no three.js, no DOM, no network), so
// these run against the real thing; only the rate limiter is stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const signCompileIp = vi.fn(async () => ({ success: true }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		get signCompileIp() {
			return signCompileIp;
		},
	},
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const { default: handler, compile, readParams, descriptor, MAX_TEXT_CHARS } = await import(
	'../api/sign.js'
);

function mockReq(search = '', method = 'GET', body = null) {
	const req = { method, headers: { host: 'localhost' }, url: `/api/sign${search}` };
	if (body != null) {
		req.headers['content-type'] = 'application/json';
		req.rawBody = Buffer.from(JSON.stringify(body));
	}
	return req;
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			this.body = b;
			this.ended = true;
		},
	};
}

const json = (res) => JSON.parse(String(res.body));

beforeEach(() => {
	signCompileIp.mockClear();
	signCompileIp.mockResolvedValue({ success: true });
});

describe('GET /api/sign with no text', () => {
	it('describes itself and lists the whole vocabulary', async () => {
		const res = mockRes();
		await handler(mockReq(''), res);
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.service).toBe('three.ws sign');
		expect(body.vocabulary_size).toBe(body.vocabulary.length);
		expect(body.vocabulary_size).toBeGreaterThan(20);
		for (const entry of body.vocabulary) {
			expect(entry.word).toMatch(/^[A-Z]+$/);
			expect(entry.gloss.length).toBeGreaterThan(8);
		}
		// Discovery must not cost a compile slot.
		expect(signCompileIp).not.toHaveBeenCalled();
	});

	it('is cacheable, and readable from any origin', async () => {
		const res = mockRes();
		await handler(mockReq(''), res);
		expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
		expect(res.headers['access-control-allow-origin']).toBe('*');
	});
});

describe('GET /api/sign?text=', () => {
	it('signs the words it knows and spells the rest', async () => {
		const res = mockRes();
		await handler(mockReq('?text=happy%20to%20meet%20you'), res);
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.words).toEqual(['HAPPY', 'TO', 'MEET', 'YOU']);
		expect(body.signed).toEqual(['HAPPY', 'MEET', 'YOU']);
		expect(body.spelled).toEqual(['TO']);
		expect(body.truncated).toBe(false);
		expect(body.viewer).toContain('/sign-language?say=');
	});

	it('returns a clip whose duration the timeline actually covers', async () => {
		const res = mockRes();
		await handler(mockReq('?text=hello%20nich'), res);
		const body = json(res);

		expect(body.timeline.length).toBe(body.words.length);
		expect(body.timeline[0].start).toBe(0);
		// Segments run in order and never overlap.
		for (let i = 1; i < body.timeline.length; i++) {
			expect(body.timeline[i].start).toBeGreaterThanOrEqual(body.timeline[i - 1].end);
		}
		const last = body.timeline[body.timeline.length - 1];
		expect(last.end).toBeCloseTo(body.duration, 4);
		expect(body.clip.duration).toBeCloseTo(body.duration, 4);

		// Every clip track is strictly increasing in time and ends within the clip.
		for (const track of body.clip.tracks) {
			for (let i = 1; i < track.times.length; i++) {
				expect(track.times[i], track.name).toBeGreaterThan(track.times[i - 1]);
			}
			expect(track.times[track.times.length - 1]).toBeLessThanOrEqual(body.clip.duration + 1e-3);
		}
	});

	it('places every spelled letter inside its own word', async () => {
		const res = mockRes();
		await handler(mockReq('?text=nich'), res);
		const word = json(res).timeline[0];
		expect(word.signed).toBe(false);
		expect(word.letters.map((l) => l.letter).join('')).toBe('NICH');
		for (const letter of word.letters) {
			expect(letter.start).toBeGreaterThanOrEqual(word.start);
			expect(letter.end).toBeLessThanOrEqual(word.end);
			expect(letter.end).toBeGreaterThan(letter.start);
		}
	});

	it('carries the gloss on a signed word and nothing on a spelled one', async () => {
		const res = mockRes();
		await handler(mockReq('?text=hello%20nich'), res);
		const [signed, spelled] = json(res).timeline;
		expect(signed.gloss).toMatch(/hand/i);
		expect(signed.letters).toBeNull();
		expect(spelled.gloss).toBeNull();
	});

	it('mirrors onto the left hand without changing the utterance', async () => {
		const right = mockRes();
		const left = mockRes();
		await handler(mockReq('?text=hello'), right);
		await handler(mockReq('?text=hello&hand=left'), left);
		const r = json(right);
		const l = json(left);
		expect(l.hand).toBe('left');
		expect(l.words).toEqual(r.words);
		expect(l.duration).toBeCloseTo(r.duration, 4);
		// Same performance, different arm: the clips must not be identical.
		expect(JSON.stringify(l.clip.tracks)).not.toBe(JSON.stringify(r.clip.tracks));
	});

	it('takes longer at a slower speed', async () => {
		const fast = mockRes();
		const slow = mockRes();
		await handler(mockReq('?text=hello%20world'), fast);
		await handler(mockReq('?text=hello%20world&speed=0.5'), slow);
		expect(json(slow).duration).toBeGreaterThan(json(fast).duration * 1.5);
	});

	it('omits the clip for format=timeline', async () => {
		const res = mockRes();
		await handler(mockReq('?text=hello&format=timeline'), res);
		const body = json(res);
		expect(body.clip).toBeUndefined();
		expect(body.timeline.length).toBe(1);
	});

	it('truncates long text at a word boundary and says so', async () => {
		const res = mockRes();
		const text = Array.from({ length: 40 }, () => 'hello').join('+');
		await handler(mockReq(`?text=${text}&max_seconds=8`), res);
		const body = json(res);
		expect(body.truncated).toBe(true);
		expect(body.timeline.length).toBeLessThan(40);
		expect(body.duration).toBeLessThan(12);
	});
});

describe('POST /api/sign', () => {
	it('accepts a JSON body', async () => {
		const res = mockRes();
		await handler(mockReq('', 'POST', { text: 'three ws', speed: 0.5 }), res);
		expect(res.statusCode).toBe(200);
		const body = json(res);
		expect(body.words).toEqual(['THREE', 'WS']);
		expect(body.speed).toBe(0.5);
	});

	it('rejects a body with no text', async () => {
		const res = mockRes();
		await handler(mockReq('', 'POST', { speed: 1 }), res);
		expect(res.statusCode).toBe(400);
		expect(json(res).error).toBe('missing_text');
	});
});

describe('bad input', () => {
	it('explains text with nothing signable in it', async () => {
		const res = mockRes();
		await handler(mockReq('?text=%E2%9C%93%E2%9C%93'), res);
		expect(res.statusCode).toBe(400);
		const body = json(res);
		expect(body.error).toBe('unsignable_text');
		expect(body.message).toMatch(/A-Z and 0-9/);
	});

	it('rate-limits per IP rather than failing open', async () => {
		signCompileIp.mockResolvedValue({ success: false, limit: 120, remaining: 0, reset: 1 });
		const res = mockRes();
		await handler(mockReq('?text=hello'), res);
		expect(res.statusCode).toBe(429);
	});
});

describe('readParams', () => {
	it('clamps every knob into range instead of erroring', () => {
		expect(readParams({ text: 'x', speed: 99 }).speed).toBe(1.5);
		expect(readParams({ text: 'x', speed: -4 }).speed).toBe(0.25);
		expect(readParams({ text: 'x', speed: 'nonsense' }).speed).toBe(1);
		expect(readParams({ text: 'x', max_seconds: 9999 }).maxSeconds).toBe(60);
		expect(readParams({ text: 'x', hand: 'LEFT' }).hand).toBe('Left');
		expect(readParams({ text: 'x', hand: 'sideways' }).hand).toBe('Right');
	});

	it('caps the text length', () => {
		expect(readParams({ text: 'a'.repeat(5000) }).text.length).toBe(MAX_TEXT_CHARS);
	});
});

describe('compile', () => {
	it('rounds clip numbers to keep the payload small', () => {
		const body = compile(readParams({ text: 'hello' }), 'https://three.ws');
		for (const track of body.clip.tracks) {
			for (const value of track.values) {
				expect(String(value).replace(/^-?\d*\.?/, '').length).toBeLessThanOrEqual(5);
			}
		}
	});

	it('agrees with the descriptor about what is signable', () => {
		const { vocabulary } = descriptor('https://three.ws');
		const word = vocabulary[0].word;
		const body = compile(readParams({ text: word }), 'https://three.ws');
		expect(body.signed).toEqual([word]);
		expect(body.spelled).toEqual([]);
	});
});
