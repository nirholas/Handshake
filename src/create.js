import { apiFetch } from './account.js';
import { AvatarCreator } from './avatar-creator.js';
import { stage as stageGuestAvatar } from './guest-avatar.js';

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

async function boot() {
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
	wireCard('card-selfie', async () => {
		if (!requireAuthForSelfie()) return;
		if (await isAtAvatarLimit()) return;
		window.location.href = '/create/selfie';
	});
	wireCard('card-upload-glb', (e) => {
		// Tooltip anchors live inside the card; let them navigate normally.
		if (e && e.target && e.target.closest('a')) return;
		document.getElementById('glb-input').click();
	});

	document.getElementById('glb-input').addEventListener('change', async (e) => {
		const file = e.target.files?.[0];
		if (!file) return;
		e.target.value = '';
		await handleGlbFile(file);
	});
}

// Cards are divs with role="button", so we need to wire both click and
// keyboard activation (Enter / Space) ourselves — native <button> semantics.
function wireCard(id, handler) {
	const el = document.getElementById(id);
	if (!el) return;
	el.addEventListener('click', handler);
	el.addEventListener('keydown', (e) => {
		if (el.getAttribute('aria-disabled') === 'true') return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handler(e);
		}
	});
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
		console.error('[create] failed to stage guest avatar:', err);
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
			<img src="/three.svg" alt="" />
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
