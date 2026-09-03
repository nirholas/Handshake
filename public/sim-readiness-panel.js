// <sim-readiness>: the physics grade, rendered.
//
// One custom element shared by /viewer and /m/:id so the two surfaces can never
// drift into describing the same verdict differently. It owns nothing but
// presentation: the caller decides where the report comes from (the model page
// already has it joined onto the creation; the viewer asks
// GET /api/sim-readiness on demand) and drives this through four methods.
//
//   el.loading()                      a grade is on the way
//   el.showReport(report, meta)       a real grade: any of the five verdicts
//   el.ungraded({ onGrade })          no grade for these bytes yet, offer one
//   el.failed(message, { onRetry })   the lookup itself failed
//
// Shadow DOM on purpose: the two hosts have completely different design tokens,
// and a badge that inherits one page's cascade and breaks on the other is the
// exact drift this element exists to prevent. Colors come from the palette
// below, sizes from the host through inherited font settings.
//
// Spec: specs/SIM_READINESS.md. Guide: /docs/sim-readiness.

// Everything a reader needs per verdict: the label they see, the sentence that
// tells them what to DO, and the accent the badge wears. needs_scale reads as
// "nearly there" rather than as failure because it is: the geometry is sound.
const VERDICTS = {
	simulation_ready: {
		label: 'Simulation ready',
		glyph: '✓',
		tone: 'good',
		lead: 'Closed, consistently wound, and sized in real meters. Drop it into a physics engine as a rigid body and the dynamics are correct.',
	},
	needs_scale: {
		label: 'Needs scale',
		glyph: '↔',
		tone: 'near',
		lead: 'The geometry is sound. Only the units are missing: the generator fitted this mesh to a unit box, so its size is not the object’s real size.',
	},
	needs_repair: {
		label: 'Needs repair',
		glyph: '⚠',
		tone: 'warn',
		lead: 'The surface is not closed, so a solver cannot integrate a volume over it. Close it before trusting any mass number below.',
	},
	unusable: {
		label: 'Unusable',
		glyph: '✕',
		tone: 'bad',
		lead: 'There is no enclosed volume here to simulate.',
	},
	unreadable: {
		label: 'Unreadable',
		glyph: '？',
		tone: 'bad',
		lead: 'These bytes are not binary glTF 2.0, or a compression extension could not be decoded, so nothing could be measured.',
	},
};

// The closed blocker/warning vocabularies from the spec, in the words a person
// uses. A raw `inconsistent_winding` in the UI would send the reader to the
// spec to find out whether they should care.
const BLOCKER_TEXT = {
	open_surface: 'the surface is open: some edges belong to only one triangle',
	non_manifold_edges: 'an edge is shared by three or more triangles',
	inconsistent_winding: 'neighbouring triangles disagree on which side faces out',
	inverted_winding: 'the whole surface is wound inward, so the volume comes out negative',
	zero_volume: 'the surface encloses nothing',
	scale_normalized: 'the size was normalized to a unit box, so the units are not the object’s',
	no_triangles: 'there are no triangles at all',
	unreadable_glb: 'the file is not readable binary glTF 2.0',
};

const WARNING_TEXT = {
	scale_outside_physical_window: 'real units, but outside the 5 mm to 20 m prop window: this is a set piece, not a prop',
	degenerate_triangles: 'some triangles have repeated corners and were excluded from the edge counts',
	non_triangle_primitives_skipped: 'points or lines are present and were excluded from the mass',
	skinned_geometry_graded_at_bind_pose: 'this mesh is skinned and was graded unposed, so treat it as a rigid body only when you say so',
};

const CSS = `
:host { position: relative; display: inline-block; font: inherit; --sr-good: #34c76d; --sr-near: #6ea8fe; --sr-warn: #f0b429; --sr-bad: #ff5656; --sr-dim: #9aa3b2; }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }

.badge {
	display: inline-flex; align-items: center; gap: 6px;
	appearance: none; cursor: pointer; font: inherit;
	font-size: 11.5px; font-weight: 700; letter-spacing: .01em; line-height: 1;
	border-radius: 999px; padding: 5px 10px; white-space: nowrap;
	color: var(--sr-dim); background: rgba(127, 140, 160, .12);
	border: 1px solid rgba(127, 140, 160, .28);
	transition: background .15s ease, border-color .15s ease, transform .06s ease, color .15s ease;
}
.badge:hover { background: rgba(127, 140, 160, .2); }
.badge:active { transform: translateY(1px); }
.badge:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.badge[disabled] { cursor: default; }
.badge[disabled]:hover { background: rgba(127, 140, 160, .12); }
.badge .glyph { font-size: 12px; line-height: 1; }
.badge .caret { font-size: 9px; opacity: .7; transition: transform .18s ease; }
.badge[aria-expanded="true"] .caret { transform: rotate(180deg); }

.badge.good { color: var(--sr-good); background: rgba(52, 199, 109, .13); border-color: rgba(52, 199, 109, .36); }
.badge.good:hover { background: rgba(52, 199, 109, .22); }
.badge.near { color: var(--sr-near); background: rgba(110, 168, 254, .13); border-color: rgba(110, 168, 254, .38); }
.badge.near:hover { background: rgba(110, 168, 254, .22); }
.badge.warn { color: var(--sr-warn); background: rgba(240, 180, 41, .13); border-color: rgba(240, 180, 41, .38); }
.badge.warn:hover { background: rgba(240, 180, 41, .22); }
.badge.bad { color: var(--sr-bad); background: rgba(255, 86, 86, .13); border-color: rgba(255, 86, 86, .36); }
.badge.bad:hover { background: rgba(255, 86, 86, .22); }

/* Loading is a skeleton, not a spinner, and it is exactly the size of the badge
   it becomes, so nothing on the page moves when the answer lands. */
.skeleton {
	display: inline-block; width: 116px; height: 23px; border-radius: 999px;
	background: linear-gradient(90deg, rgba(127,140,160,.10) 25%, rgba(127,140,160,.22) 50%, rgba(127,140,160,.10) 75%);
	background-size: 240% 100%; animation: sweep 1.25s ease-in-out infinite;
}
@keyframes sweep { from { background-position: 120% 0; } to { background-position: -120% 0; } }

/* The panel overlays rather than reflowing: opening it must not move the model,
   the title, or anything else on the page. It opens in the TOP LAYER as a
   popover, which is the only way to escape an ancestor's stacking context and
   containing block. Both matter here: the viewer's header carries a
   backdrop-filter, which makes it the containing block for fixed descendants
   AND a stacking context the 3D stage paints over, so a plain z-index panel
   rendered underneath the model. Position comes from JS so it stays clamped
   inside the viewport at any width; at 320px the badge sits within a panel's
   width of the right edge and pure-CSS anchoring pushed half the numbers off
   screen. Browsers without popover fall back to absolute positioning inside
   the host, which is why the host declares position: relative. */
.panel {
	position: fixed; top: 0; left: 0; z-index: 2147483000;
	margin: 0; inset: auto; overflow: auto;
	width: max-content; min-width: 240px; max-width: min(480px, calc(100vw - 24px));
	max-height: 60vh; overflow-y: auto; overscroll-behavior: contain;
	border: 1px solid rgba(127, 140, 160, .28); border-radius: 12px;
	background: #12141a; color: #e8eaf0;
	padding: 12px 13px; font-size: 12.5px; line-height: 1.5; text-align: left;
	opacity: 0; transform: translateY(-4px); transition: opacity .18s ease, transform .18s ease;
}
.panel[hidden] { display: none; }
.panel.open { opacity: 1; transform: translateY(0); }
.panel { box-shadow: 0 12px 34px rgba(0, 0, 0, .38); }
/* A [popover] is display:none until open; these restore the panel's own box and
   strip the UA's default popover chrome. */
.panel[popover] { display: none; border-width: 1px; padding: 12px 13px; }
.panel[popover]:popover-open { display: block; }
.panel[popover]::backdrop { background: transparent; }
.panel.fallback { position: absolute; top: calc(100% + 8px); left: 0; }
:host([align="end"]) .panel.fallback { left: auto; right: 0; }
@media (prefers-reduced-motion: reduce) {
	.panel { transition: none; }
	.skeleton { animation: none; }
}
@media (prefers-color-scheme: light) {
	.panel { background: #fff; color: #14161c; border-color: rgba(20, 22, 28, .16); box-shadow: 0 8px 28px rgba(20, 22, 28, .12); }
}
:host([data-theme="light"]) .panel { background: #fff; color: #14161c; border-color: rgba(20, 22, 28, .16); box-shadow: 0 8px 28px rgba(20, 22, 28, .12); }
:host([data-theme="light"]) .badge { color: #5b6470; background: rgba(20, 22, 28, .06); border-color: rgba(20, 22, 28, .16); }
:host([data-theme="light"]) .badge.good { color: #157f45; background: rgba(52, 199, 109, .14); border-color: rgba(52, 199, 109, .4); }
:host([data-theme="light"]) .badge.near { color: #1f5fd0; background: rgba(110, 168, 254, .16); border-color: rgba(110, 168, 254, .45); }
:host([data-theme="light"]) .badge.warn { color: #8a5d00; background: rgba(240, 180, 41, .18); border-color: rgba(240, 180, 41, .45); }
:host([data-theme="light"]) .badge.bad { color: #b3231f; background: rgba(255, 86, 86, .14); border-color: rgba(255, 86, 86, .4); }
:host([data-theme="light"]) { --sr-dim: #6b7280; --sr-warn: #8a5d00; }
:host([data-theme="dark"]) .panel { background: #12141a; color: #e8eaf0; border-color: rgba(127, 140, 160, .28); box-shadow: 0 12px 34px rgba(0, 0, 0, .38); }
:host([data-theme="dark"]) { --sr-dim: #9aa3b2; --sr-warn: #f0b429; }

.lead { margin: 0 0 10px; }
h3 { margin: 12px 0 5px; font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--sr-dim); }
h3:first-of-type { margin-top: 0; }
ul { margin: 0; padding-left: 16px; }
li { margin: 2px 0; }
li.blocker::marker { color: var(--sr-warn); }

dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 12px; margin: 0; }
dt { color: var(--sr-dim); min-width: 0; }
dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

/* needs_repair suppresses the mass block visually, because an unreliable
   number that looks authoritative is the one failure mode this whole grade
   exists to prevent. It stays readable; it stops looking quotable. */
.suspect { opacity: .55; }
.suspect-note { margin: 4px 0 0; color: var(--sr-warn); font-size: 11.5px; }

.tensor { margin: 4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; line-height: 1.55; color: var(--sr-dim); white-space: pre; overflow-x: auto; }

.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; padding-top: 9px; border-top: 1px solid rgba(127, 140, 160, .2); color: var(--sr-dim); font-size: 11px; }
.foot .spacer { flex: 1 1 auto; }
button.link, a.link {
	appearance: none; border: 0; background: none; padding: 0; cursor: pointer;
	font: inherit; font-size: 11px; color: inherit; text-decoration: underline;
	text-underline-offset: 2px; transition: color .15s ease;
}
button.link:hover, a.link:hover { color: var(--sr-near); }
button.link:focus-visible, a.link:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 3px; }

.action {
	appearance: none; cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 600;
	color: inherit; background: rgba(110, 168, 254, .16); border: 1px solid rgba(110, 168, 254, .42);
	border-radius: 8px; padding: 5px 10px; margin-left: 8px;
	transition: background .15s ease, transform .06s ease;
}
.action:hover { background: rgba(110, 168, 254, .28); }
.action:active { transform: translateY(1px); }
.action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.action[disabled] { opacity: .6; cursor: progress; }
.row { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 2px; }
`;

function fmt(value, digits = 3) {
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	if (n !== 0 && Math.abs(n) < 10 ** -digits) return n.toExponential(2);
	return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function count(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n.toLocaleString() : null;
}

class SimReadinessCard extends HTMLElement {
	constructor() {
		super();
		this._report = null;
		this._meta = {};
		this._open = false;
		this.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = CSS;
		this._head = document.createElement('div');
		this._panel = document.createElement('div');
		this._panel.className = 'panel';
		this._panel.hidden = true;
		// 'manual' rather than 'auto': the badge is the toggle, and auto's light
		// dismiss would close the panel on the same click that reopens it.
		this._popover = typeof this._panel.showPopover === 'function';
		if (this._popover) this._panel.setAttribute('popover', 'manual');
		else this._panel.classList.add('fallback');
		this.shadowRoot.append(style, this._head, this._panel);
	}

	connectedCallback() {
		this._followTheme();
		if (!this._head.hasChildNodes()) this.loading();
	}

	// Both hosts let a visitor pin light or dark with data-theme on <html>, and
	// :host-context (the obvious way to read that from a shadow root) is
	// unimplemented in Firefox. Mirroring the attribute onto this element makes
	// the same rule work in every engine, and the MutationObserver keeps it true
	// when the visitor flips the theme with the panel open.
	_followTheme() {
		const root = document.documentElement;
		const sync = () => {
			const theme = root.getAttribute('data-theme');
			if (theme === 'light' || theme === 'dark') this.setAttribute('data-theme', theme);
			else this.removeAttribute('data-theme');
		};
		sync();
		if (this._themeObserver) return;
		this._themeObserver = new MutationObserver(sync);
		this._themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
	}

	/** A grade is on the way. Occupies exactly the badge's footprint. */
	loading() {
		this._report = null;
		this._collapse();
		this._head.innerHTML = '<span class="skeleton" role="status" aria-label="Checking whether this model can be simulated"></span>';
		this._panel.innerHTML = '';
		this.hidden = false;
	}

	/**
	 * Render a real grade.
	 * @param {object} report the report from GET /api/sim-readiness
	 * @param {{ gradedAt?: string, cached?: boolean, source?: string }} [meta]
	 */
	showReport(report, meta = {}) {
		if (!report || !report.verdict) {
			this.failed('That grade could not be read.', meta);
			return;
		}
		this._report = report;
		this._meta = meta;
		const v = VERDICTS[report.verdict] || VERDICTS.unusable;
		this._head.innerHTML = '';
		const badge = document.createElement('button');
		badge.type = 'button';
		badge.className = `badge ${v.tone}`;
		badge.setAttribute('aria-expanded', 'false');
		badge.innerHTML = `<span class="glyph" aria-hidden="true">${v.glyph}</span><span>${v.label}</span><span class="caret" aria-hidden="true">▾</span>`;
		badge.title = 'Simulation readiness: what a physics engine would make of this mesh';
		badge.addEventListener('click', () => this._toggle());
		this._head.append(badge);
		this._badge = badge;
		this._panel.innerHTML = this._panelHtml(report, v);
		this._wirePanel();
		this.hidden = false;
	}

	/** No grade exists for these bytes yet. An offer, never an error. */
	ungraded({ onGrade } = {}) {
		this._report = null;
		this._collapse();
		this._panel.innerHTML = '';
		this._head.innerHTML = '';
		const badge = document.createElement('button');
		badge.type = 'button';
		badge.className = 'badge';
		badge.innerHTML = '<span class="glyph" aria-hidden="true">◇</span><span>Check physics</span>';
		badge.title = 'Measure whether a physics engine could simulate this mesh';
		if (typeof onGrade === 'function') {
			badge.addEventListener('click', () => {
				this.loading();
				onGrade();
			});
		} else {
			badge.disabled = true;
		}
		this._head.append(badge);
		this.hidden = false;
	}

	/** The lookup itself failed. Says what happened and offers the retry. */
	failed(message, { onRetry } = {}) {
		this._report = null;
		this._collapse();
		this._panel.innerHTML = '';
		this._head.innerHTML = '';
		const wrap = document.createElement('span');
		wrap.className = 'row';
		const badge = document.createElement('button');
		badge.type = 'button';
		badge.className = 'badge bad';
		badge.disabled = true;
		badge.innerHTML = '<span class="glyph" aria-hidden="true">⚠</span><span>Grade unavailable</span>';
		badge.title = message || 'The physics grade could not be fetched.';
		wrap.append(badge);
		if (typeof onRetry === 'function') {
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.className = 'action';
			retry.textContent = 'Try again';
			retry.addEventListener('click', () => {
				this.loading();
				onRetry();
			});
			wrap.append(retry);
		}
		this._head.append(wrap);
		this.hidden = false;
	}

	disconnectedCallback() {
		this._unbind();
		this._themeObserver?.disconnect();
		this._themeObserver = null;
	}

	_bind() {
		if (this._bound) return;
		this._bound = () => this._place();
		// Capture, so a scroll inside any ancestor repositions the panel too.
		window.addEventListener('scroll', this._bound, { passive: true, capture: true });
		window.addEventListener('resize', this._bound, { passive: true });
		this._onKey = (e) => { if (e.key === 'Escape' && this._open) { this._collapse(); this._badge?.focus(); } };
		document.addEventListener('keydown', this._onKey);
		// composedPath so a click inside the panel's own shadow tree (Copy JSON)
		// is not read as a click outside it.
		this._onAway = (e) => {
			if (!this._open) return;
			const path = e.composedPath();
			if (path.includes(this._panel) || path.includes(this._badge)) return;
			this._collapse();
		};
		document.addEventListener('pointerdown', this._onAway, true);
	}

	_unbind() {
		if (this._bound) {
			window.removeEventListener('scroll', this._bound, { capture: true });
			window.removeEventListener('resize', this._bound);
			this._bound = null;
		}
		if (this._onKey) {
			document.removeEventListener('keydown', this._onKey);
			this._onKey = null;
		}
		if (this._onAway) {
			document.removeEventListener('pointerdown', this._onAway, true);
			this._onAway = null;
		}
	}

	// Anchor under the badge, then clamp into the viewport on both axes and flip
	// above when there is more room there. Reading the panel's own box after it
	// is displayed is what makes this correct at any width, including the 320px
	// case where the badge itself sits within a panel's width of the right edge.
	_place() {
		if (!this._open || !this._badge || !this._popover) return;
		const anchor = this._badge.getBoundingClientRect();
		const gap = 8;
		const margin = 12;
		const box = this._panel.getBoundingClientRect();
		const preferEnd = this.getAttribute('align') === 'end';
		let left = preferEnd ? anchor.right - box.width : anchor.left;
		left = Math.min(left, window.innerWidth - box.width - margin);
		left = Math.max(margin, left);
		const below = window.innerHeight - anchor.bottom - gap - margin;
		const above = anchor.top - gap - margin;
		const flip = below < box.height && above > below;
		const top = flip
			? Math.max(margin, anchor.top - gap - box.height)
			: Math.min(anchor.bottom + gap, window.innerHeight - box.height - margin);
		this._panel.style.left = `${Math.round(left)}px`;
		this._panel.style.top = `${Math.round(Math.max(margin, top))}px`;
		this._panel.style.maxHeight = `${Math.round(Math.max(160, (flip ? above : below)))}px`;
	}

	_show() {
		if (this._popover) {
			this._panel.hidden = false;
			try { this._panel.showPopover(); return; } catch { /* already open */ }
		}
		this._panel.hidden = false;
	}

	_hide() {
		if (this._popover) {
			try { this._panel.hidePopover(); } catch { /* already closed */ }
		}
		this._panel.hidden = true;
	}

	_collapse() {
		this._open = false;
		this._panel.classList.remove('open');
		this._hide();
		this._badge?.setAttribute('aria-expanded', 'false');
		this._unbind();
	}

	_toggle() {
		this._open = !this._open;
		this._badge.setAttribute('aria-expanded', this._open ? 'true' : 'false');
		if (this._open) {
			this._show();
			this._place();
			this._bind();
			// One frame before the class so the transition actually runs rather
			// than being collapsed into the same style recalculation.
			requestAnimationFrame(() => {
				this._panel.classList.add('open');
				// Re-place once the panel has its final laid-out box: the first
				// pass measured it before the browser had resolved max-height.
				this._place();
			});
		} else {
			this._panel.classList.remove('open');
			this._hide();
			this._unbind();
		}
	}

	_panelHtml(r, v) {
		const suspect = r.verdict === 'needs_repair';
		const blockers = (r.blockers || []).map(
			(b) => `<li class="blocker">${BLOCKER_TEXT[b] || b}</li>`,
		).join('');
		const warnings = (r.warnings || []).map(
			(w) => `<li>${WARNING_TEXT[w] || w}</li>`,
		).join('');

		const geo = [];
		const tris = count(r.geometry?.triangles ?? r.topology?.triangles);
		if (tris) geo.push(['Triangles', tris]);
		const verts = count(r.geometry?.verticesWelded);
		if (verts) geo.push(['Vertices (welded)', verts]);
		if (r.topology) {
			geo.push(['Watertight', r.topology.watertight ? 'yes' : 'no']);
			const open = count(r.topology.boundaryEdges);
			if (open && Number(r.topology.boundaryEdges) > 0) geo.push(['Open edges', open]);
			const nm = count(r.topology.nonManifoldEdges);
			if (nm && Number(r.topology.nonManifoldEdges) > 0) geo.push(['Non-manifold edges', nm]);
		}

		const scale = [];
		const axis = fmt(r.scale?.longestAxisMeters, 4);
		if (axis) scale.push(['Longest axis', `${axis} m`]);
		const size = Array.isArray(r.scale?.sizeMeters)
			? r.scale.sizeMeters.map((n) => fmt(n, 3)).filter(Boolean)
			: [];
		if (size.length === 3) scale.push(['Size (x, y, z)', `${size.join(' × ')} m`]);
		if (r.scale) scale.push(['Units are the object’s', r.scale.normalizedGuess ? 'no, normalized' : 'yes']);

		const mass = [];
		const vol = fmt(r.mass?.volumeM3, 6);
		if (vol) mass.push(['Volume', `${vol} m³`]);
		const area = fmt(r.mass?.surfaceAreaM2, 4);
		if (area) mass.push(['Surface area', `${area} m²`]);
		const kg = fmt(r.mass?.massAtWaterDensityKg, 3);
		if (kg) mass.push(['Mass at water density', `${kg} kg`]);
		const centroid = Array.isArray(r.mass?.centroid)
			? r.mass.centroid.map((n) => fmt(n, 4)).filter(Boolean)
			: [];
		if (centroid.length === 3) mass.push(['Centroid', centroid.join(', ')]);

		const collision = [];
		const ratio = Number(r.collision?.convexityRatio);
		if (Number.isFinite(ratio)) {
			collision.push(['Convexity', `${(ratio * 100).toFixed(1)}%`]);
			collision.push(['One hull is enough', r.collision.convexEnough ? 'yes' : 'no, needs decomposition']);
		}
		const hullTris = count(r.collision?.hullTriangles);
		if (hullTris) collision.push(['Hull triangles', hullTris]);

		const inertia = Array.isArray(r.mass?.inertiaUnitDensity) && r.mass.inertiaUnitDensity.length === 9
			? r.mass.inertiaUnitDensity
			: null;

		const dl = (rows) => (rows.length
			? `<dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>`
			: '');

		const when = this._meta.gradedAt ? new Date(this._meta.gradedAt) : null;
		const stamp = when && !Number.isNaN(when.valueOf())
			? `Graded ${when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
			: 'Graded from the mesh';

		return `
			<p class="lead">${v.lead}</p>
			${blockers ? `<h3>What is blocking it</h3><ul>${blockers}</ul>` : ''}
			${warnings ? `<h3>Worth knowing</h3><ul>${warnings}</ul>` : ''}
			${geo.length ? `<h3>Geometry</h3>${dl(geo)}` : ''}
			${scale.length ? `<h3>Scale</h3>${dl(scale)}` : ''}
			${mass.length ? `<h3>Mass properties</h3><div class="${suspect ? 'suspect' : ''}">${dl(mass)}${inertia ? `<p class="tensor">inertia (unit density)\n${inertia.map((n) => Number(n).toExponential(3).padStart(11)).reduce((acc, s, i) => acc + s + ((i % 3 === 2) ? '\n' : ' '), '').trimEnd()}</p>` : ''}</div>${suspect ? '<p class="suspect-note">Reported for reference only: an open surface has no reliable volume, so do not use these until it is closed.</p>' : ''}` : ''}
			${collision.length ? `<h3>Collision proxy</h3>${dl(collision)}` : ''}
			<div class="foot">
				<span>${stamp}${r.grader ? ` · ${r.grader}` : ''}</span>
				<span class="spacer"></span>
				<button class="link" type="button" data-copy>Copy JSON</button>
				<a class="link" href="/docs/sim-readiness" target="_blank" rel="noopener">What this means</a>
			</div>`;
	}

	_wirePanel() {
		const copy = this._panel.querySelector('[data-copy]');
		if (!copy) return;
		// The robotics reader's next move is pasting this into their own pipeline,
		// so the full report goes to the clipboard, not the rendered subset.
		copy.addEventListener('click', async () => {
			const text = JSON.stringify(this._report, null, 2);
			try {
				await navigator.clipboard.writeText(text);
				copy.textContent = 'Copied';
			} catch {
				copy.textContent = 'Press ⌘C to copy';
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.append(ta);
				ta.select();
				try { document.execCommand('copy'); copy.textContent = 'Copied'; } catch { /* the selection is still there to copy by hand */ }
				ta.remove();
			}
			setTimeout(() => { copy.textContent = 'Copy JSON'; }, 2000);
		});
	}
}

if (!customElements.get('sim-readiness')) customElements.define('sim-readiness', SimReadinessCard);

export { SimReadinessCard, VERDICTS, BLOCKER_TEXT, WARNING_TEXT };
