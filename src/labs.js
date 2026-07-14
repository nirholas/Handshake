// Use the static generated manifest. In dev Vite serves this from public/;
// in prod Vercel serves it as a static asset (same content the /api/features
// function returns, just without the extra CORS round-trip).
const REGISTRY_URL = '/features.json';

// Category metadata derived from path patterns in the registry
const CATEGORIES = {
	'/lipsync':      { label: 'Voice',    cat: 'voice',  color: '#a78bfa', bg: 'rgba(167,139,250,.12)' },
	'/lipsync/mic':  { label: 'Voice',    cat: 'voice',  color: '#a78bfa', bg: 'rgba(167,139,250,.12)' },
	'/voice':        { label: 'Voice',    cat: 'voice',  color: '#a78bfa', bg: 'rgba(167,139,250,.12)' },
	'/brain':        { label: 'AI',       cat: 'ai',     color: '#60a5fa', bg: 'rgba(96,165,250,.12)'  },
	'/unstoppable':  { label: 'AI',       cat: 'ai',     color: '#60a5fa', bg: 'rgba(96,165,250,.12)'  },
	'/three-live':   { label: '3D Live',  cat: '3d',     color: '#34d399', bg: 'rgba(52,211,153,.12)'  },
	'/diorama':      { label: '3D Live',  cat: '3d',     color: '#34d399', bg: 'rgba(52,211,153,.12)'  },
	'/mocap-studio': { label: '3D Live',  cat: '3d',     color: '#34d399', bg: 'rgba(52,211,153,.12)'  },
	'/agenc/embodied': { label: 'AI',     cat: 'ai',     color: '#60a5fa', bg: 'rgba(96,165,250,.12)'  },
	'/autopilot':    { label: 'Crypto',   cat: 'crypto', color: '#f97316', bg: 'rgba(249,115,22,.12)'  },
	'/pulse':        { label: 'Crypto',   cat: 'crypto', color: '#f97316', bg: 'rgba(249,115,22,.12)'  },
	'/forever':      { label: 'Crypto',   cat: 'crypto', color: '#f97316', bg: 'rgba(249,115,22,.12)'  },
};

function categorize(path) {
	if (CATEGORIES[path]) return CATEGORIES[path];
	return { label: 'x402', cat: 'x402', color: '#fbbf24', bg: 'rgba(251,191,36,.12)' };
}

// Human-readable plain-language blurb (trimmed to ~120 chars max for cards)
function blurb(description) {
	if (!description) return '';
	const stripped = description.replace(/ — .*$/, '').trim();
	return stripped.length > 130 ? stripped.slice(0, 127) + '…' : stripped;
}

// Check if a route resolves (HEAD fetch, 3s timeout)
async function checkLive(path) {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 3000);
		const res = await fetch(path, { method: 'HEAD', signal: ctrl.signal });
		clearTimeout(t);
		return res.status < 500;
	} catch {
		return false;
	}
}

function buildSkeletons(count) {
	return Array.from({ length: count }, () => {
		const el = document.createElement('div');
		el.className = 'gem-skeleton';
		el.setAttribute('aria-hidden', 'true');
		el.innerHTML = `
			<div class="sk-preview"></div>
			<div class="sk-body">
				<div class="sk-line title"></div>
				<div class="sk-line wide"></div>
				<div class="sk-line short"></div>
			</div>`;
		return el;
	});
}

function buildCard(gem) {
	const { path, title, description } = gem;
	const meta = categorize(path);

	const article = document.createElement('article');
	article.className = 'gem-card';
	article.dataset.path = path;
	article.dataset.cat = meta.cat;

	// Set CSS custom properties for the category gradient on the card element
	article.style.setProperty('--gem-cat-color', meta.color);
	article.style.setProperty('--gem-cat-bg-1', meta.bg.replace(/\)$/, '').replace(/,[^,]+$/, ', 0.08)'));
	article.style.setProperty('--gem-cat-bg-2', meta.bg.replace(/\)$/, '').replace(/,[^,]+$/, ', 0.03)'));

	article.innerHTML = `
		<div class="gem-preview" role="img" aria-label="Preview of ${escHtml(title)}">
			<div class="gem-preview-fallback">
				<span class="gem-preview-path">${escHtml(path)}</span>
			</div>
			<span class="gem-cat-badge"
				style="color:${meta.color};background:${meta.bg};border-color:${meta.color}22"
				aria-label="Category: ${escHtml(meta.label)}"
			>${escHtml(meta.label)}</span>
		</div>
		<div class="gem-body">
			<div class="gem-header">
				<h2 class="gem-title">${escHtml(title)}</h2>
				<span class="gem-status" data-state="checking" aria-live="polite" aria-label="Status: checking">Checking</span>
			</div>
			<p class="gem-desc">${escHtml(blurb(description))}</p>
			<a class="gem-cta" href="${escHtml(path)}" aria-label="Try ${escHtml(title)}">Try it →</a>
		</div>`;

	return article;
}

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Attach a lazy-loading iframe preview via IntersectionObserver
function attachPreview(card) {
	const previewEl = card.querySelector('.gem-preview');
	if (!previewEl) return;
	const path = card.dataset.path;

	const observer = new IntersectionObserver((entries, obs) => {
		if (!entries[0].isIntersecting) return;
		obs.disconnect();

		const iframe = document.createElement('iframe');
		// No sandbox: previews frame our own first-party pages (paths come from
		// /features.json), which need their real origin for API and storage
		// access. Sandboxing same-origin content with allow-scripts is escapable
		// anyway, so the attribute added nothing but a console warning.
		iframe.src = path;
		iframe.setAttribute('loading', 'lazy');
		iframe.setAttribute('tabindex', '-1');
		iframe.setAttribute('aria-hidden', 'true');
		iframe.setAttribute('title', '');
		previewEl.insertBefore(iframe, previewEl.firstChild);
	}, { rootMargin: '200px' });

	observer.observe(card);
}

// Update a card's status pill
async function updateStatus(card, statusCounter) {
	const path = card.dataset.path;
	const pill = card.querySelector('.gem-status');
	if (!pill) return;

	const live = await checkLive(path);
	pill.dataset.state = live ? 'live' : 'offline';
	pill.textContent = live ? 'Live' : 'Offline';
	pill.setAttribute('aria-label', `Status: ${live ? 'live' : 'offline'}`);

	if (live) statusCounter.count++;
	statusCounter.done++;
	if (statusCounter.done === statusCounter.total) {
		const liveEl = document.getElementById('labs-live-count');
		if (liveEl) liveEl.textContent = statusCounter.count;
	}
}

let allGems = [];
let activeFilter = 'all';

function applyFilter(cat) {
	activeFilter = cat;
	const grid = document.getElementById('labs-grid');
	if (!grid) return;

	const cards = grid.querySelectorAll('.gem-card');
	let visible = 0;
	cards.forEach(card => {
		const match = cat === 'all' || card.dataset.cat === cat;
		card.hidden = !match;
		if (match) visible++;
	});

	const countEl = document.getElementById('labs-result-count');
	if (countEl) countEl.textContent = `${visible} feature${visible !== 1 ? 's' : ''}`;

	const emptyEl = document.getElementById('labs-empty');
	if (emptyEl) emptyEl.setAttribute('aria-hidden', visible > 0 ? 'true' : 'false');
}

async function load() {
	const grid = document.getElementById('labs-grid');
	if (!grid) return;

	// Clear skeletons, keep empty/error states
	Array.from(grid.querySelectorAll('.gem-skeleton')).forEach(el => el.remove());
	grid.setAttribute('aria-busy', 'true');

	const errorEl = document.getElementById('labs-error');
	if (errorEl) errorEl.setAttribute('aria-hidden', 'true');
	const emptyEl = document.getElementById('labs-empty');
	if (emptyEl) emptyEl.setAttribute('aria-hidden', 'true');

	let manifest;
	try {
		const res = await fetch(REGISTRY_URL);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		manifest = await res.json();
	} catch {
		grid.setAttribute('aria-busy', 'false');
		if (errorEl) errorEl.setAttribute('aria-hidden', 'false');
		return;
	}

	// Collect all showcase pages across all sections
	allGems = manifest.sections
		.flatMap(s => s.pages)
		.filter(p => p.showcase === true);

	// Update gem count
	const countEl = document.getElementById('labs-gem-count');
	if (countEl) countEl.textContent = allGems.length;

	if (allGems.length === 0) {
		grid.setAttribute('aria-busy', 'false');
		if (emptyEl) emptyEl.setAttribute('aria-hidden', 'false');
		return;
	}

	// Status counter shared across all async checks
	const statusCounter = { total: allGems.length, done: 0, count: 0 };

	// Build and insert cards
	const fragment = document.createDocumentFragment();
	for (const gem of allGems) {
		const card = buildCard(gem);
		fragment.appendChild(card);
	}
	grid.insertBefore(fragment, grid.querySelector('.labs-empty'));
	grid.setAttribute('aria-busy', 'false');

	// Apply current filter
	applyFilter(activeFilter);

	// Attach iframe previews and kick off status checks concurrently
	for (const gem of allGems) {
		const card = grid.querySelector(`.gem-card[data-path="${CSS.escape(gem.path)}"]`);
		if (!card) continue;
		attachPreview(card);
		updateStatus(card, statusCounter);
	}

	// Update result count
	const resultEl = document.getElementById('labs-result-count');
	if (resultEl) {
		resultEl.textContent = `${allGems.length} feature${allGems.length !== 1 ? 's' : ''}`;
	}
}

function init() {
	// Filter buttons
	document.querySelectorAll('.labs-filter').forEach(btn => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.labs-filter').forEach(b => b.classList.remove('active'));
			btn.classList.add('active');
			applyFilter(btn.dataset.cat || 'all');
		});
	});

	// Retry button
	const retryBtn = document.getElementById('labs-retry');
	if (retryBtn) retryBtn.addEventListener('click', load);

	load();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
