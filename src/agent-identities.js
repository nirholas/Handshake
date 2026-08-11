// /agent-identities: Agent Identity Studio showcase grid.
//
// Data comes from /api/agent-identities at runtime: the demo identities are real
// pipeline runs recorded in data/agent-identities.json, and the price + endpoint
// chips come from the OKX catalog, so nothing on this page can drift from what
// the service actually charges. Each card: the full-body hero shot with the PFP
// crop pinned on top, thumbnails to switch poses, and a lazy "View in 3D" that
// swaps the image for a <model-viewer> of the rigged GLB. Heavy 3D loads only
// on request, never on page load.

const grid = document.getElementById('identity-grid');
const priceChip = document.getElementById('ai-service-price');

let modelViewerLoaded = false;
function ensureModelViewer() {
	if (modelViewerLoaded) return;
	modelViewerLoaded = true;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/model-viewer-meshopt.js';
	document.head.appendChild(s);
}

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'text') node.textContent = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of children) node.appendChild(c);
	return node;
}

function replaceGrid(...nodes) {
	grid.replaceChildren(...nodes);
}

// A render that 404s (an expired object, a purged bucket) must not leave a
// broken-image glyph in a 4:5 frame. Swap in a labelled placeholder instead.
function onImageError(img, stage, label) {
	img.remove();
	if (stage.querySelector('.ai-pending')) return;
	stage.appendChild(
		el('div', { class: 'ai-pending' }, [
			el('strong', { text: 'Render unavailable' }),
			el('span', { text: `${label} is in the studio archive but its image did not load.` }),
		]),
	);
}

function skeletonCard() {
	return el('article', { class: 'ai-card ai-card-skeleton', 'aria-hidden': 'true' }, [
		el('div', { class: 'ai-stage ai-skel' }),
		el('div', { class: 'ai-body' }, [
			el('span', { class: 'ai-skel ai-skel-line ai-skel-kind' }),
			el('span', { class: 'ai-skel ai-skel-line ai-skel-name' }),
			el('span', { class: 'ai-skel ai-skel-line' }),
			el('span', { class: 'ai-skel ai-skel-line ai-skel-short' }),
		]),
	]);
}

function loadingState() {
	replaceGrid(...Array.from({ length: 4 }, skeletonCard));
	grid.setAttribute('aria-busy', 'true');
}

function panel({ title, message, actions = [] }) {
	return el('div', { class: 'ai-state', role: 'status' }, [
		el('h2', { class: 'ai-state-title', text: title }),
		el('p', { class: 'ai-state-msg', text: message }),
		...(actions.length ? [el('div', { class: 'ai-state-actions' }, actions)] : []),
	]);
}

function emptyState() {
	grid.removeAttribute('aria-busy');
	replaceGrid(
		panel({
			title: 'No demo identities published yet',
			message:
				'The studio is live, the showcase is not. Agents can call the service today: the catalog lists the price and the endpoint, and the docs walk through the paid MCP call end to end.',
			actions: [
				el('a', { class: 'btn btn-primary', href: '/docs/okx-marketplace', text: 'Read the service docs' }),
				el('a', { class: 'btn', href: '/api/okx/3d/catalog', text: 'Service catalog (JSON)' }),
			],
		}),
	);
}

function errorState(message, retry) {
	grid.removeAttribute('aria-busy');
	replaceGrid(
		panel({
			title: 'Could not load the demo identities',
			message: `${message} The studio itself is unaffected: the service catalog and docs are static and still reachable.`,
			actions: [
				el('button', { type: 'button', class: 'btn btn-primary', text: 'Try again', onclick: retry }),
				el('a', { class: 'btn', href: '/docs/okx-marketplace', text: 'Read the service docs' }),
			],
		}),
	);
}

function pendingStage(agentName) {
	return el('div', { class: 'ai-pending' }, [
		el('strong', { text: 'Still in the studio' }),
		el('span', { text: `${agentName} has no completed pipeline run yet. Check back soon.` }),
	]);
}

function metaLine(identity) {
	const bits = [];
	if (identity.rigged) bits.push(`rigged · ${identity.joints} joints`);
	if (identity.durationSeconds) bits.push(`${Math.round(identity.durationSeconds / 60)} min to done`);
	if (identity.fullBody?.length) bits.push(`${identity.fullBody.length + 1} renders`);
	return bits.length ? el('p', { class: 'ai-meta', text: bits.join('  ·  ') }) : null;
}

function card(identity) {
	const { agentName, kind, brief, status } = identity;

	const stage = el('div', { class: 'ai-stage' });
	const bodyChildren = [
		el('span', { class: 'ai-kind', text: kind }),
		el('h2', { class: 'ai-name', text: agentName }),
		el('p', { class: 'ai-brief', text: brief }),
	];

	if (status !== 'ready') {
		stage.appendChild(pendingStage(agentName));
		return el('article', { class: 'ai-card' }, [stage, el('div', { class: 'ai-body' }, bodyChildren)]);
	}

	const hero = el('img', {
		src: identity.fullBody[0]?.url || identity.pfp.url,
		alt: `${agentName}, full-body 3D render`,
		loading: 'lazy',
		decoding: 'async',
		onerror: () => onImageError(hero, stage, agentName),
	});
	stage.appendChild(hero);

	const pfpImg = el('img', {
		src: identity.pfp.previewUrl || identity.pfp.url,
		alt: `${agentName} profile picture crop`,
		loading: 'lazy',
		decoding: 'async',
		onerror: () => pfpImg.closest('.ai-pfp')?.remove(),
	});
	stage.appendChild(el('div', { class: 'ai-pfp' }, [pfpImg]));

	const view3d = el('button', {
		type: 'button',
		class: 'ai-3d-toggle',
		'aria-pressed': 'false',
		text: 'View in 3D',
	});

	// One place that tears the viewer down, so every exit (the toggle, a pose
	// click, a load failure) leaves the button and the hero in the same state.
	function closeViewer() {
		stage.querySelector('model-viewer')?.remove();
		stage.querySelector('.ai-3d-status')?.remove();
		hero.style.opacity = '1';
		view3d.textContent = 'View in 3D';
		view3d.setAttribute('aria-pressed', 'false');
	}

	function openViewer() {
		ensureModelViewer();
		const status = el('div', { class: 'ai-3d-status', role: 'status' }, [
			el('span', { class: 'ai-spinner', 'aria-hidden': 'true' }),
			el('span', { text: 'Loading the rigged avatar' }),
		]);
		const viewer = el('model-viewer', {
			src: identity.riggedGlbUrl,
			'camera-controls': '',
			'touch-action': 'pan-y',
			'shadow-intensity': '0.6',
			exposure: '1.05',
			alt: `${agentName}, rigged 3D avatar`,
			onload: () => status.remove(),
			onerror: () => {
				closeViewer();
				stage.appendChild(
					el('div', { class: 'ai-3d-status ai-3d-error', role: 'status' }, [
						el('span', { text: 'The 3D avatar failed to load.' }),
						el('a', { href: identity.viewerUrl, target: '_blank', rel: 'noopener', text: 'Open it in the full viewer' }),
					]),
				);
			},
		});
		hero.style.opacity = '0';
		stage.appendChild(viewer);
		stage.appendChild(status);
		view3d.textContent = 'Back to renders';
		view3d.setAttribute('aria-pressed', 'true');
	}

	view3d.addEventListener('click', () => {
		if (stage.querySelector('model-viewer')) closeViewer();
		else openViewer();
	});

	const shots = el('div', { class: 'ai-shots', role: 'group', 'aria-label': `${agentName} poses` });
	for (const shot of identity.fullBody) {
		const btn = el(
			'button',
			{
				type: 'button',
				'aria-label': `Show ${shot.pose} pose`,
				'aria-pressed': shot === identity.fullBody[0] ? 'true' : 'false',
				onclick: () => {
					closeViewer();
					hero.src = shot.url;
					// The hero removes itself when a render 404s; a different pose is a
					// fresh chance at a working image, so put it back and clear the notice.
					if (!hero.isConnected) {
						stage.querySelector('.ai-pending')?.remove();
						stage.prepend(hero);
					}
					shots.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
					btn.setAttribute('aria-pressed', 'true');
				},
			},
			[
				el('img', {
					src: shot.url,
					alt: '',
					loading: 'lazy',
					decoding: 'async',
					onerror: (e) => e.target.closest('button')?.remove(),
				}),
			],
		);
		shots.appendChild(btn);
	}
	if (shots.childElementCount) bodyChildren.push(shots);

	const meta = metaLine(identity);
	if (meta) bodyChildren.push(meta);

	bodyChildren.push(
		el('div', { class: 'ai-actions' }, [
			view3d,
			el('a', { href: identity.viewerUrl, target: '_blank', rel: 'noopener', text: 'Open in viewer' }),
			el('a', { href: identity.poseStudioUrl, target: '_blank', rel: 'noopener', text: 'Pose studio' }),
		]),
	);

	return el('article', { class: 'ai-card' }, [stage, el('div', { class: 'ai-body' }, bodyChildren)]);
}

function renderService(service) {
	if (!priceChip || !service?.priceUsd) return;
	priceChip.textContent = `· $${service.priceUsd} ${service.currency || 'USDC'} per identity`;
	priceChip.hidden = false;
}

async function load() {
	loadingState();
	let payload;
	try {
		const res = await fetch('/api/agent-identities', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`the showcase feed answered HTTP ${res.status}.`);
		payload = await res.json();
	} catch (err) {
		const reason = err.name === 'TypeError' ? 'The network request did not complete.' : err.message;
		errorState(reason, load);
		return;
	}

	renderService(payload.service);

	const identities = Array.isArray(payload.identities) ? payload.identities : [];
	if (!identities.length) {
		emptyState();
		return;
	}
	grid.removeAttribute('aria-busy');
	replaceGrid(...identities.map(card));
}

load();
