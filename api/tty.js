// GET /api/tty: stream a 3D agent into the caller's terminal.
//
//   curl three.ws/tty
//   curl three.ws/tty/<avatar-id>
//   curl 'three.ws/tty?src=https://example.com/model.glb&frames=120'
//
// The whole point is that it needs nothing installed. No GPU on this side, no
// WebGL on the caller's side, no client at all beyond curl: the server runs the
// software rasterizer from @three-ws/tty (packages/tty-3d) and writes ANSI
// frames down a chunked response, pacing them so the response IS the animation.
//
// Why a stream rather than a rendered file: a GIF would need an encoder, a
// content type the terminal cannot show, and a download step. Frames of text
// arrive progressively and start animating before the model has even finished
// sending, which is the difference between a demo and a trick.

import { createRenderer, loadModel } from '../packages/tty-3d/src/index.js';
import { ansi, ColorMode } from '../packages/tty-3d/src/term.js';
import { getAvatar } from './_lib/avatars.js';
import { error, redirect, wantsHtmlNavigation, wrap } from './_lib/http.js';
import { clientIp, limits } from './_lib/rate-limit.js';
import { assertSafePublicUrl, SsrfBlockedError } from './_lib/ssrf-guard.js';

export const maxDuration = 60;

// The signature model, used when the caller names nothing. It is the one GLB
// every deploy is guaranteed to ship, so `curl three.ws/tty` can never 404.
const DEFAULT_MODEL = '/avatars/default.glb';

const MAX_FRAMES = 600;
const MAX_SECONDS = 45;
const MIN_COLS = 20;
const MAX_COLS = 220;
const MIN_ROWS = 8;
const MAX_ROWS = 90;

const clampInt = (raw, min, max, fallback) => {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
};

const clampFloat = (raw, min, max, fallback) => {
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
};

/**
 * Terminals do not announce themselves, so colour depth is inferred from what
 * curl passes through. A caller who knows better can always say `?color=`.
 */
export function colorModeFor(query, headers = {}) {
	const asked = String(query.color ?? '').toLowerCase();
	if (Object.values(ColorMode).includes(asked)) return asked;
	// curl forwards neither COLORTERM nor TERM, so the safe default over the
	// wire is 256 colour: universally supported by anything that renders escape
	// sequences at all, and visibly better than the ASCII ramp.
	if (String(headers['x-color'] ?? '').toLowerCase() === 'truecolor') return ColorMode.TRUECOLOR;
	return ColorMode.ANSI256;
}

/** Resolve what to draw: an explicit GLB URL, an avatar id, or the default. */
export async function resolveSource(query, origin) {
	if (query.src) {
		// Caller-supplied URLs are fetched by this server, so they are an SSRF
		// vector like any other. Same guard the render endpoints use.
		const safe = await assertSafePublicUrl(String(query.src));
		return { url: safe.toString ? safe.toString() : String(query.src), label: 'model' };
	}
	const avatarId = query.avatar ? String(query.avatar) : '';
	if (avatarId) {
		const avatar = await getAvatar({ id: avatarId });
		if (!avatar) return null;
		// model_url is null for a private avatar, which is exactly the case that
		// must not render: this endpoint is unauthenticated.
		if (!avatar.model_url) return null;
		return { url: avatar.model_url, label: avatar.name || 'avatar' };
	}
	return { url: new URL(DEFAULT_MODEL, origin).toString(), label: 'three.ws' };
}

function banner(label, info, cols) {
	const left = `three.ws  ${label}`;
	const right = `${info.triangles.toLocaleString('en-US')} tris${info.skinned ? '  rigged' : ''}`;
	const gap = Math.max(1, cols - left.length - right.length);
	return `${left}${' '.repeat(gap)}${right}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default wrap(async function handler(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const query = Object.fromEntries(url.searchParams);

	// A browser that lands here would see escape codes as literal mojibake, so
	// send it somewhere that explains the trick instead.
	if (wantsHtmlNavigation(req) && !query.raw) {
		const to = query.avatar ? `/tty?avatar=${encodeURIComponent(String(query.avatar))}` : '/tty';
		return redirect(res, to, 302);
	}

	const rate = await limits.ttyIp(clientIp(req));
	if (!rate.ok) return error(res, 429, 'rate_limited', 'too many terminal renders, try again shortly');

	const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || 'three.ws'}`;

	let source;
	try {
		source = await resolveSource(query, origin);
	} catch (err) {
		if (err instanceof SsrfBlockedError) return error(res, 400, 'blocked_url', 'that model URL is not reachable');
		throw err;
	}
	if (!source) return error(res, 404, 'not_found', 'no such avatar');

	const cols = clampInt(query.w ?? query.cols, MIN_COLS, MAX_COLS, 76);
	const rows = clampInt(query.h ?? query.rows, MIN_ROWS, MAX_ROWS, 30);
	const fps = clampInt(query.fps, 4, 30, 18);
	const spin = clampFloat(query.spin, -4, 4, 0.9);
	const frames = clampInt(query.frames, 1, Math.min(MAX_FRAMES, fps * MAX_SECONDS), fps * 8);

	let model;
	try {
		model = await loadModel(source.url);
	} catch (err) {
		return error(res, 502, 'model_unavailable', `could not read that model: ${err.message}`);
	}

	const renderer = createRenderer(model, {
		width: cols,
		height: rows,
		mode: colorModeFor(query, req.headers),
		animation: query.clip ?? undefined,
		spin,
		pitch: clampFloat(query.pitch, -1.4, 1.4, 0.08),
		zoom: clampFloat(query.zoom, 0.3, 6, 1),
	});

	res.statusCode = 200;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	// Nothing may buffer this: a proxy that waits for the body to finish turns a
	// live animation into a wall of text delivered at the end.
	res.setHeader('x-accel-buffering', 'no');
	res.setHeader('x-content-type-options', 'nosniff');
	if (typeof res.flushHeaders === 'function') res.flushHeaders();

	const info = { triangles: model.triangleCount, skinned: model.skinned };
	const single = frames === 1;
	// A single frame can be asked for at any point in the clip, which is what
	// makes `?frames=1&t=` a usable still-image API and not just a first frame.
	const startTime = clampFloat(query.t ?? query.time, 0, 600, 0);

	// A client that hangs up mid-animation (Ctrl-C on curl) must stop the render
	// loop, not keep rasterizing frames into a dead socket for another 40s.
	let aborted = false;
	const stop = () => { aborted = true; };
	req.on('aborted', stop);
	res.on('close', stop);

	if (!single) res.write(ansi.hideCursor + '\n'.repeat(rows + 1));

	try {
		for (let i = 0; i < frames && !aborted; i += 1) {
			const time = startTime + i / fps;
			const frame = renderer.frame(time);
			const head = single ? '' : ansi.up(rows + 1);
			res.write(`${head}${frame}\n${banner(source.label, info, cols)}\n`);
			if (single) break;
			await sleep(Math.round(1000 / fps));
		}
	} finally {
		if (!aborted) {
			if (!single) res.write(ansi.showCursor);
			res.end();
		}
	}
});
