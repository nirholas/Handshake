/**
 * ValidationPage — orchestrator for /validation.
 *
 * Three tabs share one input source (file/URL/sample):
 *   1. Validate  → official Khronos glTF-Validator (gltf-validator npm)
 *   2. Inspect   → glTF-Transform stats + optimization suggestions
 *   3. Records   → existing on-chain attestation browser/submitter
 *
 * The Validate tab can hand its report straight to the Records submit flow
 * via "Pin & sign on-chain" — no copy/paste round-trip.
 */

import { Validator } from './validator.js';
import { ValidatorReport } from './components/validator-report.jsx';
import { InspectReport } from './components/inspect-report.jsx';
import { inspectModel, suggestOptimizations } from './gltf-inspect.js';
import { hashReport } from './erc8004/validation-recorder.js';

// Khronos-curated sample assets, served from jsdelivr (CORS-friendly CDN over
// the official KhronosGroup/glTF-Sample-Assets repo). All are GLB-Binary so
// textures and buffers are self-contained — no external resource resolution.
const SAMPLE_BASE =
	'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models';
const SAMPLES = [
	{ name: 'Box', file: `${SAMPLE_BASE}/Box/glTF-Binary/Box.glb` },
	{ name: 'Duck', file: `${SAMPLE_BASE}/Duck/glTF-Binary/Duck.glb` },
	{ name: 'BoomBox', file: `${SAMPLE_BASE}/BoomBox/glTF-Binary/BoomBox.glb` },
	{ name: 'DamagedHelmet', file: `${SAMPLE_BASE}/DamagedHelmet/glTF-Binary/DamagedHelmet.glb` },
	{ name: 'Avocado', file: `${SAMPLE_BASE}/Avocado/glTF-Binary/Avocado.glb` },
];

export class ValidationPage {
	constructor(els, dashboard) {
		this.els = els;
		this.dashboard = dashboard;
		this.activeTab = 'validate';
		this.currentBytes = null;
		this.currentName = null;
		this.currentReport = null;
		this.currentInspect = null;
		this.currentSuggestions = null;
		// Last input, so a failure can offer a real retry instead of asking the
		// visitor to re-pick the file or re-paste the URL.
		this.lastSource = null;

		this._renderSamples();
		this._bindEvents();
		this._restoreFromHash();
	}

	// ── Tabs ────────────────────────────────────────────────────────────────

	switchTab(name, { focus = false } = {}) {
		this.activeTab = name;
		this.els.tabs.forEach((btn) => {
			const selected = btn.dataset.tab === name;
			btn.classList.toggle('active', selected);
			btn.setAttribute('aria-selected', selected ? 'true' : 'false');
			// Roving tabindex: one stop for the whole tablist, arrows move within.
			btn.tabIndex = selected ? 0 : -1;
			if (selected && focus) btn.focus();
		});
		this.els.panels.forEach((p) => {
			p.classList.toggle('active', p.dataset.tab === name);
		});
		const url = new URL(location.href);
		url.hash = name;
		history.replaceState(null, '', url);
	}

	_restoreFromHash() {
		const h = (location.hash || '').replace(/^#/, '');
		if (h === 'validate' || h === 'inspect' || h === 'records') {
			this.switchTab(h);
		}
	}

	// ── Input wiring ────────────────────────────────────────────────────────

	_bindEvents() {
		const tabs = Array.from(this.els.tabs);
		tabs.forEach((btn, i) => {
			btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
			btn.addEventListener('keydown', (e) => {
				const step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
				if (step === undefined) return;
				e.preventDefault();
				const next = tabs[(i + step + tabs.length) % tabs.length];
				this.switchTab(next.dataset.tab, { focus: true });
			});
		});

		this.els.fileInput.addEventListener('change', (e) => {
			const f = e.target.files?.[0];
			if (f) this.loadFile(f);
		});

		this.els.dropZone.addEventListener('dragover', (e) => {
			e.preventDefault();
			this.els.dropZone.classList.add('drag');
		});
		this.els.dropZone.addEventListener('dragleave', () => {
			this.els.dropZone.classList.remove('drag');
		});
		this.els.dropZone.addEventListener('drop', (e) => {
			e.preventDefault();
			this.els.dropZone.classList.remove('drag');
			const f = e.dataTransfer?.files?.[0];
			if (f) this.loadFile(f);
		});

		this.els.urlBtn.addEventListener('click', () => {
			const url = this.els.urlInput.value.trim();
			if (url) this.loadUrl(url);
		});
		this.els.urlInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.els.urlBtn.click();
		});

		this.els.signBtn.addEventListener('click', () => this._handOffToDashboard());

		// Retry buttons live inside rendered error cards, so the listener is
		// delegated onto the panels that own them.
		[this.els.validateOut, this.els.inspectOut].forEach((panel) => {
			panel.addEventListener('click', (e) => {
				if (e.target.closest('[data-retry]')) this.retryLast();
			});
		});
	}

	_renderSamples() {
		this.els.samples.innerHTML = SAMPLES.map(
			(s) =>
				`<button class="sample-chip" data-url="${s.file}" data-name="${s.name}">${s.name}</button>`,
		).join('');
		this.els.samples.querySelectorAll('.sample-chip').forEach((btn) => {
			btn.addEventListener('click', () => {
				this.loadUrl(btn.dataset.url, btn.dataset.name);
			});
		});
	}

	// ── Load + run ──────────────────────────────────────────────────────────

	async loadFile(file) {
		this.lastSource = { kind: 'file', file, name: file.name };
		this._setStatus(`Reading ${file.name} (${formatBytes(file.size)})…`);
		try {
			const buffer = await file.arrayBuffer();
			await this._run(new Uint8Array(buffer), file.name);
		} catch (e) {
			this._failBoth(`${file.name} could not be read`, errorText(e), [
				'The file may have been moved or renamed since you picked it.',
				'Pick it again, or drag it onto the drop zone.',
			]);
		}
	}

	async loadUrl(url, displayName) {
		const name = displayName || url.split('/').pop() || 'remote';
		this.lastSource = { kind: 'url', url, name };
		this._setStatus(`Fetching ${name}…`);
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
			const buffer = await res.arrayBuffer();
			await this._run(new Uint8Array(buffer), name);
		} catch (e) {
			this._failBoth(`Could not fetch ${name}`, errorText(e), [
				'The host must send an Access-Control-Allow-Origin header. Most CDNs and object stores do not by default.',
				'Check the URL points straight at a .glb or .gltf file, not at a viewer page.',
				'No CORS on the host? Download the model and drop the file here instead: it never leaves your browser.',
			]);
		}
	}

	async _run(bytes, name) {
		this.currentBytes = bytes;
		this.currentName = name;
		this.currentReport = null;
		this.currentInspect = null;
		this.currentSuggestions = null;
		this.els.signBtn.disabled = true;

		this._setStatus(`Running validator + inspector on ${name}…`);
		this.els.validateOut.innerHTML = '<div class="loading">Validating…</div>';
		this.els.inspectOut.innerHTML = '<div class="loading">Inspecting…</div>';

		const validator = new Validator(null);
		const validatePromise = validator
			.validateBuffer(bytes)
			.then((report) => {
				this.currentReport = report;
				this._renderValidate(report);
			})
			.catch((e) => {
				this.els.validateOut.innerHTML = errorCard(
					`${name} is not valid glTF`,
					errorText(e),
					[
						'The Khronos validator could not parse the file at all, so there is no report to show.',
						'Confirm the download finished and the file is a glTF 2.0 .glb or .gltf.',
						'A .gltf that references external .bin or texture files must be packed into a .glb first.',
					],
				);
			});

		const inspectPromise = inspectModel(bytes, { fileSize: bytes.byteLength })
			.then((inspect) => {
				const suggestions = suggestOptimizations(inspect);
				this.currentInspect = inspect;
				this.currentSuggestions = suggestions;
				this._renderInspect(inspect, suggestions);
			})
			.catch((e) => {
				this.els.inspectOut.innerHTML = errorCard(
					`Could not inspect ${name}`,
					errorText(e),
					[
						'glTF-Transform reads the same bytes as the validator, so an unreadable file fails both.',
						'The Validate tab shows what the Khronos suite made of it.',
					],
				);
			});

		await Promise.allSettled([validatePromise, inspectPromise]);

		// Report what actually happened. Claiming "validated" after both lanes
		// threw is how a broken upload used to read as a clean pass.
		const size = formatBytes(bytes.byteLength);
		if (this.currentReport) {
			const n = this.currentReport.issues;
			const issues = n.numErrors + n.numWarnings + n.numInfos + n.numHints;
			this._setStatus(
				`${name} · ${size} · ${issues === 0 ? 'no issues found' : `${issues} issue${issues === 1 ? '' : 's'} found`}`,
				true,
			);
			this.els.signBtn.disabled = false;
		} else {
			this._setStatus(`${name} · ${size} · could not be validated`, false, true);
		}
	}

	/** Same failure in both panels: nothing was read, so neither check ran. */
	_failBoth(title, detail, hints) {
		this._setStatus(title, false, true);
		const card = errorCard(title, detail, hints);
		this.els.validateOut.innerHTML = card;
		this.els.inspectOut.innerHTML = card;
		this.els.signBtn.disabled = true;
	}

	retryLast() {
		const src = this.lastSource;
		if (!src) return;
		if (src.kind === 'url') this.loadUrl(src.url, src.name);
		else this.loadFile(src.file);
	}

	_renderValidate(report) {
		const reportJSON = buildDownloadHref(report);
		this.els.validateOut.innerHTML = ValidatorReport({
			...report,
			location,
			reportJSON,
		});
	}

	_renderInspect(inspect, suggestions) {
		const reportJSON = buildDownloadHref({ inspect, suggestions });
		this.els.inspectOut.innerHTML = InspectReport({ inspect, suggestions, reportJSON });
	}

	// ── Status display ──────────────────────────────────────────────────────

	_setStatus(msg, ok = false, failed = false) {
		this.els.statusEl.textContent = msg;
		this.els.statusEl.className = `status${failed ? ' err' : ok ? ' ok' : ''}`;
	}

	// ── Bridge to on-chain submit ───────────────────────────────────────────

	_handOffToDashboard() {
		if (!this.currentReport) {
			this.dashboard.showToast('Run a validation first', true);
			return;
		}
		// Switch to the Records tab and pre-load the modal with the in-memory
		// report, skipping the JSON file picker entirely.
		this.switchTab('records');
		this.dashboard.openModal();
		const report = this.currentReport;
		const hash = hashReport(report);
		this.dashboard.currentReport = report;
		this.dashboard.currentReportHash = hash;
		this.dashboard.els.fileStatus.textContent = `✓ In-memory report from ${this.currentName}`;
		this.dashboard.els.fileStatus.style.color = '#76d776';
		this.dashboard.els.previewJson.textContent = JSON.stringify(report, null, 2);
		this.dashboard.els.previewSection.style.display = 'block';
		this.dashboard.els.previewError.style.display = 'none';
		this.dashboard.els.reportHash.value = hash;
		this.dashboard.els.hashSection.style.display = 'block';
		this.dashboard.els.submitReportBtn.disabled = false;
	}
}

/**
 * A designed, actionable failure block. Every path that used to blank a panel
 * renders one of these instead: what broke, the raw detail, what to try next,
 * and a retry that reruns the last input.
 */
function errorCard(title, detail, hints) {
	const list = hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
	return `
		<div class="result-error" role="alert">
			<div class="result-error-title">${escapeHtml(title)}</div>
			${detail ? `<div class="result-error-detail">${escapeHtml(detail)}</div>` : ''}
			<ul class="result-error-hints">${list}</ul>
			<div class="result-error-actions">
				<button type="button" class="result-error-retry" data-retry>Try again</button>
			</div>
		</div>`;
}

/**
 * gltf-validator rejects with a bare string, fetch with a TypeError, and
 * glTF-Transform with an Error. Reading `.message` off all three printed
 * "undefined" to the visitor for the most common failure of the three.
 */
function errorText(e) {
	if (!e) return '';
	if (typeof e === 'string') return e;
	if (e.message) return String(e.message);
	return String(e);
}

function formatBytes(n) {
	if (!Number.isFinite(n)) return 'unknown size';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function buildDownloadHref(payload) {
	try {
		const json = JSON.stringify(payload, null, 2);
		return 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
	} catch {
		return '';
	}
}

function escapeHtml(str) {
	return String(str).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#039;',
	})[c]);
}
