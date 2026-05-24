// Knowledge panel for the Widget Studio (talking-agent only).
//
// Lets the creator attach docs that the agent uses as grounding when a
// visitor asks a question:
//   • URL ingest — server fetches + extracts visible text
//   • Paste text — plain or markdown
//   • Drop file  — .txt / .md / .pdf (PDFs are extracted client-side via
//                  pdfjs from the CDN; we send extracted text to the server)
//
// After ingest, the panel re-fetches the doc list and surfaces the server's
// `preview_questions` so the creator can sanity-check that the doc landed in
// retrieval — concrete proof, not "trust me it indexed."
//
// Mount: mountKnowledgePanel(rootEl, { getWidgetId, getCanEdit })
//        → returns { destroy, refresh }
//
// Calls /api/widgets/:id/knowledge — no separate listing/delete files needed.

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LEN = 200_000;

let _pdfjsPromise = null;
function loadPdfjs() {
	if (_pdfjsPromise) return _pdfjsPromise;
	_pdfjsPromise = import(/* @vite-ignore */ PDFJS_CDN).then((mod) => {
		try {
			mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
		} catch {}
		return mod;
	});
	return _pdfjsPromise;
}

const ICON = {
	url: '↗',
	text: '¶',
	markdown: '⌘',
	pdf: '⎙',
};

export function mountKnowledgePanel(root, ctx) {
	const { getWidgetId, getCanEdit } = ctx || {};
	root.classList.add('knowledge-panel');
	root.innerHTML = template();

	const listEl = root.querySelector('[data-list]');
	const emptyEl = root.querySelector('[data-empty]');
	const fileEl = root.querySelector('[data-file]');
	const urlEl = root.querySelector('[data-url]');
	const textEl = root.querySelector('[data-text]');
	const urlBtn = root.querySelector('[data-url-btn]');
	const textBtn = root.querySelector('[data-text-btn]');
	const dropEl = root.querySelector('[data-drop]');
	const statusEl = root.querySelector('[data-status]');
	const previewEl = root.querySelector('[data-preview]');

	let busy = false;

	fileEl.addEventListener('change', async () => {
		const f = fileEl.files?.[0];
		fileEl.value = '';
		if (f) await ingestFile(f);
	});
	dropEl.addEventListener('dragover', (e) => {
		e.preventDefault();
		dropEl.classList.add('over');
	});
	dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
	dropEl.addEventListener('drop', async (e) => {
		e.preventDefault();
		dropEl.classList.remove('over');
		const f = e.dataTransfer?.files?.[0];
		if (f) await ingestFile(f);
	});
	urlBtn.addEventListener('click', () => ingestUrl(urlEl.value.trim()));
	textBtn.addEventListener('click', () => ingestText(textEl.value.trim()));

	refresh();

	return {
		destroy() {
			root.innerHTML = '';
		},
		refresh,
	};

	// ── render ──────────────────────────────────────────────────────────────

	async function refresh() {
		const widgetId = getWidgetId?.();
		if (!widgetId) {
			renderList([]);
			setStatus('Save the widget once to start adding knowledge.');
			disable(true);
			return;
		}
		disable(!getCanEdit?.());
		setStatus('');
		try {
			const res = await fetch(`/api/widgets/${encodeURIComponent(widgetId)}/knowledge`, {
				credentials: 'include',
			});
			if (!res.ok) throw new Error(`${res.status}`);
			const { docs = [] } = await res.json();
			renderList(docs);
		} catch (err) {
			renderList([]);
			setStatus(`Couldn't load knowledge: ${err.message}`, 'err');
		}
	}

	function renderList(docs) {
		listEl.innerHTML = '';
		emptyEl.hidden = docs.length > 0;
		for (const d of docs) listEl.appendChild(renderRow(d));
	}

	function renderRow(d) {
		const row = document.createElement('div');
		row.className = 'kp-row' + (d.status === 'failed' ? ' kp-row-err' : '');
		const icon = ICON[d.source_type] || '·';
		const sub = [
			d.source_url ? linkify(d.source_url) : null,
			d.chunk_count ? `${d.chunk_count} chunks` : null,
			d.token_count ? `${formatNum(d.token_count)} tokens` : null,
			d.status === 'failed' && d.error ? `error: ${escapeHtml(d.error)}` : null,
		]
			.filter(Boolean)
			.join(' · ');

		row.innerHTML = `
			<div class="kp-row-icon" aria-hidden="true">${icon}</div>
			<div class="kp-row-meta">
				<div class="kp-row-title">${escapeHtml(d.title)}</div>
				<div class="kp-row-sub">${sub}</div>
			</div>
			<button class="kp-row-del" type="button" aria-label="Remove ${escapeHtml(d.title)}">×</button>
		`;
		row.querySelector('.kp-row-del').addEventListener('click', () => removeDoc(d));
		return row;
	}

	function setStatus(msg, kind) {
		statusEl.textContent = msg;
		statusEl.className =
			'kp-status' + (kind === 'err' ? ' kp-err' : kind === 'ok' ? ' kp-ok' : '');
	}

	function renderPreview(doc) {
		const qs = doc.preview_questions || [];
		if (!qs.length) {
			previewEl.innerHTML = '';
			previewEl.hidden = true;
			return;
		}
		previewEl.innerHTML = `
			<div class="kp-preview-title">Your bot now knows <strong>${escapeHtml(doc.title)}</strong>. Try asking:</div>
			<ul class="kp-preview-list">
				${qs.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}
			</ul>
		`;
		previewEl.hidden = false;
	}

	function disable(disabled) {
		for (const el of root.querySelectorAll('input, textarea, button')) {
			if (el.matches('[data-list] *')) continue;
			el.disabled = disabled;
		}
	}

	// ── ingest actions ──────────────────────────────────────────────────────

	async function ingestFile(file) {
		if (busy) return;
		const widgetId = getWidgetId?.();
		if (!widgetId) return setStatus('Save the widget first.', 'err');

		const name = file.name || 'file';
		const lower = name.toLowerCase();
		const isPdf = file.type === 'application/pdf' || lower.endsWith('.pdf');
		const isMd = lower.endsWith('.md') || lower.endsWith('.markdown');
		const isTxt = file.type.startsWith('text/') || lower.endsWith('.txt') || isMd;
		if (!isPdf && !isTxt) {
			return setStatus(`Unsupported file type — drop a .txt, .md, or .pdf.`, 'err');
		}
		if (isPdf && file.size > MAX_PDF_BYTES) {
			return setStatus(
				`PDF must be under 12 MB (this one is ${formatBytes(file.size)}).`,
				'err',
			);
		}

		setBusy(true, isPdf ? `Extracting ${name}…` : `Reading ${name}…`);
		try {
			let text;
			if (isPdf) {
				text = await extractPdf(file);
			} else {
				text = await file.text();
			}
			text = (text || '').trim();
			if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN);
			if (!text) throw new Error('No text could be extracted.');

			setStatus(`Embedding ${formatNum(text.length)} characters…`);
			const doc = await postIngest({
				title: name.replace(/\.(pdf|md|markdown|txt)$/i, '').slice(0, 120),
				source_type: isPdf ? 'pdf' : isMd ? 'markdown' : 'text',
				content: text,
				byte_size: file.size,
			});
			setStatus(`Added "${doc.title}".`, 'ok');
			renderPreview(doc);
			await refresh();
		} catch (err) {
			setStatus(`Couldn't add: ${err.message}`, 'err');
		} finally {
			setBusy(false);
		}
	}

	async function ingestUrl(url) {
		if (busy) return;
		if (!url) return setStatus('Paste a URL first.', 'err');
		const widgetId = getWidgetId?.();
		if (!widgetId) return setStatus('Save the widget first.', 'err');
		setBusy(true, `Fetching ${url}…`);
		try {
			const doc = await postIngest({ source_type: 'url', source_url: url });
			setStatus(`Added "${doc.title}".`, 'ok');
			urlEl.value = '';
			renderPreview(doc);
			await refresh();
		} catch (err) {
			setStatus(`Couldn't add: ${err.message}`, 'err');
		} finally {
			setBusy(false);
		}
	}

	async function ingestText(text) {
		if (busy) return;
		if (!text) return setStatus('Paste some text first.', 'err');
		if (text.length > MAX_TEXT_LEN) text = text.slice(0, MAX_TEXT_LEN);
		setBusy(true, `Embedding ${formatNum(text.length)} characters…`);
		try {
			const doc = await postIngest({ source_type: 'text', content: text });
			setStatus(`Added "${doc.title}".`, 'ok');
			textEl.value = '';
			renderPreview(doc);
			await refresh();
		} catch (err) {
			setStatus(`Couldn't add: ${err.message}`, 'err');
		} finally {
			setBusy(false);
		}
	}

	async function removeDoc(doc) {
		if (!confirm(`Remove "${doc.title}" from this widget's knowledge?`)) return;
		const widgetId = getWidgetId?.();
		try {
			const res = await fetch(
				`/api/widgets/${encodeURIComponent(widgetId)}/knowledge?doc_id=${encodeURIComponent(doc.id)}`,
				{ method: 'DELETE', credentials: 'include' },
			);
			if (!res.ok) throw new Error(`${res.status}`);
			setStatus(`Removed.`, 'ok');
			previewEl.hidden = true;
			await refresh();
		} catch (err) {
			setStatus(`Couldn't remove: ${err.message}`, 'err');
		}
	}

	async function postIngest(body) {
		const widgetId = getWidgetId?.();
		const res = await fetch(`/api/widgets/${encodeURIComponent(widgetId)}/knowledge`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			// Surface known error codes as plain English. The raw status is a
			// last-resort message — fine for unknown failures, useless to a
			// creator who doesn't read HTTP.
			const code = data.error;
			const msg = data.error_description || `Request failed (${res.status})`;
			if (code === 'embedder_unavailable') {
				throw new Error(
					'Knowledge upload needs an OpenAI key configured on the server. Ask the site admin to set OPENAI_API_KEY.',
				);
			}
			if (code === 'too_many_docs') {
				throw new Error(msg + ' Remove a doc above first.');
			}
			throw new Error(msg);
		}
		return data.doc;
	}

	function setBusy(b, msg) {
		busy = b;
		root.classList.toggle('kp-busy', b);
		disable(b || !getCanEdit?.());
		if (msg !== undefined) setStatus(msg);
	}
}

async function extractPdf(file) {
	const pdfjs = await loadPdfjs();
	const buf = await file.arrayBuffer();
	const pdf = await pdfjs.getDocument({ data: buf, useWorkerFetch: true }).promise;
	const pages = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const tc = await page.getTextContent();
		const line = tc.items.map((it) => it.str || '').join(' ');
		pages.push(line);
	}
	return pages.join('\n\n');
}

function template() {
	return `
		<header class="kp-head">
			<h3>Knowledge</h3>
			<p class="kp-sub">Ground the agent in your docs. PDFs, URLs, or pasted text — chunks are embedded and surfaced when a visitor asks a relevant question.</p>
		</header>

		<div class="kp-list-wrap">
			<div class="kp-list" data-list></div>
			<div class="kp-empty" data-empty>No knowledge attached yet.</div>
		</div>

		<div class="kp-drop" data-drop>
			<div class="kp-drop-inner">
				<strong>Drop a file</strong> or
				<label class="kp-drop-link">
					<input type="file" data-file accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf" hidden />
					<span>choose one</span>
				</label>
				<div class="kp-drop-hint">.txt · .md · .pdf (up to 12 MB)</div>
			</div>
		</div>

		<details class="kp-section">
			<summary>Add a URL</summary>
			<div class="kp-row-form">
				<input type="url" data-url placeholder="https://docs.example.com/getting-started" />
				<button type="button" class="btn-ghost btn-sm" data-url-btn>Fetch & add</button>
			</div>
		</details>

		<details class="kp-section">
			<summary>Paste text</summary>
			<div class="kp-paste-form">
				<textarea data-text rows="4" placeholder="Paste pricing notes, product docs, FAQs…"></textarea>
				<button type="button" class="btn-ghost btn-sm" data-text-btn>Add as knowledge</button>
			</div>
		</details>

		<div class="kp-status" data-status></div>
		<div class="kp-preview" data-preview hidden></div>
	`;
}

function formatNum(n) {
	const v = Number(n) || 0;
	if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
	return String(v);
}

function formatBytes(n) {
	const v = Number(n) || 0;
	if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
	if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
	return `${v} B`;
}

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function linkify(url) {
	const safe = escapeHtml(url);
	return `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
}
