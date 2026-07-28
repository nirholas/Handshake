#!/usr/bin/env node
// scripts/x402-milestone-video.mjs
//
// Build the x402 milestone video: Veo-generated cinematic b-roll underneath
// frame-accurate, brand-typeset statistics.
//
// Why it is split this way
// ------------------------
// Veo renders text as garbled pseudo-glyphs — it cannot be trusted with a
// figure like "59,173". So the two layers are produced by different tools and
// composited:
//
//   background   Veo 3 (scripts/veo-generate.mjs) -> gs://three-ws-veo/…
//   foreground   headless Chrome rendering the real Inter / Space Grotesk /
//                JetBrains Mono webfonts this site ships, one transparent PNG
//                per frame, so the numbers count up instead of sitting still
//   composite    ffmpeg — normalize, darken for legibility, overlay, crossfade
//
// The figures are never typed by hand. They come from
// scripts/x402-milestone-stats.mjs, which reads the facilitator's own logs, so
// the video cannot drift from the database. Pass --stats to override for a
// dry run or to reproduce an older snapshot.
//
// Usage:
//   node --env-file=.env scripts/x402-milestone-video.mjs
//   node --env-file=.env scripts/x402-milestone-video.mjs --clips /tmp/veo-clips
//   node --env-file=.env scripts/x402-milestone-video.mjs --stats '{"paymentsSettled":55195,…}'
//   node --env-file=.env scripts/x402-milestone-video.mjs --vertical   # 9:16 for stories
//
// Flags:
//   --clips <dir>   directory of clip-1.mp4 … clip-4.mp4 (default /tmp/veo-clips)
//   --out <path>    output file (default marketing/x402-milestone/x402-milestone.mp4)
//   --stats <json>  override the live figures
//   --vertical      render 1080x1920 instead of 1920x1080
//   --fps <n>       frame rate (default 30)
//   --keep-frames   leave the intermediate PNG frames on disk for inspection

import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const VERTICAL = flag('vertical');
const WIDTH = VERTICAL ? 1080 : 1920;
const HEIGHT = VERTICAL ? 1920 : 1080;
const FPS = Number(opt('fps', '30'));
const CLIP_DIR = opt('clips', '/tmp/veo-clips');
const FRAME_ROOT = '/tmp/x402-milestone-frames';
const OUT = path.resolve(
	REPO,
	opt('out', `marketing/x402-milestone/x402-milestone${VERTICAL ? '-vertical' : ''}.mp4`),
);

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

async function loadStats() {
	const override = opt('stats');
	if (override) return JSON.parse(override);
	const { stdout } = await execFileAsync(
		process.execPath,
		['--env-file=.env', 'scripts/x402-milestone-stats.mjs', '--json'],
		{ cwd: REPO, maxBuffer: 8 << 20 },
	);
	return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------
//
// Four beats, one Veo clip each. `hold` is the beat's on-screen duration before
// the crossfade into the next beat is subtracted.

function storyboard(stats) {
	const days = stats.spanDaysWhole ?? 25;
	return [
		{
			kind: 'stat',
			hold: 6.0,
			eyebrow: 'THREE.WS · X402 ON SOLANA',
			value: days,
			label: 'DAYS',
			sub: 'One facilitator. No third party.',
		},
		// Headline figure is paymentsSettled — the facilitator's own count of
		// settlement operations (owner decision, 2026-07-28).
		//
		// Label it "payments settled", never "on-chain transactions": 21% of these
		// rows share a tx signature with another row, so distinct signatures number
		// ~46.6k, not 59.3k. See the duplicate-signature warning that
		// x402-milestone-stats.mjs prints. Wording that claims one chain
		// transaction per payment would not survive an explorer check.
		{
			kind: 'stat',
			hold: 6.8,
			eyebrow: 'SETTLED',
			value: stats.paymentsSettled,
			label: 'X402 PAYMENTS',
			sub: 'Verified and settled by our own facilitator.',
		},
		{
			kind: 'stat',
			hold: 6.8,
			eyebrow: 'PAID',
			value: stats.distinctEndpoints,
			label: 'DISTINCT ENDPOINTS',
			sub: 'Machine-to-machine payments, no human in the loop.',
		},
		{
			kind: 'end',
			hold: 7.0,
			lines: ['All on Solana mainnet.', 'All through our own facilitator.'],
			mark: 'three.ws',
		},
	];
}

// ---------------------------------------------------------------------------
// Overlay page
// ---------------------------------------------------------------------------
//
// A single self-contained page exposing window.render(t). Rendering is driven
// frame by frame from Node rather than by CSS animation, so every frame is
// deterministic and the count-up lands on the exact figure.

function overlayHtml(beat, fontDir) {
	const font = (f) => `file://${path.join(fontDir, f)}`;
	const beatJson = JSON.stringify(beat);
	const isEnd = beat.kind === 'end';

	return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face{font-family:'Inter';src:url('${font('inter-latin.woff2')}') format('woff2');font-weight:100 900;font-display:block}
@font-face{font-family:'Space Grotesk';src:url('${font('space-grotesk-latin.woff2')}') format('woff2');font-weight:300 700;font-display:block}
@font-face{font-family:'JetBrains Mono';src:url('${font('jetbrains-mono-latin.woff2')}') format('woff2');font-weight:100 800;font-display:block}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${WIDTH}px;height:${HEIGHT}px;background:transparent;overflow:hidden}
/* Contrast scrim. Veo footage is bright and busy in places (the circuit-city
   and particle-burst beats especially); without this, white type over a lit
   region drops below a readable contrast ratio. Baked into the overlay PNG so
   it crossfades with the beat instead of pumping mid-shot. */
.scrim{position:absolute;inset:0;background:${
		VERTICAL
			? 'linear-gradient(180deg,rgba(0,0,0,.72) 0%,rgba(0,0,0,.45) 30%,rgba(0,0,0,.45) 62%,rgba(0,0,0,.82) 100%)'
			: 'linear-gradient(90deg,rgba(0,0,0,.86) 0%,rgba(0,0,0,.68) 34%,rgba(0,0,0,.28) 62%,rgba(0,0,0,0) 84%)'
	}}
.stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px;
  display:flex;flex-direction:column;justify-content:center;
  padding:0 ${VERTICAL ? 90 : 160}px;font-family:'Inter',system-ui,sans-serif}
.eyebrow{font-family:'JetBrains Mono',monospace;font-weight:500;
  font-size:${VERTICAL ? 26 : 24}px;letter-spacing:.34em;color:#78a9ff;
  text-transform:uppercase;margin-bottom:${VERTICAL ? 34 : 30}px;
  text-shadow:0 0 28px rgba(120,169,255,.55)}
.rule{height:2px;background:linear-gradient(90deg,#78a9ff,rgba(120,169,255,0));
  margin-bottom:${VERTICAL ? 38 : 34}px;box-shadow:0 0 18px rgba(120,169,255,.45)}
.value{font-family:'Space Grotesk','Inter',sans-serif;font-weight:700;
  font-size:${VERTICAL ? 190 : 240}px;line-height:.92;letter-spacing:-.035em;color:#fff;
  font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;
  text-shadow:0 0 90px rgba(255,255,255,.32),0 0 200px rgba(120,169,255,.24)}
.label{font-weight:600;font-size:${VERTICAL ? 40 : 46}px;letter-spacing:.24em;
  text-transform:uppercase;color:rgba(255,255,255,.9);margin-top:${VERTICAL ? 22 : 24}px}
.sub{font-weight:400;font-size:${VERTICAL ? 28 : 30}px;letter-spacing:.01em;
  color:rgba(255,255,255,.58);margin-top:${VERTICAL ? 26 : 28}px;max-width:${VERTICAL ? 880 : 1150}px;line-height:1.5}
.endline{font-family:'Space Grotesk','Inter',sans-serif;font-weight:600;
  font-size:${VERTICAL ? 74 : 96}px;line-height:1.22;letter-spacing:-.02em;color:#fff;
  text-shadow:0 0 80px rgba(255,255,255,.28)}
.mark{position:absolute;left:${VERTICAL ? 90 : 160}px;bottom:${VERTICAL ? 130 : 110}px;
  font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:${VERTICAL ? 46 : 54}px;
  letter-spacing:-.01em;color:#fff}
.markrule{position:absolute;left:${VERTICAL ? 90 : 160}px;bottom:${VERTICAL ? 108 : 92}px;
  height:2px;width:${VERTICAL ? 150 : 180}px;background:#78a9ff;box-shadow:0 0 16px rgba(120,169,255,.6)}
.corner{position:absolute;right:${VERTICAL ? 90 : 160}px;bottom:${VERTICAL ? 118 : 100}px;
  font-family:'JetBrains Mono',monospace;font-size:${VERTICAL ? 22 : 22}px;letter-spacing:.2em;
  color:rgba(255,255,255,.4);text-transform:uppercase}
</style></head><body>
<div class="stage" id="stage">
  <div class="scrim"></div>
  ${
		isEnd
			? `<div id="l0" class="endline"></div><div id="l1" class="endline"></div>
     <div class="mark" id="mark"></div><div class="markrule" id="markrule"></div>`
			: `<div class="eyebrow" id="eyebrow"></div>
     <div class="rule" id="rule"></div>
     <div class="value" id="value"></div>
     <div class="label" id="label"></div>
     <div class="sub" id="sub"></div>
     <div class="corner" id="corner">three.ws</div>`
	}
</div>
<script>
const BEAT = ${beatJson};
const HOLD = BEAT.hold;

// easeOutExpo — fast arrival, long settle. Reads as "the number lands".
const easeOut = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const clamp01 = v => Math.max(0, Math.min(1, v));
// Window a value in with a fade+rise, and out again at the tail of the beat.
function appear(t, start, dur){ return clamp01((t - start) / dur); }
function tail(t){ return clamp01((HOLD - t) / 0.55); }

function setFade(el, p, rise){
  if(!el) return;
  el.style.opacity = String(p);
  el.style.transform = 'translateY(' + ((1 - p) * (rise || 0)).toFixed(2) + 'px)';
}

function render(t){
  const out = tail(t);
  if (BEAT.kind === 'end') {
    const a = easeOut(appear(t, 0.25, 0.9));
    const b = easeOut(appear(t, 0.75, 0.9));
    const m = easeOut(appear(t, 1.5, 0.8));
    setFade(document.getElementById('l0'), a * out, 34);
    setFade(document.getElementById('l1'), b * out, 34);
    document.getElementById('l0').textContent = BEAT.lines[0];
    document.getElementById('l1').textContent = BEAT.lines[1];
    const mark = document.getElementById('mark');
    mark.textContent = BEAT.mark;
    setFade(mark, m * out, 20);
    const mr = document.getElementById('markrule');
    mr.style.opacity = String(m * out);
    mr.style.transform = 'scaleX(' + easeOut(appear(t, 1.6, 0.9)).toFixed(3) + ')';
    mr.style.transformOrigin = 'left center';
    return;
  }

  const eb = easeOut(appear(t, 0.15, 0.6));
  setFade(document.getElementById('eyebrow'), eb * out, 18);
  document.getElementById('eyebrow').textContent = BEAT.eyebrow;

  const rule = document.getElementById('rule');
  const rp = easeOut(appear(t, 0.35, 0.9));
  rule.style.opacity = String(out);
  rule.style.width = (rp * (${VERTICAL ? 620 : 900})).toFixed(1) + 'px';

  // The count-up: 0 -> value over 1.9s, easing to a hard stop on the real figure.
  const cp = easeOut(appear(t, 0.5, 1.9));
  const shown = Math.round(BEAT.value * cp);
  const el = document.getElementById('value');
  el.textContent = shown.toLocaleString('en-US') + (BEAT.suffix || '');
  setFade(el, clamp01(appear(t, 0.4, 0.4)) * out, 26);

  const lp = easeOut(appear(t, 1.15, 0.75));
  setFade(document.getElementById('label'), lp * out, 22);
  document.getElementById('label').textContent = BEAT.label;

  const sp = easeOut(appear(t, 1.55, 0.8));
  setFade(document.getElementById('sub'), sp * out, 20);
  document.getElementById('sub').textContent = BEAT.sub || '';

  document.getElementById('corner').style.opacity = String(0.85 * out);
}
window.render = render;
render(0);
</script></body></html>`;
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

async function renderFrames(beats, fontDir, log) {
	const { chromium } = await import('playwright');
	const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
	const page = await browser.newPage({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: 1,
	});

	const dirs = [];
	for (const [i, beat] of beats.entries()) {
		const dir = path.join(FRAME_ROOT, `beat-${i + 1}`);
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });

		const html = overlayHtml(beat, fontDir);
		const htmlPath = path.join(FRAME_ROOT, `beat-${i + 1}.html`);
		await writeFile(htmlPath, html, 'utf8');
		await page.goto(`file://${htmlPath}`);
		// Block until the webfonts are actually parsed, or frame 1 renders in a
		// fallback face and the beat visibly "snaps" to Space Grotesk.
		await page.evaluate(() => document.fonts.ready);

		const total = Math.round(beat.hold * FPS);
		for (let f = 0; f < total; f++) {
			const t = f / FPS;
			await page.evaluate((tt) => window.render(tt), t);
			await page.screenshot({
				path: path.join(dir, `${String(f + 1).padStart(5, '0')}.png`),
				omitBackground: true,
			});
		}
		log(`  beat ${i + 1}: ${total} frames`);
		dirs.push({ dir, beat, frames: total });
	}

	await browser.close();
	return dirs;
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

async function ffmpeg(args) {
	try {
		return await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
			maxBuffer: 32 << 20,
		});
	} catch (err) {
		throw new Error(`ffmpeg failed:\n${err.stderr || err.message}`);
	}
}

// One beat = Veo clip, normalized and darkened, with the frame sequence on top.
async function buildSegment({ dir, beat, frames }, clipPath, index, log) {
	const out = path.join(FRAME_ROOT, `seg-${index + 1}.mp4`);
	const dur = frames / FPS;

	// Cover-fit the clip to the target frame, pull the exposure down and desaturate
	// slightly so white type stays legible over bright footage, then vignette.
	const bg =
		`[0:v]trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS,fps=${FPS},` +
		`scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
		`crop=${WIDTH}:${HEIGHT},eq=brightness=-0.10:saturation=0.82:contrast=1.06,` +
		`vignette=PI/4[bg]`;

	await ffmpeg([
		'-i', clipPath,
		'-framerate', String(FPS),
		'-i', path.join(dir, '%05d.png'),
		'-filter_complex', `${bg};[1:v]format=rgba[ov];[bg][ov]overlay=0:0:format=auto[v]`,
		'-map', '[v]',
		'-t', dur.toFixed(3),
		'-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
		'-pix_fmt', 'yuv420p',
		out,
	]);
	log(`  segment ${index + 1} composited (${dur.toFixed(1)}s)`);
	return { path: out, duration: dur };
}

// Chain the segments with 0.5s crossfades. xfade offsets are cumulative and
// each transition eats its own duration, so the running offset is tracked
// rather than assumed.
async function concatSegments(segments, outPath, log) {
	const XF = 0.5;
	const inputs = segments.flatMap((s) => ['-i', s.path]);

	let filter = '';
	let last = '0:v';
	let offset = segments[0].duration - XF;
	for (let i = 1; i < segments.length; i++) {
		const tag = i === segments.length - 1 ? 'vout' : `x${i}`;
		filter += `[${last}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${tag}];`;
		last = tag;
		offset += segments[i].duration - XF;
	}
	filter = filter.replace(/;$/, '');

	await mkdir(path.dirname(outPath), { recursive: true });
	await ffmpeg([
		...inputs,
		'-filter_complex', filter,
		'-map', '[vout]',
		'-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
		'-pix_fmt', 'yuv420p', '-movflags', '+faststart',
		outPath,
	]);
	const total = segments.reduce((a, s) => a + s.duration, 0) - XF * (segments.length - 1);
	log(`  concatenated -> ${total.toFixed(1)}s`);
	return total;
}

// ---------------------------------------------------------------------------

const log = console.log;

const fontDir = path.join(REPO, 'public', 'fonts');
if (!existsSync(path.join(fontDir, 'inter-latin.woff2'))) {
	throw new Error(`Brand fonts not found in ${fontDir}`);
}

log('Loading figures from the facilitator logs…');
const stats = await loadStats();
log(
	`  ${Number(stats.paymentsSettled).toLocaleString('en-US')} settled · ` +
		`${Number(stats.onchainTxs).toLocaleString('en-US')} on-chain · ` +
		`${Number(stats.distinctEndpoints).toLocaleString('en-US')} endpoints · ` +
		`${stats.spanDaysWhole} days`,
);

const beats = storyboard(stats);

// One clip per beat, in order. A missing clip is fatal rather than silently
// reusing an earlier one — a repeated shot reads as a rendering bug on screen.
const clips = beats.map((_, i) => {
	const p = path.join(CLIP_DIR, `clip-${i + 1}.mp4`);
	if (!existsSync(p)) {
		throw new Error(
			`Missing ${p} (storyboard has ${beats.length} beats). Render the b-roll first:\n` +
				`  node scripts/veo-generate.mjs --file <prompts.json> --download ${CLIP_DIR}`,
		);
	}
	return p;
});

await mkdir(FRAME_ROOT, { recursive: true });
log(`Rendering overlay frames at ${WIDTH}x${HEIGHT} @ ${FPS}fps…`);
const frameDirs = await renderFrames(beats, fontDir, log);

log('Compositing…');
const segments = [];
for (const [i, fd] of frameDirs.entries()) {
	segments.push(await buildSegment(fd, clips[i], i, log));
}

const total = await concatSegments(segments, OUT, log);

if (!flag('keep-frames')) {
	for (const fd of frameDirs) await rm(fd.dir, { recursive: true, force: true });
}

const { stdout: probe } = await execFileAsync('ffprobe', [
	'-v', 'error',
	'-show_entries', 'format=duration,size',
	'-of', 'default=noprint_wrappers=1',
	OUT,
]);

log(`\nDone -> ${OUT}`);
log(probe.trim().split('\n').map((l) => `  ${l}`).join('\n'));
log(`  ${total.toFixed(1)}s · ${WIDTH}x${HEIGHT} · ${FPS}fps`);
