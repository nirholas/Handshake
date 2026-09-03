// Rig Doctor page controller.
//
// Three jobs, in the order the user experiences them:
//   1. Get bytes. Drag-drop, file picker, keyboard shortcut, or a sample rig.
//   2. Diagnose. src/rig-report.js does the analysis; this file renders it.
//   3. Prove and repair. Mount the real PoseStage on a blob URL of the file so
//      the user watches their own rig perform, and offer the canonicalized GLB
//      as a download when the bone names needed rewriting.
//
// The privacy claim in the copy is load-bearing, so it constrains the code: the
// only network requests this page makes are for the animation clip library and
// the sample rigs, both of which are three.ws assets. The user's file is read
// with FileReader and never posted anywhere. PoseStage consumes a blob: URL
// created from the in-memory buffer, which never leaves the tab.
//
// The stage is imported lazily. Three.js plus the GLTF/DRACO/meshopt loaders are
// the heaviest thing on the page, and a visitor who reads the explainer and
// leaves should not pay for them.

import { analyzeGlb, manifestFromReport, formatBytes, CANONICAL_TOTAL } from './rig-report.js';
import { canonicalizeGLBBones } from './glb-canonicalize.js';

// Clips offered under the preview, chosen so each one exercises a different
// limb group: idle reads the torso, wave the arms, walk the legs. A rig whose
// legs failed to map shows that failure most obviously under `walk`.
const CLIPS = [
	{ name: 'idle', label: 'Idle', group: 'torso' },
	{ name: 'walk', label: 'Walk', group: 'legs' },
	{ name: 'wave', label: 'Wave', group: 'arms' },
	{ name: 'dance', label: 'Dance', group: 'legs' },
];

const VERDICT_MARK = {
	pass: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	warn: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17" r="1.35" fill="currentColor"/></svg>',
	fail: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
};

const VERDICT_WORD = { pass: 'Ready', warn: 'Partial', fail: 'Will not animate' };

const $ = (id) => document.getElementById(id);

/** Live page state. One file at a time; loading a second one tears the first down. */
const state = {
	report: null,
	buffer: null,
	repaired: null,
	blobUrl: null,
	stage: null,
	// Monotonic token for the newest requested file. FileReader and fetch both
	// resolve asynchronously, so a second drop landing mid-read must win rather
	// than be dropped on the floor: every completion checks that it is still the
	// newest before it touches the DOM.
	seq: 0,
};

// ── Entry ────────────────────────────────────────────────────────────────────

function init() {
	wireDropZone();
	wireSamples();
	wireTabs();
	wireCopyButtons();
	wireTooltips();
	wireShortcut();
	// A ?sample= parameter makes every verdict state shareable and linkable,
	// which is what lets the docs point at a live failing rig instead of
	// describing one.
	const preset = new URLSearchParams(location.search).get('sample');
	if (preset) {
		const btn = document.querySelector(`.rd-sample[data-sample="${CSS.escape(preset)}"]`);
		if (btn) loadSample(btn.dataset.sample, btn.dataset.sampleName);
	}
}

// ── Input ────────────────────────────────────────────────────────────────────

function wireDropZone() {
	const drop = $('rd-drop');
	const input = $('rd-file');
	if (!drop || !input) return;

	input.addEventListener('change', () => {
		const file = input.files?.[0];
		if (file) readFile(file);
		// Reset so re-picking the same file fires `change` again.
		input.value = '';
	});

	// dragenter/dragleave fire for every child element, so count depth rather
	// than toggling on each event or the zone flickers as the cursor moves.
	let depth = 0;
	const setDragging = (on) => drop.setAttribute('data-state', on ? 'dragging' : 'idle');

	for (const type of ['dragenter', 'dragover']) {
		drop.addEventListener(type, (e) => {
			e.preventDefault();
			if (type === 'dragenter') depth++;
			setDragging(true);
		});
	}
	drop.addEventListener('dragleave', () => {
		depth = Math.max(0, depth - 1);
		if (depth === 0) setDragging(false);
	});
	drop.addEventListener('drop', (e) => {
		e.preventDefault();
		depth = 0;
		setDragging(false);
		const file = e.dataTransfer?.files?.[0];
		if (file) readFile(file);
	});

	// The page itself must swallow drops, or a miss drops the user's avatar into
	// the browser's own GLB viewer and loses the session.
	for (const type of ['dragover', 'drop']) {
		window.addEventListener(type, (e) => {
			if (!drop.contains(e.target)) e.preventDefault();
		});
	}
}

function wireSamples() {
	for (const btn of document.querySelectorAll('.rd-sample')) {
		btn.addEventListener('click', () => loadSample(btn.dataset.sample, btn.dataset.sampleName));
	}
}

// `D` focuses and opens the picker from anywhere, so a returning user never
// hunts for the drop zone. Guarded against firing while typing in a field.
function wireShortcut() {
	window.addEventListener('keydown', (e) => {
		if (e.key !== 'd' && e.key !== 'D') return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target;
		if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		e.preventDefault();
		$('rd-file')?.click();
	});
}

function readFile(file) {
	if (!/\.glb$/i.test(file.name)) {
		showError(file.name, 'Only .glb files can be read here. Export as binary glTF, not .gltf, .fbx, or .vrm.');
		return;
	}
	const seq = ++state.seq;
	setDropState('reading', file.name);
	const reader = new FileReader();
	reader.onerror = () => {
		if (seq !== state.seq) return;
		showError(file.name, 'The browser could not read that file. It may have been moved or renamed since you picked it.');
	};
	reader.onload = () => {
		if (seq !== state.seq) return;
		diagnose(reader.result, file.name);
	};
	reader.readAsArrayBuffer(file);
}

// The samples are the only bytes this page fetches, so a failure here is a
// network or hosting problem, not a malformed rig. Saying "could not be read as
// a GLB" over a bare "Failed to fetch" would send the user to re-export a file
// that is perfectly fine, so this path gets its own headline and its own way out.
async function loadSample(url, name) {
	const seq = ++state.seq;
	setDropState('reading', name);
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`the server answered ${res.status}`);
		const buffer = await res.arrayBuffer();
		if (seq !== state.seq) return;
		diagnose(buffer, name);
	} catch (err) {
		if (seq !== state.seq) return;
		const reason = /failed to fetch|networkerror|load failed/i.test(err.message)
			? 'the request never reached three.ws'
			: err.message;
		showError(
			name,
			`This sample rig could not be downloaded: ${reason}. Check your connection and try again, or drop one of your own .glb files instead: that path needs no network at all.`,
			'That sample could not be downloaded.',
		);
	}
}

function setDropState(name, label) {
	const drop = $('rd-drop');
	if (!drop) return;
	drop.setAttribute('data-state', name);
	const title = drop.querySelector('.rd-drop-title');
	if (title) {
		title.textContent = name === 'reading' ? `Reading ${label}` : name === 'loaded' ? label : 'Drop a .glb here';
	}
}

// ── Diagnosis ────────────────────────────────────────────────────────────────

function diagnose(buffer, fileName) {
	let report;
	try {
		report = analyzeGlb(buffer, { fileName });
	} catch (err) {
		showError(fileName, err.message);
		return;
	}

	teardownStage();
	state.report = report;
	state.buffer = buffer;
	state.repaired = null;

	setDropState('loaded', fileName);
	renderVerdict(report);
	renderGroups(report);
	renderStats(report);
	renderRenames(report);
	renderUnmapped(report);
	renderOutputs(report);

	const results = $('rd-results');
	results.hidden = false;
	results.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

	mountStage(report);
}

function showError(fileName, message, headline = 'That file could not be read as a GLB.') {
	const results = $('rd-results');
	teardownStage();
	state.report = null;
	setDropState('idle');
	$('rd-verdict').setAttribute('data-level', 'fail');
	$('rd-verdict-mark').innerHTML = VERDICT_MARK.fail;
	$('rd-verdict-file').textContent = fileName;
	$('rd-verdict-headline').textContent = headline;
	$('rd-verdict-detail').textContent = message;
	$('rd-verdict-notes').innerHTML = '';
	$('rd-verdict-actions').innerHTML = '';
	for (const id of ['rd-groups', 'rd-stats', 'rd-unmapped', 'rd-renames']) {
		const el = $(id);
		if (el) el.innerHTML = '';
	}
	$('rd-renames-panel').hidden = true;
	$('rd-unmapped-panel').hidden = true;
	// Hide the panels that would render empty rather than showing four blank
	// cards under a failure the user cannot act on.
	for (const panel of document.querySelectorAll('.rd-col-report .rd-panel')) panel.hidden = true;
	$('rd-stage').setAttribute('data-state', 'failed');
	setStageStatus('Nothing to preview');
	// The stage panel's own labels are set by mountStage, which never ran here.
	// Left alone they read "Loading the scene" above a stage that has already
	// given up, and promise a retargeting run on a file that was never parsed.
	$('rd-stage-note').textContent = 'Preview unavailable';
	$('rd-stage-foot').textContent = 'Once a file parses, its rig previews here with the real clip library.';
	results.hidden = false;
	results.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function renderVerdict(report) {
	const v = report.verdict;
	for (const panel of document.querySelectorAll('.rd-col-report .rd-panel')) panel.hidden = false;
	$('rd-verdict').setAttribute('data-level', v.level);
	$('rd-verdict-mark').innerHTML = VERDICT_MARK[v.level];
	$('rd-verdict-file').innerHTML = `<span class="rd-verdict-word">${VERDICT_WORD[v.level]}</span> ${escapeHtml(report.fileName)} <span class="rd-verdict-size">${formatBytes(report.bytes)}</span>`;
	$('rd-verdict-headline').textContent = v.headline;
	$('rd-verdict-detail').textContent = v.detail;

	const notes = $('rd-verdict-notes');
	notes.innerHTML = '';
	for (const line of [...v.notes, ...v.fixes.map((f) => `Fix: ${f}`)]) {
		const li = document.createElement('li');
		li.className = /^Fix: /.test(line) ? 'rd-note-fix' : '';
		li.textContent = line.replace(/^Fix: /, '');
		notes.appendChild(li);
	}

	renderActions(report);
}

// The repair button only appears when a repair would actually change something.
// A button that downloads a byte-identical file is a lie about having helped.
function renderActions(report) {
	const host = $('rd-verdict-actions');
	host.innerHTML = '';
	if (!report.skeleton.renames.length) return;

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'rd-action-primary';
	btn.dataset.tip = 'Rewrites joint names only. Geometry, materials, and textures are copied through untouched.';
	btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Download the repaired GLB`;
	btn.addEventListener('click', () => downloadRepaired(btn));
	host.appendChild(btn);

	const note = document.createElement('span');
	note.className = 'rd-action-note';
	note.textContent = `${report.skeleton.renames.length} joints renamed`;
	host.appendChild(note);
	applyTooltip(btn);
}

function downloadRepaired(btn) {
	const report = state.report;
	if (!report || !state.buffer) return;
	const label = btn.innerHTML;
	try {
		if (!state.repaired) state.repaired = canonicalizeGLBBones(state.buffer);
		const blob = new Blob([state.repaired.buffer], { type: 'model/gltf-binary' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = report.fileName.replace(/\.glb$/i, '') + '.canonical.glb';
		document.body.appendChild(a);
		a.click();
		a.remove();
		// Revoke on the next task so Safari has finished starting the download.
		setTimeout(() => URL.revokeObjectURL(url), 0);
		btn.classList.add('is-done');
		btn.innerHTML = 'Downloaded';
		setTimeout(() => {
			btn.classList.remove('is-done');
			btn.innerHTML = label;
		}, 2200);
	} catch (err) {
		btn.innerHTML = `Repair failed: ${escapeHtml(err.message)}`;
	}
}

function renderGroups(report) {
	const s = report.skeleton;
	$('rd-coverage-note').textContent = `${s.mapped} of ${CANONICAL_TOTAL} canonical joints`;
	const host = $('rd-groups');
	host.innerHTML = '';
	for (const g of s.groups) {
		const row = document.createElement('div');
		row.className = 'rd-group';
		row.dataset.driven = String(g.driven);
		row.dataset.tip = g.driven
			? `${g.blurb} All key joints mapped.`
			: `${g.blurb} Missing: ${g.missingKey.join(', ')}.`;
		row.innerHTML = `
			<div class="rd-group-head">
				<span class="rd-group-label">${escapeHtml(g.label)}</span>
				<span class="rd-group-count">${g.have}/${g.total}</span>
			</div>
			<div class="rd-group-bar"><span class="rd-group-fill" style="width:${g.pct}%"></span></div>
			<p class="rd-group-state">${g.driven ? 'Will animate' : `Frozen: missing ${escapeHtml(g.missingKey.join(', '))}`}</p>
		`;
		host.appendChild(row);
		applyTooltip(row);
	}
}

function renderStats(report) {
	$('rd-inventory-note').textContent = report.generator === 'unknown' ? 'No generator recorded' : `Exported by ${report.generator}`;
	const host = $('rd-stats');
	host.innerHTML = '';
	const rows = [
		['Convention', report.skeleton.convention.label, report.skeleton.convention.evidence],
		['Triangles', report.geometry.triangles.toLocaleString(), `${report.geometry.vertices.toLocaleString()} vertices across ${report.geometry.primitives} primitives`],
		['Joints', String(report.skeleton.jointCount), `${report.skeleton.mapped} recognised, ${report.skeleton.unmapped.length} not`],
		['Materials', String(report.counts.materials), `${report.counts.textures} textures, ${formatBytes(report.textureBytes)}`],
		['Blendshapes', String(report.morphs.total), report.morphs.lipSync ? `${report.morphs.visemeCount} visemes, lip-sync ready` : 'No visemes, so no lip-sync'],
		['Embedded clips', String(report.animations.length), report.animations.length ? report.animations.map((a) => a.name).slice(0, 4).join(', ') : 'None; the library supplies the motion'],
		['Extensions', report.extensions.length ? String(report.extensions.length) : 'none', report.extensions.length ? report.extensions.join(', ') : 'Plain glTF 2.0'],
		['File', formatBytes(report.bytes), `${formatBytes(report.jsonBytes)} JSON, ${formatBytes(report.binBytes)} binary`],
	];
	for (const [term, value, tip] of rows) {
		const wrap = document.createElement('div');
		wrap.className = 'rd-stat';
		wrap.dataset.tip = tip;
		wrap.innerHTML = `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`;
		host.appendChild(wrap);
		applyTooltip(wrap);
	}
}

function renderRenames(report) {
	const renames = report.skeleton.renames;
	const panel = $('rd-renames-panel');
	if (!renames.length) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	$('rd-renames-note').textContent = `${renames.length} of ${report.skeleton.jointCount} joints`;
	const host = $('rd-renames');
	host.innerHTML = '';
	// Show a readable slice, then say plainly how many were withheld. A silent
	// truncation would read as "that is all of them".
	const shown = renames.slice(0, 10);
	for (const r of shown) {
		const row = document.createElement('div');
		row.className = 'rd-rename';
		row.innerHTML = `<code class="rd-rename-from">${escapeHtml(r.from)}</code><span class="rd-rename-arrow" aria-hidden="true">&rarr;</span><code class="rd-rename-to">${escapeHtml(r.to)}</code>`;
		host.appendChild(row);
	}
	if (renames.length > shown.length) {
		const more = document.createElement('p');
		more.className = 'rd-panel-foot';
		more.textContent = `and ${renames.length - shown.length} more, all applied in the repaired file.`;
		host.appendChild(more);
	}
}

function renderUnmapped(report) {
	const list = report.skeleton.unmapped;
	const panel = $('rd-unmapped-panel');
	if (!list.length) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	const host = $('rd-unmapped');
	host.innerHTML = '';
	for (const name of list.slice(0, 40)) {
		const chip = document.createElement('code');
		chip.className = 'rd-chip';
		chip.textContent = name;
		host.appendChild(chip);
	}
	if (list.length > 40) {
		const chip = document.createElement('span');
		chip.className = 'rd-chip rd-chip-more';
		chip.textContent = `+${list.length - 40} more`;
		host.appendChild(chip);
	}
}

function renderOutputs(report) {
	const slug = report.fileName.replace(/\.glb$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'avatar';
	const meshUri = `https://your-host.example/${slug}.glb`;
	const manifest = manifestFromReport(report, {
		id: slug,
		name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
		meshUri,
		owner: 'YOUR_SOLANA_ADDRESS',
		createdAt: new Date().toISOString(),
	});
	$('rd-out-manifest').textContent = JSON.stringify(manifest, null, 2);

	$('rd-out-embed').textContent = [
		'<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"><\/script>',
		'',
		`<agent-3d src="${meshUri}" style="width:400px;height:600px"></agent-3d>`,
	].join('\n');

	$('rd-out-cli').textContent = [
		'npx @three-ws/avatar-cli init \\',
		`  --name "${manifest.name}" \\`,
		`  --mesh ./${report.fileName} \\`,
		`  --mesh-uri ${meshUri} \\`,
		'  --owner YOUR_SOLANA_ADDRESS \\',
		`  --out ${slug}.avatar.json`,
		'',
		`npx @three-ws/avatar-cli validate ${slug}.avatar.json`,
	].join('\n');
}

// ── Live preview ─────────────────────────────────────────────────────────────

function setStageStatus(text, spinning = false) {
	const status = $('rd-stage-status');
	const label = $('rd-stage-status-text');
	if (label) label.textContent = text;
	if (status) status.classList.toggle('is-static', !spinning);
}

function teardownStage() {
	state.stage?.dispose();
	state.stage = null;
	if (state.blobUrl) {
		URL.revokeObjectURL(state.blobUrl);
		state.blobUrl = null;
	}
	$('rd-clips').innerHTML = '';
}

async function mountStage(report) {
	const host = $('rd-stage');
	host.setAttribute('data-state', 'loading');
	setStageStatus('Loading the scene', true);
	$('rd-stage-note').textContent = 'Retargeting the clip library';

	// The blob URL is created from the ORIGINAL bytes, not the repaired ones, so
	// the preview shows what the user has today. Retargeting canonicalizes bone
	// names in memory anyway, so a Mixamo rig still performs; what the preview
	// cannot hide is a limb group that never mapped at all.
	const blob = new Blob([state.buffer], { type: 'model/gltf-binary' });
	state.blobUrl = URL.createObjectURL(blob);

	let PoseStage;
	try {
		({ PoseStage } = await import('./avatar-pose.js'));
	} catch {
		host.setAttribute('data-state', 'failed');
		setStageStatus('The 3D scene could not load in this browser.');
		$('rd-stage-note').textContent = 'Preview unavailable';
		return;
	}

	const stage = new PoseStage(host, { glbUrl: state.blobUrl, framing: 'full' });
	state.stage = stage;
	try {
		const { supported } = await stage.mount();
		// A second file dropped mid-load supersedes this one.
		if (state.stage !== stage) return;
		stage.start();
		host.setAttribute('data-state', 'ready');
		renderClipButtons(report, supported);
		$('rd-stage-note').textContent = supported ? 'Drag to orbit' : 'Static: no drivable rig';
		$('rd-stage-foot').textContent = supported
			? 'Play a clip and watch which limbs move. This is the same retargeting path the platform uses.'
			: 'This rig cannot be driven by the clip library, so the platform substitutes the default avatar rather than showing a frozen pose.';
	} catch (err) {
		if (state.stage !== stage) return;
		host.setAttribute('data-state', 'failed');
		setStageStatus(`The scene could not render this file: ${err.message}`);
		$('rd-stage-note').textContent = 'Preview unavailable';
	}
}

function renderClipButtons(report, supported) {
	const host = $('rd-clips');
	host.innerHTML = '';
	if (!supported) return;
	const groups = new Map(report.skeleton.groups.map((g) => [g.id, g]));
	for (const clip of CLIPS) {
		const group = groups.get(clip.group);
		const frozen = group && !group.driven;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'rd-clip';
		btn.textContent = clip.label;
		btn.dataset.frozen = String(!!frozen);
		btn.dataset.tip = frozen
			? `Plays, but this rig's ${group.label.toLowerCase()} are unmapped so they stay still.`
			: `Drives the ${group ? group.label.toLowerCase() : 'rig'}.`;
		btn.addEventListener('click', async () => {
			for (const other of host.querySelectorAll('.rd-clip')) other.classList.remove('is-active');
			btn.classList.add('is-active');
			try {
				await state.stage?.play(clip.name);
			} catch {
				btn.classList.remove('is-active');
				btn.dataset.tip = 'This clip is not available right now.';
			}
		});
		host.appendChild(btn);
		applyTooltip(btn);
	}
	host.querySelector('.rd-clip')?.classList.add('is-active');
}

// ── Small UI plumbing ────────────────────────────────────────────────────────

function wireTabs() {
	const tabs = [...document.querySelectorAll('.rd-tab')];
	const select = (name) => {
		for (const tab of tabs) {
			const on = tab.dataset.pane === name;
			tab.setAttribute('aria-selected', String(on));
			$(`rd-pane-${tab.dataset.pane}`).hidden = !on;
		}
	};
	for (const tab of tabs) {
		tab.addEventListener('click', () => select(tab.dataset.pane));
		// Roving arrow-key navigation, which is what a tablist owes a keyboard user.
		tab.addEventListener('keydown', (e) => {
			const i = tabs.indexOf(tab);
			const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
			if (next < 0 || next >= tabs.length) return;
			e.preventDefault();
			tabs[next].focus();
			select(tabs[next].dataset.pane);
		});
	}
}

function wireCopyButtons() {
	for (const btn of document.querySelectorAll('.rd-copy')) {
		btn.addEventListener('click', async () => {
			const source = $(btn.dataset.copyTarget);
			if (!source) return;
			const label = btn.textContent;
			try {
				await navigator.clipboard.writeText(source.textContent);
				btn.textContent = 'Copied';
			} catch {
				// Clipboard access is denied over plain HTTP and in some embedded
				// browsers. Select the text so the user can still take it.
				const range = document.createRange();
				range.selectNodeContents(source);
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
				btn.textContent = 'Selected: press Ctrl+C';
			}
			btn.classList.add('is-done');
			setTimeout(() => {
				btn.textContent = label;
				btn.classList.remove('is-done');
			}, 1800);
		});
	}
}

// Tooltips: one shared floating element rather than a bubble per trigger, so
// adding `data-tip` to anything (including nodes rendered later) is free. It is
// mirrored into `aria-describedby` so the text reaches a screen reader too,
// which a CSS-only `::after` tooltip never does.
let tipEl = null;
let tipHost = null;

function ensureTipEl() {
	if (tipEl) return tipEl;
	tipEl = document.createElement('div');
	tipEl.className = 'rd-tip';
	tipEl.id = 'rd-tip';
	tipEl.setAttribute('role', 'tooltip');
	tipEl.hidden = true;
	document.body.appendChild(tipEl);
	return tipEl;
}

function showTip(host) {
	const text = host.dataset.tip;
	if (!text) return;
	const el = ensureTipEl();
	el.textContent = text;
	el.hidden = false;
	tipHost = host;
	host.setAttribute('aria-describedby', 'rd-tip');

	const r = host.getBoundingClientRect();
	const t = el.getBoundingClientRect();
	const margin = 10;
	// Prefer above; flip below when the trigger sits near the top of the viewport.
	const above = r.top > t.height + margin;
	let left = r.left + r.width / 2 - t.width / 2;
	left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(above ? r.top - t.height - 8 : r.bottom + 8)}px`;
	el.dataset.placement = above ? 'top' : 'bottom';
}

function hideTip() {
	if (!tipEl) return;
	tipEl.hidden = true;
	tipHost?.removeAttribute('aria-describedby');
	tipHost = null;
}

function applyTooltip(el) {
	if (!el?.dataset.tip || el.dataset.tipWired === '1') return;
	el.dataset.tipWired = '1';
	el.addEventListener('mouseenter', () => showTip(el));
	el.addEventListener('mouseleave', hideTip);
	el.addEventListener('focus', () => showTip(el));
	el.addEventListener('blur', hideTip);
}

function wireTooltips() {
	for (const el of document.querySelectorAll('[data-tip]')) applyTooltip(el);
	window.addEventListener('scroll', hideTip, { passive: true });
	window.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') hideTip();
	});
}

function prefersReducedMotion() {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
