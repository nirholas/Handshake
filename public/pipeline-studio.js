/*
 * Pipeline Studio (/cookbook/playground)
 *
 * The cookbook's four stages, executed in the browser against the real, free,
 * keyless API:
 *
 *   1. generate   POST /api/3d/generate      (inline-done or queued + poll)
 *   2. render     GET  /api/render/glb       (headless chromium still)
 *   3. gate       GET  /api/3d/inspect       (stats + Khronos validator)
 *   4. export     manifest.json + the commands that reproduce the run locally
 *
 * The gate is a deliberate, line-by-line port of `evaluate()` in
 * /cookbook/recipes/asset_gate.py. That is the whole point of this page: the
 * verdict you see here has to be the verdict your CI reaches, or the preview is
 * worse than useless. When one changes, change the other.
 */
(function () {
	'use strict';

	/* ── Constants ─────────────────────────────────────────────────────── */

	// Matches asset_pack.py's DEFAULT_WORKERS. The free lane is a shared GPU
	// pool: more parallelism queues rather than finishes.
	const DEFAULT_WORKERS = 3;
	const MAX_WORKERS = 4;

	// Poll cadence bounds, mirroring text_to_3d.py. The server sends a
	// `retryAfter` hint on every queued response and we honour it inside these.
	const MIN_POLL_MS = 2000;
	const MAX_POLL_MS = 10000;

	// A draft generation that has not landed in six minutes is not coming back.
	const GENERATE_TIMEOUT_MS = 6 * 60 * 1000;
	// A still is a chromium boot plus a render; a minute is generous.
	const RENDER_TIMEOUT_MS = 60 * 1000;

	const RENDER_W = 640;
	const RENDER_H = 480;

	const STORAGE_KEY = 'threews.pipeline-studio.v1';

	// Packs that exercise different corners of the lane: soft organic shapes,
	// hard-surface props, and one deliberately detailed set that tends to bust a
	// tight triangle budget, so the gate has something to actually catch.
	const PRESETS = [
		{
			name: 'Garden props',
			prompts: [
				'a clay flower pot with a saucer',
				'a woven wicker basket',
				'a brass watering can',
			],
		},
		{
			name: 'Desk objects',
			prompts: [
				'a small ceramic teapot with a bamboo handle',
				'a stack of three hardcover books',
				'a copper desk lamp with a fabric shade',
			],
		},
		{
			name: 'Game pickups',
			prompts: [
				'a wooden treasure chest with iron bands',
				'a glowing blue health potion in a glass flask',
				'an iron key with an ornate bow',
			],
		},
	];

	const DEFAULT_BUDGET = {
		maxTriangles: 100000,
		minTriangles: 100,
		maxSizeMb: 8,
		maxMaterials: 16,
		requireTextures: false,
		requireMaterials: false,
	};

	/* ── Small helpers ─────────────────────────────────────────────────── */

	const $ = (id) => document.getElementById(id);

	function clamp(value, low, high) {
		return Math.max(low, Math.min(high, value));
	}

	function escapeHtml(value) {
		return String(value == null ? '' : value).replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
		);
	}

	/* Byte-for-byte the same rule as slugify() in text_to_3d.py, so a model
	   downloaded here lands under the same filename the CLI would give it. */
	function slugify(text, limit) {
		const cap = limit || 48;
		let slug = String(text)
			.split('')
			.map((c) => (/[a-z0-9]/i.test(c) ? c.toLowerCase() : '-'))
			.join('');
		slug = slug.replace(/^-+|-+$/g, '');
		while (slug.indexOf('--') !== -1) slug = slug.replace(/--/g, '-');
		return slug.slice(0, cap).replace(/^-+|-+$/g, '') || 'model';
	}

	/* asset_pack.py's unique_slugs: two prompts that collapse to the same slug
	   must not overwrite each other's file. */
	function uniqueSlugs(prompts) {
		const seen = Object.create(null);
		return prompts.map((prompt) => {
			const base = slugify(prompt);
			seen[base] = (seen[base] || 0) + 1;
			return seen[base] === 1 ? base : base + '-' + seen[base];
		});
	}

	class Cancelled extends Error {
		constructor() {
			super('cancelled');
			this.name = 'Cancelled';
		}
	}

	function sleep(ms, signal) {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new Cancelled());
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			function onAbort() {
				clearTimeout(timer);
				reject(new Cancelled());
			}
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	function formatDuration(ms) {
		const s = Math.round(ms / 1000);
		if (s < 60) return s + 's';
		return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
	}

	function formatInt(n) {
		return Number(n || 0).toLocaleString('en-US');
	}

	function formatMb(bytes) {
		return (Number(bytes || 0) / 1048576).toFixed(1);
	}

	/* ── Stage 1: generate ─────────────────────────────────────────────── */

	async function readJson(response) {
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch (err) {
			throw new Error('the API returned a non-JSON response (HTTP ' + response.status + ')');
		}
	}

	function apiMessage(payload, fallback) {
		return (
			(payload && (payload.error_description || payload.message || payload.error)) || fallback
		);
	}

	function pollDelay(payload, previous) {
		const hint = Number(payload && payload.retryAfter);
		if (!Number.isFinite(hint) || hint <= 0) return previous || MIN_POLL_MS;
		return clamp(hint * 1000, MIN_POLL_MS, MAX_POLL_MS);
	}

	async function generate(prompt, signal, onQueued) {
		const res = await fetch('/api/3d/generate', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ prompt: prompt }),
			signal: signal,
		});
		const data = await readJson(res);
		if (!res.ok) throw new Error(apiMessage(data, 'the 3D lane refused the job'));
		if (data.status === 'done' && data.glbUrl) return data;
		if (data.status === 'error') throw new Error(apiMessage(data, 'generation failed'));

		const job = data.job;
		if (!job) throw new Error('the API queued the job without returning a handle');

		let delay = pollDelay(data, MIN_POLL_MS);
		if (onQueued) onQueued(data.etaSeconds);

		const deadline = Date.now() + GENERATE_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await sleep(delay, signal);
			const url =
				'/api/3d/generate?job=' +
				encodeURIComponent(job) +
				'&title=' +
				encodeURIComponent(prompt);
			const pollRes = await fetch(url, { headers: { accept: 'application/json' }, signal: signal });
			const polled = await readJson(pollRes);
			if (!pollRes.ok) throw new Error(apiMessage(polled, 'the poll failed'));
			if (polled.status === 'done' && polled.glbUrl) return polled;
			if (polled.status === 'error') throw new Error(apiMessage(polled, 'generation failed'));
			delay = pollDelay(polled, delay);
		}
		throw new Error('the job did not finish within ' + Math.round(GENERATE_TIMEOUT_MS / 60000) + ' minutes');
	}

	/* ── Stage 2: render ───────────────────────────────────────────────── */

	function renderUrl(glbUrl) {
		return (
			'/api/render/glb?glbUrl=' +
			encodeURIComponent(glbUrl) +
			'&width=' +
			RENDER_W +
			'&height=' +
			RENDER_H +
			'&background=transparent'
		);
	}

	/* Load the still through an Image so the card only ever shows a picture that
	   really decoded. The endpoint boots headless chromium, so onload here is
	   genuine evidence the render happened, not an optimistic guess. */
	function renderStill(glbUrl, signal) {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new Cancelled());
			const url = renderUrl(glbUrl);
			const img = new Image();
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error('the render did not finish in time'));
			}, RENDER_TIMEOUT_MS);
			function cleanup() {
				clearTimeout(timer);
				img.onload = null;
				img.onerror = null;
				signal.removeEventListener('abort', onAbort);
			}
			function onAbort() {
				cleanup();
				img.src = '';
				reject(new Cancelled());
			}
			img.onload = () => {
				cleanup();
				resolve(url);
			};
			img.onerror = () => {
				cleanup();
				reject(new Error('the renderer could not draw this model'));
			};
			signal.addEventListener('abort', onAbort, { once: true });
			img.decoding = 'async';
			img.src = url;
		});
	}

	/* ── Stage 3: gate ─────────────────────────────────────────────────── */

	async function inspect(glbUrl, signal) {
		const res = await fetch('/api/3d/inspect?url=' + encodeURIComponent(glbUrl), {
			headers: { accept: 'application/json' },
			signal: signal,
		});
		const data = await readJson(res);
		if (!res.ok) throw new Error(apiMessage(data, 'the inspector could not read this model'));
		return data;
	}

	/*
	 * Port of evaluate() in asset_gate.py. Same order, same wording, same split
	 * between a failure (something a user will feel) and an advisory (something
	 * worth a look). Keep the two in step.
	 */
	function evaluate(payload, budget) {
		const stats = payload.stats || {};
		const validation = payload.validation || {};
		const sizeBytes = Number(payload.sizeBytes || 0);
		const failures = [];
		const advisories = [];

		if (!payload.valid) failures.push('the file is not a valid glTF/GLB container');

		const errors = Number(validation.numErrors || 0);
		if (errors) failures.push('glTF validator reported ' + errors + ' error(s)');

		const triangles = Number(stats.triangles || 0);
		if (triangles > budget.maxTriangles) {
			failures.push(
				formatInt(triangles) + ' triangles exceeds the budget of ' + formatInt(budget.maxTriangles),
			);
		}
		if (triangles < budget.minTriangles) {
			failures.push(
				'only ' +
					formatInt(triangles) +
					' triangles: generation probably collapsed (minimum ' +
					formatInt(budget.minTriangles) +
					')',
			);
		}

		const sizeMb = sizeBytes / 1048576;
		if (sizeMb > budget.maxSizeMb) {
			failures.push(
				sizeMb.toFixed(1) + ' MB exceeds the budget of ' + budget.maxSizeMb.toFixed(1) + ' MB',
			);
		}

		const materials = Number(stats.materials || 0);
		if (materials > budget.maxMaterials) {
			failures.push(materials + ' materials exceeds the budget of ' + budget.maxMaterials);
		}

		const textures = Number(stats.textures || 0);
		// Zero materials is not automatically broken: the draft lane routinely
		// ships vertex-coloured geometry, which renders in full colour with no
		// material at all. Only fail on it when the caller opted in.
		if (materials === 0) {
			if (budget.requireMaterials) {
				failures.push('no materials, and "require materials" was set');
			} else {
				advisories.push(
					'no materials: likely vertex-coloured geometry, which renders in colour but ignores your lighting setup',
				);
			}
		}
		if (budget.requireTextures && textures === 0) {
			failures.push('no textures, and "require textures" was set');
		}

		const warnings = Number(validation.numWarnings || 0);
		if (warnings) advisories.push('glTF validator reported ' + warnings + ' warning(s)');
		(payload.recommendations || []).forEach((rec) => {
			if (['warn', 'warning', 'error'].indexOf(rec.severity) !== -1 && rec.issue) {
				advisories.push(rec.issue);
			}
		});

		return { passed: failures.length === 0, failures: failures, advisories: advisories };
	}

	/* ── Run state ─────────────────────────────────────────────────────── */

	const state = {
		items: [],
		budget: Object.assign({}, DEFAULT_BUDGET),
		workers: DEFAULT_WORKERS,
		running: false,
		startedAt: 0,
		elapsedMs: 0,
		controller: null,
	};

	const els = {};
	let tickTimer = 0;

	function cacheEls() {
		[
			'pl-form',
			'pl-prompts',
			'pl-prompt-count',
			'pl-presets',
			'pl-tri',
			'pl-mb',
			'pl-mat',
			'pl-req-tex',
			'pl-req-mat',
			'pl-workers',
			'pl-run',
			'pl-stop',
			'pl-eta',
			'pl-log',
			'pl-grid',
			'pl-intro',
			'pl-stages',
			'pl-verdict',
			'pl-export',
			'pl-repro',
			'pl-dl-manifest',
			'pl-dl-all',
			'pl-share',
			'pl-copy-repro',
			'pl-tip',
		].forEach((id) => {
			els[id.replace(/^pl-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
		});
	}

	function log(message, kind) {
		const li = document.createElement('li');
		if (kind) li.className = 'is-' + kind;
		const time = new Date();
		li.innerHTML =
			'<time>' +
			String(time.getHours()).padStart(2, '0') +
			':' +
			String(time.getMinutes()).padStart(2, '0') +
			':' +
			String(time.getSeconds()).padStart(2, '0') +
			'</time><span>' +
			escapeHtml(message) +
			'</span>';
		els.log.appendChild(li);
		els.log.scrollTop = els.log.scrollHeight;
	}

	/* ── Rendering the results ─────────────────────────────────────────── */

	const STATUS_LABEL = {
		queued: 'Queued',
		generating: 'Generating',
		rendering: 'Rendering',
		inspecting: 'Inspecting',
		pass: 'Pass',
		fail: 'Fail',
		error: 'Error',
		cancelled: 'Stopped',
	};

	function statsRow(item) {
		if (!item.stats) return '';
		const cells = [
			[formatInt(item.stats.triangles), 'tris'],
			[formatMb(item.sizeBytes), 'MB'],
			[String(Number(item.stats.materials || 0)), 'mat'],
			[String(Number(item.stats.textures || 0)), 'tex'],
		];
		return (
			'<dl class="pl-stats">' +
			cells
				.map(
					(c) =>
						'<div><dt>' + escapeHtml(c[1]) + '</dt><dd>' + escapeHtml(c[0]) + '</dd></div>',
				)
				.join('') +
			'</dl>'
		);
	}

	function reasonList(item) {
		const rows = [];
		(item.failures || []).forEach((f) => {
			rows.push('<li class="is-fail">' + escapeHtml(f) + '</li>');
		});
		(item.issues || []).forEach((issue) => {
			rows.push(
				'<li class="is-fail"><code>' +
					escapeHtml(issue.code) +
					'</code> ' +
					escapeHtml(issue.message) +
					(issue.pointer ? ' <span class="pl-pointer">' + escapeHtml(issue.pointer) + '</span>' : '') +
					'</li>',
			);
		});
		(item.advisories || []).forEach((a) => {
			rows.push('<li class="is-note">' + escapeHtml(a) + '</li>');
		});
		if (item.error) rows.push('<li class="is-fail">' + escapeHtml(item.error) + '</li>');
		return rows.length ? '<ul class="pl-reasons">' + rows.join('') + '</ul>' : '';
	}

	function mediaFor(item) {
		if (item.still) {
			return (
				'<img src="' +
				escapeHtml(item.still) +
				'" alt="Rendered still of ' +
				escapeHtml(item.prompt) +
				'" width="' +
				RENDER_W +
				'" height="' +
				RENDER_H +
				'" loading="lazy" decoding="async">'
			);
		}
		if (item.status === 'error' || item.status === 'cancelled') {
			return '<span class="pl-media-empty">no still</span>';
		}
		return '<span class="pl-shimmer" aria-hidden="true"></span>';
	}

	function actionsFor(item) {
		if (!item.glbUrl) return '';
		return (
			'<div class="pl-card-actions">' +
			'<a class="pl-btn subtle" href="' +
			escapeHtml(item.viewerUrl || '/viewer?src=' + encodeURIComponent(item.glbUrl)) +
			'" target="_blank" rel="noopener">View in 3D</a>' +
			(item.arUrl
				? '<a class="pl-btn subtle" href="' +
					escapeHtml(item.arUrl) +
					'" target="_blank" rel="noopener">View in AR</a>'
				: '') +
			'<a class="pl-btn subtle" href="' +
			escapeHtml(item.glbUrl) +
			'" download="' +
			escapeHtml(item.slug) +
			'.glb">Download GLB</a>' +
			'</div>'
		);
	}

	function cardHtml(item) {
		const busy = ['generating', 'rendering', 'inspecting'].indexOf(item.status) !== -1;
		return (
			'<li class="pl-card" data-status="' +
			escapeHtml(item.status) +
			'" data-id="' +
			escapeHtml(item.id) +
			'">' +
			'<div class="pl-card-media">' +
			mediaFor(item) +
			'</div>' +
			'<div class="pl-card-body">' +
			'<div class="pl-card-head">' +
			'<span class="pl-badge" data-status="' +
			escapeHtml(item.status) +
			'">' +
			escapeHtml(STATUS_LABEL[item.status] || item.status) +
			'</span>' +
			'<span class="pl-elapsed" data-elapsed="' +
			escapeHtml(item.id) +
			'">' +
			(item.ms ? formatDuration(item.ms) : busy ? '0s' : '') +
			'</span>' +
			'</div>' +
			'<p class="pl-card-prompt">' +
			escapeHtml(item.prompt) +
			'</p>' +
			statsRow(item) +
			reasonList(item) +
			actionsFor(item) +
			'</div></li>'
		);
	}

	function renderGrid() {
		els.grid.innerHTML = state.items.map(cardHtml).join('');
		els.intro.hidden = state.items.length > 0;
	}

	function patchCard(item) {
		const existing = els.grid.querySelector('[data-id="' + item.id + '"]');
		if (!existing) return renderGrid();
		const holder = document.createElement('div');
		holder.innerHTML = cardHtml(item);
		existing.replaceWith(holder.firstElementChild);
	}

	function updateStages() {
		const counts = {
			generate: state.items.filter((i) => i.glbUrl).length,
			render: state.items.filter((i) => i.still).length,
			gate: state.items.filter((i) => i.stats).length,
			export: state.items.filter((i) => i.status === 'pass').length,
		};
		Object.keys(counts).forEach((stage) => {
			const el = els.stages.querySelector('[data-count="' + stage + '"]');
			if (el) el.textContent = String(counts[stage]) + '/' + state.items.length;
		});
		els.stages.querySelectorAll('li').forEach((li) => {
			const stage = li.dataset.stage;
			const done = counts[stage] === state.items.length && state.items.length > 0;
			li.dataset.done = done ? 'true' : 'false';
		});
	}

	function updateVerdict() {
		const done = state.items.filter((i) =>
			['pass', 'fail', 'error', 'cancelled'].includes(i.status),
		);
		if (!done.length) {
			els.verdict.hidden = true;
			return;
		}
		const passed = state.items.filter((i) => i.status === 'pass').length;
		const failed = state.items.filter((i) => i.status === 'fail').length;
		const broken = state.items.filter((i) => i.status === 'error').length;
		const total = state.items.length;
		const allDone = done.length === total && !state.running;
		els.verdict.hidden = false;
		els.verdict.dataset.tone = failed || broken ? 'fail' : allDone ? 'pass' : 'busy';
		els.verdict.innerHTML =
			'<strong>' +
			passed +
			' of ' +
			total +
			' passed the budget</strong>' +
			(failed ? '<span>' + failed + ' over budget</span>' : '') +
			(broken ? '<span>' + broken + ' could not be built</span>' : '') +
			(state.elapsedMs ? '<span>' + formatDuration(state.elapsedMs) + '</span>' : '') +
			(allDone && (failed || broken)
				? '<span class="pl-verdict-exit">a CI run would exit 1 here</span>'
				: '');
	}

	/* One timer for every in-flight card, rather than one timer each. */
	function startTicking() {
		if (tickTimer) return;
		tickTimer = setInterval(() => {
			const now = Date.now();
			let live = 0;
			state.items.forEach((item) => {
				if (!item.startedAt || item.ms) return;
				live += 1;
				const el = els.grid.querySelector('[data-elapsed="' + item.id + '"]');
				if (el) el.textContent = formatDuration(now - item.startedAt);
			});
			if (state.running) {
				state.elapsedMs = now - state.startedAt;
				updateVerdict();
			}
			if (!live && !state.running) stopTicking();
		}, 1000);
	}

	function stopTicking() {
		if (!tickTimer) return;
		clearInterval(tickTimer);
		tickTimer = 0;
	}

	/* ── The run itself ────────────────────────────────────────────────── */

	function readBudget() {
		return {
			maxTriangles: clamp(parseInt(els.tri.value, 10) || DEFAULT_BUDGET.maxTriangles, 100, 2000000),
			minTriangles: DEFAULT_BUDGET.minTriangles,
			maxSizeMb: clamp(parseFloat(els.mb.value) || DEFAULT_BUDGET.maxSizeMb, 0.1, 64),
			maxMaterials: clamp(
				parseInt(els.mat.value, 10) || DEFAULT_BUDGET.maxMaterials,
				0,
				256,
			),
			requireTextures: els.reqTex.checked,
			requireMaterials: els.reqMat.checked,
		};
	}

	function readPrompts() {
		return els.prompts.value
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith('#'));
	}

	async function runOne(item, signal) {
		item.startedAt = Date.now();
		item.status = 'generating';
		patchCard(item);
		updateStages();

		const built = await generate(item.prompt, signal, (eta) => {
			log(
				'queued on the shared lane: ' +
					item.prompt +
					(eta ? ' (about ' + Math.round(eta) + 's)' : ''),
			);
		});
		item.glbUrl = built.glbUrl;
		item.viewerUrl = built.viewerUrl || '';
		item.arUrl = built.arUrl || '';
		item.creationId = built.creationId || '';
		log('built: ' + item.prompt, 'ok');
		item.status = 'rendering';
		patchCard(item);
		updateStages();

		// A still that fails to draw is not a reason to lose the model, so the
		// render is allowed to fail on its own and the run carries on to the gate.
		try {
			item.still = await renderStill(item.glbUrl, signal);
		} catch (err) {
			if (err instanceof Cancelled) throw err;
			item.advisories = (item.advisories || []).concat(['still render failed: ' + err.message]);
			log('no still for ' + item.prompt + ': ' + err.message, 'warn');
		}
		item.status = 'inspecting';
		patchCard(item);
		updateStages();

		const report = await inspect(item.glbUrl, signal);
		item.stats = report.stats || {};
		item.sizeBytes = Number(report.sizeBytes || 0);
		item.validation = report.validation || {};
		item.issues = (report.validation && report.validation.issues) || [];
		const verdict = evaluate(report, state.budget);
		item.failures = verdict.failures;
		item.advisories = (item.advisories || []).concat(verdict.advisories);
		item.status = verdict.passed ? 'pass' : 'fail';
		item.ms = Date.now() - item.startedAt;
		log(
			(verdict.passed ? 'passed: ' : 'FAILED the budget: ') +
				item.prompt +
				' (' +
				formatInt(item.stats.triangles) +
				' tris, ' +
				formatMb(item.sizeBytes) +
				' MB)',
			verdict.passed ? 'ok' : 'fail',
		);
		patchCard(item);
		updateStages();
	}

	/* A fixed-size worker pool over a shared cursor: N runners pulling from one
	   queue keeps exactly N in flight without a barrier between items. */
	async function pool(items, limit, signal) {
		let cursor = 0;
		const runner = async () => {
			while (cursor < items.length) {
				if (signal.aborted) return;
				const item = items[cursor++];
				try {
					await runOne(item, signal);
				} catch (err) {
					item.ms = Date.now() - item.startedAt;
					if (err instanceof Cancelled || signal.aborted) {
						item.status = 'cancelled';
					} else {
						item.status = 'error';
						item.error = err.message || String(err);
						log('failed: ' + item.prompt + ': ' + item.error, 'fail');
					}
					patchCard(item);
					updateStages();
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(limit, items.length) }, () => runner()),
		);
	}

	async function run() {
		const prompts = readPrompts();
		if (!prompts.length) {
			log('add at least one prompt before running', 'fail');
			els.prompts.focus();
			return;
		}

		state.budget = readBudget();
		state.workers = clamp(parseInt(els.workers.value, 10) || DEFAULT_WORKERS, 1, MAX_WORKERS);
		const slugs = uniqueSlugs(prompts);
		state.items = prompts.map((prompt, i) => ({
			id: 'a' + i + '-' + slugs[i],
			prompt: prompt,
			slug: slugs[i],
			status: 'queued',
			startedAt: 0,
			ms: 0,
			advisories: [],
			failures: [],
			issues: [],
		}));
		state.running = true;
		state.startedAt = Date.now();
		state.elapsedMs = 0;
		state.controller = new AbortController();

		els.run.hidden = true;
		els.stop.hidden = false;
		els.export.hidden = true;
		els.log.innerHTML = '';
		renderGrid();
		updateStages();
		updateVerdict();
		startTicking();
		log(
			'running ' +
				prompts.length +
				' prompt(s), ' +
				state.workers +
				' at a time, budget ' +
				formatInt(state.budget.maxTriangles) +
				' tris / ' +
				state.budget.maxSizeMb +
				' MB',
		);

		try {
			await pool(state.items, state.workers, state.controller.signal);
		} finally {
			state.running = false;
			state.elapsedMs = Date.now() - state.startedAt;
			els.run.hidden = false;
			els.stop.hidden = true;
			updateStages();
			updateVerdict();
			stopTicking();
			const usable = state.items.filter((i) => i.glbUrl).length;
			if (usable) {
				els.export.hidden = false;
				els.repro.textContent = reproCommands();
			}
			log(
				'run finished in ' +
					formatDuration(state.elapsedMs) +
					': ' +
					state.items.filter((i) => i.status === 'pass').length +
					'/' +
					state.items.length +
					' passed',
			);
			persist();
		}
	}

	function stop() {
		if (!state.controller) return;
		state.controller.abort();
		log('stopped by you; models already built are kept', 'warn');
	}

	/* ── Stage 4: export ───────────────────────────────────────────────── */

	function manifest() {
		return {
			generator: 'three.ws cookbook / pipeline-studio',
			api: 'https://three.ws/api/3d/generate',
			tier: 'free draft',
			seconds: Math.round(state.elapsedMs / 100) / 10,
			budget: state.budget,
			assets: state.items.map((item) => ({
				prompt: item.prompt,
				slug: item.slug,
				ok: item.status === 'pass',
				glb_url: item.glbUrl || '',
				viewer_url: item.viewerUrl || '',
				ar_url: item.arUrl || '',
				still_url: item.still ? new URL(item.still, location.origin).href : '',
				seconds: Math.round(item.ms / 100) / 10,
				error: item.error || '',
				warnings: item.advisories || [],
				failures: item.failures || [],
				stats: item.stats || null,
				size_bytes: item.sizeBytes || 0,
				validation: item.validation || null,
			})),
		};
	}

	function download(blob, filename) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	function reproCommands() {
		const prompts = state.items.map((i) => i.prompt);
		const b = state.budget;
		const flags = [
			'--max-triangles ' + b.maxTriangles,
			'--max-size-mb ' + b.maxSizeMb,
			'--max-materials ' + b.maxMaterials,
		];
		if (b.requireTextures) flags.push('--require-textures');
		if (b.requireMaterials) flags.push('--require-materials');
		return [
			'# 1. get the two recipes',
			'curl -O https://three.ws/cookbook/recipes/text_to_3d.py',
			'curl -O https://three.ws/cookbook/recipes/asset_pack.py',
			'curl -O https://three.ws/cookbook/recipes/asset_gate.py',
			'',
			'# 2. the prompts you just ran',
			"cat > props.txt <<'EOF'",
			prompts.join('\n'),
			'EOF',
			'',
			'# 3. build the pack (' + state.workers + ' at a time, same as this page)',
			'python3 asset_pack.py --prompts-file props.txt --out ./pack --workers ' + state.workers,
			'',
			'# 4. gate it with the budget you set above',
			'python3 asset_gate.py pack/models/*.glb ' + flags.join(' '),
		].join('\n');
	}

	async function downloadAll() {
		const built = state.items.filter((i) => i.glbUrl);
		if (!built.length) return;
		els.dlAll.disabled = true;
		const original = els.dlAll.textContent;
		try {
			for (let i = 0; i < built.length; i += 1) {
				const item = built[i];
				els.dlAll.textContent = 'Downloading ' + (i + 1) + ' of ' + built.length;
				const res = await fetch(item.glbUrl);
				if (!res.ok) {
					log('could not download ' + item.slug + '.glb (HTTP ' + res.status + ')', 'fail');
					continue;
				}
				download(await res.blob(), item.slug + '.glb');
			}
			log('downloaded ' + built.length + ' model(s)', 'ok');
		} finally {
			els.dlAll.disabled = false;
			els.dlAll.textContent = original;
		}
	}

	async function copyText(text, button, done) {
		const original = button.textContent;
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = done;
		} catch (err) {
			button.textContent = 'Press Ctrl+C to copy';
			log('the browser blocked clipboard access', 'warn');
		}
		setTimeout(() => {
			button.textContent = original;
		}, 1800);
	}

	function shareLink() {
		const url = new URL(location.href);
		url.search = '';
		const b = state.budget;
		url.searchParams.set('prompts', readPrompts().join('\n'));
		url.searchParams.set('tri', String(b.maxTriangles));
		url.searchParams.set('mb', String(b.maxSizeMb));
		url.searchParams.set('mat', String(b.maxMaterials));
		if (b.requireTextures) url.searchParams.set('tex', '1');
		if (b.requireMaterials) url.searchParams.set('rmat', '1');
		return url.href;
	}

	/* ── Persistence and links ─────────────────────────────────────────── */

	function persist() {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					items: state.items,
					budget: state.budget,
					workers: state.workers,
					elapsedMs: state.elapsedMs,
					savedAt: Date.now(),
				}),
			);
		} catch (err) {
			/* A full or disabled localStorage must never break a finished run. */
		}
	}

	function restore() {
		let saved = null;
		try {
			saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
		} catch (err) {
			saved = null;
		}
		if (!saved || !Array.isArray(saved.items) || !saved.items.length) return false;
		state.items = saved.items;
		state.budget = Object.assign({}, DEFAULT_BUDGET, saved.budget || {});
		state.workers = saved.workers || DEFAULT_WORKERS;
		state.elapsedMs = saved.elapsedMs || 0;
		renderGrid();
		updateStages();
		updateVerdict();
		if (state.items.some((i) => i.glbUrl)) {
			els.export.hidden = false;
			els.repro.textContent = reproCommands();
		}
		log('restored your last run from this browser', 'ok');
		return true;
	}

	function applyBudgetToForm(budget) {
		els.tri.value = String(budget.maxTriangles);
		els.mb.value = String(budget.maxSizeMb);
		els.mat.value = String(budget.maxMaterials);
		els.reqTex.checked = Boolean(budget.requireTextures);
		els.reqMat.checked = Boolean(budget.requireMaterials);
	}

	function readUrlConfig() {
		const q = new URL(location.href).searchParams;
		const prompts = q.get('prompts');
		if (prompts) els.prompts.value = prompts;
		const budget = Object.assign({}, DEFAULT_BUDGET);
		if (q.get('tri')) budget.maxTriangles = clamp(parseInt(q.get('tri'), 10) || 0, 100, 2000000);
		if (q.get('mb')) budget.maxSizeMb = clamp(parseFloat(q.get('mb')) || 0, 0.1, 64);
		if (q.get('mat')) budget.maxMaterials = clamp(parseInt(q.get('mat'), 10) || 0, 0, 256);
		budget.requireTextures = q.get('tex') === '1';
		budget.requireMaterials = q.get('rmat') === '1';
		applyBudgetToForm(budget);
		return Boolean(prompts);
	}

	/* ── Tooltips ──────────────────────────────────────────────────────── */

	/*
	 * A real tooltip rather than a `title` attribute: keyboard reachable,
	 * announced through aria-describedby, dismissible with Escape, and readable
	 * long enough to explain a decision. Every hint on this page answers "why is
	 * this control here", which is the question a title attribute never gets to.
	 */
	function initTooltips() {
		const tip = els.tip;
		tip.id = 'pl-tip';
		let current = null;

		function hide() {
			if (!current) return;
			current.setAttribute('aria-expanded', 'false');
			current.removeAttribute('aria-describedby');
			current = null;
			tip.hidden = true;
		}

		function show(button) {
			if (current === button) return;
			hide();
			current = button;
			tip.textContent = button.dataset.hint || '';
			tip.hidden = false;
			button.setAttribute('aria-expanded', 'true');
			button.setAttribute('aria-describedby', 'pl-tip');

			const rect = button.getBoundingClientRect();
			const width = Math.min(300, window.innerWidth - 24);
			tip.style.width = width + 'px';
			let left = rect.left + rect.width / 2 - width / 2;
			left = clamp(left, 12, window.innerWidth - width - 12);
			tip.style.left = left + 'px';
			// Prefer above; flip below when the button sits near the top.
			const height = tip.offsetHeight;
			const above = rect.top - height - 10;
			tip.style.top = (above > 8 ? above : rect.bottom + 10) + 'px';
			tip.dataset.flipped = above > 8 ? 'false' : 'true';
		}

		document.querySelectorAll('.pl-hint').forEach((button) => {
			button.setAttribute('aria-expanded', 'false');
			button.addEventListener('mouseenter', () => show(button));
			button.addEventListener('focus', () => show(button));
			button.addEventListener('mouseleave', hide);
			button.addEventListener('blur', hide);
			button.addEventListener('click', (event) => {
				event.preventDefault();
				if (current === button) hide();
				else show(button);
			});
		});

		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') hide();
		});
		window.addEventListener('scroll', hide, { passive: true });
		window.addEventListener('resize', hide);
	}

	/* ── Boot ──────────────────────────────────────────────────────────── */

	function updatePromptCount() {
		const n = readPrompts().length;
		els.promptCount.textContent =
			n === 0 ? 'No prompts yet' : n + (n === 1 ? ' prompt' : ' prompts') + ', about ' + estimate(n);
		els.eta.textContent = n
			? 'Roughly ' + estimate(n) + ' at ' + (parseInt(els.workers.value, 10) || DEFAULT_WORKERS) + ' at a time.'
			: '';
	}

	/* Honest arithmetic, not a promise: a draft takes 60 to 120 seconds on the
	   free lane, so a pack takes about ninety seconds per wave of workers. */
	function estimate(count) {
		const workers = clamp(parseInt(els.workers.value, 10) || DEFAULT_WORKERS, 1, MAX_WORKERS);
		const waves = Math.ceil(count / workers);
		return formatDuration(waves * 95000);
	}

	function initPresets() {
		els.presets.innerHTML = PRESETS.map(
			(p, i) =>
				'<button class="pl-preset" type="button" data-preset="' +
				i +
				'">' +
				escapeHtml(p.name) +
				'</button>',
		).join('');
		els.presets.addEventListener('click', (event) => {
			const button = event.target.closest('[data-preset]');
			if (!button) return;
			els.prompts.value = PRESETS[Number(button.dataset.preset)].prompts.join('\n');
			updatePromptCount();
			els.prompts.focus();
		});
	}

	function boot() {
		cacheEls();
		initPresets();
		initTooltips();

		// Arriving at an empty textarea is a step nobody needs: the page opens on a
		// pack that already works, so the first action available is "Run".
		const fromUrl = readUrlConfig();
		if (!fromUrl) els.prompts.value = PRESETS[0].prompts.join('\n');
		updatePromptCount();

		els.prompts.addEventListener('input', updatePromptCount);
		els.workers.addEventListener('input', updatePromptCount);
		els.form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!state.running) run();
		});
		els.stop.addEventListener('click', stop);

		els.dlManifest.addEventListener('click', () => {
			download(
				new Blob([JSON.stringify(manifest(), null, 2)], { type: 'application/json' }),
				'manifest.json',
			);
			log('saved manifest.json', 'ok');
		});
		els.dlAll.addEventListener('click', downloadAll);
		els.share.addEventListener('click', () =>
			copyText(shareLink(), els.share, 'Link copied'),
		);
		els.copyRepro.addEventListener('click', () =>
			copyText(reproCommands(), els.copyRepro, 'Copied'),
		);

		// Cmd/Ctrl+Enter runs from anywhere on the page, Escape stops a live run.
		document.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				if (!state.running) run();
			} else if (event.key === 'Escape' && state.running) {
				stop();
			}
		});

		window.addEventListener('beforeunload', (event) => {
			if (!state.running) return;
			event.preventDefault();
			event.returnValue = '';
		});

		const restored = restore();
		if (restored) applyBudgetToForm(state.budget);
		else log('ready. Press Run pipeline, or Cmd+Enter.');
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}

	// Exposed so the gate's parity with asset_gate.py can be asserted in tests.
	window.PipelineStudio = { evaluate: evaluate, slugify: slugify, uniqueSlugs: uniqueSlugs };
})();
