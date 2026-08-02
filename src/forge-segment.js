// Part segmentation layered onto the forge result viewer.
//
// When a model becomes available (forge.js dispatches `forge:model-ready`), this
// panel splits the live GLB into semantic parts via the real /api/forge-segment
// route (workers/segment). The result swaps into the <model-viewer> with every
// part tinted its own colour, and each part is listed with its face count so the
// user can see how the mesh actually decomposes.
//
// Clicking a part isolates it: a second segment run with `only_part` returns
// that part alone as its own GLB, which is what makes this more than a preview.
// Isolated parts are downloadable individually, so a generated model becomes a
// kit of components (a head to rig separately, a wheel to instance, a prop to
// re-texture on its own).
//
// Three real methods are exposed: auto, connected-component, and crease-angle.
// Nothing fakes progress: the panel polls the job and shows honest elapsed time.
//
// The panel injects its own markup + styles so it survives independently of the
// forge.html template: it only needs the result panel and viewer to be present.

const resultPanel = document.getElementById('state-result');
const viewer = document.getElementById('viewer');

if (resultPanel && viewer) {
	const POLL_MS = 2500;
	const MAX_MS = 6 * 60 * 1000;

	// Reuse the forge anonymous client id (set by forge.js) for rate-limit
	// fairness; harmless if absent.
	const CLIENT_HEADERS = (() => {
		try {
			const id = localStorage.getItem('forge:cid');
			return id ? { 'x-forge-client': id } : {};
		} catch {
			return {};
		}
	})();

	const METHOD_HINTS = {
		auto: 'Picks the best split for this mesh: connected components first, falling back to crease detection on a single welded shell.',
		connected: 'Splits on physically disconnected shells. Exact and fast, but a model welded into one surface returns a single part.',
		crease: 'Splits along sharp edges using the crease angle below. Use when the mesh is one shell but has clear hard edges.',
	};

	const MAX_PARTS = [
		[4, '4'],
		[8, '8'],
		[16, '16'],
		[24, '24'],
		[48, '48'],
	];

	// ── Styles ───────────────────────────────────────────────────────────────
	if (!document.getElementById('forge-segment-styles')) {
		const style = document.createElement('style');
		style.id = 'forge-segment-styles';
		style.textContent = `
			.segmentp { border-top: 1px solid var(--stroke); }
			.segmentp-toggle {
				width: 100%; display: flex; align-items: center; justify-content: space-between;
				gap: var(--space-sm); background: transparent; border: none; color: var(--ink);
				font-family: var(--font-display); font-weight: 600; font-size: var(--text-sm);
				padding: var(--space-sm) var(--space-md); cursor: pointer;
			}
			.segmentp-toggle:hover { background: var(--surface-2); }
			.segmentp-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
			.segmentp-toggle .chev { transition: transform 0.18s ease; color: var(--ink-dim); }
			.segmentp[data-open='true'] .segmentp-toggle .chev { transform: rotate(180deg); }
			.segmentp-body { display: none; flex-direction: column; gap: var(--space-md); padding: 0 var(--space-md) var(--space-md); }
			.segmentp[data-open='true'] .segmentp-body { display: flex; }
			.seg-field { display: flex; flex-direction: column; gap: 0.4rem; }
			.seg-field > span {
				font-size: var(--text-xs); color: var(--ink-dim); font-family: var(--font-mono);
				text-transform: uppercase; letter-spacing: 0.04em;
			}
			.seg-method {
				display: inline-flex; flex-wrap: wrap; gap: 2px; background: var(--surface-1);
				border: 1px solid var(--stroke); border-radius: var(--radius-md); padding: 2px;
			}
			.seg-method button {
				flex: 1 1 auto; background: transparent; border: none; color: var(--ink-dim);
				font-family: var(--font-mono); font-size: var(--text-xs); padding: 0.4rem 0.7rem;
				border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s, color 0.15s;
			}
			.seg-method button:hover { color: var(--ink); }
			.seg-method button[aria-pressed='true'] { background: var(--surface-3); color: var(--ink); }
			.seg-method button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
			.seg-hint { font-size: var(--text-xs); color: var(--ink-dim); line-height: 1.4; min-height: 1.4em; margin: 0; }
			.seg-row { display: flex; gap: var(--space-md); flex-wrap: wrap; }
			.seg-row .seg-field { flex: 1 1 140px; }
			.seg-select {
				background: var(--surface-1); border: 1px solid var(--stroke); border-radius: var(--radius-md);
				color: var(--ink); font-family: var(--font-mono); font-size: var(--text-xs); padding: 0.45rem 0.6rem;
			}
			.seg-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
			.seg-actions { display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap; }
			.seg-status { font-size: var(--text-xs); font-family: var(--font-mono); color: var(--ink-dim); }
			.seg-status[data-kind='error'] { color: var(--danger); }
			.seg-status[data-kind='done'] { color: var(--success); }
			.seg-parts { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
			.seg-parts.is-hidden, .seg-crease-field.is-hidden, .seg-after.is-hidden { display: none; }
			.seg-part {
				display: flex; align-items: center; gap: var(--space-sm); width: 100%;
				background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
				padding: 0.4rem 0.5rem; cursor: pointer; text-align: left; color: var(--ink);
				font-family: var(--font-mono); font-size: var(--text-xs);
				transition: background 0.15s, border-color 0.15s;
			}
			.seg-part:hover { background: var(--surface-2); }
			.seg-part:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
			.seg-part[aria-pressed='true'] { background: var(--surface-3); border-color: var(--stroke); }
			.seg-part:disabled { opacity: 0.55; cursor: default; }
			.seg-swatch {
				width: 12px; height: 12px; border-radius: 3px; flex: 0 0 auto;
				border: 1px solid rgba(255, 255, 255, 0.25);
			}
			.seg-part-name { flex: 1 1 auto; color: var(--ink); }
			.seg-part-faces { color: var(--ink-dim); }
			.seg-after { display: flex; gap: var(--space-md); flex-wrap: wrap; align-items: center; }
			.seg-summary { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--ink-dim); }
			.seg-summary strong { color: var(--ink); font-weight: 600; }
		`;
		document.head.appendChild(style);
	}

	// ── DOM ────────────────────────────────────────────────────────────────────
	const panel = document.createElement('div');
	panel.className = 'segmentp';
	panel.dataset.open = 'false';
	panel.hidden = true;
	panel.innerHTML = `
		<button class="segmentp-toggle" type="button" aria-expanded="false">
			<span>Split into parts</span>
			<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
				stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="6 9 12 15 18 9" />
			</svg>
		</button>
		<div class="segmentp-body">
			<div class="seg-field">
				<span>Method</span>
				<div class="seg-method" role="group" aria-label="Segmentation method">
					<button type="button" data-method="auto" aria-pressed="true">Auto</button>
					<button type="button" data-method="connected" aria-pressed="false">Connected</button>
					<button type="button" data-method="crease" aria-pressed="false">Crease</button>
				</div>
				<p class="seg-hint"></p>
			</div>
			<div class="seg-row">
				<label class="seg-field">
					<span>Max parts</span>
					<select class="seg-select seg-max"></select>
				</label>
				<label class="seg-field seg-crease-field is-hidden">
					<span>Crease angle</span>
					<select class="seg-select seg-crease">
						<option value="20">20&deg;, fine</option>
						<option value="40" selected>40&deg;, balanced</option>
						<option value="70">70&deg;, coarse</option>
					</select>
				</label>
			</div>
			<div class="seg-actions">
				<button class="btn seg-run" type="button"><span class="seg-run-label">Split into parts</span></button>
				<span class="seg-status" role="status" aria-live="polite"></span>
			</div>
			<p class="seg-summary is-hidden"></p>
			<ul class="seg-parts is-hidden" aria-label="Detected parts"></ul>
			<div class="seg-after is-hidden">
				<a class="btn btn-ghost seg-download" download>Download parts GLB</a>
				<a class="btn btn-ghost seg-manifest" target="_blank" rel="noopener">Part manifest</a>
				<button class="btn btn-ghost seg-revert" type="button">Revert to original</button>
			</div>
		</div>
	`;
	resultPanel.appendChild(panel);

	const toggle = panel.querySelector('.segmentp-toggle');
	const methodGroup = panel.querySelector('.seg-method');
	const hint = panel.querySelector('.seg-hint');
	const maxSel = panel.querySelector('.seg-max');
	const creaseField = panel.querySelector('.seg-crease-field');
	const creaseSel = panel.querySelector('.seg-crease');
	const runBtn = panel.querySelector('.seg-run');
	const runLabel = panel.querySelector('.seg-run-label');
	const status = panel.querySelector('.seg-status');
	const summary = panel.querySelector('.seg-summary');
	const partList = panel.querySelector('.seg-parts');
	const after = panel.querySelector('.seg-after');
	const downloadLink = panel.querySelector('.seg-download');
	const manifestLink = panel.querySelector('.seg-manifest');
	const revertBtn = panel.querySelector('.seg-revert');

	for (const [value, label] of MAX_PARTS) {
		const opt = document.createElement('option');
		opt.value = String(value);
		opt.textContent = label;
		if (value === 16) opt.selected = true;
		maxSel.appendChild(opt);
	}

	// ── State ──────────────────────────────────────────────────────────────────
	let originalGlbUrl = '';
	let baseLabel = '';
	let ownSwapUrl = ''; // a src we set ourselves; the observer must ignore it
	let method = 'auto';
	let parts = [];
	let segmentedUrl = '';
	let activePartId = '';
	let runToken = 0;
	let elapsedTimer = null;
	let unconfigured = false;

	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	function setStatus(text, kind = '') {
		status.textContent = text || '';
		status.dataset.kind = kind;
	}

	function stopElapsed() {
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
	}

	function startElapsed(label) {
		stopElapsed();
		const t0 = performance.now();
		const tick = () => {
			setStatus(`${label}: ${Math.floor((performance.now() - t0) / 1000)}s`, 'busy');
		};
		tick();
		elapsedTimer = setInterval(tick, 1000);
	}

	function setBusy(busy) {
		runBtn.disabled = busy;
		maxSel.disabled = busy;
		creaseSel.disabled = busy;
		for (const b of methodGroup.querySelectorAll('button')) b.disabled = busy;
		for (const b of partList.querySelectorAll('.seg-part')) b.disabled = busy;
		panel.dataset.busy = busy ? 'true' : 'false';
	}

	function safeName(suffix) {
		const base =
			(baseLabel || 'forge').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-|-$/g, '') || 'forge';
		return `${base}-${suffix}.glb`;
	}

	function syncMethod(next) {
		method = next;
		for (const b of methodGroup.querySelectorAll('button')) {
			b.setAttribute('aria-pressed', String(b.dataset.method === next));
		}
		hint.textContent = METHOD_HINTS[next] || '';
		creaseField.classList.toggle('is-hidden', next !== 'crease');
	}

	// ── Network ────────────────────────────────────────────────────────────────
	async function startJob(body) {
		const res = await fetch('/api/forge-segment', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 503 || data.error === 'unconfigured') {
			const e = new Error(data.message || 'Segmentation is not configured on this deployment.');
			e.kind = 'unconfigured';
			throw e;
		}
		if (res.status === 429 || data.error === 'rate_limited') {
			const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 10;
			throw new Error(`The segmenter is busy. Try again in about ${secs}s.`);
		}
		if (!res.ok || !data.job_id) {
			throw new Error(data.message || `The segmenter returned ${res.status}.`);
		}
		return data;
	}

	async function pollUntilDone(jobId, token) {
		const deadline = performance.now() + MAX_MS;
		while (token === runToken && performance.now() < deadline) {
			await sleep(POLL_MS);
			if (token !== runToken) return null;
			const res = await fetch(`/api/forge-segment?job=${encodeURIComponent(jobId)}`);
			const data = await res.json().catch(() => ({}));
			if (data.error === 'unconfigured') {
				const e = new Error(data.message || 'unconfigured');
				e.kind = 'unconfigured';
				throw e;
			}
			if (data.status === 'done' && data.result_url) return data;
			if (data.status === 'failed') throw new Error(data.error || 'Segmentation failed.');
		}
		if (token !== runToken) return null;
		throw new Error('Segmentation timed out. Try fewer parts.');
	}

	function markUnconfigured(message) {
		unconfigured = true;
		panel.dataset.state = 'unconfigured';
		setStatus(
			message ||
				'Splitting needs the segment worker configured on this deployment (GCP_SEGMENT_URL). The controls light up once it’s set.',
			'error',
		);
		runBtn.disabled = true;
		maxSel.disabled = true;
		creaseSel.disabled = true;
		for (const b of methodGroup.querySelectorAll('button')) b.disabled = true;
		panel.dataset.busy = 'false';
	}

	// ── Actions ────────────────────────────────────────────────────────────────
	function renderParts(list) {
		partList.innerHTML = '';
		for (const p of list) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'seg-part';
			btn.dataset.partId = p.id;
			btn.setAttribute('aria-pressed', 'false');
			btn.title = `Isolate ${p.name} as its own GLB`;
			const swatch = document.createElement('span');
			swatch.className = 'seg-swatch';
			swatch.style.background = p.color || 'var(--surface-3)';
			const name = document.createElement('span');
			name.className = 'seg-part-name';
			name.textContent = p.name || p.id;
			const faces = document.createElement('span');
			faces.className = 'seg-part-faces';
			faces.textContent = `${Number(p.face_count || 0).toLocaleString()} faces`;
			btn.append(swatch, name, faces);
			btn.addEventListener('click', () => isolatePart(p));
			li.appendChild(btn);
			partList.appendChild(li);
		}
		partList.classList.toggle('is-hidden', list.length === 0);
	}

	function markActivePart(id) {
		activePartId = id;
		for (const b of partList.querySelectorAll('.seg-part')) {
			b.setAttribute('aria-pressed', String(b.dataset.partId === id));
		}
	}

	async function runSegment() {
		if (!originalGlbUrl || unconfigured) return;
		const token = ++runToken;
		setBusy(true);
		startElapsed('Splitting into parts');
		try {
			const job = await startJob({
				mesh_url: originalGlbUrl,
				method,
				max_parts: Number(maxSel.value),
				...(method === 'crease' ? { crease_angle: Number(creaseSel.value) } : {}),
			});
			const done = await pollUntilDone(job.job_id, token);
			if (token !== runToken || !done) return;
			stopElapsed();
			parts = Array.isArray(done.parts) ? done.parts : [];
			segmentedUrl = done.result_url;
			ownSwapUrl = done.result_url;
			viewer.setAttribute('src', done.result_url);
			viewer.setAttribute('alt', `${baseLabel || '3D model'}, split into ${done.part_count || parts.length} parts`);
			renderParts(parts);
			markActivePart('');
			downloadLink.href = done.result_url;
			downloadLink.setAttribute('download', safeName('parts'));
			downloadLink.textContent = 'Download parts GLB';
			if (done.manifest_url) {
				manifestLink.href = done.manifest_url;
				manifestLink.hidden = false;
			} else {
				manifestLink.hidden = true;
			}
			after.classList.remove('is-hidden');
			const src = Number(done.source_faces) > 0 ? ` from ${Number(done.source_faces).toLocaleString()} faces` : '';
			summary.innerHTML = `<strong>${done.part_count || parts.length}</strong> parts${src}. Click a part to isolate and download it on its own.`;
			summary.classList.remove('is-hidden');
			const warn = Array.isArray(done.warnings) && done.warnings.length ? ` ${done.warnings[0]}` : '';
			setStatus(`Split complete.${warn}`, 'done');
		} catch (err) {
			if (token !== runToken) return;
			stopElapsed();
			if (err.kind === 'unconfigured') {
				markUnconfigured(err.message);
				return;
			}
			setStatus(err.message || 'Segmentation failed. Try another method.', 'error');
		} finally {
			if (token === runToken && !unconfigured) setBusy(false);
		}
	}

	// Isolating re-runs the segmenter with `only_part`, which returns that part
	// alone as its own GLB: a real per-part export, not a viewer-side hide.
	async function isolatePart(part) {
		if (!originalGlbUrl || unconfigured) return;
		if (activePartId === part.id) {
			// Toggling the active part off returns to the full split.
			markActivePart('');
			ownSwapUrl = segmentedUrl;
			viewer.setAttribute('src', segmentedUrl);
			downloadLink.href = segmentedUrl;
			downloadLink.setAttribute('download', safeName('parts'));
			downloadLink.textContent = 'Download parts GLB';
			setStatus('Showing all parts.', 'done');
			return;
		}
		const token = ++runToken;
		markActivePart(part.id);
		setBusy(true);
		startElapsed(`Isolating ${part.name || part.id}`);
		try {
			const job = await startJob({
				mesh_url: originalGlbUrl,
				method,
				max_parts: Number(maxSel.value),
				only_part: part.id,
				...(method === 'crease' ? { crease_angle: Number(creaseSel.value) } : {}),
			});
			const done = await pollUntilDone(job.job_id, token);
			if (token !== runToken || !done) return;
			stopElapsed();
			ownSwapUrl = done.result_url;
			viewer.setAttribute('src', done.result_url);
			viewer.setAttribute('alt', `${baseLabel || '3D model'}, ${part.name || part.id} isolated`);
			downloadLink.href = done.result_url;
			downloadLink.setAttribute('download', safeName(part.name || part.id));
			downloadLink.textContent = `Download ${part.name || part.id}`;
			after.classList.remove('is-hidden');
			setStatus(`${part.name || part.id} isolated. Click it again to show all parts.`, 'done');
		} catch (err) {
			if (token !== runToken) return;
			stopElapsed();
			markActivePart('');
			if (err.kind === 'unconfigured') {
				markUnconfigured(err.message);
				return;
			}
			setStatus(err.message || 'Could not isolate that part.', 'error');
		} finally {
			if (token === runToken && !unconfigured) setBusy(false);
		}
	}

	function revert() {
		runToken++; // abort any in-flight poll
		stopElapsed();
		setBusy(false);
		ownSwapUrl = originalGlbUrl;
		viewer.setAttribute('src', originalGlbUrl);
		viewer.setAttribute('alt', baseLabel || '3D model');
		markActivePart('');
		after.classList.add('is-hidden');
		partList.classList.add('is-hidden');
		summary.classList.add('is-hidden');
		parts = [];
		segmentedUrl = '';
		setStatus('Showing the original model.', '');
	}

	// A new source model became available: reset to the idle state for that mesh.
	function onNewSource(glbUrl, label) {
		if (!glbUrl || glbUrl === originalGlbUrl) return;
		originalGlbUrl = glbUrl;
		baseLabel = label || '';
		runToken++; // abort polls tied to the previous model
		stopElapsed();
		parts = [];
		segmentedUrl = '';
		markActivePart('');
		partList.innerHTML = '';
		partList.classList.add('is-hidden');
		summary.classList.add('is-hidden');
		after.classList.add('is-hidden');
		setStatus(unconfigured ? '' : '', '');
		if (!unconfigured) setBusy(false);
		panel.hidden = false;
	}

	// ── Wiring ─────────────────────────────────────────────────────────────────
	toggle.addEventListener('click', () => {
		const open = panel.dataset.open === 'true';
		panel.dataset.open = open ? 'false' : 'true';
		toggle.setAttribute('aria-expanded', String(!open));
	});

	methodGroup.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-method]');
		if (btn && !btn.disabled) syncMethod(btn.dataset.method);
	});

	runBtn.addEventListener('click', runSegment);
	revertBtn.addEventListener('click', revert);

	syncMethod('auto');
	runLabel.textContent = 'Split into parts';

	// Primary signal: forge.js announces the model explicitly.
	document.addEventListener('forge:model-ready', (e) => {
		onNewSource(e.detail?.glbUrl, e.detail?.label);
	});

	// Resilient fallback: watch the viewer's `src` so the panel reveals whenever a
	// model loads, even if the explicit event isn't emitted. Our own swaps
	// (ownSwapUrl) are ignored so they aren't mistaken for a new source mesh.
	const srcObserver = new MutationObserver(() => {
		const url = viewer.getAttribute('src');
		if (!url || url === originalGlbUrl || url === ownSwapUrl) return;
		onNewSource(url, document.getElementById('result-label')?.textContent?.trim() || '');
	});
	srcObserver.observe(viewer, { attributes: true, attributeFilter: ['src'] });

	// Pick up a model that was already shown before this module finished loading.
	if (viewer.getAttribute('src')) {
		onNewSource(viewer.getAttribute('src'), document.getElementById('result-label')?.textContent?.trim() || '');
	}
}
