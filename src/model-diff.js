// Model Diff page controller (/diff).
//
// Three jobs, in the order the visitor experiences them:
//   1. Get two models. Drag-drop, file picker, a pasted URL, or an example pair.
//   2. Compare them. The whole engine (@three-ws/glb-diff) runs here in the tab.
//   3. Show the result twice over: as a change set you can read and copy, and as
//      a 3D scene where clicking a row frames the object it names.
//
// The privacy claim in the copy constrains the code, as it does on /rig-doctor:
// a dropped file is read with the File API and compared in this tab. It is never
// posted anywhere. A model given as a URL is a different matter and the page
// says so: it is fetched through the same-origin proxy at /api/glb, because an
// arbitrary CDN will not send an Access-Control-Allow-Origin header and the
// browser would refuse the read outright.
//
// The 3D stage is imported lazily. three.js plus the glTF loader stack is the
// heaviest thing on this page and the report is useful without it, so the
// import starts only once a model is actually in hand.

import { describeModel, diffDescriptions, formatBytes, formatMarkdown, SEVERITY_MEANING } from '@three-ws/glb-diff';
import { proxiedModelURL } from './ipfs.js';

const $ = (id) => document.getElementById(id);

// Real models this site already serves, chosen so the four states a visitor can
// land in are each one click away: a rig that lost its skeleton, two unrelated
// characters, two close siblings, and a pair with nothing between them.
const EXAMPLE_PAIRS = [
	{
		label: 'A rig, then the same pose unrigged',
		a: '/avatars/default.glb',
		b: '/avatars/mannequin.glb',
		title: 'Every skeleton and clip gone: the breaking case',
	},
	{
		label: 'Two different characters',
		a: '/avatars/xbot.glb',
		b: '/avatars/michelle.glb',
		title: 'Different meshes, different clips, overlapping joint names',
	},
	{
		label: 'Sibling avatars',
		a: '/avatars/realistic-male.glb',
		b: '/avatars/realistic-female.glb',
		title: 'Same rig family, different geometry and textures',
	},
	{
		label: 'Nothing changed',
		a: '/avatars/cesium-man.glb',
		b: '/avatars/cesium-man.glb',
		title: 'What a clean comparison looks like',
	},
];

const SECTION_ORDER = [
	['skins', 'Skeletons'],
	['animations', 'Animations'],
	['meshes', 'Meshes'],
	['nodes', 'Nodes'],
	['materials', 'Materials'],
	['textures', 'Textures'],
];

const TOTAL_LABEL = {
	vertices: 'Vertices',
	triangles: 'Triangles',
	nodes: 'Nodes',
	meshes: 'Meshes',
	materials: 'Materials',
	textures: 'Textures',
	animations: 'Animations',
	skins: 'Skeletons',
	joints: 'Joints',
	scenes: 'Scenes',
	textureBytes: 'Texture bytes',
	sizeBytes: 'File size',
};

const state = {
	a: null,
	b: null,
	changeset: null,
	stage: null,
	stagePromise: null,
	mode: 'overlay',
	focused: null,
};

// ── Small helpers ────────────────────────────────────────────────────────────

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function num(value) {
	return Number(value || 0).toLocaleString();
}

function signed(value, isBytes) {
	if (value === 0) return '0';
	const body = isBytes ? formatBytes(Math.abs(value)) : num(Math.abs(value));
	return `${value > 0 ? '+' : '-'}${body}`;
}

function fieldText(change) {
	const opaque = { geometry: 'vertex data changed', pixels: 'image data changed', inverseBindMatrices: 'bind pose changed' };
	if (opaque[change.field]) return `${opaque[change.field]}${change.note ? ` (${change.note})` : ''}`;
	const show = (value) => {
		if (value === null || value === undefined) return 'none';
		if (Array.isArray(value)) return value.length > 4 ? `[${value.slice(0, 4).join(', ')}, +${value.length - 4}]` : `[${value.join(', ')}]`;
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	};
	return `${show(change.a)} to ${show(change.b)}${change.note ? ` (${change.note})` : ''}`;
}

// ── Loading a side ───────────────────────────────────────────────────────────

// Same-origin models are fetched directly. Anything else goes through the
// site's own GLB proxy, which exists precisely because a third-party CDN's CORS
// policy would otherwise make the model unreadable from a browser. The rule
// itself lives in src/ipfs.js beside the image-proxy rule, so a surface that
// paints a model and a surface that paints token art cannot drift apart.
function proxied(url) {
	return proxiedModelURL(url) || null;
}

function setSlotState(role, slotState) {
	$(`dx-slot-${role}`).dataset.state = slotState;
}

function showSlotError(role, message) {
	const el = $(`dx-error-${role}`);
	el.textContent = message;
	el.hidden = !message;
	setSlotState(role, message ? 'error' : 'idle');
}

async function loadSide(role, bytes, name, sourceUrl) {
	showSlotError(role, '');
	setSlotState(role, 'loading');
	$(`dx-name-${role}`).textContent = name;
	$(`dx-meta-${role}`).textContent = formatBytes(bytes.byteLength);

	let description;
	try {
		description = await describeModel(new Uint8Array(bytes), { name });
	} catch (err) {
		showSlotError(role, `Not a readable glTF/GLB: ${err?.message || 'could not parse the file'}`);
		state[role] = null;
		renderReport();
		return;
	}

	state[role] = { description, bytes, name, url: sourceUrl || null };
	setSlotState(role, 'loaded');
	$(`dx-meta-${role}`).textContent =
		`${formatBytes(bytes.byteLength)} - ${num(description.totals.triangles)} tris - ${num(description.totals.joints)} joints`;

	const stage = await ensureStage();
	if (stage) {
		try {
			await stage.setModel(role, bytes);
		} catch (err) {
			// The report is the product; a viewport that refuses one exotic model
			// must not take the comparison down with it.
			showSlotError(role, `Compared fine, but the 3D view could not load it: ${err?.message || 'renderer error'}`);
		}
	}
	compare();
	syncShareUrl();
}

async function loadFromFile(role, file) {
	if (!file) return;
	try {
		const bytes = await file.arrayBuffer();
		await loadSide(role, bytes, file.name);
	} catch (err) {
		showSlotError(role, `Could not read the file: ${err?.message || 'unknown error'}`);
	}
}

async function loadFromUrl(role, rawUrl) {
	const url = String(rawUrl || '').trim();
	if (!url) return;
	const target = proxied(url);
	if (!target) {
		showSlotError(role, 'That does not look like a URL.');
		return;
	}
	setSlotState(role, 'loading');
	$(`dx-name-${role}`).textContent = 'Fetching...';
	try {
		const res = await fetch(target, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const bytes = await res.arrayBuffer();
		const name = url.split('/').filter(Boolean).pop() || url;
		await loadSide(role, bytes, name, url);
	} catch (err) {
		$(`dx-name-${role}`).textContent = role === 'a' ? 'Drop the baseline .glb' : 'Drop the candidate .glb';
		showSlotError(role, `Could not fetch that model: ${err?.message || 'network error'}`);
	}
}

// ── The comparison ───────────────────────────────────────────────────────────

function compare() {
	if (!state.a || !state.b) {
		renderReport();
		return;
	}
	renderSkeleton();
	// Yield one frame so the skeleton actually paints before the comparison
	// takes the main thread. Without it the placeholder never appears and a
	// heavy pair looks like a frozen page.
	requestAnimationFrame(() => {
		state.changeset = diffDescriptions(state.a.description, state.b.description);
		renderReport();
		if (state.stage) {
			state.stage.applyChangeSet(state.changeset);
			$('dx-stage-bar').hidden = false;
			$('dx-legend').hidden = false;
			$('dx-play-wrap').hidden = !state.stage.hasClips();
		}
	});
}

function renderSkeleton() {
	$('dx-report').innerHTML =
		'<div class="dx-card"><div class="dx-skeleton"><i></i><i></i><i></i><i></i></div></div>';
}

function renderReport() {
	const host = $('dx-report');
	if (!state.a || !state.b) {
		const waiting = state.a || state.b ? 'One more to go.' : 'Drop a file on each side, paste two URLs, or pick an example pair.';
		host.innerHTML = `<div class="dx-card"><div class="dx-empty"><strong>Load two models</strong>${esc(waiting)} The comparison runs on your machine.</div></div>`;
		return;
	}
	const changes = state.changeset;
	if (!changes) return;

	host.innerHTML = [
		verdictHtml(changes),
		totalsHtml(changes),
		sectionsHtml(changes),
		actionsHtml(changes),
	].join('');

	wireReport();
}

function verdictHtml(changes) {
	const s = changes.summary;
	const counts = changes.identical
		? 'no differences'
		: `+${s.added} / -${s.removed} / ~${s.modified} / renamed ${s.renamed} / moved ${s.moved}`;
	const highlights = changes.highlights
		.map((h) => `<li class="dx-highlight dx-sev-${esc(h.severity)}">${esc(h.text)}</li>`)
		.join('');
	return `
		<div class="dx-verdict dx-sev-${esc(changes.severity)}">
			<div class="dx-verdict-top">
				<span class="dx-verdict-level">${esc(changes.severity)}</span>
				<span class="dx-verdict-counts">${esc(counts)}</span>
			</div>
			<p class="dx-verdict-why">${esc(SEVERITY_MEANING[changes.severity])}</p>
			${highlights ? `<ul class="dx-highlights">${highlights}</ul>` : ''}
		</div>`;
}

function totalsHtml(changes) {
	const rows = Object.entries(changes.totals).filter(([, v]) => v.delta !== 0);
	if (!rows.length) return '';
	const body = rows
		.map(([key, v]) => {
			const isBytes = key.endsWith('Bytes');
			const fmt = isBytes ? formatBytes : num;
			const cls = v.delta > 0 ? 'dx-up' : 'dx-down';
			const pct = v.pct === null || v.pct === 0 ? '' : ` (${v.pct > 0 ? '+' : ''}${v.pct}%)`;
			return `<tr><td>${esc(TOTAL_LABEL[key] || key)}</td><td class="dx-num">${esc(fmt(v.a))}</td><td class="dx-num">${esc(fmt(v.b))}</td><td class="dx-num ${cls}">${esc(signed(v.delta, isBytes) + pct)}</td></tr>`;
		})
		.join('');
	return `
		<div class="dx-card">
			<div class="dx-card-head"><span>Totals</span></div>
			<table class="dx-totals">
				<thead><tr><th>metric</th><th class="dx-num">before</th><th class="dx-num">after</th><th class="dx-num">delta</th></tr></thead>
				<tbody>${body}</tbody>
			</table>
		</div>`;
}

function rowHtml({ mark, markClass, name, detail, fields, path }) {
	const inner = `
		<span class="dx-mark ${markClass}" aria-hidden="true">${mark}</span>
		<span>
			<span class="dx-row-name">${esc(name)}</span>
			${detail ? ` <span class="dx-row-detail">${esc(detail)}</span>` : ''}
			${fields && fields.length ? `<ul class="dx-fields">${fields.map((f) => `<li class="dx-field"><b>${esc(f.field)}</b> ${esc(fieldText(f))}</li>`).join('')}</ul>` : ''}
		</span>`;
	if (path) {
		return `<li><button type="button" class="dx-row" data-path="${esc(path)}" aria-pressed="false" title="Frame this node in the viewer">${inner}</button></li>`;
	}
	return `<li class="dx-row">${inner}</li>`;
}

function sectionsHtml(changes) {
	const blocks = SECTION_ORDER.map(([key, label]) => {
		const section = changes.sections[key];
		if (!section || !section.changed) return '';
		const isNodes = key === 'nodes';
		const rows = [
			...section.removed.map((item) =>
				rowHtml({ mark: '-', markClass: 'dx-mark-del', name: item.name, detail: item.detail, path: isNodes ? item.name : null }),
			),
			...section.added.map((item) =>
				rowHtml({ mark: '+', markClass: 'dx-mark-add', name: item.name, detail: item.detail, path: isNodes ? item.name : null }),
			),
			...section.renamed.map((item) =>
				rowHtml({ mark: 'R', markClass: 'dx-mark-ren', name: `${item.from} to ${item.to}`, path: isNodes ? item.to : null }),
			),
			...(section.moved || []).map((item) =>
				rowHtml({ mark: 'M', markClass: 'dx-mark-mov', name: `${item.from} to ${item.to}`, detail: 'reparented', path: item.to }),
			),
			...section.modified.map((item) =>
				rowHtml({
					mark: '~',
					markClass: 'dx-mark-mod',
					name: item.name,
					detail: item.from && item.from !== item.name ? `was ${item.from}` : '',
					fields: item.changes,
					path: isNodes ? item.name : null,
				}),
			),
		].join('');
		const open = section.severity === 'breaking' || section.severity === 'major' ? ' open' : '';
		return `
			<details class="dx-section"${open}>
				<summary>
					<svg class="dx-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
					<span class="dx-section-name dx-sev-${esc(section.severity)}" style="color: var(--dx-sev)">${esc(label)}</span>
					<span class="dx-section-count">${section.changed} changed, ${section.unchanged} same</span>
				</summary>
				<ul class="dx-rows">${rows}</ul>
			</details>`;
	}).join('');

	const extras = extensionsHtml(changes);
	if (!blocks && !extras) {
		return `<div class="dx-card"><div class="dx-empty"><strong>No differences</strong>Every scene, mesh, material, texture, skeleton and clip matches.</div></div>`;
	}
	return `<div class="dx-card">${blocks}${extras}</div>`;
}

function extensionsHtml(changes) {
	const ext = changes.extensions;
	const rows = [
		...ext.required.added.map((n) => rowHtml({ mark: '+', markClass: 'dx-mark-add', name: n, detail: 'now required' })),
		...ext.required.removed.map((n) => rowHtml({ mark: '-', markClass: 'dx-mark-del', name: n, detail: 'no longer required' })),
		...ext.used.added.filter((n) => !ext.required.added.includes(n)).map((n) => rowHtml({ mark: '+', markClass: 'dx-mark-add', name: n })),
		...ext.used.removed.filter((n) => !ext.required.removed.includes(n)).map((n) => rowHtml({ mark: '-', markClass: 'dx-mark-del', name: n })),
		...changes.asset.map((c) => rowHtml({ mark: '~', markClass: 'dx-mark-mod', name: c.field, detail: fieldText(c) })),
	];
	if (!rows.length) return '';
	return `
		<details class="dx-section">
			<summary>
				<svg class="dx-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
				<span class="dx-section-name">Extensions and metadata</span>
				<span class="dx-section-count">${rows.length} changed</span>
			</summary>
			<ul class="dx-rows">${rows.join('')}</ul>
		</details>`;
}

function cliCommand() {
	const a = state.a?.url || state.a?.name || 'before.glb';
	const b = state.b?.url || state.b?.name || 'after.glb';
	return `npx @three-ws/glb-diff ${a} ${b} --fail-on breaking`;
}

function actionsHtml() {
	return `
		<div class="dx-card">
			<div class="dx-card-head"><span>Take it with you</span></div>
			<div style="padding: var(--space-md); display: flex; flex-direction: column; gap: var(--space-sm)">
				<div class="dx-actions">
					<button type="button" class="dx-btn" data-copy="markdown">Copy Markdown</button>
					<button type="button" class="dx-btn" data-copy="json">Copy JSON</button>
					<button type="button" class="dx-btn" data-download="json">Download change set</button>
					<button type="button" class="dx-btn" data-copy="link">Copy link</button>
				</div>
				<pre class="dx-cli">${esc(cliCommand())}</pre>
				<div class="dx-actions">
					<button type="button" class="dx-btn" data-copy="cli">Copy the CLI command</button>
				</div>
			</div>
		</div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

async function flash(button, message) {
	const original = button.textContent;
	button.textContent = message;
	button.disabled = true;
	setTimeout(() => {
		button.textContent = original;
		button.disabled = false;
	}, 1400);
}

async function copy(text, button, label) {
	try {
		await navigator.clipboard.writeText(text);
		flash(button, label);
	} catch {
		flash(button, 'Clipboard blocked');
	}
}

function wireReport() {
	for (const button of document.querySelectorAll('[data-path]')) {
		button.addEventListener('click', () => {
			const path = button.dataset.path;
			for (const other of document.querySelectorAll('[data-path]')) other.setAttribute('aria-pressed', 'false');
			button.setAttribute('aria-pressed', 'true');
			state.focused = path;
			state.stage?.focusPath(path);
		});
	}

	for (const button of document.querySelectorAll('[data-copy]')) {
		button.addEventListener('click', () => {
			const kind = button.dataset.copy;
			if (kind === 'markdown') return copy(formatMarkdown(state.changeset), button, 'Copied');
			if (kind === 'json') return copy(JSON.stringify(state.changeset, null, 2), button, 'Copied');
			if (kind === 'cli') return copy(cliCommand(), button, 'Copied');
			return copy(location.href, button, 'Copied');
		});
	}

	const download = document.querySelector('[data-download]');
	if (download) {
		download.addEventListener('click', () => {
			const blob = new Blob([JSON.stringify(state.changeset, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `${state.a.name.replace(/\.[^.]+$/, '')}-to-${state.b.name.replace(/\.[^.]+$/, '')}.diff.json`;
			link.click();
			URL.revokeObjectURL(url);
			flash(download, 'Saved');
		});
	}
}

async function ensureStage() {
	if (state.stage) return state.stage;
	if (!state.stagePromise) {
		state.stagePromise = import('./model-diff-stage.js')
			.then((mod) => mod.createDiffStage($('dx-stage')))
			.then((stage) => {
				state.stage = stage;
				$('dx-stage-empty').hidden = true;
				return stage;
			})
			.catch((err) => {
				// WebGL can be unavailable (headless, blocked, software-blacklisted).
				// The report still works, so say what happened and carry on.
				$('dx-stage-empty').innerHTML =
					`<strong>3D view unavailable</strong><span>${esc(err?.message || 'this browser refused a WebGL context')}. The comparison below still works.</span>`;
				state.stagePromise = null;
				return null;
			});
	}
	return state.stagePromise;
}

function wireSlot(role) {
	const slot = $(`dx-slot-${role}`);
	const input = $(`dx-file-${role}`);
	input.addEventListener('change', () => loadFromFile(role, input.files?.[0]));

	for (const type of ['dragenter', 'dragover']) {
		slot.addEventListener(type, (event) => {
			event.preventDefault();
			slot.dataset.state = 'dragging';
		});
	}
	for (const type of ['dragleave', 'drop']) {
		slot.addEventListener(type, (event) => {
			event.preventDefault();
			if (slot.dataset.state === 'dragging') slot.dataset.state = state[role] ? 'loaded' : 'idle';
		});
	}
	slot.addEventListener('drop', (event) => loadFromFile(role, event.dataTransfer?.files?.[0]));

	$(`dx-load-${role}`).addEventListener('click', () => loadFromUrl(role, $(`dx-url-${role}`).value));
	$(`dx-url-${role}`).addEventListener('keydown', (event) => {
		if (event.key === 'Enter') loadFromUrl(role, event.currentTarget.value);
	});
}

function wireExamples() {
	const host = $('dx-examples');
	for (const pair of EXAMPLE_PAIRS) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'dx-example';
		button.textContent = pair.label;
		button.title = pair.title;
		button.addEventListener('click', async () => {
			$('dx-url-a').value = pair.a;
			$('dx-url-b').value = pair.b;
			await loadFromUrl('a', pair.a);
			await loadFromUrl('b', pair.b);
		});
		host.appendChild(button);
	}
}

function wireStageControls() {
	for (const button of document.querySelectorAll('[data-mode]')) {
		button.addEventListener('click', () => {
			state.mode = button.dataset.mode;
			for (const other of document.querySelectorAll('[data-mode]')) {
				other.setAttribute('aria-pressed', String(other === button));
			}
			$('dx-wipe').hidden = state.mode !== 'wipe';
			state.stage?.setMode(state.mode);
		});
	}
	$('dx-wipe').addEventListener('input', (event) => state.stage?.setWipe(Number(event.target.value) / 100));
	$('dx-highlight').addEventListener('change', (event) => state.stage?.setHighlight(event.target.checked));
	$('dx-play').addEventListener('change', (event) => state.stage?.setPlaying(event.target.checked));

	$('dx-swap').addEventListener('click', async () => {
		const [a, b] = [state.a, state.b];
		if (!a && !b) return;
		state.a = b;
		state.b = a;
		const urlA = $('dx-url-a').value;
		$('dx-url-a').value = $('dx-url-b').value;
		$('dx-url-b').value = urlA;
		for (const role of ['a', 'b']) {
			const side = state[role];
			$(`dx-name-${role}`).textContent = side ? side.name : role === 'a' ? 'Drop the baseline .glb' : 'Drop the candidate .glb';
			$(`dx-meta-${role}`).textContent = side
				? `${formatBytes(side.bytes.byteLength)} - ${num(side.description.totals.triangles)} tris - ${num(side.description.totals.joints)} joints`
				: '';
			setSlotState(role, side ? 'loaded' : 'idle');
			if (side && state.stage) await state.stage.setModel(role, side.bytes);
		}
		compare();
		syncShareUrl();
	});
}

// Keyboard shortcuts, so the comparison modes are reachable without hunting for
// the control strip. Skipped while a text field has focus.
function wireShortcuts() {
	document.addEventListener('keydown', (event) => {
		const tag = document.activeElement?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || event.metaKey || event.ctrlKey || event.altKey) return;
		const modes = { o: 'overlay', w: 'wipe', s: 'split' };
		const mode = modes[event.key.toLowerCase()];
		if (mode) {
			document.querySelector(`[data-mode="${mode}"]`)?.click();
			return;
		}
		if (event.key.toLowerCase() === 'h') $('dx-highlight').click();
		if (event.key.toLowerCase() === 'f') state.stage?.frameAll();
	});
}

// A pair given as URLs is shareable, so it goes in the address bar. A pair of
// dropped files is not, and pretending otherwise would produce a link that
// silently opens an empty page for whoever received it.
function syncShareUrl() {
	const params = new URLSearchParams();
	if (state.a?.url) params.set('a', state.a.url);
	if (state.b?.url) params.set('b', state.b.url);
	const query = params.toString();
	history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname);
}

async function restoreFromUrl() {
	const params = new URLSearchParams(location.search);
	const a = params.get('a');
	const b = params.get('b');
	if (a) {
		$('dx-url-a').value = a;
		await loadFromUrl('a', a);
	}
	if (b) {
		$('dx-url-b').value = b;
		await loadFromUrl('b', b);
	}
}

function init() {
	wireSlot('a');
	wireSlot('b');
	wireExamples();
	wireStageControls();
	wireShortcuts();
	restoreFromUrl();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
