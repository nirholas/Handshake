// /m/<id>: the model detail page. One forged 3D model as a first-class page,
// in the shape of the classic model-platform detail layout: viewer hero, title,
// creator card with follow, real geometry stats, description, attribute chips,
// likes, comments, and a suggested-models rail.
//
// Real endpoints only:
//   GET  /api/forge-creation?id=&related=6&view=1  (model + suggested, counts a view)
//   GET  /api/3d/inspect?url=<glb>                 (live triangle/vertex stats)
//   POST /api/forge-vote                           (anonymous like, x-forge-client)
//   GET/POST/DELETE /api/forge-comments            (comment thread)
//   GET  /api/auth/me                              (composer + follow gating)
//   GET/POST/DELETE /api/users/:username/follow    (follow graph)
//   POST /api/x402/remix-asset                     (paid remix, via ensureX402)

import { apiFetch } from './api.js';
import { ensureX402 } from './shared/x402-loader.js';
import { createLogger } from './shared/log.js';
import {
	modelIdFromPath,
	titleFromPrompt,
	formatCount,
	formatBytes,
	timeAgo,
	embedSnippet,
	chipsFor,
} from './model-lib.js';

const log = createLogger('model-page');
const $ = (id) => document.getElementById(id);

const state = {
	id: null,
	creation: null,
	related: [],
	viewer: null, // { id, username, display_name, avatar_url } or null
	comments: [],
	commentsTotal: 0,
	commentsNext: null,
	edition: null, // { limit, issued, remaining, soldOut } from /api/print/editions
};

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// The same browser-local id /forge and the showcase use (forge:cid), so this
// page's like button shares vote state with every other forge surface.
let _clientId = null;
function clientId() {
	if (_clientId) return _clientId;
	try {
		const k = 'forge:cid';
		let v = localStorage.getItem(k);
		if (!v) {
			v = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(k, v);
		}
		_clientId = v;
	} catch {
		_clientId = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	}
	return _clientId;
}

let toastTimer = null;
function toast(msg) {
	const el = $('mp-toast');
	if (!el) return;
	el.textContent = msg;
	el.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove('is-on'), 2400);
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
	const shell = $('mp-shell');
	state.id = modelIdFromPath(location.pathname);
	if (!state.id) return renderMissing('That link does not point at a model.');

	renderInfoSkeleton();

	const [creationRes, me] = await Promise.all([
		fetch(`/api/forge-creation?id=${encodeURIComponent(state.id)}&related=6&view=1`, {
			headers: { 'x-forge-client': clientId() },
		})
			.then((r) => (r.ok ? r.json() : r.status === 404 ? { creation: null } : Promise.reject(new Error(`HTTP ${r.status}`))))
			.catch((err) => ({ error: err })),
		apiFetch('/api/auth/me', { allowAnonymous: true })
			.then((r) => (r.ok ? r.json() : { user: null }))
			.then((j) => j?.user || null)
			.catch(() => null),
	]);

	state.viewer = me;

	if (creationRes?.error) {
		log.error('load failed', creationRes.error);
		return renderError();
	}
	if (!creationRes?.creation) return renderMissing('This model does not exist, or has not finished generating.');

	state.creation = creationRes.creation;
	state.related = Array.isArray(creationRes.related) ? creationRes.related : [];

	patchMeta();
	renderViewer();
	renderInfo();
	renderSuggested();
	loadGeometry();
	loadSimReadiness();
	loadComments();
	loadEdition();
	if (shell) shell.setAttribute('aria-busy', 'false');
}

// Client-side title/OG patch; the OG image is the server-rendered PNG of the
// actual model (api/forge-og.js).
function patchMeta() {
	const c = state.creation;
	const title = `${titleFromPrompt(c.prompt)} · 3D Model · three.ws`;
	document.title = title;
	const set = (sel, value) => document.querySelector(sel)?.setAttribute('content', value);
	set('meta[property="og:title"]', title);
	set('meta[name="twitter:title"]', title);
	set('meta[property="og:url"]', `https://three.ws/m/${c.id}`);
	set('meta[property="og:image"]', `https://three.ws/api/forge/${c.id}/og`);
	set('meta[name="twitter:image"]', `https://three.ws/api/forge/${c.id}/og`);
	const canonical = document.querySelector('link[rel="canonical"]');
	if (canonical) canonical.setAttribute('href', `https://three.ws/m/${c.id}`);
}

// ── viewer hero ──────────────────────────────────────────────────────────────

// The mesh the VIEWER should download, which is not the mesh the user downloads.
// `web_glb_url` is the delivery variant written by api/_lib/forge-store.js
// (meshopt geometry + WebP textures, 80-94% smaller on real production output);
// `glb_url` stays the full-resolution original and is what every download link
// and every third-party API consumer gets. Null variant means "there is only the
// original", which is the honest state for a creation made before this landed or
// one already small enough that a second object would not pay for itself.
export function viewerSrc(creation) {
	return creation?.web_glb_url || creation?.glb_url || '';
}

function renderViewer() {
	const host = $('mp-viewer');
	const c = state.creation;
	if (!host) return;
	const poster = c.preview_image_url ? ` poster="${esc(c.preview_image_url)}"` : '';
	host.innerHTML = `
		<model-viewer src="${esc(viewerSrc(c))}"${poster}
			alt="${esc(titleFromPrompt(c.prompt))}"
			camera-controls auto-rotate auto-rotate-delay="1500" rotation-per-second="18deg"
			interaction-prompt="when-focused" shadow-intensity="0.5" exposure="0.95"
			environment-image="neutral" ar ar-modes="webxr scene-viewer quick-look"></model-viewer>
		<div class="mp-viewer-actions">
			<a class="mp-viewer-btn" href="/api/ar?src=${encodeURIComponent(c.glb_url)}" target="_blank" rel="noopener">View in AR</a>
			<a class="mp-viewer-btn" href="/viewer?src=${encodeURIComponent(c.glb_url)}&title=${encodeURIComponent(titleFromPrompt(c.prompt))}" target="_blank" rel="noopener">Open viewer</a>
			<button class="mp-viewer-btn" id="mp-fullscreen" type="button" aria-label="Fullscreen">⛶ Fullscreen</button>
		</div>`;
	$('mp-fullscreen')?.addEventListener('click', () => {
		const mv = host.querySelector('model-viewer');
		if (!document.fullscreenElement) (mv || host).requestFullscreen?.().catch(() => {});
		else document.exitFullscreen?.();
	});
	// Decoder fallback. The delivery variant needs EXT_meshopt_compression and
	// EXT_texture_webp; both are supported everywhere model-viewer 4 runs, but a
	// browser with WASM disabled, a blocked decoder script, or a corrupt object
	// would otherwise leave the visitor staring at a poster forever. One retry
	// against the untouched original turns that into a slower load instead of a
	// dead page, and it can only fire once (the flag is on the element).
	const mv = host.querySelector('model-viewer');
	if (mv && c.web_glb_url && c.glb_url && c.web_glb_url !== c.glb_url) {
		mv.addEventListener('error', () => {
			if (mv.dataset.fellBack) return;
			mv.dataset.fellBack = '1';
			log.warn('delivery variant failed to decode, falling back to the original mesh');
			mv.setAttribute('src', c.glb_url);
		});
	}
}

// ── info column ──────────────────────────────────────────────────────────────

function renderInfoSkeleton() {
	const host = $('mp-info');
	if (!host) return;
	host.innerHTML = `
		<div class="mp-skeleton mp-skeleton--title"></div>
		<div class="mp-skeleton mp-skeleton--line" style="width:40%"></div>
		<div class="mp-skeleton mp-skeleton--line" style="width:85%"></div>
		<div class="mp-skeleton mp-skeleton--line" style="width:70%"></div>`;
	const sugg = $('mp-suggested');
	if (sugg) sugg.innerHTML = Array.from({ length: 4 }).map(() => '<div class="mp-skeleton mp-skeleton--card"></div>').join('');
}

function creatorBlock() {
	const c = state.creation;
	if (!c.creatorUsername) {
		return `
			<div class="mp-creator">
				<div class="mp-creator-avatar" aria-hidden="true">◆</div>
				<div>
					<div class="mp-creator-name">Anonymous forger</div>
					<div class="mp-creator-sub">forged without an account</div>
				</div>
			</div>`;
	}
	const avatar = c.creatorAvatarUrl
		? `<img class="mp-creator-avatar" src="${esc(c.creatorAvatarUrl)}" alt="" loading="lazy" />`
		: `<div class="mp-creator-avatar" aria-hidden="true">${esc((c.creatorDisplayName || c.creatorUsername).charAt(0).toUpperCase())}</div>`;
	const isSelf = state.viewer?.username && state.viewer.username === c.creatorUsername;
	const followBtn = !isSelf
		? `<button class="mp-follow" id="mp-follow" type="button" data-following="false" hidden>Follow</button>`
		: '';
	return `
		<div class="mp-creator">
			${avatar}
			<div>
				<a class="mp-creator-name" href="/u/${esc(c.creatorUsername)}">${esc(c.creatorDisplayName || c.creatorUsername)}</a>
				<div class="mp-creator-sub">@${esc(c.creatorUsername)}</div>
			</div>
			${followBtn}
		</div>`;
}

function renderInfo() {
	const host = $('mp-info');
	const c = state.creation;
	if (!host) return;

	const chips = chipsFor(c)
		.map((chip) =>
			chip.kind === 'category'
				? `<a class="mp-chip" href="/creations?category=${encodeURIComponent(chip.label)}">${esc(chip.label)}</a>`
				: `<span class="mp-chip">${esc(chip.label)}</span>`,
		)
		.join('');

	const publishedAbs = new Date(c.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	const likeCount = Number(c.vote_count) || 0;

	host.innerHTML = `
		<h1 class="mp-title">${esc(titleFromPrompt(c.prompt))}</h1>
		<p class="mp-kicker">3D Model</p>
		${creatorBlock()}
		<div class="mp-actionbar">
			<button class="mp-action${c.voted ? ' is-liked' : ''}" id="mp-like" type="button" aria-pressed="${c.voted ? 'true' : 'false'}">
				♥ <span id="mp-like-count">${formatCount(likeCount)}</span>
			</button>
			<span class="mp-stat" title="Page views">👁 <b id="mp-views">${formatCount(c.view_count)}</b></span>
			${c.remix_count ? `<span class="mp-stat" title="Remixes">⑂ <b>${formatCount(c.remix_count)}</b></span>` : ''}
			<a class="mp-action" href="${esc(c.glb_url)}" download>Download GLB</a>
			<a class="mp-action" href="/materialize?creation=${encodeURIComponent(c.id)}" title="Order this model as a real physical print, shipped to you">⬢ Materialize</a>
			<button class="mp-action" id="mp-embed" type="button">&lt;/&gt; Embed</button>
			<button class="mp-action" id="mp-share" type="button">↗ Share</button>
			${c.remixable ? `<button class="mp-action" id="mp-remix" type="button">Remix · $0.25</button>` : ''}
		</div>
		<div class="mp-geo" id="mp-geo"><span>Reading geometry…</span></div>
		<div class="mp-sim" id="mp-sim"></div>
		<p class="mp-desc">${esc(c.prompt)}</p>
		<div class="mp-published" title="${esc(publishedAbs)}">🕒 Published ${esc(timeAgo(c.created_at))}</div>
		${chips ? `<div class="mp-chips">${chips}</div>` : ''}
		<div class="mp-liked-line" id="mp-liked-line">${likeCount ? `${formatCount(likeCount)} ${likeCount === 1 ? 'person likes' : 'people like'} this model` : ''}</div>
		<section class="mp-edition" id="mp-edition" hidden aria-label="Physical editions"></section>`;

	wireActions();
	wireFollow();
	renderEdition();
}

// ── physical editions ────────────────────────────────────────────────────────
//
// Materialize turns a model into an object, and an object is a collectible only
// if its supply is knowable. The creator sets one number here; every print of
// this model then claims the next edition out of it, and each shipped print's
// certificate (/cert/:id) renders "3 of 25" forever.
//
// The block stays hidden for the common case: an open edition nobody has
// printed yet, viewed by someone who cannot change it. It appears the moment
// there is something true to say.

function viewerIsCreator() {
	const c = state.creation;
	return Boolean(state.viewer?.username && c?.creatorUsername && state.viewer.username === c.creatorUsername);
}

async function loadEdition() {
	const c = state.creation;
	if (!c) return;
	try {
		const res = await fetch(`/api/print/editions?creation_id=${encodeURIComponent(c.id)}`);
		if (!res.ok) return;
		const body = await res.json();
		if (!body?.edition) return;
		state.edition = body.edition;
		renderEdition();
	} catch (err) {
		// A model page is not worth breaking over a scarcity badge.
		log.error('edition load failed', err);
	}
}

function editionSummary(e) {
	if (!e) return '';
	if (e.limit === null) {
		return e.issued
			? `Open edition · ${formatCount(e.issued)} printed`
			: 'Open edition · none printed yet';
	}
	if (e.soldOut) return `Limited edition of ${formatCount(e.limit)} · sold out`;
	return `Limited edition of ${formatCount(e.limit)} · ${formatCount(e.issued)} printed, ${formatCount(e.remaining)} left`;
}

function renderEdition() {
	const host = $('mp-edition');
	const e = state.edition;
	if (!host) return;
	const owner = viewerIsCreator();
	if (!e || (!owner && e.limit === null && !e.issued)) {
		host.hidden = true;
		return;
	}
	host.hidden = false;
	host.innerHTML = `
		<h2 class="mp-edition-title">Physical editions</h2>
		<p class="mp-edition-line" id="mp-edition-line">${esc(editionSummary(e))}</p>
		${
			owner
				? `<form class="mp-edition-form" id="mp-edition-form">
						<label class="mp-edition-label" for="mp-edition-input">Cap this edition</label>
						<input class="mp-edition-input" id="mp-edition-input" type="number" inputmode="numeric"
							min="${e.issued > 0 ? e.issued : 1}" max="10000" step="1"
							placeholder="Open" value="${e.limit === null ? '' : esc(String(e.limit))}"
							aria-describedby="mp-edition-help" />
						<button class="mp-action" type="submit" id="mp-edition-save">Save</button>
						<p class="mp-edition-help" id="mp-edition-help">
							Leave it empty for an open edition. Once set, orders past the cap are refused at
							the price, and every certificate reads "n of ${e.limit === null ? 'N' : esc(String(e.limit))}".
						</p>
					</form>`
				: '<p class="mp-edition-help">Set by the creator. Every print carries a numbered certificate of authenticity.</p>'
		}`;
	if (owner) wireEditionForm();
}

function wireEditionForm() {
	const form = $('mp-edition-form');
	form?.addEventListener('submit', async (event) => {
		event.preventDefault();
		const input = $('mp-edition-input');
		const save = $('mp-edition-save');
		const raw = String(input?.value ?? '').trim();
		if (save) {
			save.disabled = true;
			save.textContent = 'Saving…';
		}
		try {
			const res = await apiFetch('/api/print/editions', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forge-client': clientId() },
				body: JSON.stringify({ creation_id: state.creation.id, edition_of: raw === '' ? null : Number(raw) }),
			});
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.edition) throw new Error(body?.error || `HTTP ${res.status}`);
			state.edition = body.edition;
			renderEdition();
			toast(body.edition.limit === null ? 'This model is an open edition' : `Capped at ${body.edition.limit} prints`);
		} catch (err) {
			log.error('edition save failed', err);
			toast(String(err?.message || 'Could not save the edition size'));
			if (save) {
				save.disabled = false;
				save.textContent = 'Save';
			}
		}
	});
}

function wireActions() {
	const c = state.creation;

	$('mp-like')?.addEventListener('click', async () => {
		const btn = $('mp-like');
		const wasLiked = btn.classList.contains('is-liked');
		try {
			const res = await fetch('/api/forge-vote', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forge-client': clientId() },
				body: JSON.stringify({ creation_id: c.id, vote: !wasLiked }),
			});
			const data = await res.json();
			if (!res.ok || data?.ok === false) throw new Error(data?.message || 'vote failed');
			btn.classList.toggle('is-liked', Boolean(data.voted));
			btn.setAttribute('aria-pressed', data.voted ? 'true' : 'false');
			const n = Number(data.vote_count) || 0;
			const countEl = $('mp-like-count');
			if (countEl) countEl.textContent = formatCount(n);
			const line = $('mp-liked-line');
			if (line) line.textContent = n ? `${formatCount(n)} ${n === 1 ? 'person likes' : 'people like'} this model` : '';
		} catch (err) {
			log.error('vote failed', err);
			toast('Could not save your like. Try again.');
		}
	});

	$('mp-embed')?.addEventListener('click', async () => {
		const snippet = embedSnippet(c.glb_url, titleFromPrompt(c.prompt));
		try {
			await navigator.clipboard.writeText(snippet);
			toast('Embed code copied to clipboard');
		} catch {
			window.prompt('Copy this embed code:', snippet);
		}
	});

	$('mp-share')?.addEventListener('click', async () => {
		const url = `https://three.ws/m/${c.id}`;
		const title = titleFromPrompt(c.prompt);
		if (navigator.share) {
			navigator.share({ title, url }).catch(() => {});
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
			toast('Link copied to clipboard');
		} catch {
			window.prompt('Copy this link:', url);
		}
	});

	$('mp-remix')?.addEventListener('click', async () => {
		const instruction = window.prompt('Describe your remix (e.g. "make it chrome with red accents"):');
		if (!instruction?.trim()) return;
		const btn = $('mp-remix');
		btn.disabled = true;
		btn.textContent = 'Opening payment…';
		try {
			const X402 = await ensureX402();
			const out = await X402.pay({
				endpoint: '/api/x402/remix-asset',
				method: 'POST',
				body: { source_creation_id: c.id, instruction: instruction.trim() },
				merchant: 'three.ws Remix Bazaar',
				action: 'Remix this model for $0.25 USDC (a royalty routes to its creator)',
			});
			const remix = out?.result?.remix;
			if (remix?.viewerUrl) {
				toast('Remix ready. Opening it…');
				window.open(remix.viewerUrl, '_blank', 'noopener');
			} else {
				toast('Remix submitted.');
			}
		} catch (err) {
			log.error('remix failed', err);
			toast(err?.message || 'Remix failed. Try again.');
		} finally {
			btn.disabled = false;
			btn.textContent = 'Remix · $0.25';
		}
	});
}

async function wireFollow() {
	const btn = $('mp-follow');
	const username = state.creation?.creatorUsername;
	if (!btn || !username) return;

	const setBtn = (following) => {
		btn.dataset.following = following ? 'true' : 'false';
		btn.textContent = following ? 'Following' : 'Follow';
	};

	try {
		const r = await fetch(`/api/users/${encodeURIComponent(username)}/follow`, { credentials: 'include' });
		if (r.ok) {
			const j = await r.json();
			setBtn(Boolean(j.following));
			btn.hidden = false;
		}
	} catch (err) {
		log.warn('follow state unavailable', err);
	}

	btn.addEventListener('click', async () => {
		if (!state.viewer) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const wasFollowing = btn.dataset.following === 'true';
		btn.disabled = true;
		try {
			const r = await apiFetch(`/api/users/${encodeURIComponent(username)}/follow`, {
				method: wasFollowing ? 'DELETE' : 'POST',
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const j = await r.json();
			setBtn(Boolean(j.following));
		} catch (err) {
			log.error('follow toggle failed', err);
			toast('Could not update follow. Try again.');
		} finally {
			btn.disabled = false;
		}
	});
}

// ── geometry stats (live from the free 3D inspect API) ──────────────────────

async function loadGeometry() {
	const host = $('mp-geo');
	const c = state.creation;
	if (!host) return;
	try {
		const r = await fetch(`/api/3d/inspect?url=${encodeURIComponent(c.glb_url)}`);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		const s = data?.stats || {};
		const size = formatBytes(data?.sizeBytes ?? c.size_bytes);
		host.innerHTML = `
			<span>◤ Triangles: <b>${formatCount(s.triangles)}</b></span>
			<span>◇ Vertices: <b>${formatCount(s.vertices)}</b></span>
			<button class="mp-geo-more" id="mp-geo-toggle" type="button" aria-expanded="false">More model information</button>
			<div class="mp-geo-detail" id="mp-geo-detail" hidden>
				<div><span>Materials</span><b>${Number(s.materials) || 0}</b></div>
				<div><span>Textures</span><b>${Number(s.textures) || 0}</b></div>
				<div><span>Meshes</span><b>${Number(s.meshes) || 0}</b></div>
				<div><span>Animations</span><b>${Number(s.animations) || 0}</b></div>
				${size ? `<div><span>File size</span><b>${esc(size)}</b></div>` : ''}
				${c.backend ? `<div><span>Engine</span><b>${esc(c.backend)}</b></div>` : ''}
				<div><span>glTF valid</span><b>${data?.valid ? 'yes' : 'no'}</b></div>
			</div>`;
		$('mp-geo-toggle')?.addEventListener('click', () => {
			const detail = $('mp-geo-detail');
			const open = detail.hidden;
			detail.hidden = !open;
			$('mp-geo-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
		});
	} catch (err) {
		log.warn('inspect unavailable', err);
		const size = formatBytes(c.size_bytes);
		host.innerHTML = size ? `<span>File size: <b>${esc(size)}</b></span>` : '';
	}
}

// ── simulation readiness (the physics grade) ────────────────────────────────

// The grade rides in on the creation payload, joined from sim_readiness_grades
// by creation_id, so the common case renders instantly with no extra request
// and, crucially, without re-fetching the GLB server-side just to recompute a
// hash we already have a row for. A creation from before this lane existed has
// no row: that is the ungraded state, and it offers the grade rather than
// reading as a failure.
async function loadSimReadiness() {
	const host = $('mp-sim');
	const c = state.creation;
	if (!host || !c?.glb_url) return;

	// The element's definition is loaded by a <script src> in model.html (a
	// module under public/ cannot be imported from src/). Race the upgrade
	// against a deadline so a blocked script degrades to no badge rather than
	// leaving this function pending forever.
	const defined = await Promise.race([
		customElements.whenDefined('sim-readiness').then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
	]);
	if (!defined) {
		log.warn('simulation-readiness panel did not load');
		return;
	}

	const el = document.createElement('sim-readiness');
	host.replaceChildren(el);

	const grade = async () => {
		try {
			const r = await fetch(`/api/sim-readiness?src=${encodeURIComponent(c.glb_url)}`, {
				headers: { accept: 'application/json' },
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
			el.showReport(body, { gradedAt: body.gradedAt, cached: body.cached });
		} catch (err) {
			log.warn('simulation-readiness grade failed', err);
			el.failed(err?.message || 'The physics grade could not be fetched.', { onRetry: grade });
		}
	};

	if (c.simReadiness?.verdict) {
		el.showReport(c.simReadiness, { gradedAt: c.simReadinessGradedAt, cached: true });
	} else {
		el.ungraded({ onGrade: grade });
	}
}

// ── comments ─────────────────────────────────────────────────────────────────

async function loadComments() {
	const host = $('mp-comments');
	if (!host) return;
	host.innerHTML = `<h2>Comments</h2><div class="mp-skeleton mp-skeleton--line" style="width:50%"></div>`;
	try {
		const r = await fetch(`/api/forge-comments?creation_id=${encodeURIComponent(state.id)}`, { credentials: 'include' });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		state.comments = data.comments || [];
		state.commentsTotal = data.total || 0;
		state.commentsNext = data.next || null;
		renderComments();
	} catch (err) {
		log.error('comments failed', err);
		host.innerHTML = `<h2>Comments</h2><div class="mp-error" style="padding:var(--space-md)">Could not load comments. <button id="mp-comments-retry" type="button">Retry</button></div>`;
		$('mp-comments-retry')?.addEventListener('click', loadComments);
	}
}

function commentHTML(cm) {
	const avatar = cm.author_avatar
		? `<img class="mp-comment-avatar" src="${esc(cm.author_avatar)}" alt="" loading="lazy" />`
		: `<div class="mp-comment-avatar" aria-hidden="true">${esc((cm.author_name || '?').charAt(0).toUpperCase())}</div>`;
	const name = cm.author_username
		? `<a class="mp-comment-author" href="/u/${esc(cm.author_username)}">${esc(cm.author_name)}</a>`
		: `<span class="mp-comment-author">${esc(cm.author_name)}</span>`;
	return `
		<div class="mp-comment" data-comment-id="${esc(cm.id)}">
			${avatar}
			<div class="mp-comment-body">
				<div class="mp-comment-head">
					${name}
					<span class="mp-comment-when">${esc(timeAgo(cm.created_at))}</span>
					${cm.is_mine ? `<button class="mp-comment-delete" type="button" data-delete="${esc(cm.id)}">delete</button>` : ''}
				</div>
				<p class="mp-comment-text">${esc(cm.body)}</p>
			</div>
		</div>`;
}

function renderComments() {
	const host = $('mp-comments');
	if (!host) return;
	const n = state.commentsTotal;

	const composer = state.viewer
		? `
		<div class="mp-composer">
			<textarea id="mp-comment-input" maxlength="2000" placeholder="Leave a comment, share your feedback."></textarea>
			<div class="mp-composer-actions">
				<button class="mp-action" id="mp-comment-post" type="button">Post comment</button>
				<span class="mp-composer-hint">Visible to anyone with this link</span>
			</div>
		</div>`
		: `
		<div class="mp-signin-note">
			<a href="/login?next=${encodeURIComponent(location.pathname)}">Sign in</a> to leave a comment.
		</div>`;

	host.innerHTML = `
		<h2>${n === 0 ? 'No comments yet' : `${formatCount(n)} comment${n === 1 ? '' : 's'}`}</h2>
		${composer}
		<div id="mp-comment-list">${state.comments.map(commentHTML).join('')}</div>
		${state.commentsNext ? `<button class="mp-action" id="mp-comments-more" type="button" style="margin-top:var(--space-sm)">Load older comments</button>` : ''}`;

	$('mp-comment-post')?.addEventListener('click', postComment);
	$('mp-comment-input')?.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment();
	});
	$('mp-comments-more')?.addEventListener('click', loadOlderComments);
	$('mp-comment-list')?.addEventListener('click', async (e) => {
		const id = e.target.closest('[data-delete]')?.dataset.delete;
		if (!id) return;
		try {
			const r = await apiFetch('/api/forge-comments', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ comment_id: id }),
			});
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			state.comments = state.comments.filter((cm) => cm.id !== id);
			state.commentsTotal = Math.max(0, state.commentsTotal - 1);
			renderComments();
		} catch (err) {
			log.error('delete failed', err);
			toast('Could not delete the comment.');
		}
	});
}

async function postComment() {
	const input = $('mp-comment-input');
	const btn = $('mp-comment-post');
	const body = input?.value.trim();
	if (!body) return;
	btn.disabled = true;
	try {
		const r = await apiFetch('/api/forge-comments', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ creation_id: state.id, body }),
		});
		const data = await r.json().catch(() => null);
		if (!r.ok) throw new Error(data?.error_description || `HTTP ${r.status}`);
		state.comments.unshift(data.comment);
		state.commentsTotal += 1;
		renderComments();
	} catch (err) {
		log.error('post failed', err);
		toast(err?.message || 'Could not post the comment.');
		btn.disabled = false;
	}
}

async function loadOlderComments() {
	try {
		const r = await fetch(
			`/api/forge-comments?creation_id=${encodeURIComponent(state.id)}&before=${encodeURIComponent(state.commentsNext)}`,
			{ credentials: 'include' },
		);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		state.comments.push(...(data.comments || []));
		state.commentsNext = data.next || null;
		renderComments();
	} catch (err) {
		log.error('older comments failed', err);
		toast('Could not load older comments.');
	}
}

// ── suggested rail ───────────────────────────────────────────────────────────

function renderSuggested() {
	const host = $('mp-suggested');
	if (!host) return;
	if (!state.related.length) {
		host.innerHTML = `<div class="mp-empty" style="padding:var(--space-md)">No suggestions yet. <a href="/forge">Forge something new →</a></div>`;
		return;
	}
	host.innerHTML = state.related
		.map((m) => {
			const thumb = m.preview_image_url
				? `<img class="mp-sugg-thumb" src="${esc(m.preview_image_url)}" alt="" loading="lazy" />`
				: `<div class="mp-sugg-thumb" aria-hidden="true">◆</div>`;
			return `
			<a class="mp-sugg-card" href="/m/${esc(m.id)}">
				${thumb}
				<div>
					<div class="mp-sugg-title">${esc(titleFromPrompt(m.prompt))}</div>
					<div class="mp-sugg-meta">
						<span>👁 ${formatCount(m.view_count)}</span>
						<span>♥ ${formatCount(m.vote_count)}</span>
					</div>
				</div>
			</a>`;
		})
		.join('');
}

// ── error states ─────────────────────────────────────────────────────────────

function renderMissing(msg) {
	const shell = $('mp-shell');
	if (!shell) return;
	shell.setAttribute('aria-busy', 'false');
	shell.innerHTML = `
		<div class="mp-empty">
			<h1>Model not found</h1>
			<p>${esc(msg)}</p>
			<p><a href="/creations">Browse the creator gallery</a> · <a href="/forge">Forge a new model</a></p>
		</div>`;
}

function renderError() {
	const shell = $('mp-shell');
	if (!shell) return;
	shell.setAttribute('aria-busy', 'false');
	shell.innerHTML = `
		<div class="mp-error">
			<h1>Something broke</h1>
			<p>The model could not be loaded right now.</p>
			<p><button type="button" data-action="reload">Retry</button> · <a href="/creations">Back to creations</a></p>
		</div>`;
}

boot();
