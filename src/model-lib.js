// Pure helpers for the model detail page (/m/:id). No DOM, no fetch: everything
// here is unit-tested in tests/model-lib.test.js and imported by src/model-page.js.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /m/<uuid> (optional trailing slash) → the uuid, else null.
export function modelIdFromPath(pathname) {
	const parts = String(pathname || '').split('/').filter(Boolean);
	if (parts.length !== 2 || parts[0] !== 'm') return null;
	const id = parts[1];
	return UUID_RE.test(id) ? id : null;
}

// A forge row has no title column; the prompt is the title everywhere. For the
// page heading, keep it readable: first line, sentence-cased, capped at 90
// chars on a word boundary.
export function titleFromPrompt(prompt) {
	const line = String(prompt || '').trim().split('\n')[0].trim();
	if (!line) return 'Untitled model';
	let t = line.length <= 90 ? line : `${line.slice(0, 90).replace(/\s+\S*$/, '')}…`;
	return t.charAt(0).toUpperCase() + t.slice(1);
}

// A card label, not a heading. Prompts that came out of a refiner or an
// image-to-3D pass are structured specs hundreds of characters long ("1.
// Geometry and pose: Torso: volumetric, teardrop shaped, …"), so a grid of them
// reads as a wall of identical text with the one distinguishing word off the
// end. Keep the first clause of the first line: enough to tell two models
// apart, short enough to sit on two lines of a card. The full prompt still
// belongs in the tooltip/aria-label of whatever renders this.
export function cardTitleFromPrompt(prompt, maxLen = 48) {
	const line = String(prompt || '').trim().split('\n')[0].trim();
	if (!line) return 'Untitled model';
	// Drop list scaffolding ("1.", "2)", "-", "•") the spec formats start with.
	const unnumbered = line.replace(/^\s*(?:[-*•]|\d+\s*[.)])\s+/, '').trim();
	// First clause: a colon/semicolon, the "1." that opens the spec's first
	// numbered section mid-line, or a comma/period followed by a space.
	// Requiring the space keeps "3.5 inch" and "1,200" whole.
	const clause = unnumbered.split(/[:;]|\s\d+\s*[.)]\s|,\s|\.\s|\.$/)[0].trim() || unnumbered;
	const head = clause.length >= 3 ? clause : unnumbered;
	const trimmed = head.replace(/[\s,;:.-]+$/, '');
	const t =
		trimmed.length <= maxLen
			? trimmed
			: `${trimmed.slice(0, maxLen).replace(/\s+\S*$/, '')}…`;
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Untitled model';
}

// 1234 → "1.2k", 1200000 → "1.2M"; below 1000 verbatim.
export function formatCount(n) {
	const v = Number(n) || 0;
	if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
	if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
	return String(v);
}

export function formatBytes(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return null;
	if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
	if (v >= 1024) return `${Math.round(v / 1024)} KB`;
	return `${v} B`;
}

// "8 months ago" style relative time, compact and stable for tests via `now`.
export function timeAgo(iso, now = Date.now()) {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return '';
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
	const d = Math.floor(h / 24);
	if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
	const mo = Math.floor(d / 30.44);
	if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
	const y = Math.floor(d / 365.25);
	return `${y} year${y === 1 ? '' : 's'} ago`;
}

// The copy-paste embed for any site: the same /viewer iframe public/viewer.html
// generates for itself, sized like a card.
export function embedSnippet(glbUrl, title) {
	const src = `https://three.ws/viewer?src=${encodeURIComponent(glbUrl || '')}${title ? `&title=${encodeURIComponent(title)}` : ''}`;
	return `<iframe src="${src}" width="640" height="480" frameborder="0" allow="xr-spatial-tracking; fullscreen" title="${escapeAttr(title || '3D model')}"></iframe>`;
}

function escapeAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Honest attribute chips for a creation row. Never invents tags: every chip is
// a real stored attribute of the generation.
export function chipsFor(creation) {
	const c = creation || {};
	const chips = [];
	if (c.model_category && c.model_category !== 'other') chips.push({ label: c.model_category, kind: 'category' });
	if (c.backend) chips.push({ label: c.backend, kind: 'backend' });
	if (c.tier) chips.push({ label: c.tier, kind: 'tier' });
	if (c.path === 'geometry') chips.push({ label: 'geometry-first', kind: 'path' });
	if (c.multiview) chips.push({ label: 'multiview', kind: 'path' });
	if (c.remixable) chips.push({ label: 'remixable', kind: 'remix' });
	if (c.parent_creation_id) chips.push({ label: 'remix', kind: 'remix' });
	return chips;
}
