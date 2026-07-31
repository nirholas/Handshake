// Pure geometry for the walkthrough player.
//
// Every captured frame is stored with the hotspot (the element the step is
// about) as a normalized rectangle in [0,1] viewport space. The player renders
// that frame into a stage of the SAME aspect ratio, so image space and stage
// space are the same coordinate system and the maths below stays in normalized
// units all the way to the CSS transform.
//
// Kept free of DOM access on purpose: this is the part with the edge cases
// (tiny hotspots, hotspots against an edge, hotspots wider than the frame), so
// it is the part that gets unit tests.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Zoom and pan that brings a hotspot to the middle of the stage.
 *
 * The frame is never allowed to pull away from an edge: the returned offsets
 * are clamped so the scaled image still covers the stage completely, which is
 * why a hotspot in a corner ends up off-centre rather than dragging a grey
 * gutter into view.
 *
 * @param {{x:number,y:number,w:number,h:number}} hotspot normalized frame coords
 * @param {{fill?:number,maxScale?:number}} [opts] fill = share of the stage the hotspot should occupy
 * @returns {{scale:number,x:number,y:number}} transform, offsets in normalized stage units
 */
export function frameTransform(hotspot, opts = {}) {
	const fill = opts.fill ?? 0.58;
	const maxScale = opts.maxScale ?? 3.2;
	const w = Math.max(hotspot.w, 1e-4);
	const h = Math.max(hotspot.h, 1e-4);
	const scale = clamp(Math.min(fill / w, fill / h), 1, maxScale);
	const cx = hotspot.x + hotspot.w / 2;
	const cy = hotspot.y + hotspot.h / 2;
	// Bounds: the image spans [offset, offset + scale]; it must cover [0, 1].
	const x = clamp(0.5 - scale * cx, 1 - scale, 0);
	const y = clamp(0.5 - scale * cy, 1 - scale, 0);
	return { scale, x, y };
}

/**
 * Where the hotspot ends up on the stage once the transform is applied.
 * @param {{x:number,y:number,w:number,h:number}} hotspot
 * @param {{scale:number,x:number,y:number}} transform
 * @returns {{x:number,y:number,w:number,h:number}} normalized stage coords
 */
export function projectHotspot(hotspot, transform) {
	return {
		x: hotspot.x * transform.scale + transform.x,
		y: hotspot.y * transform.scale + transform.y,
		w: hotspot.w * transform.scale,
		h: hotspot.h * transform.scale,
	};
}

/**
 * Pick the side of the hotspot with room for the callout card, and the point
 * on the hotspot it should attach to.
 *
 * Order of preference is right, left, below, above, then centred over the
 * dimmed frame when the hotspot is too large to sit beside anything. Anchors
 * on the vertical sides are pulled back from the top and bottom edges so a
 * card attached near a corner still renders inside the stage.
 *
 * @param {{x:number,y:number,w:number,h:number}} spot projected hotspot
 * @param {{need?:number,needBlock?:number}} [opts] normalized space the card needs
 * @returns {{side:'right'|'left'|'bottom'|'top'|'over',x:number,y:number}}
 */
export function calloutPlacement(spot, opts = {}) {
	const need = opts.need ?? 0.3;
	const needBlock = opts.needBlock ?? 0.24;
	const midX = spot.x + spot.w / 2;
	const midY = clamp(spot.y + spot.h / 2, 0.2, 0.8);
	const right = 1 - (spot.x + spot.w);
	const bottom = 1 - (spot.y + spot.h);

	if (right >= need) return { side: 'right', x: spot.x + spot.w, y: midY };
	if (spot.x >= need) return { side: 'left', x: spot.x, y: midY };
	if (bottom >= needBlock) return { side: 'bottom', x: clamp(midX, 0.2, 0.8), y: spot.y + spot.h };
	if (spot.y >= needBlock) return { side: 'top', x: clamp(midX, 0.2, 0.8), y: spot.y };
	return { side: 'over', x: 0.5, y: 0.5 };
}

/**
 * Everything the renderer needs for one step, in one call.
 * @param {{x:number,y:number,w:number,h:number}} hotspot
 * @param {{fill?:number,maxScale?:number,need?:number,needBlock?:number,motion?:boolean}} [opts]
 */
export function stepLayout(hotspot, opts = {}) {
	// With motion off the frame is shown whole, so the hotspot keeps its
	// captured position instead of being zoomed under the reader.
	const transform = opts.motion === false ? { scale: 1, x: 0, y: 0 } : frameTransform(hotspot, opts);
	const spot = projectHotspot(hotspot, transform);
	return { transform, spot, callout: calloutPlacement(spot, opts) };
}
