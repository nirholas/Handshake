// Multi-provider voice browser for the Voice Lab.
//
// Reads /api/tts/catalog (every lane the deployment can serve, in one shape)
// plus /api/tts/eleven/library (the public ElevenLabs Voice Library, which is
// paged upstream and therefore fetched on demand rather than merged into the
// catalog). Previews play through /api/tts/synthesize, so what you hear in the
// browser is exactly what the playground and an agent will render.

import { withElevenKey } from './eleven-key.js';

const PREVIEW_LINE = "Hey, I'm your agent. This is how I sound.";

const BILLING_COPY = {
	free: { label: 'Free', title: 'No vendor cost. Never charged.' },
	gcp: { label: 'Free', title: 'Runs on the platform Google Cloud credits. Never charged.' },
	credits: { label: 'Credits', title: 'Metered to your prepaid credit balance, per 1k characters.' },
};

// One <audio> for the whole browser: starting a preview always stops the one
// already playing, so a fast clicker never stacks overlapping voices.
const previewAudio = new Audio();
let previewToken = 0;

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
	let t = 0;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

/** Human tags for a card, deduped and capped so a card never overflows. */
function voiceTags(v) {
	const raw = [
		v.gender,
		v.accent,
		v.age,
		v.locale,
		v.labels?.description,
		v.labels?.use_case,
		v.labels?.descriptive,
		v.labels?.persona,
		...(v.labels?.personalities || []),
		...(v.labels?.categories || []),
	];
	const seen = new Set();
	const out = [];
	for (const tag of raw) {
		const t = String(tag || '').trim();
		if (!t) continue;
		const key = t.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
		if (out.length === 4) break;
	}
	return out;
}

export function mountVoiceBrowser({ root, onSelect, onCatalog }) {
	const els = {
		pills: root.querySelector('#vbProviders'),
		search: root.querySelector('#vbSearch'),
		language: root.querySelector('#vbLanguage'),
		grid: root.querySelector('#vbGrid'),
		status: root.querySelector('#vbStatus'),
		more: root.querySelector('#vbMore'),
	};

	let providers = [];
	let allVoices = [];
	let filtered = [];
	let shown = 0;
	let activeProvider = 'all';
	let selectedKey = null;
	let libraryPage = 0;
	let libraryHasMore = false;
	let reqToken = 0;

	const PAGE = 60;

	function setStatus(text, tone = 'info') {
		els.status.textContent = text;
		els.status.dataset.tone = tone;
	}

	function providerById(id) {
		return providers.find((p) => p.id === id) || null;
	}

	function keyOf(v) {
		return `${v.provider}:${v.id}`;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	function renderPills() {
		const total = allVoices.length;
		const buttons = [
			`<button class="vb-pill${activeProvider === 'all' ? ' active' : ''}" data-provider="all" aria-pressed="${activeProvider === 'all'}">All voices</button>`,
			...providers.map((p) => {
				const disabled = !p.available && p.id !== 'elevenlabs-library';
				return (
					`<button class="vb-pill${activeProvider === p.id ? ' active' : ''}${disabled ? ' disabled' : ''}"` +
					` data-provider="${esc(p.id)}" aria-pressed="${activeProvider === p.id}"` +
					`${disabled ? ` title="${esc(p.reason || 'Unavailable')}"` : ` title="${esc(p.tagline)}"`}>` +
					`${esc(p.label)}` +
					`<span class="vb-pill-billing" data-billing="${esc(p.billing)}">${esc(BILLING_COPY[p.billing]?.label || '')}</span>` +
					`</button>`
				);
			}),
		];
		els.pills.innerHTML = buttons.join('');
		els.pills.setAttribute('aria-label', `${total} voices across ${providers.length} providers`);
	}

	function renderCards(reset = true) {
		if (reset) shown = 0;
		const next = filtered.slice(0, shown + PAGE);
		shown = next.length;

		if (!next.length) {
			const p = providerById(activeProvider);
			els.grid.innerHTML =
				`<div class="vl-empty">` +
				`<div class="vl-empty-title">${p && !p.available ? esc(p.label) + ' is unavailable' : 'No voices match'}</div>` +
				esc(
					p && !p.available
						? p.reason || 'This lane is not configured on this server.'
						: 'Clear the search or pick a different provider. The free Edge lane alone has around 500 voices.',
				) +
				`</div>`;
			els.more.hidden = true;
			return;
		}

		els.grid.innerHTML = next.map(cardHtml).join('');
		els.more.hidden = shown >= filtered.length && !libraryHasMore;
		els.more.textContent = libraryHasMore && shown >= filtered.length
			? 'Load more from the ElevenLabs library'
			: `Show more (${filtered.length - shown} left)`;
	}

	function cardHtml(v) {
		const key = keyOf(v);
		const p = providerById(v.shared ? 'elevenlabs-library' : v.provider);
		const tags = voiceTags(v);
		const billing = BILLING_COPY[p?.billing || 'free'];
		return `
			<article class="vb-card${selectedKey === key ? ' selected' : ''}" data-key="${esc(key)}">
				<div class="vb-card-top">
					<h3 class="vb-card-name">${esc(v.name)}</h3>
					<span class="vb-badge" data-provider="${esc(v.provider)}" title="${esc(billing?.title || '')}">${esc(p?.label || v.provider)}</span>
				</div>
				${tags.length ? `<div class="vb-tags">${tags.map((t) => `<span class="vb-tag">${esc(t)}</span>`).join('')}</div>` : ''}
				${v.description ? `<p class="vb-card-desc">${esc(v.description)}</p>` : ''}
				<div class="vb-card-actions">
					<button class="vl-btn vl-btn-ghost vl-btn-sm" data-act="preview" data-key="${esc(key)}">Preview</button>
					${
						v.shared
							? `<button class="vl-btn vl-btn-primary vl-btn-sm" data-act="add" data-key="${esc(key)}">Add to my voices</button>`
							: `<button class="vl-btn vl-btn-primary vl-btn-sm" data-act="use" data-key="${esc(key)}">Use this voice</button>`
					}
				</div>
			</article>`;
	}

	// ── Filtering ─────────────────────────────────────────────────────────────

	// Sorted by relevance to THIS visitor, not by locale code. Unranked, a
	// ~500-voice Edge catalog opens on af-ZA and sq-AL, which reads like a
	// database dump. Voices that speak the visitor's own language come first,
	// then English, then everything else; multi-language lanes (Gemini, OpenAI,
	// NVIDIA) count as speaking it. Ties break on provider order, then name.
	const PROVIDER_ORDER = new Map(
		['gemini', 'edge', 'nvidia', 'openai', 'elevenlabs'].map((id, i) => [id, i]),
	);
	const uiLocale = String(
		(typeof navigator !== 'undefined' && navigator.language) || 'en-US',
	).toLowerCase();
	const uiPrimary = uiLocale.split('-')[0];

	function localeRank(v) {
		const locale = String(v.locale || '').toLowerCase();
		if (!locale) return String(v.language || '') === 'multi' ? 0 : 3;
		if (locale === uiLocale) return 0;
		if (locale.split('-')[0] === uiPrimary) return 1;
		return locale.startsWith('en') ? 2 : 3;
	}

	/**
	 * Order a filtered list for display. Within a relevance rank the providers
	 * are round-robined rather than grouped, so the first screen is a mix (a
	 * Gemini voice, an Edge voice, an NVIDIA voice) instead of 30 Gemini cards
	 * with the visitor's own locale buried on page two.
	 */
	function rankForDisplay(list) {
		const seen = new Map(); // "<rank>:<provider>" -> how many placed so far
		return list
			.map((v) => {
				const rank = localeRank(v);
				const key = `${rank}:${v.provider}`;
				const slot = seen.get(key) || 0;
				seen.set(key, slot + 1);
				return { v, rank, slot, order: PROVIDER_ORDER.get(v.provider) ?? 9 };
			})
			.sort(
				(a, b) =>
					a.rank - b.rank ||
					a.slot - b.slot ||
					a.order - b.order ||
					String(a.v.name).localeCompare(String(b.v.name)),
			)
			.map((e) => e.v);
	}

	function applyFilter() {
		const q = els.search.value.trim().toLowerCase();
		const lang = els.language.value;
		filtered = allVoices.filter((v) => {
			if (activeProvider !== 'all') {
				const owner = v.shared ? 'elevenlabs-library' : v.provider;
				if (owner !== activeProvider) return false;
			}
			if (lang) {
				const l = String(v.locale || v.language || '').toLowerCase();
				if (l !== 'multi' && !l.startsWith(lang)) return false;
			}
			if (q) {
				const hay = [v.name, v.id, v.locale, v.description, ...voiceTags(v)]
					.filter(Boolean)
					.join(' ')
					.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
		// The shared library arrives in ElevenLabs' own relevance order; re-sorting
		// it would throw away the ranking the search just produced.
		if (activeProvider !== 'elevenlabs-library') filtered = rankForDisplay(filtered);
		renderCards(true);
		setStatus(
			`${filtered.length} voice${filtered.length === 1 ? '' : 's'}` +
				(activeProvider === 'all' ? ` across ${providers.filter((p) => p.available).length} providers` : ''),
		);
	}

	// ── Loading ───────────────────────────────────────────────────────────────

	async function loadCatalog() {
		const token = ++reqToken;
		setStatus('Loading voices…');
		els.grid.innerHTML = Array.from({ length: 6 })
			.map(() => '<div class="vb-card vb-skeleton" aria-hidden="true"></div>')
			.join('');
		els.more.hidden = true;

		let data;
		try {
			const r = await fetch('/api/tts/catalog?limit=2000', {
				credentials: 'include',
				headers: withElevenKey({}),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			data = await r.json();
		} catch (err) {
			if (token !== reqToken) return;
			els.grid.innerHTML =
				'<div class="vl-empty"><div class="vl-empty-title">Could not load the voice catalog</div>' +
				`${esc(err.message)}. Check your connection and retry.</div>`;
			setStatus('Catalog unavailable', 'err');
			return;
		}
		if (token !== reqToken) return;

		// The shared ElevenLabs library is a distinct browsing mode, not a lane:
		// its voices must be added to an account before they can be synthesized.
		const elevenlabs = data.providers.find((p) => p.id === 'elevenlabs');
		providers = [
			...data.providers,
			{
				id: 'elevenlabs-library',
				label: 'ElevenLabs Library',
				tagline: 'Thousands of community voices, add one to your account to use it',
				billing: 'credits',
				available: Boolean(elevenlabs?.available),
				reason: elevenlabs?.reason || null,
				shared: true,
			},
		];
		allVoices = data.voices;

		renderPills();
		populateLanguages();
		applyFilter();
		onCatalog?.(providers);
	}

	function populateLanguages() {
		const seen = new Map();
		for (const v of allVoices) {
			const loc = String(v.locale || '');
			if (!loc) continue;
			const primary = loc.split('-')[0];
			if (!seen.has(primary)) seen.set(primary, loc);
		}
		const names =
			typeof Intl !== 'undefined' && Intl.DisplayNames
				? new Intl.DisplayNames(['en'], { type: 'language' })
				: null;
		const options = [...seen.keys()]
			.map((code) => ({ code, label: names?.of(code) || code }))
			.sort((a, b) => a.label.localeCompare(b.label));
		const prev = els.language.value;
		els.language.innerHTML =
			'<option value="">All languages</option>' +
			options.map((o) => `<option value="${esc(o.code)}">${esc(o.label)}</option>`).join('');
		if (prev) els.language.value = prev;
	}

	async function loadLibraryPage({ reset = false } = {}) {
		if (reset) {
			libraryPage = 0;
			allVoices = allVoices.filter((v) => !v.shared);
		}
		const token = ++reqToken;
		setStatus('Searching the ElevenLabs library…');

		const params = new URLSearchParams({ page: String(libraryPage), page_size: '48' });
		const q = els.search.value.trim();
		if (q) params.set('q', q);
		if (els.language.value) params.set('language', els.language.value);

		let data;
		try {
			const r = await fetch(`/api/tts/eleven/library?${params}`, {
				credentials: 'include',
				headers: withElevenKey({}),
			});
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				throw new Error(body.error_description || body.message || `HTTP ${r.status}`);
			}
			data = await r.json();
		} catch (err) {
			if (token !== reqToken) return;
			setStatus(`Library unavailable: ${err.message}`, 'err');
			els.grid.innerHTML =
				'<div class="vl-empty"><div class="vl-empty-title">The ElevenLabs library needs a key</div>' +
				'Save your own ElevenLabs API key below, or sign in on a deployment where the platform key is set.</div>';
			els.more.hidden = true;
			return;
		}
		if (token !== reqToken) return;

		libraryHasMore = data.has_more;
		libraryPage += 1;
		allVoices = allVoices.concat(data.voices);
		applyFilter();
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	function findVoice(key) {
		return allVoices.find((v) => keyOf(v) === key) || null;
	}

	async function preview(key, btn) {
		const v = findVoice(key);
		if (!v) return;
		const token = ++previewToken;

		previewAudio.pause();
		previewAudio.currentTime = 0;

		// A shared-library voice ships a real preview clip; playing it costs
		// nothing and needs no account, so never synthesize one.
		if (v.preview_url) {
			previewAudio.src = v.preview_url;
			previewAudio.play().catch(() => setStatus('Autoplay was blocked, press Preview again.', 'warn'));
			return;
		}

		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = 'Loading…';
		try {
			const r = await fetch('/api/tts/synthesize', {
				method: 'POST',
				credentials: 'include',
				headers: withElevenKey({ 'content-type': 'application/json' }),
				body: JSON.stringify({ provider: v.provider, voiceId: v.id, text: PREVIEW_LINE }),
			});
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				throw new Error(body.error_description || body.message || `HTTP ${r.status}`);
			}
			if (token !== previewToken) return;
			const blob = await r.blob();
			if (previewAudio.src.startsWith('blob:')) URL.revokeObjectURL(previewAudio.src);
			previewAudio.src = URL.createObjectURL(blob);
			await previewAudio.play().catch(() => {});
			const billing = r.headers.get('x-tts-billing');
			setStatus(billing === 'credits' ? 'Preview rendered, charged to credits.' : 'Preview rendered.');
		} catch (err) {
			setStatus(`Preview failed: ${err.message}`, 'err');
		} finally {
			btn.disabled = false;
			btn.textContent = original;
		}
	}

	async function addSharedVoice(key, btn) {
		const v = findVoice(key);
		if (!v) return;
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = 'Adding…';
		try {
			const r = await fetch('/api/tts/eleven/library', {
				method: 'POST',
				credentials: 'include',
				headers: withElevenKey({ 'content-type': 'application/json' }),
				body: JSON.stringify({ publicUserId: v.publicUserId, voiceId: v.id, name: v.name }),
			});
			const body = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(body.error_description || body.message || `HTTP ${r.status}`);
			setStatus(`"${v.name}" added to your ElevenLabs voices.`, 'ok');
			btn.textContent = 'Added';
			onSelect?.({ ...v, id: body.voiceId, provider: 'elevenlabs', shared: false });
		} catch (err) {
			setStatus(`Could not add the voice: ${err.message}`, 'err');
			btn.disabled = false;
			btn.textContent = original;
		}
	}

	function select(key) {
		const v = findVoice(key);
		if (!v) return;
		selectedKey = key;
		root.querySelectorAll('.vb-card').forEach((c) => {
			c.classList.toggle('selected', c.dataset.key === key);
		});
		onSelect?.(v);
	}

	// ── Wiring ────────────────────────────────────────────────────────────────

	els.pills.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-provider]');
		if (!btn || btn.classList.contains('disabled')) return;
		activeProvider = btn.dataset.provider;
		renderPills();
		if (activeProvider === 'elevenlabs-library') loadLibraryPage({ reset: true });
		else applyFilter();
	});

	const onSearch = debounce(() => {
		if (activeProvider === 'elevenlabs-library') loadLibraryPage({ reset: true });
		else applyFilter();
	}, 250);
	els.search.addEventListener('input', onSearch);
	els.language.addEventListener('change', onSearch);

	els.more.addEventListener('click', () => {
		if (shown >= filtered.length && libraryHasMore) loadLibraryPage();
		else renderCards(false);
	});

	els.grid.addEventListener('click', (e) => {
		const actionBtn = e.target.closest('[data-act]');
		if (actionBtn) {
			const { act, key } = actionBtn.dataset;
			if (act === 'preview') preview(key, actionBtn);
			else if (act === 'add') addSharedVoice(key, actionBtn);
			else if (act === 'use') select(key);
			return;
		}
		const card = e.target.closest('.vb-card');
		if (card && !card.classList.contains('vb-skeleton')) select(card.dataset.key);
	});

	loadCatalog();

	return { reload: loadCatalog, getProviders: () => providers };
}
