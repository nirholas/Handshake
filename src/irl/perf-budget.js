// src/irl/perf-budget.js — device tiering + render budgets for the IRL AR scene.
//
// A busy plaza can carry dozens of pins; a handful of skinned-mesh avatars plus
// per-frame label projection will tank a mid-range phone and trip "Too many
// active WebGL contexts" on top of the rest of the page. These budgets are the
// hard ceilings the renderer holds to per device class — they are *defined*
// here, never left implicit.
//
// detectTier() reads only REAL device signals (hardwareConcurrency, deviceMemory,
// devicePixelRatio, a coarse mobile UA check, and — when a renderer is passed —
// real GPU capabilities). Unknown signals contribute nothing; we default to
// 'mid' rather than fabricate a value.

export const TIER_ORDER = ['low', 'mid', 'high'];

// maxGLB   = concurrent full skinned avatars
// lodNear  = full GLB rendered at or below this many metres
// lodFar   = impostor billboard at or below this many metres (dot beyond)
// cull     = beyond this many metres a pin is hidden entirely (no draw, no label)
// pixelRatio = renderer DPR ceiling
// shadow   = directional shadow-map size (0 disables shadows)
// label    = max simultaneous HTML labels (nearest-first)
// draw     = approximate draw-call ceiling; fulls demote to impostors above it
// realism  = upgrade skin/eye/hair materials to MeshPhysicalMaterial (sheen +
//            clearcoat). This is what makes an avatar read as a person standing
//            on the floor rather than a plastic figurine, and it is the single
//            biggest look lever in the scene. It is also the most expensive
//            shader we compile, so the low tier keeps the flat glTF materials
//            the forge exported: a 2-avatar budget phone would spend the frame
//            on shading instead of tracking.
export const BUDGETS = {
	high: { maxGLB: 8, lodNear: 18, lodFar: 45, cull: 150, pixelRatio: 2,   shadow: 1024, label: 24, draw: 220, realism: true },
	mid:  { maxGLB: 5, lodNear: 14, lodFar: 35, cull: 120, pixelRatio: 1.5, shadow: 512,  label: 16, draw: 140, realism: true },
	low:  { maxGLB: 2, lodNear: 10, lodFar: 22, cull: 80,  pixelRatio: 1,   shadow: 0,    label: 8,  draw: 70,  realism: false },
};

// Score from the signals we actually have. Each branch only moves the score when
// the underlying API reported a real value — a browser that hides deviceMemory
// (Safari) simply doesn't contribute that term instead of guessing.
function baseScore() {
	if (typeof navigator === 'undefined') return 0;
	const cores  = navigator.hardwareConcurrency || 0;     // 0 = unknown
	const mem    = navigator.deviceMemory || 0;            // GB, Chrome/Android only
	const dpr    = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
	const ua     = navigator.userAgent || '';
	const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);

	let score = 0;
	if (cores >= 8)      score += 2;
	else if (cores >= 6) score += 1;
	else if (cores > 0 && cores <= 4) score -= 1;

	if (mem >= 8)        score += 2;
	else if (mem >= 4)   score += 1;
	else if (mem > 0 && mem <= 2) score -= 2;

	if (mobile)              score -= 1; // phones push fewer triangles than laptops
	if (mobile && dpr >= 3)  score -= 1; // …and a 3× panel is a lot more pixels

	return score;
}

// Real GPU capability nudge from an existing renderer. No fabricated values:
// returns 0 when nothing can be read.
function gpuScore(renderer) {
	try {
		const caps = renderer && renderer.capabilities;
		const max  = caps && caps.maxTextureSize;
		let adj = 0;
		if (max >= 16384)      adj += 1;
		else if (max && max <= 4096) adj -= 1;

		const gl  = renderer && renderer.getContext && renderer.getContext();
		const dbg = gl && gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
		const rs  = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
		// A software rasteriser (headless CI, locked-down browsers) can't carry a
		// real-time AR scene — force the floor.
		if (/swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(rs)) adj -= 3;
		return adj;
	} catch {
		return 0;
	}
}

function scoreToTier(score) {
	if (score >= 3)  return 'high';
	if (score <= -2) return 'low';
	return 'mid';
}

// Pass the live renderer to fold real GPU capabilities into the decision; omit it
// for a signals-only estimate before the renderer exists.
export function detectTier(renderer) {
	let score = baseScore();
	if (renderer) score += gpuScore(renderer);
	return scoreToTier(score);
}

// Move a tier name one step along TIER_ORDER, clamped. The runtime watchdog uses
// this to degrade (or recover) live without re-reading device signals.
export function shiftTier(tier, dir) {
	const i = TIER_ORDER.indexOf(tier);
	if (i < 0) return tier;
	const next = Math.max(0, Math.min(TIER_ORDER.length - 1, i + dir));
	return TIER_ORDER[next];
}
