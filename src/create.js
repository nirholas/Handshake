import { apiFetch } from './account.js';
import { AvatarCreator } from './avatar-creator.js';
import { stage as stageGuestAvatar } from './guest-avatar.js';
import { createFromTemplate } from './shared/template-picker.js';
import { log } from './shared/log.js';
import { clearSharedIntent, sharedIntent, takeSharedFiles } from './shared/share-target.js';
import { captureWizardReturn } from './shared/wizard-return.js';

// The /start wizard links here with ?next=; remember it before anything else
// loads, so whichever creation page finishes the avatar can hand it back
// (src/shared/wizard-return.js). Top level, not boot(): this hub pulls in
// heavy modules first and a visitor can click through to a sub-page before
// boot() ever runs.
captureWizardReturn();

// GLB magic bytes: ASCII "glTF"
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46];

// Surface ARKit-52 conformance results to the user. The companions pipeline
// dispatches `three-ws:arkit-report` on document once the GLB has been
// inspected. Avatars with full coverage are silent — we only nudge when a
// rig is missing morphs, since that's the actionable case.
document.addEventListener('three-ws:arkit-report', (event) => {
	const detail = /** @type {CustomEvent} */ (event).detail || {};
	const coverage = Math.round((detail.coverage || 0) * 100);
	const implemented = detail.implemented?.length ?? 0;
	if (coverage >= 100) return;
	showStatus(
		`Avatar saved · ${coverage}% ARKit blendshape coverage (${implemented}/52). Missing morphs render flatter — see docs/avatar-creation.md.`,
		'info',
	);
});

// The selfie pipeline (/create/selfie) hits a server-side reconstruction job
// that requires auth + counts against plan quota — we keep that gate. The
// default editor, Studio iframe and direct GLB upload all stay anonymous;
// we stash the resulting blob in IndexedDB and let /create-review handle the
// "sign in to save" step after the user has seen their avatar.
function requireAuthForSelfie() {
	if (window.__authed === false) {
		const next = encodeURIComponent('/create/selfie');
		window.location.replace(`/login?next=${next}`);
		return false;
	}
	return true;
}

// Probe runtime feature flags. Selfie reconstruction is always available
// (BYOK providers are always an option); only video avatar is gated on an
// optional Cloud Run worker.
//
// Three states, not a boolean: "the probe never answered" is not the same
// answer as "the worker is off". Collapsing them brands a live lane "coming
// soon" for anyone who loaded the page during a network blip, with no way back
// short of a reload. 'unknown' keeps the card live and re-asks on activation.
/** @type {'ready' | 'unavailable' | 'unknown'} */
let _videoAvatar = 'unknown';

async function probeVideoAvatar() {
	try {
		const r = await fetch('/api/config', { credentials: 'omit' });
		if (!r.ok) return 'unknown';
		const j = await r.json();
		return j?.features?.videoAvatar === true ? 'ready' : 'unavailable';
	} catch {
		return 'unknown';
	}
}

async function probeFeatures() {
	_videoAvatar = await probeVideoAvatar();
	if (_videoAvatar === 'unavailable') markVideoAvatarUnavailable();
}

// The dimmed card has to say why it is dimmed. The title carries a data-i18n
// annotation, so runtime i18n reclaims anything written into it; the state goes
// into a chip and the CTA label instead, both of which the catalog never owns.
function markVideoAvatarUnavailable() {
	const card = document.getElementById('card-video-avatar');
	if (!card || card.dataset.unavailable === '1') return;
	card.dataset.unavailable = '1';
	card.setAttribute('aria-disabled', 'true');
	card.setAttribute(
		'aria-label',
		'Talking avatar video: coming soon, this lane is not live yet',
	);
	card.style.opacity = '0.45';
	card.style.cursor = 'not-allowed';

	const meta = document.getElementById('card-video-avatar-meta');
	if (meta && !meta.querySelector('.chip-soon')) {
		const chip = document.createElement('span');
		chip.className = 'chip chip-soon';
		chip.textContent = 'Coming soon';
		meta.prepend(chip);
	}
	const cta = document.getElementById('card-video-avatar-cta');
	if (cta) cta.textContent = 'Coming soon';
}

// Activation handler for the video-avatar card, shared by pointer and keyboard.
// 'unknown' means the boot probe never got an answer, so ask again on the click
// rather than refusing a lane that may well be live.
async function openVideoAvatar() {
	if (_videoAvatar === 'unknown') {
		showStatus('Checking whether talking avatar video is available…', 'loading');
		_videoAvatar = await probeVideoAvatar();
		if (_videoAvatar === 'unavailable') markVideoAvatarUnavailable();
		if (_videoAvatar === 'unknown') {
			showStatus(
				'Could not reach three.ws to check this feature. Check your connection and try again.',
				'error',
			);
			return;
		}
	}
	if (_videoAvatar === 'unavailable') {
		showStatus('Talking avatar video is coming soon. Stay tuned.', 'info');
		return;
	}
	if (window.__authed === false) {
		window.location.replace(`/login?next=${encodeURIComponent('/create/video')}`);
		return;
	}
	window.location.href = '/create/video';
}

async function handleFork(avatarId) {
	showSaveOverlay('Saving avatar…');
	try {
		// Canonical, GitHub-style fork for signed-in users: the server copies the
		// model into the caller's namespace, mints a new owned avatar with a
		// "Forked from" link, and provisions its agent wallet. No client download.
		const forkRes = await fetch('/api/avatars/fork', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ source_avatar_id: avatarId }),
		});
		if (forkRes.ok) {
			const { avatar } = await forkRes.json();
			window.location.href = `/avatars/${encodeURIComponent(avatar.id)}`;
			return;
		}
		// Only auth failures fall through to the guest remix flow; surface real errors.
		if (forkRes.status !== 401 && forkRes.status !== 403) {
			const d = await forkRes.json().catch(() => ({}));
			throw new Error(d.message || d.error || 'Could not save this avatar.');
		}

		// Not signed in → stage a guest copy so they can sign up at review and own it.
		updateSaveOverlay('Loading avatar…');
		const metaRes = await fetch(`/api/avatars/${encodeURIComponent(avatarId)}`);
		if (!metaRes.ok) throw new Error('Could not load the original avatar.');
		const { avatar } = await metaRes.json();

		const glbUrl = avatar.url || avatar.model_url;
		if (!glbUrl) throw new Error('Original avatar has no downloadable model.');

		updateSaveOverlay('Downloading model…');
		const glbRes = await fetch(glbUrl, { mode: 'cors' });
		if (!glbRes.ok) throw new Error('Could not download the avatar model.');
		const blob = await glbRes.blob();

		updateSaveOverlay('Preparing remix…');
		await stageGuestAvatar(blob, {
			source: 'import',
			name: avatar.name || 'Remixed avatar',
			source_meta: { provider: 'remix', fork_of: avatarId },
		});

		window.location.href = '/create-review';
	} catch (err) {
		hideSaveOverlay();
		log.error('[create] fork failed:', err);
		showFatal({
			title: 'That remix could not be loaded',
			body: `${err.message || 'Could not remix this avatar.'} The original may have been deleted or made private. Every other way to create is still open below.`,
			retryLabel: 'Try the remix again',
			onRetry: () => handleFork(avatarId),
		});
	}
}

// Hard failures render into #create-alert-slot, not the 4.5s toast: a visitor
// who arrived on a ?fork= link and hit an error has nothing else on screen to
// act on, so the message has to persist and carry its own way forward.
function showFatal({ title, body, retryLabel, onRetry }) {
	const slot = document.getElementById('create-alert-slot');
	if (!slot) return;
	slot.replaceChildren();

	const box = document.createElement('div');
	box.className = 'create-alert';

	const h = document.createElement('p');
	h.className = 'create-alert-title';
	h.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>';
	h.append(title);

	const p = document.createElement('p');
	p.className = 'create-alert-body';
	p.textContent = body;

	const actions = document.createElement('div');
	actions.className = 'create-alert-actions';

	if (onRetry) {
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'create-alert-btn create-alert-btn--primary';
		retry.textContent = retryLabel || 'Try again';
		retry.addEventListener('click', () => {
			slot.replaceChildren();
			onRetry();
		});
		actions.appendChild(retry);
	}

	const dismiss = document.createElement('button');
	dismiss.type = 'button';
	dismiss.className = 'create-alert-btn';
	dismiss.textContent = 'Start something new instead';
	dismiss.addEventListener('click', () => {
		slot.replaceChildren();
		// Drop ?fork= so a reload does not replay the failure.
		const url = new URL(window.location.href);
		url.searchParams.delete('fork');
		history.replaceState(null, '', url.pathname + url.search + url.hash);
		document.getElementById('card-default-editor')?.focus();
	});
	actions.appendChild(dismiss);

	box.append(h, p, actions);
	slot.appendChild(box);
	box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function boot() {
	probeFeatures();
	const creator = new AvatarCreator(document.body, (blob, meta = {}) => {
		const provider = meta.provider || 'avaturn';
		// Forward-compatible source mapping:
		//   - 'avaturn' is its own enum value (auto-links to default agent)
		//   - 'readyplayer' uses the API's 'import' value today (older deploys reject 'readyplayer'),
		//     with the canonical provider stored in source_meta so server-side auto-link still triggers
		const source = provider === 'avaturn' ? 'avaturn' : 'import';
		const source_meta = { provider, ...(meta.sourceUrl ? { source_url: meta.sourceUrl } : {}) };
		return stageAndReview(blob, { source, source_meta, provider });
	});

	document.getElementById('back-btn')?.addEventListener('click', () => {
		if (history.length > 1) history.back();
		else window.location.href = '/';
	});

	wireCard('card-default-editor', async () => {
		if (window.__authed && (await isAtAvatarLimit())) return;
		creator.openDefaultEditor();
	});
	wireCard('card-customize', async () => {
		if (window.__authed && (await isAtAvatarLimit())) return;
		createFromTemplate();
	});
	wireCard('card-agent-studio', async () => {
		if (window.__authed && (await isAtAvatarLimit())) return;
		window.location.href = '/create/studio';
	});
	wireCard('card-selfie', async () => {
		if (!requireAuthForSelfie()) return;
		if (await isAtAvatarLimit()) return;
		window.location.href = '/create/selfie';
	});
	wireCard('card-prompt', async () => {
		if (window.__authed === false) {
			window.location.replace(`/login?next=${encodeURIComponent('/create/prompt')}`);
			return;
		}
		if (await isAtAvatarLimit()) return;
		window.location.href = '/create/prompt';
	});
	wireCard('card-video-avatar', () => openVideoAvatar());
	wireCard('card-cosmos', () => {
		window.location.href = '/cosmos';
	});
	wireCard('card-upload-glb', (e) => {
		// Tooltip anchors live inside the card; let them navigate normally.
		if (e && e.target && e.target.closest('a')) return;
		document.getElementById('glb-input').click();
	});

	startPromptExampleLoop();

	document.getElementById('glb-input').addEventListener('change', async (e) => {
		const file = e.target.files?.[0];
		if (!file) return;
		e.target.value = '';
		await handleGlbFile(file);
	});

	await ingestSharedFile();

	loadYourAvatars();

	// The remix runs LAST, and only after every card above is live. It used to
	// run first and return early, so a failed ?fork= left the visitor looking at
	// a full page of cards where not one of them was wired to anything.
	const forkId = new URLSearchParams(location.search).get('fork');
	if (forkId) await handleFork(forkId);
}

// Returning users with at least one saved avatar get a "Start from one of
// yours" strip above the cards — each thumbnail remixes that avatar through the
// same fork path the ?fork= query param uses. Anonymous users (401) and users
// with no avatars simply never see the strip; it stays hidden.
async function loadYourAvatars() {
	const section = document.getElementById('your-avatars');
	const row = document.getElementById('your-avatars-row');
	if (!section || !row) return;

	// The auth hint (set/cleared by the login flows) tells us up front the
	// visitor is anonymous — skip the request instead of collecting a 401.
	try {
		const hint = localStorage.getItem('3dagent:auth-hint');
		if (!hint || JSON.parse(hint)?.authed !== true) return;
	} catch { return; }

	let avatars = [];
	try {
		// allowAnonymous: a stale hint still 401s here by design — apiFetch would
		// otherwise redirect to /login, breaking the anonymous create flow.
		const res = await apiFetch('/api/avatars', { allowAnonymous: true });
		if (!res.ok) return;
		// The endpoint answers { avatars, next_cursor }. This used to read the
		// body as a bare array, so Array.isArray was false for every real
		// response and the strip returned early every time: a signed-in visitor
		// with a full library never saw one of their own avatars here. Accept the
		// envelope, and still accept a bare array so an older API keeps working.
		const body = await res.json();
		avatars = Array.isArray(body) ? body : (body?.avatars ?? []);
	} catch {
		return; // network/auth issue — leave the strip hidden
	}
	if (!Array.isArray(avatars) || avatars.length === 0) return;

	const placeholder =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></svg>';

	const frag = document.createDocumentFragment();
	for (const av of avatars.slice(0, 8)) {
		const name = av.display_name || av.name || 'Avatar';
		const thumb = av.thumbnail_url;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'ya-thumb';
		btn.setAttribute('aria-label', `Remix ${name}`);

		const imgWrap = document.createElement('span');
		imgWrap.className = 'ya-thumb-img';
		if (thumb) {
			const img = document.createElement('img');
			img.src = thumb;
			img.alt = '';
			img.loading = 'lazy';
			// A thumbnail whose storage object has expired must not leave a broken
			// image icon in the strip: fall back to the same silhouette a
			// thumbnail-less avatar gets. The remix button still works either way.
			img.addEventListener('error', () => {
				imgWrap.innerHTML = placeholder;
			});
			imgWrap.appendChild(img);
		} else {
			imgWrap.innerHTML = placeholder;
		}

		const label = document.createElement('span');
		label.className = 'ya-thumb-label';
		label.textContent = name;

		btn.append(imgWrap, label);
		btn.addEventListener('click', () => handleFork(av.id));
		frag.appendChild(btn);
	}
	row.appendChild(frag);
	section.hidden = false;
}

// The featured prompt card demos its own value proposition: a slow typewriter
// cycles real example prompts in the card's example line. The element is
// aria-hidden (pure decoration), the loop sleeps while the tab is hidden, and
// prefers-reduced-motion downgrades the typing to a plain periodic swap.
// The first example ships fully typed in the markup so there is no pop-in.
const PROMPT_EXAMPLES = [
	'a samurai in neon armor',
	'a cozy robot librarian with brass glasses',
	'a jade dragon-scaled warrior queen',
	'an astronaut covered in koi tattoos',
	'a Victorian ghost detective in a long coat',
	'a desert nomad with a clockwork falcon',
	'a street medic from a cyberpunk night market',
];

function startPromptExampleLoop() {
	const el = document.getElementById('card-prompt-example');
	if (!el) return;

	let index = 0;
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		setInterval(() => {
			if (document.hidden) return;
			index = (index + 1) % PROMPT_EXAMPLES.length;
			el.textContent = PROMPT_EXAMPLES[index];
		}, 4000);
		return;
	}

	let chars = PROMPT_EXAMPLES[0].length;
	let phase = 'hold';
	const HOLD_MS = 2600;

	function tick() {
		if (document.hidden) {
			setTimeout(tick, 600);
			return;
		}
		let wait;
		if (phase === 'hold') {
			phase = 'erase';
			wait = HOLD_MS;
		} else if (phase === 'erase') {
			chars -= 1;
			el.textContent = PROMPT_EXAMPLES[index].slice(0, chars);
			if (chars <= 0) {
				index = (index + 1) % PROMPT_EXAMPLES.length;
				phase = 'type';
				wait = 350;
			} else {
				wait = 14 + Math.random() * 20;
			}
		} else {
			chars += 1;
			el.textContent = PROMPT_EXAMPLES[index].slice(0, chars);
			if (chars >= PROMPT_EXAMPLES[index].length) {
				phase = 'hold';
				wait = 60;
			} else {
				wait = 28 + Math.random() * 40;
			}
		}
		setTimeout(tick, wait);
	}
	// The 'hold' phase itself waits HOLD_MS, so enter the loop almost at once.
	setTimeout(tick, 60);
}

// Cards are divs with role="button", so we need to wire both click and
// keyboard activation (Enter / Space) ourselves — native <button> semantics.
function wireCard(id, handler) {
	const el = document.getElementById(id);
	if (!el) return;
	el.addEventListener('click', handler);
	el.addEventListener('keydown', (e) => {
		// No aria-disabled short-circuit here: the pointer path always reaches the
		// handler, and a card that answers a mouse with an explanation but a
		// keyboard with silence is broken for exactly the people who need the
		// explanation most. The handler owns the decision on both paths.
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handler(e);
		}
	});
}

// Android share-sheet handoff. public/share-target-sw.js intercepts the share
// POST to /create/share, stashes the files in the Cache API, and redirects here
// with ?shared=glb (a .glb), ?shared=1 (anything else), or ?shared=error.
async function ingestSharedFile() {
	const intent = sharedIntent();
	if (!intent) return;
	if (intent === 'error') {
		clearSharedIntent();
		showStatus("We couldn't read the shared file. Try again from the app you shared it from.", 'error');
		return;
	}
	if (intent === 'nosw') {
		// The share reached the server instead of the service worker: the app
		// had not finished installing its worker yet (first launch), so the
		// file could not be handed over. One visit fixes it.
		clearSharedIntent();
		showStatus('three.ws just finished setting up. Share the file again and it will land here.', 'error');
		return;
	}
	if (intent === 'glb') {
		clearSharedIntent();
		let files = [];
		try {
			({ files } = await takeSharedFiles());
		} catch (err) {
			log.warn('[create] could not read shared file:', err);
		}
		const glb = files.find((f) => /\.glb$/i.test(f.name) || f.type === 'model/gltf-binary');
		if (glb) await handleGlbFile(glb);
		else showStatus('The shared file was not a .glb. Share a GLB avatar or a photo.', 'error');
		return;
	}
	// A photo or unknown file: the selfie flow owns images. Hand the param
	// over untouched so that page consumes the cache instead of this one.
	location.replace('/create/selfie?shared=1');
}

async function handleGlbFile(file) {
	if (!file.name.toLowerCase().endsWith('.glb')) {
		showStatus('Please select a .glb file.', 'error');
		return;
	}

	showSaveOverlay('Checking your file…');

	const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
	if (!GLB_MAGIC.every((b, i) => header[i] === b)) {
		hideSaveOverlay();
		showStatus("File doesn't appear to be a valid GLB.", 'error');
		return;
	}

	const name = file.name.replace(/\.glb$/i, '').trim() || 'My Avatar';
	await stageAndReview(file, { source: 'upload', name });
}

async function isAtAvatarLimit() {
	try {
		const res = await apiFetch('/api/usage/summary');
		if (!res.ok) return false;
		const { counts, plan } = await res.json();
		if (counts.avatars >= plan.max_avatars) {
			showStatus(
				`You've reached the ${plan.max_avatars}-avatar limit on the free plan. Delete an avatar to create a new one.`,
				'error',
			);
			return true;
		}
	} catch {
		// network error — let the upload attempt proceed and fail naturally
	}
	return false;
}

// Stash the freshly generated GLB locally and send the user to /create-review,
// where they preview the avatar before deciding whether to sign in and save.
// Anonymous users get to see what they built before the auth wall; signed-in
// users still go through the same review step so the flow is consistent.
async function stageAndReview(blob, meta = {}) {
	showSaveOverlay('Preparing preview…');
	try {
		await stageGuestAvatar(blob, meta);
	} catch (err) {
		hideSaveOverlay();
		log.error('[create] failed to stage guest avatar:', err);
		showStatus('Could not save your avatar locally. Check browser storage settings.', 'error');
		return;
	}
	updateSaveOverlay('Opening preview…');
	window.location.href = '/create-review';
}

function showSaveOverlay(label, sublabel) {
	let el = document.getElementById('save-loading');
	if (!el) {
		el = document.createElement('div');
		el.id = 'save-loading';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.setAttribute('aria-busy', 'true');
		el.innerHTML = `
			<img loading="lazy" decoding="async" src="/three.svg" alt="" />
			<div class="dots">...</div>
			<div class="label"></div>
			<div class="sublabel"></div>
		`;
		document.body.appendChild(el);
		document.documentElement.style.overflow = 'hidden';
		document.body.style.overflow = 'hidden';
	}
	el.querySelector('.label').textContent = label;
	el.querySelector('.sublabel').textContent = sublabel || '';
}

function updateSaveOverlay(label, sublabel) {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.querySelector('.label').textContent = label;
	if (sublabel !== undefined) el.querySelector('.sublabel').textContent = sublabel;
}

function hideSaveOverlay() {
	const el = document.getElementById('save-loading');
	if (!el) return;
	el.remove();
	document.documentElement.style.overflow = '';
	document.body.style.overflow = '';
}

function showStatus(msg, type = 'info') {
	const el = document.getElementById('status-toast');
	el.textContent = msg;
	el.className = 'status-toast ' + type;
	el.hidden = false;
	if (type !== 'loading') {
		setTimeout(() => {
			el.hidden = true;
		}, 4500);
	}
}

boot();
