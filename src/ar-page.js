/**
 * /avatars/:id/ar — dedicated AR experience page
 *
 * Fetches the avatar, loads it into a full-screen model-viewer with AR enabled.
 * If the avatar has a pre-generated usdz_url, sets it as ios-src immediately.
 * Otherwise converts the GLB to USDZ in-browser and sets a temporary object URL
 * so Quick Look works in the current session.
 */

import { glbBlobToUsdzBlob } from './usdz-pipeline.js';

const segments = location.pathname.split('/').filter(Boolean);
// /avatars/:id/ar → segments = ['avatars', 'uuid', 'ar']
const fromPath = segments[0] === 'avatars' && segments[2] === 'ar' ? segments[1] : null;
const fromQuery = new URLSearchParams(location.search).get('id');
const avatarId = fromPath || fromQuery || '';

const $ = (id) => document.getElementById(id);

let usdzObjectUrl = null;

async function init() {
	if (!avatarId) {
		showError('No avatar specified.');
		return;
	}

	const avatar = await fetchAvatar(avatarId);
	if (!avatar) return;

	const glbUrl = avatar.model_url || avatar.url;
	if (!glbUrl) {
		showError('This avatar has no 3D model.');
		return;
	}

	renderPage(avatar, glbUrl);

	if (avatar.usdz_url) {
		applyUsdzSrc(avatar.usdz_url);
		setArReady();
	} else {
		// Auto-generate USDZ so AR works in this session
		generateUsdz(glbUrl);
	}
}

async function fetchAvatar(id) {
	try {
		const r = await fetch(`/api/avatars/${encodeURIComponent(id)}`);
		if (!r.ok) throw new Error(`${r.status}`);
		return (await r.json()).avatar;
	} catch (err) {
		showError(`Couldn't load avatar (${err.message}).`);
		return null;
	}
}

function renderPage(avatar, glbUrl) {
	$('ar-avatar-name').textContent = avatar.name || 'Avatar';
	document.title = `${avatar.name || 'Avatar'} in AR · three.ws`;

	if (avatar.thumbnail_url) {
		document.querySelector('meta[name="og:image"]')?.setAttribute('content', avatar.thumbnail_url);
	}

	const viewer = $('ar-viewer');
	viewer.setAttribute('src', glbUrl);
	viewer.setAttribute('alt', avatar.name || 'three.ws avatar');

	if (avatar.usdz_url) {
		viewer.setAttribute('ios-src', avatar.usdz_url);
	}

	$('ar-back-link').href = `/agent-next?id=${encodeURIComponent(avatar.id || avatarId)}`;

	$('ar-share-btn').addEventListener('click', () => shareAvatar(avatar));
}

function applyUsdzSrc(src) {
	$('ar-viewer').setAttribute('ios-src', src);
}

function setArReady() {
	$('ar-status').hidden = true;
	$('ar-launch-btn').disabled = false;
	$('ar-launch-btn').removeAttribute('aria-busy');
}

function setStatus(msg) {
	const el = $('ar-status');
	const txt = $('ar-status-text');
	if (!msg) { el.hidden = true; return; }
	txt.textContent = msg;
	el.hidden = false;
}

async function generateUsdz(glbUrl) {
	const btn = $('ar-launch-btn');
	setStatus('Preparing AR preview…');
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');

	try {
		setStatus('Downloading model…');
		const r = await fetch(glbUrl);
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
		$('ar-status').classList.add('is-error');
		setStatus(`Couldn't generate AR preview: ${err.message}`);
		btn.disabled = false;
		btn.removeAttribute('aria-busy');
	}
}

function showError(msg) {
	const shell = $('ar-shell');
	if (shell) shell.innerHTML = `<div class="ar-error">${msg}</div>`;
}

async function shareAvatar(avatar) {
	const url = location.href;
	const title = `${avatar.name || 'Avatar'} in AR · three.ws`;
	if (navigator.share) {
		try {
			await navigator.share({ title, url });
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

// Wire the "Place in your space" button to model-viewer's activateAR()
document.addEventListener('DOMContentLoaded', () => {
	$('ar-launch-btn').addEventListener('click', () => {
		const viewer = $('ar-viewer');
		if (viewer.activateAR) {
			viewer.activateAR();
		}
	});

	init().catch((err) => {
		console.error('[ar-page] init error', err);
		showError('Something went wrong loading this avatar.');
	});

	window.addEventListener('beforeunload', () => {
		if (usdzObjectUrl) URL.revokeObjectURL(usdzObjectUrl);
	});
});
