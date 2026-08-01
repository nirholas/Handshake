// /walkthroughs: the index of interactive walkthroughs.
//
// Reads the same generated manifest the player reads, so a walkthrough that
// captured cleanly appears here and one that did not cannot. Cards carry the
// real first frame of each walkthrough as their cover, which means the index
// is also the fastest visual check that the media is current.

const MANIFEST_URL = '/walkthroughs/manifest.json';

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function cardHtml(w) {
	const cover = w.cover || (w.steps[0] && w.steps[0].shot);
	return `
	<li class="wt-card" style="--wt-card-accent:${esc(w.accent)}">
		<div class="wt-card-shot">
			${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async" width="1440" height="900" />` : ''}
			<span class="wt-card-steps">${w.steps.length} steps</span>
		</div>
		<div class="wt-card-body">
			<h2 class="wt-card-title"><a href="/walkthroughs/${esc(w.slug)}">${esc(w.title)}</a></h2>
			<p class="wt-card-outcome">${esc(w.outcome)}</p>
			<p class="wt-card-blurb">${esc(w.blurb)}</p>
			<ul class="wt-card-meta">
				<li class="wt-chip wt-chip-level" style="--wt-accent:${esc(w.accent)}">${esc(w.level)}</li>
				<li class="wt-chip">${w.minutes} min</li>
			</ul>
		</div>
	</li>`;
}

function renderMessage(root, heading, detail, retry) {
	root.innerHTML = `
	<div class="wt-msg">
		<h1>${esc(heading)}</h1>
		<p>${esc(detail)}</p>
		<div class="wt-msg-actions">
			<a class="wt-msg-btn" href="/tutorials">Read the tutorials</a>
			${retry ? '<button type="button" class="wt-msg-btn wt-msg-btn-ghost" id="wt-idx-retry">Try again</button>' : ''}
		</div>
	</div>`;
	const btn = root.querySelector('#wt-idx-retry');
	if (btn) btn.addEventListener('click', boot);
}

async function boot() {
	const root = document.getElementById('wt-index');
	if (!root) return;

	root.innerHTML = `
	<ul class="wt-idx-grid" aria-hidden="true">
		${'<li class="wt-card"><div class="wt-card-shot wt-sk-stage"></div><div class="wt-card-body"><div class="wt-sk-line wt-sk-line-lg"></div><div class="wt-sk-line wt-sk-line-sm"></div></div></li>'.repeat(4)}
	</ul>
	<p class="wt-sr" role="status" aria-live="polite">Loading walkthroughs</p>`;

	let manifest;
	try {
		const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
		if (!res.ok) throw new Error(`manifest ${res.status}`);
		manifest = await res.json();
	} catch (err) {
		renderMessage(root, 'Could not load the walkthroughs', `The walkthrough index did not load (${err.message}). The written tutorials cover the same ground.`, true);
		return;
	}

	const list = manifest.walkthroughs || [];
	if (!list.length) {
		renderMessage(root, 'No walkthroughs published yet', 'Nothing has been captured into the walkthrough library. The written tutorials cover the same ground in the meantime.', false);
		return;
	}

	const captured = manifest.generatedAt ? new Date(manifest.generatedAt) : null;
	root.innerHTML = `
	<ul class="wt-idx-grid">${list.map(cardHtml).join('')}</ul>
	<p class="wt-idx-note">
		<strong>These frames are the real product.</strong>
		Every picture here was captured by a browser driving <a href="https://three.ws">three.ws</a> itself, and each step is pinned to a live element rather than a hand-drawn box, so a walkthrough breaks loudly when the interface moves instead of quietly going out of date.
		${captured ? `Last captured ${esc(captured.toISOString().slice(0, 10))}.` : ''}
	</p>`;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
