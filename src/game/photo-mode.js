// Photo mode for /play, the screenshot people post.
//
// Press the HUD camera button or P and the world is captured, composited onto a
// share card, and offered back as a download or a clipboard image. Everything
// happens in the browser: one offscreen render, one 2D canvas, no upload, no
// server round trip, nothing leaves the machine unless the player saves it.
//
// Three things make the shot postable rather than merely saved:
//
//   1. It is the WORLD, not the screen. The capture is an offscreen render
//      (scene-capture.js), so the HUD, chat, name tags and this very card are
//      never in the frame, and the classic black-screenshot bug (reading a
//      canvas whose drawing buffer the compositor already took) cannot happen.
//   2. It is signed. A quiet monochrome bar carries the three.ws mark, the coin
//      the world belongs to, and the date, in the platform's own type.
//   3. During a live event it is stamped with the event's own name, read from
//      /event.json, so a photo taken at the meetup says so forever.
//
// This module is imported lazily on the first press, with its CSS, so a player
// who never takes a photo downloads none of it and pays no frame cost.

import './photo-mode.css';
import { captureSceneCanvas } from './scene-capture.js';
import { threeMarkPath2D, THREE_MARK_VIEWBOX } from '../shared/brand-mark.js';
import { parseEvent, eventState, applyPreviewOverride, PHASE } from './meetup-schedule.js';
import { log } from '../shared/log.js';

const EVENT_URL = '/event.json';
// Wide enough for a 1440p desktop capture, small enough that the PNG stays
// pasteable and the render target stays cheap on a phone GPU.
const MAX_CAPTURE_WIDTH = 2560;
// The event doc is normally already in the HTTP cache (the countdown pill and
// the in-world meetup layer both read it on boot). If it is not, the photo
// still lands: the stamp is the only thing that waits on it.
const EVENT_WAIT_MS = 1200;

const CARD_INK = '#08080a';
const CARD_TEXT = '#f5f5f6';
const CARD_DIM = '#8c8c92';
const CARD_FAINT = '#5a5a60';
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// The phases where a photo is part of the event rather than merely near it: the
// stage is already lit, the show is on, or the afterglow is still running.
const STAMPED_PHASES = new Set([PHASE.PRESHOW, PHASE.LIVE, PHASE.AFTERGLOW]);

let preview = null;      // the mounted preview card, or null
let capturing = false;   // guards a double press mid-capture
let eventDoc;            // Promise<event|null>, resolved once per session

function reducedMotion() {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Same contract as the `el` in coincommunities-ui.js, deliberately: this module
// is lazy-loaded on its own and must not drag the HUD in, so the helper is
// duplicated rather than imported. Keep the two in step. It handles `html` and
// plain-string children because the card below uses both, and a helper that
// silently turns `html` into an attribute and throws on a string child produces
// a preview that never mounts.
function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v === true ? '' : v);
	}
	for (const c of [].concat(kids)) {
		if (c == null || c === false) continue;
		n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return n;
}

// ── the event stamp ─────────────────────────────────────────────────────────

function loadEvent() {
	if (eventDoc) return eventDoc;
	eventDoc = fetch(EVENT_URL, { cache: 'no-cache' })
		.then((res) => (res.ok ? res.json() : null))
		.then((doc) => applyPreviewOverride(parseEvent(doc), location.search))
		.catch(() => null);
	return eventDoc;
}

// Start the fetch as soon as the module lands so the first press rarely waits.
loadEvent();

/** The event's own name while its window is open, else null. */
async function eventStamp(now = Date.now()) {
	const event = await Promise.race([
		loadEvent(),
		new Promise((resolve) => setTimeout(() => resolve(null), EVENT_WAIT_MS)),
	]);
	if (!event) return null;
	return STAMPED_PHASES.has(eventState(event, now).phase) ? event.title : null;
}

// ── the share card ──────────────────────────────────────────────────────────

/** Trim `text` with an ellipsis until it fits `maxWidth` in the current font. */
function fitText(ctx, text, maxWidth) {
	if (!text) return '';
	if (maxWidth <= 0) return '';
	if (ctx.measureText(text).width <= maxWidth) return text;
	let cut = text;
	while (cut.length > 1 && ctx.measureText(cut + '…').width > maxWidth) cut = cut.slice(0, -1);
	return cut + '…';
}

function roundRect(ctx, x, y, w, h, r) {
	const radius = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

/**
 * Composite the world shot onto the share card: full-bleed world, hairline, and
 * a signature bar. Every dimension is derived from the shot, so the same code
 * produces a balanced card for a 2560x1440 desktop frame and a 1170x2532 phone
 * frame without a second layout.
 */
function composeCard(shot, { coinLabel, worldLabel, stamp, when }) {
	const W = shot.width;
	const shotH = shot.height;
	// The bar tracks the shot's height (a tall portrait frame can afford more)
	// but is clamped at both ends so it never dominates a short landscape frame
	// nor disappears on a tiny one.
	const barH = Math.round(Math.min(Math.max(shotH * 0.078, 54), 148));
	const u = barH / 84; // design unit: every offset below is authored at u = 1
	const H = shotH + barH;

	const canvas = document.createElement('canvas');
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext('2d');

	// Paint the ground first: the world can render with alpha (the transparent
	// embed), and a PNG with holes punched in it is not a photo anyone posts.
	ctx.fillStyle = CARD_INK;
	ctx.fillRect(0, 0, W, H);
	ctx.drawImage(shot.canvas, 0, 0);

	const barY = shotH;
	ctx.fillStyle = CARD_INK;
	ctx.fillRect(0, barY, W, barH);
	ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
	ctx.fillRect(0, barY, W, Math.max(1, Math.round(u)));

	const pad = Math.round(26 * u);
	const midY = barY + barH / 2;
	ctx.textBaseline = 'alphabetic';

	// Right block first: it is fixed-width, and the left block gets what is left.
	let rightWidth = 0;
	const pillH = Math.round(30 * u);
	const pillPad = Math.round(13 * u);
	const dotR = Math.max(1.5, 3.2 * u);
	let stampText = '';
	if (stamp) {
		ctx.font = `600 ${Math.round(13 * u)}px ${FONT_STACK}`;
		stampText = fitText(ctx, stamp.toUpperCase(), W * 0.42 - pillPad * 2 - dotR * 2);
		rightWidth = Math.ceil(ctx.measureText(stampText).width + pillPad * 2 + dotR * 2 + Math.round(8 * u));
	}
	ctx.font = `500 ${Math.round(13 * u)}px ${FONT_STACK}`;
	const whenWidth = Math.ceil(ctx.measureText(when).width);
	rightWidth = Math.max(rightWidth, whenWidth);

	// Left block: the mark, the wordmark, and the world this shot came from.
	const markSize = Math.round(30 * u);
	const mark = threeMarkPath2D();
	if (mark) {
		ctx.save();
		ctx.fillStyle = CARD_TEXT;
		ctx.translate(pad, midY - markSize / 2);
		ctx.scale(markSize / THREE_MARK_VIEWBOX, markSize / THREE_MARK_VIEWBOX);
		ctx.fill(mark);
		ctx.restore();
	}
	const textX = pad + (mark ? markSize + Math.round(13 * u) : 0);
	const leftRoom = W - textX - pad - rightWidth - Math.round(24 * u);

	ctx.fillStyle = CARD_TEXT;
	ctx.font = `700 ${Math.round(23 * u)}px ${FONT_STACK}`;
	ctx.fillText(fitText(ctx, 'three.ws', leftRoom), textX, midY - Math.round(3 * u));

	ctx.fillStyle = CARD_DIM;
	ctx.font = `500 ${Math.round(14 * u)}px ${FONT_STACK}`;
	const subline = [coinLabel, worldLabel].filter(Boolean).join(' · ');
	ctx.fillText(fitText(ctx, subline, leftRoom), textX, midY + Math.round(20 * u));

	// Right block, right-aligned against the same padding as the left.
	ctx.textAlign = 'right';
	const rightX = W - pad;
	if (stampText) {
		ctx.font = `600 ${Math.round(13 * u)}px ${FONT_STACK}`;
		const pillW = Math.ceil(ctx.measureText(stampText).width + pillPad * 2 + dotR * 2 + Math.round(8 * u));
		const pillY = Math.round(midY - pillH - Math.round(3 * u));
		roundRect(ctx, rightX - pillW, pillY, pillW, pillH, pillH / 2);
		ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
		ctx.fill();
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
		ctx.lineWidth = Math.max(1, u);
		ctx.stroke();

		ctx.beginPath();
		ctx.arc(rightX - pillW + pillPad + dotR, pillY + pillH / 2, dotR, 0, Math.PI * 2);
		ctx.fillStyle = CARD_TEXT;
		ctx.fill();

		ctx.fillStyle = CARD_TEXT;
		ctx.fillText(stampText, rightX - pillPad, pillY + pillH / 2 + Math.round(4.5 * u));

		ctx.fillStyle = CARD_FAINT;
		ctx.font = `500 ${Math.round(13 * u)}px ${FONT_STACK}`;
		ctx.fillText(when, rightX, midY + Math.round(22 * u));
	} else {
		ctx.fillStyle = CARD_FAINT;
		ctx.font = `500 ${Math.round(13 * u)}px ${FONT_STACK}`;
		ctx.fillText(when, rightX, midY + Math.round(5 * u));
	}
	ctx.textAlign = 'left';

	return canvas;
}

// ── shutter ─────────────────────────────────────────────────────────────────

function shutter() {
	if (reducedMotion()) return;
	const flash = el('div', { class: 'cc-photo-flash', 'aria-hidden': 'true' });
	const drop = () => flash.remove();
	flash.addEventListener('animationend', drop, { once: true });
	// A tab backgrounded mid-animation never fires animationend; the timer makes
	// sure a white sheet can never be left over the world.
	setTimeout(drop, 900);
	document.body.appendChild(flash);
}

// ── preview card ────────────────────────────────────────────────────────────

function canCopyImages() {
	return typeof ClipboardItem !== 'undefined' && typeof navigator?.clipboard?.write === 'function';
}

/** True while the preview card is on screen. */
export function photoPreviewOpen() {
	return !!preview;
}

/**
 * Dismiss the preview and release the object URL behind it.
 *
 * @param {{ immediate?: boolean }} [opts] skip the exit transition and tear the
 *   sheet down in this frame. A retake passes it: a card that is still fading
 *   out while its replacement mounts would leave two sheets stacked, and the
 *   outgoing one's backdrop would close the fresh card if it caught a click.
 */
export function closePhotoPreview({ immediate = false } = {}) {
	if (!preview) return;
	const { root, url, onClose, restoreFocus, onKeydown } = preview;
	preview = null;
	document.removeEventListener('keydown', onKeydown, true);
	root.classList.remove('cc-on');
	const drop = () => {
		root.remove();
		URL.revokeObjectURL(url);
	};
	if (immediate || reducedMotion()) drop();
	else setTimeout(drop, 220);
	if (restoreFocus?.isConnected) restoreFocus.focus();
	onClose?.();
}

function showPreview({ blob, width, height, stamp, filename, onClose }) {
	const url = URL.createObjectURL(blob);
	const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

	const status = el('p', { class: 'cc-photo-status', role: 'status', 'aria-live': 'polite' });
	const setStatus = (msg, kind) => {
		status.textContent = msg || '';
		if (kind) status.setAttribute('data-kind', kind);
		else status.removeAttribute('data-kind');
	};

	const downloadBtn = el('a', {
		class: 'cc-photo-btn cc-photo-primary', href: url, download: filename,
		title: `Save ${filename} to your device`,
		onclick: () => setStatus('Saved to your downloads.', 'ok'),
	}, [el('span', { 'aria-hidden': 'true', text: '⬇' }), document.createTextNode('Download')]);

	const copyable = canCopyImages();
	const copyBtn = el('button', {
		class: 'cc-photo-btn', type: 'button',
		'aria-disabled': copyable ? null : 'true',
		title: copyable
			? 'Copy the image to your clipboard'
			: 'This browser cannot put images on the clipboard, Download saves the same file',
	}, [el('span', { 'aria-hidden': 'true', text: '⧉' }), document.createTextNode('Copy image')]);
	copyBtn.addEventListener('click', async () => {
		// Honest rather than hidden: browsers without the async clipboard image
		// API keep the button and get told exactly what to do instead.
		if (!copyable) {
			setStatus('This browser cannot put images on the clipboard. Download saves the same file.', 'warn');
			return;
		}
		setStatus('Copying…');
		try {
			// The blob is already in hand, so the ClipboardItem is built inside the
			// click: Safari rejects a write whose data was resolved after the gesture.
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			setStatus('Copied. Paste it straight into a post.', 'ok');
		} catch (err) {
			log.warn('[photo-mode] clipboard write failed:', err?.message);
			setStatus('The browser blocked the copy. Download saves the same file.', 'warn');
		}
	});

	const card = el('div', {
		class: 'cc-photo-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Your photo',
		onclick: (e) => e.stopPropagation(),
	}, [
		el('button', {
			class: 'cc-photo-close', type: 'button', 'aria-label': 'Close photo', title: 'Close (Esc)',
			onclick: () => closePhotoPreview(),
		}, ['✕']),
		el('span', { class: 'cc-photo-kicker', text: stamp ? 'Event photo' : 'Photo ready' }),
		el('h3', { class: 'cc-photo-h', text: stamp || 'Your shot of the world' }),
		el('p', { class: 'cc-photo-sub', text: `${width} × ${height} · PNG` }),
		el('img', { class: 'cc-photo-shot', src: url, alt: 'Preview of the photo you just took', decoding: 'async' }),
		el('div', { class: 'cc-photo-actions' }, [downloadBtn, copyBtn]),
		status,
		el('p', { class: 'cc-photo-hint', html: 'The world keeps running behind this card. <kbd>P</kbd> takes another.' }),
	]);

	const root = el('div', { id: 'cc-photo', onclick: () => closePhotoPreview() }, [card]);

	// Keys pressed inside the card must not also drive the avatar: /play listens
	// on window in the bubble phase, so this capture-phase listener sees them
	// first and Space presses the focused button instead of jumping the player.
	// Escape closes from anywhere except a text field. P is the one key
	// deliberately let through: the hint below promises it takes another, and the
	// host's handler routes it back into takePhoto, which retakes over this card.
	const onKeydown = (e) => {
		const typing = e.target instanceof HTMLElement
			&& (/^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable);
		if (typing) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			closePhotoPreview();
			return;
		}
		// Ctrl/Cmd+P included: the host leaves that to the browser's print dialog.
		if (e.key === 'p' || e.key === 'P') return;
		if (card.contains(e.target)) e.stopPropagation();
	};
	document.addEventListener('keydown', onKeydown, true);

	document.body.appendChild(root);
	preview = { root, url, onClose, restoreFocus, onKeydown };
	if (reducedMotion()) root.classList.add('cc-on');
	else requestAnimationFrame(() => preview?.root.classList.add('cc-on'));
	downloadBtn.focus();
	return preview;
}

// ── the press ───────────────────────────────────────────────────────────────

function stampedName(symbol) {
	const now = new Date();
	const pad2 = (n) => String(n).padStart(2, '0');
	const when = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
		+ `_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	const slug = (symbol || 'play').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'play';
	return `threews-${slug}-${when}.png`;
}

/**
 * Take a photo: shutter, capture, composite, preview.
 *
 * @param {object} ctx
 * @param {import('three').WebGLRenderer} ctx.renderer
 * @param {import('three').Scene} ctx.scene
 * @param {import('three').Camera} ctx.camera
 * @param {string} [ctx.coinLabel]  the coin, e.g. "$THREE"
 * @param {string} [ctx.worldLabel] the world's display name
 * @param {(msg: string, kind?: string) => void} [ctx.toast]
 * @param {() => void} [ctx.onClose] fired when the preview is dismissed
 * @returns {Promise<boolean>} whether a photo reached the preview
 */
export async function takePhoto({ renderer, scene, camera, coinLabel, worldLabel, toast, onClose }) {
	if (capturing) return false;
	capturing = true;
	// A second press while a card is up is a retake, not a second card: tear the
	// old sheet down in this frame so the two never overlap.
	if (preview) closePhotoPreview({ immediate: true });

	try {
		shutter();
		const shot = captureSceneCanvas(renderer, scene, camera, { maxWidth: MAX_CAPTURE_WIDTH });
		if (!shot) {
			toast?.('Couldn’t photograph the world just now, try again in a moment.', 'warn');
			return false;
		}

		const now = Date.now();
		const stamp = await eventStamp(now);
		const when = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
			.format(new Date(now));
		const card = composeCard(shot, { coinLabel, worldLabel, stamp, when });

		const blob = await new Promise((resolve) => card.toBlob(resolve, 'image/png'));
		if (!blob) {
			toast?.('Couldn’t save that photo, try again in a moment.', 'warn');
			return false;
		}

		showPreview({
			blob,
			width: card.width,
			height: card.height,
			stamp,
			filename: stampedName(coinLabel),
			onClose,
		});
		return true;
	} catch (err) {
		log.warn('[photo-mode] photo failed:', err?.message);
		toast?.('Couldn’t photograph the world just now, try again in a moment.', 'warn');
		return false;
	} finally {
		capturing = false;
	}
}
