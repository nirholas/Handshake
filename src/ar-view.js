// /ar/view: generic "place this GLB in AR" page, driven entirely by query
// params instead of an avatar record. This is the shared landing spot for
// every "give me a src, open real device AR" caller that isn't itself a
// bundled page: /api/ar (AR Forge's iOS/desktop fallback, the export_ar MCP
// tool, Object Library), and the AR Studio single-model hand-off. It exists
// because <model-viewer>'s Quick Look mode needs a real USDZ file (ios-src),
// which model-viewer does NOT generate on its own. The conversion has to
// run here, in a page Vite actually bundles (so `import 'three/addons/...'`
// resolves), exactly the way /avatars/:id/ar (src/ar-page.js) already does.
// Never copy this logic back into an unbundled static file or a server-
// rendered HTML string: it will 404 or throw on the bare 'three' import.

import { glbBlobToUsdzBlob } from './usdz-pipeline.js';
import { createLogger } from './shared/log.js';

const log = createLogger('ar-view');

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const glbUrl = params.get('src') || '';
const title = (params.get('title') || '').slice(0, 120);
const irlUrl = params.get('irl') || '';
const backUrl = params.get('back') || '/ar';

let usdzObjectUrl = null;

function isHttpsGlb(u) {
	try {
		const parsed = new URL(u);
		return parsed.protocol === 'https:' && /\.(glb|gltf)$/i.test(parsed.pathname);
	} catch {
		return false;
	}
}

function showError(msg) {
	const shell = $('ar-shell');
	if (shell) shell.innerHTML = `<div class="ar-error">${msg}</div>`;
}

function setStatus(msg) {
	const el = $('ar-status');
	const txt = $('ar-status-text');
	if (!msg) { el.hidden = true; return; }
	txt.textContent = msg;
	el.hidden = false;
}

function setArReady() {
	$('ar-status').hidden = true;
	$('ar-launch-btn').disabled = false;
	$('ar-launch-btn').removeAttribute('aria-busy');
}

function applyUsdzSrc(src) {
	$('ar-viewer').setAttribute('ios-src', src);
}

async function generateUsdz(url) {
	const btn = $('ar-launch-btn');
	setStatus('Preparing AR preview…');
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');
	try {
		setStatus('Downloading model…');
		const r = await fetch(url);
		if (!r.ok) throw new Error(`GLB fetch ${r.status}`);
		const glbBlob = await r.blob();
		setStatus('Generating AR preview…');
		const usdzBlob = await glbBlobToUsdzBlob(glbBlob);
		if (usdzObjectUrl) URL.revokeObjectURL(usdzObjectUrl);
		usdzObjectUrl = URL.createObjectURL(usdzBlob);
		applyUsdzSrc(usdzObjectUrl);
		setArReady();
		setStatus('AR preview ready');
		setTimeout(() => setStatus(null), 2000);
	} catch (err) {
		log.warn('[ar-view] USDZ generation failed:', err?.message);
		$('ar-status').classList.add('is-error');
		setStatus(`Couldn't generate AR preview: ${err.message}`);
		btn.disabled = false;
		btn.removeAttribute('aria-busy');
	}
}

async function shareModel() {
	const url = location.href;
	const shareTitle = title ? `${title} in AR · three.ws` : '3D model in AR · three.ws';
	if (navigator.share) {
		try {
			await navigator.share({ title: shareTitle, url });
			return;
		} catch {
			// fall through to clipboard
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		const btn = $('ar-share-btn');
		const orig = btn.textContent;
		btn.textContent = 'Copied!';
		setTimeout(() => { btn.textContent = orig; }, 1800);
	} catch {
		// nothing to do
	}
}

// Desktop / unsupported browsers report canActivateAR === false; there is no
// AR mode to activate, so copy the link for a phone instead.
async function offerArOnPhone() {
	const statusEl = $('ar-status');
	statusEl.classList.remove('is-error');
	try {
		await navigator.clipboard.writeText(location.href);
		setStatus('AR needs a phone: link copied. Open it on your iPhone or Android.');
	} catch {
		setStatus('AR needs a phone: open this page on your iPhone or Android device.');
	}
	setTimeout(() => setStatus(null), 6000);
}

function init() {
	if (!isHttpsGlb(glbUrl)) {
		showError("Couldn't open this in AR: provide a valid https URL to a .glb model.");
		return;
	}

	$('ar-title').textContent = title || '3D model';
	document.title = title ? `${title} in AR · three.ws` : 'View in AR · three.ws';
	$('ar-back-link').href = backUrl;

	const viewer = $('ar-viewer');
	viewer.setAttribute('src', glbUrl);
	viewer.setAttribute('alt', title || '3D model');

	if (irlUrl) {
		const liveLink = $('ar-live-link');
		liveLink.href = irlUrl;
		liveLink.hidden = false;
	}

	viewer.addEventListener('load', () => generateUsdz(glbUrl), { once: true });
	viewer.addEventListener('error', () => {
		showError('This model could not be displayed here.');
	}, { once: true });

	$('ar-share-btn').addEventListener('click', shareModel);
	$('ar-launch-btn').addEventListener('click', () => {
		if (viewer.canActivateAR) {
			viewer.activateAR();
		} else {
			offerArOnPhone();
		}
	});

	window.addEventListener('beforeunload', () => {
		if (usdzObjectUrl) URL.revokeObjectURL(usdzObjectUrl);
	});
}

document.addEventListener('DOMContentLoaded', init);
