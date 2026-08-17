// Cosmos · Living Worlds — drive the /api/cosmos text→world video lane and
// composite the result behind a live 3D avatar (Google <model-viewer>).
//
// Flow: pick an avatar → describe a world → POST /api/cosmos → poll the NVCF job
// → play the returned MP4 as a full-bleed backdrop behind the transparent avatar
// viewer. Every state is designed here: empty (living aurora + prompt ideas),
// loading (real elapsed-driven progress, cancelable), success (video + tools),
// error / unconfigured (actionable banner, aurora stays so the stage is never
// blank). No fake timers — progress reflects the real poll lifecycle.

const $ = (id) => document.getElementById(id);

const els = {
	stage: $('cz-stage'),
	world: $('cz-world'),
	avatar: $('cz-avatar'),
	prompt: $('cz-prompt'),
	chips: $('cz-chips'),
	generate: $('cz-generate'),
	secondary: $('cz-secondary'),
	cancel: $('cz-cancel'),
	regen: $('cz-regen'),
	note: $('cz-note'),
	avatars: $('cz-avatars'),
	seed: $('cz-seed'),
	download: $('cz-download'),
	copy: $('cz-copy'),
	toast: $('cz-toast'),
	progLabel: $('cz-prog-label'),
	progTime: $('cz-prog-time'),
	progFill: $('cz-prog-fill'),
	phases: $('cz-phases'),
	statusBadge: $('cz-status-badge'),
	statusText: $('cz-status-text'),
};

// Curated, visually-distinct world ideas — one tap fills the prompt.
const IDEAS = [
	'a neon Tokyo street in the rain at night, reflections on the pavement',
	'a serene alpine lake at sunrise, mist drifting over the water',
	'a golden savanna at sunset, tall grass swaying in the wind',
	'a bioluminescent forest at midnight, glowing spores in the air',
	'a futuristic city skyline with flying traffic, volumetric haze',
	'an underwater coral reef, sun rays piercing the blue water',
	'a snowy mountain pass in a blizzard, dramatic clouds',
	'a desert canyon at dusk, warm light raking the red rock',
];

// Bundled humanoid avatars that ship in /public/avatars — instant, no fetch.
const BUNDLED = [
	{ name: 'Aria', url: '/avatars/realistic-female.glb' },
	{ name: 'Kai', url: '/avatars/realistic-male.glb' },
	{ name: 'Michelle', url: '/avatars/michelle.glb' },
	{ name: 'X-Bot', url: '/avatars/xbot.glb' },
	{ name: 'Mona', url: '/avatars/selfie-girl.glb' },
];
const DEFAULT_AVATAR = BUNDLED[0].url;

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
// Reveal the clip even if `canplay` was missed (cache/seek edge); cleared the
// moment the video reports it can play, or that it cannot.
const REVEAL_FALLBACK_MS = 1200;

// Shown whenever the lane itself reports it is down (unconfigured deployment, or
// NVIDIA retired every hosted Cosmos route this account can reach). The aurora
// backdrop stays, so the stage is a designed scene rather than a dead void.
const LANE_OFFLINE_COPY =
	'NVIDIA Cosmos world generation is offline right now. Your avatar keeps its living backdrop above; check back soon for generated worlds.';

let activeAvatarUrl = null;
let job = null; // { id, startedAt }
let pollTimer = null;
let elapsedTimer = null;
let lastVideoUrl = null;
let lastPrompt = '';

// ── helpers ────────────────────────────────────────────────────────────────
function toast(msg) {
	els.toast.textContent = msg;
	els.toast.classList.add('show');
	clearTimeout(toast._t);
	toast._t = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

// Notes render as text plus an optional real <button>. Server copy is never
// interpolated into innerHTML: the upstream lane has answered with vendor detail
// before, and a banner is not a template.
function showNote(kind, message, action = null) {
	els.note.className = `cz-note show ${kind}`;
	els.note.replaceChildren(document.createTextNode(message));
	if (!action) return;
	els.note.appendChild(document.createTextNode(' '));
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.textContent = action.label;
	btn.addEventListener('click', action.onClick);
	els.note.appendChild(btn);
}
function clearNote() {
	els.note.className = 'cz-note';
	els.note.replaceChildren();
}

// Three honest badge states: idle (nothing attempted yet), live (the lane just
// accepted a job), off (the lane told us it is down). The dot never claims a
// health we have not observed.
function setBadge(state, text) {
	els.statusBadge.classList.toggle('is-off', state === 'off');
	els.statusBadge.classList.toggle('is-idle', state === 'idle');
	els.statusText.textContent = text;
}

// ── avatar selection ─────────────────────────────────────────────────────────
function selectAvatar(url, { quiet = false } = {}) {
	activeAvatarUrl = url;
	els.avatar.setAttribute('src', url);
	for (const tile of els.avatars.querySelectorAll('.cz-av')) {
		tile.classList.toggle('is-active', tile.dataset.url === url);
		tile.setAttribute('aria-pressed', tile.dataset.url === url ? 'true' : 'false');
	}
	if (!quiet) toast('Avatar set');
}

function avatarTile({ name, url, image }) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'cz-av';
	btn.dataset.url = url;
	btn.title = name;
	btn.setAttribute('aria-label', `Use avatar ${name}`);
	btn.setAttribute('aria-pressed', 'false');
	const placeholder = () => {
		const ph = document.createElement('span');
		ph.className = 'ph';
		ph.textContent = (name || '?').trim().charAt(0).toUpperCase();
		return ph;
	};
	if (image) {
		const img = document.createElement('img');
		img.src = image;
		img.alt = '';
		img.loading = 'lazy';
		// Community previews outlive their stored object: the gallery still lists a
		// thumbnail URL after the bytes are gone. Swap a dead one for the initial
		// tile so the picker never shows a broken image.
		img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
		btn.appendChild(img);
	} else {
		btn.appendChild(placeholder());
	}
	btn.addEventListener('click', () => selectAvatar(url));
	return btn;
}

function renderAvatars(list) {
	els.avatars.innerHTML = '';
	for (const a of list) els.avatars.appendChild(avatarTile(a));
}

// Pull recent community creations (real GLBs) to enrich the picker. Best-effort:
// a disabled store or empty feed just leaves the bundled set.
async function loadCommunityAvatars() {
	try {
		const res = await fetch('/api/forge-gallery?scope=community', { headers: { accept: 'application/json' } });
		if (!res.ok) return;
		const data = await res.json();
		const creations = Array.isArray(data?.creations) ? data.creations : [];
		const extra = creations
			.filter((c) => typeof c?.glb_url === 'string' && c.glb_url)
			.slice(0, 5)
			.map((c, i) => ({
				name: c.prompt ? c.prompt.split(/[\s,]/)[0] : `Forge ${i + 1}`,
				url: c.glb_url,
				image: c.preview_image_url || null,
			}));
		if (extra.length) {
			const seen = new Set(BUNDLED.map((b) => b.url));
			const merged = [...BUNDLED];
			for (const e of extra) if (!seen.has(e.url)) merged.push(e);
			renderAvatars(merged.slice(0, 10));
			selectAvatar(activeAvatarUrl || DEFAULT_AVATAR, { quiet: true });
		}
	} catch {
		/* keep bundled set */
	}
}

// ── progress (driven by real elapsed time + poll phase, not a fake bar) ──────
function phaseFor(elapsedSec, status) {
	if (status === 'queued' || elapsedSec < 6) return { label: 'Submitting to NVIDIA Cosmos…', idx: 0, fill: 12 };
	if (elapsedSec < 70) return { label: 'Rendering world frames…', idx: 1, fill: Math.min(85, 18 + elapsedSec) };
	return { label: 'Finalizing the clip…', idx: 2, fill: 92 };
}

function renderProgress(status) {
	const elapsed = job ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
	const p = phaseFor(elapsed, status);
	els.progLabel.textContent = p.label;
	els.progTime.textContent = `${elapsed}s`;
	els.progFill.style.width = `${p.fill}%`;
	const names = ['Submitting', 'Rendering frames', 'Finalizing'];
	els.phases.innerHTML = names
		.map((n, i) => {
			const sep = i === 0 ? '' : '· ';
			return i === p.idx ? `<b>${n}</b>` : `<span>${sep}${n}</span>`;
		})
		.join(' ');
}

// ── generation lifecycle ─────────────────────────────────────────────────────
function setBusy(busy) {
	els.generate.disabled = busy;
	els.generate.classList.toggle('is-busy', busy);
	els.stage.classList.toggle('is-loading', busy);
	els.secondary.style.display = busy ? 'flex' : els.regen.style.display === 'inline-block' ? 'flex' : 'none';
	els.cancel.style.display = busy ? 'block' : 'none';
}

function stopTimers() {
	clearTimeout(pollTimer);
	clearInterval(elapsedTimer);
	pollTimer = null;
	elapsedTimer = null;
}

async function generate() {
	const prompt = els.prompt.value.trim();
	if (prompt.length < 3) {
		showNote('err', 'Describe a world first. Even a few words is enough.');
		els.prompt.focus();
		return;
	}
	clearNote();
	lastPrompt = prompt;
	els.stage.classList.remove('is-done');
	els.world.classList.remove('is-live');
	els.regen.style.display = 'none';

	const seedVal = els.seed.value.trim();
	const payload = { prompt };
	if (seedVal && Number.isFinite(Number(seedVal))) payload.seed = Math.trunc(Number(seedVal));

	setBusy(true);
	renderProgress('queued');
	elapsedTimer = setInterval(() => renderProgress(job?.status || 'running'), 1000);

	let res, data;
	try {
		res = await fetch('/api/cosmos', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(payload),
		});
		data = await res.json();
	} catch {
		// A dropped connection or an unparseable body is recoverable, so it keeps a
		// Retry: only the lane telling us it is offline drops the retry affordance.
		if (res && res.status === 404) {
			setBadge('off', 'Cosmos offline');
			return failGeneration(LANE_OFFLINE_COPY, { unconfigured: true });
		}
		return failGeneration('Could not reach the Cosmos service. Check your connection and try again.');
	}

	if (res.status === 503 || res.status === 404 || data?.error === 'unconfigured' || data?.error === 'lane_unavailable') {
		setBadge('off', 'Cosmos offline');
		return failGeneration(LANE_OFFLINE_COPY, { unconfigured: true });
	}
	if (!res.ok) {
		const retry = data?.retry_after ? ` Try again in ~${data.retry_after}s.` : '';
		return failGeneration((data?.message || 'Cosmos could not start this world.') + retry);
	}

	setBadge('live', 'NVIDIA Cosmos');

	// Rare synchronous completion.
	if (data.status === 'done' && data.video_url) {
		return succeed(data.video_url);
	}
	if (!data.job_id) {
		return failGeneration('Cosmos accepted the request but returned no job to track.');
	}

	job = { id: data.job_id, status: 'queued', startedAt: Date.now() };
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

async function poll() {
	if (!job) return;
	if (Date.now() - job.startedAt > POLL_TIMEOUT_MS) {
		return failGeneration('This world is taking unusually long. Try a simpler prompt or generate again.');
	}
	let data, res;
	try {
		res = await fetch(`/api/cosmos?job=${encodeURIComponent(job.id)}`, { headers: { accept: 'application/json' } });
		data = await res.json();
	} catch {
		// transient network hiccup — keep the job alive
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
		return;
	}

	// The lane can go down mid-render (a redeploy that drops the key, a retired
	// upstream route). Land in the designed offline state instead of polling a job
	// nobody is answering for the full five-minute ceiling.
	if (res.status === 503 || data?.error === 'unconfigured' || data?.error === 'lane_unavailable') {
		setBadge('off', 'Cosmos offline');
		return failGeneration(LANE_OFFLINE_COPY, { unconfigured: true });
	}
	if (!res.ok) {
		return failGeneration('Lost track of this world while it was rendering. Generate it again.');
	}

	job.status = data?.status || 'running';
	renderProgress(job.status);

	if (data?.status === 'done' && data.video_url) return succeed(data.video_url);
	if (data?.status === 'failed') {
		return failGeneration(data?.error || 'Cosmos could not finish this world. Try a different prompt.');
	}
	pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

function succeed(videoUrl) {
	stopTimers();
	lastVideoUrl = videoUrl;
	const v = els.world;
	let revealTimer = null;
	const reveal = () => {
		clearTimeout(revealTimer);
		v.classList.add('is-live');
		v.play().catch(() => {});
	};
	v.oncanplay = reveal;
	// A durable URL that will not decode (storage hiccup, expired object) must not
	// leave a "done" stage with nothing in it.
	v.onerror = () => {
		clearTimeout(revealTimer);
		v.classList.remove('is-live');
		v.setAttribute('aria-hidden', 'true');
		els.stage.classList.remove('is-done');
		lastVideoUrl = null;
		failGeneration('The world rendered but its clip would not play. Generate it again.');
	};
	v.src = videoUrl;
	v.removeAttribute('aria-hidden');
	// Safety: reveal even if canplay was missed (cache/seek edge).
	revealTimer = setTimeout(reveal, REVEAL_FALLBACK_MS);

	job = null;
	setBusy(false);
	els.stage.classList.add('is-done');
	els.regen.style.display = 'inline-block';
	els.secondary.style.display = 'flex';
	clearNote();
	toast('Your world is alive ✦');
}

function failGeneration(message, { unconfigured = false } = {}) {
	stopTimers();
	job = null;
	setBusy(false);
	els.regen.style.display = lastVideoUrl ? 'inline-block' : 'none';
	els.secondary.style.display = lastVideoUrl ? 'flex' : 'none';
	// An offline lane gets no Retry: the same request would fail the same way, and
	// a button that cannot work is worse than none.
	showNote(
		unconfigured ? 'info' : 'err',
		message,
		unconfigured ? null : { label: 'Retry', onClick: () => generate() },
	);
}

function cancelJob() {
	stopTimers();
	job = null;
	setBusy(false);
	els.regen.style.display = lastVideoUrl ? 'inline-block' : 'none';
	showNote('info', 'Generation canceled. Tweak the prompt and try again.');
}

// ── result actions ───────────────────────────────────────────────────────────
async function downloadClip() {
	if (!lastVideoUrl) return;
	try {
		const res = await fetch(lastVideoUrl);
		const blob = await res.blob();
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `cosmos-world-${Date.now()}.mp4`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 4000);
		toast('Downloading MP4…');
	} catch {
		// Cross-origin blocked the blob — fall back to opening the durable URL.
		window.open(lastVideoUrl, '_blank', 'noopener');
	}
}

// A shared world has to arrive as a world. The link carries the clip itself plus
// the avatar and prompt that framed it, so the recipient opens the finished scene
// rather than a blank stage and a prefilled textarea.
async function shareLink() {
	if (!lastVideoUrl) return;
	const url = new URL(window.location.href);
	url.search = '';
	url.searchParams.set('prompt', lastPrompt);
	url.searchParams.set('world', lastVideoUrl);
	if (activeAvatarUrl) url.searchParams.set('avatar', activeAvatarUrl);
	const seedVal = els.seed.value.trim();
	if (seedVal) url.searchParams.set('seed', seedVal);
	const link = url.toString();
	try {
		await navigator.clipboard.writeText(link);
		toast('Shareable link copied');
	} catch {
		window.prompt('Copy this link:', link);
	}
}

// ── init ─────────────────────────────────────────────────────────────────────
function init() {
	// Prompt ideas
	for (const idea of IDEAS) {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'cz-chip';
		chip.textContent = idea.split(',')[0];
		chip.title = idea;
		chip.addEventListener('click', () => {
			els.prompt.value = idea;
			els.prompt.focus();
		});
		els.chips.appendChild(chip);
	}

	// Avatars (bundled now; community enriches async)
	renderAvatars(BUNDLED);

	// Deep-link params: ?prompt= and ?avatar=/?model=
	const params = new URLSearchParams(window.location.search);
	const deepAvatar = params.get('avatar') || params.get('model');
	const deepPrompt = params.get('prompt');
	if (deepAvatar && /^https?:\/\/|^\//.test(deepAvatar)) {
		renderAvatars([{ name: 'Yours', url: deepAvatar }, ...BUNDLED]);
		selectAvatar(deepAvatar, { quiet: true });
	} else {
		selectAvatar(DEFAULT_AVATAR, { quiet: true });
	}
	if (deepPrompt) {
		els.prompt.value = deepPrompt.slice(0, 300);
		lastPrompt = els.prompt.value;
	}
	const deepSeed = params.get('seed');
	if (deepSeed && Number.isFinite(Number(deepSeed))) els.seed.value = String(Math.trunc(Number(deepSeed)));

	// A shared world plays straight away. Only an https .mp4 is honored, matching
	// the durable URLs this lane hands out; anything else is ignored so a crafted
	// link cannot point the stage at arbitrary content.
	const deepWorld = params.get('world');
	if (deepWorld && /^https:\/\/[^\s]+\.mp4(\?[^\s]*)?$/i.test(deepWorld)) succeed(deepWorld);

	loadCommunityAvatars();

	// Events
	els.generate.addEventListener('click', generate);
	els.regen.addEventListener('click', generate);
	els.cancel.addEventListener('click', cancelJob);
	els.download.addEventListener('click', downloadClip);
	els.copy.addEventListener('click', shareLink);
	els.prompt.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && job) cancelJob();
	});

	// Model-viewer load resilience: if the chosen GLB fails, fall back to default.
	els.avatar.addEventListener('error', () => {
		if (activeAvatarUrl !== DEFAULT_AVATAR) {
			showNote('info', 'That avatar could not load, so the stage fell back to a default. Pick another below.');
			selectAvatar(DEFAULT_AVATAR, { quiet: true });
		}
	});
}

init();
