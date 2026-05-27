// Public Launchpad renderer — hydrates a /p/<slug> page from
// /api/launchpad/get and wires the CTA to the configured monetization flow.
//
// Self-contained: only depends on the global <agent-3d> custom element
// (registered via /embed.js / agent-3d UMD on the published page) and
// fetch + DOM. No build step needed for this file — Vite copies it to dist
// alongside the HTML.

const AGENT_3D_HOST = 'https://three.ws';

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function short(addr) {
	if (!addr) return '';
	const s = String(addr);
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function priceLabel(m) {
	if (!m || !m.price) return '';
	const n = Number(m.price);
	return isFinite(n) && n > 0 ? `${n} ${m.currency || ''}`.trim() : '';
}

function slugFromPath() {
	const m = location.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/i);
	return m ? m[1].toLowerCase() : '';
}

async function loadConfig(slug) {
	const r = await fetch(`/api/launchpad/get?slug=${encodeURIComponent(slug)}`);
	if (r.status === 404) return { notFound: true };
	if (!r.ok) throw new Error(`Failed to load launchpad (${r.status})`);
	return r.json();
}

function renderError(root, headline, body) {
	root.innerHTML = `
		<div class="error-page">
			<h1>${esc(headline)}</h1>
			<p>${esc(body)}</p>
			<a href="/launchpad">Build your own launchpad →</a>
		</div>
	`;
}

function renderPage(root, payload) {
	const { config, template, slug } = payload;
	const brand = config?.identity?.brand || '#ffffff';
	const theme = config?.identity?.theme === 'dark' ? 'dark' : 'light';
	const headline = config?.copy?.headline || 'three.ws launchpad';
	const tagline = config?.copy?.tagline || '';
	const cta = config?.copy?.cta || 'Get started';
	const website = config?.identity?.website || '';
	const wallet = config?.identity?.wallet || '';
	const avatarSrc = config?.avatar?.src || `${AGENT_3D_HOST}/avatars/default.glb`;
	const monetize = config?.monetize || {};

	document.title = `${headline} — three.ws`;
	document.documentElement.style.setProperty('--brand', brand);

	root.innerHTML = `
		<div class="page ${theme}" style="--brand: ${esc(brand)}">
			<header class="page-header">
				<div class="brand">
					<span class="swatch"></span>
					<span>${esc(headline)}</span>
				</div>
				<nav class="links">
					${website ? `<a href="${esc(website)}" target="_blank" rel="noopener">Website</a>` : ''}
					<a href="${AGENT_3D_HOST}/launchpad?template=${esc(template)}" target="_blank" rel="noopener">Build yours</a>
				</nav>
			</header>
			<div class="hero">
				<div class="hero-copy">
					<h1>${esc(tagline || headline)}</h1>
					<p class="tagline">${esc(extraCopy(payload))}</p>
					<div class="cta-row">
						<button class="cta" type="button" data-cta>${esc(cta)}</button>
						${priceLabel(monetize) ? `<span class="price-chip">${esc(priceLabel(monetize))} per call</span>` : ''}
					</div>
					<div class="status-msg" data-status></div>
				</div>
				<div class="avatar-stage">
					<agent-3d
						src="${esc(avatarSrc)}"
						viewer
						background="transparent"
						camera-controls="auto"
						auto-rotate
					></agent-3d>
				</div>
			</div>
			<footer class="page-footer">
				Hosted on <a href="${AGENT_3D_HOST}" target="_blank" rel="noopener">three.ws</a> ·
				wallet ${esc(short(wallet) || 'not set')} ·
				<a href="${AGENT_3D_HOST}/launchpad?template=${esc(template)}" target="_blank" rel="noopener">build your own</a>
			</footer>
		</div>
	`;

	// Lazy-load agent-3d so we don't block paint.
	if (!customElements.get('agent-3d')) {
		const s = document.createElement('script');
		s.type = 'module';
		s.src = `${AGENT_3D_HOST}/embed.js`;
		document.head.appendChild(s);
	}

	const ctaBtn = root.querySelector('[data-cta]');
	const statusEl = root.querySelector('[data-status]');
	ctaBtn.addEventListener('click', () => onCtaClick(payload, ctaBtn, statusEl));
}

function extraCopy(payload) {
	const { template, config } = payload;
	const m = config?.monetize || {};
	if (template === 'token-launchpad') {
		const t = config?.token || {};
		const name = t.name || 'your token';
		const ticker = t.ticker ? ` ($${t.ticker})` : '';
		return `One click launches ${name}${ticker} on Pump.fun. Creator fees route to ${short(config?.identity?.wallet)}.`;
	}
	if (template === 'paid-concierge') {
		return `Ask anything. Each call costs ${priceLabel(m) || 'a small USDC fee'} and settles instantly to ${short(config?.identity?.wallet)}.`;
	}
	if (template === 'gated-showroom') {
		return `Unlock a private 3D scene with a one-time ${priceLabel(m) || 'USDC pass'}.`;
	}
	return '';
}

// CTA handlers — each template hands off to the relevant real flow.
function onCtaClick(payload, btn, statusEl) {
	const { template, slug, config } = payload;
	if (template === 'token-launchpad') {
		// Pump.fun coin creation lives in the agent token UI. Open the
		// dedicated launch surface with prefilled params; the user signs the
		// transaction in their wallet there.
		const t = config?.token || {};
		const params = new URLSearchParams({
			creator: config?.identity?.wallet || '',
			name: t.name || '',
			ticker: t.ticker || '',
			supply: String(t.supply || ''),
			ref: `launchpad:${slug}`,
		});
		window.open(`${AGENT_3D_HOST}/agent-pumpfun?${params}`, '_blank', 'noopener');
		statusEl.textContent = 'Opened Pump.fun launch in a new tab.';
		statusEl.className = 'status-msg ok';
		return;
	}
	if (template === 'paid-concierge') {
		openConciergeModal(payload, statusEl);
		return;
	}
	if (template === 'gated-showroom') {
		openUnlockModal(payload, statusEl);
		return;
	}
	statusEl.textContent = 'No action wired for this template yet.';
	statusEl.className = 'status-msg err';
}

function openConciergeModal(payload, statusEl) {
	const { slug, config } = payload;
	const m = config?.monetize || {};
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';
	backdrop.innerHTML = `
		<div class="modal" role="dialog" aria-modal="true">
			<h2>Ask the concierge</h2>
			<p>Costs ${esc(priceLabel(m) || 'a small USDC fee')}. Settles to ${esc(short(config?.identity?.wallet))} on ${esc(m.chain || 'base')}.</p>
			<div class="field">
				<label>Your question</label>
				<input type="text" data-q placeholder="What's the best way to..." autofocus />
			</div>
			<div class="status-msg" data-modal-status></div>
			<div class="modal-actions">
				<button class="secondary" data-cancel>Cancel</button>
				<button class="primary" data-pay>Pay ${esc(priceLabel(m) || '')}</button>
			</div>
		</div>
	`;
	document.body.appendChild(backdrop);
	const close = () => backdrop.remove();
	backdrop.querySelector('[data-cancel]').addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	backdrop.querySelector('[data-pay]').addEventListener('click', async () => {
		const q = backdrop.querySelector('[data-q]').value.trim();
		const ms = backdrop.querySelector('[data-modal-status]');
		if (!q) { ms.textContent = 'Type a question first.'; ms.className = 'status-msg err'; return; }
		ms.textContent = 'Requesting payment quote…';
		ms.className = 'status-msg';
		try {
			const r = await fetch(`/api/launchpad/invoke?slug=${encodeURIComponent(slug)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ question: q }),
			});
			if (r.status === 402) {
				const challenge = await r.json();
				ms.innerHTML = `Payment required. Open your x402 wallet — invoice <code>${esc(challenge?.invoice || challenge?.payment?.id || '…')}</code>.`;
				ms.className = 'status-msg';
				return;
			}
			if (!r.ok) throw new Error(`Service error (${r.status})`);
			const data = await r.json();
			ms.textContent = data?.answer || 'Reply received.';
			ms.className = 'status-msg ok';
			statusEl.textContent = 'Concierge replied — see modal.';
			statusEl.className = 'status-msg ok';
		} catch (err) {
			ms.textContent = err.message || 'Something went wrong.';
			ms.className = 'status-msg err';
		}
	});
}

function openUnlockModal(payload, statusEl) {
	const { slug, config } = payload;
	const m = config?.monetize || {};
	const sceneSrc = config?.scene?.src || '';
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';
	backdrop.innerHTML = `
		<div class="modal" role="dialog" aria-modal="true">
			<h2>Unlock the room</h2>
			<p>One-time ${esc(priceLabel(m) || 'USDC pass')} grants 24 h access. Settles to ${esc(short(config?.identity?.wallet))}.</p>
			<div class="status-msg" data-modal-status">Preparing payment…</div>
			<div class="modal-actions">
				<button class="secondary" data-cancel>Cancel</button>
				<button class="primary" data-pay>Pay & enter</button>
			</div>
		</div>
	`;
	document.body.appendChild(backdrop);
	const close = () => backdrop.remove();
	backdrop.querySelector('[data-cancel]').addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	backdrop.querySelector('[data-pay]').addEventListener('click', async () => {
		const ms = backdrop.querySelector('[data-modal-status]');
		ms.textContent = 'Issuing x402 invoice…';
		ms.className = 'status-msg';
		try {
			const r = await fetch(`/api/launchpad/invoke?slug=${encodeURIComponent(slug)}&action=unlock`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sceneSrc }),
			});
			if (r.status === 402) {
				const challenge = await r.json();
				ms.innerHTML = `Pay <code>${esc(challenge?.invoice || challenge?.payment?.id || '…')}</code> in your x402 wallet, then refresh.`;
				ms.className = 'status-msg';
				return;
			}
			if (!r.ok) throw new Error(`Service error (${r.status})`);
			const data = await r.json();
			if (data?.unlockUrl) {
				window.open(data.unlockUrl, '_blank', 'noopener');
				close();
				statusEl.textContent = 'Room unlocked — opened in new tab.';
				statusEl.className = 'status-msg ok';
			} else {
				ms.textContent = 'Unlocked, but no scene URL was returned.';
				ms.className = 'status-msg err';
			}
		} catch (err) {
			ms.textContent = err.message || 'Something went wrong.';
			ms.className = 'status-msg err';
		}
	});
}

// ─────── Boot ───────
const slug = slugFromPath();
const root = document.getElementById('root');

if (!slug) {
	renderError(root, 'No launchpad slug', 'Try /p/<your-slug> or build a new one.');
} else {
	loadConfig(slug)
		.then((payload) => {
			if (payload.notFound) {
				renderError(root, '404 — not found', `No launchpad published at /p/${slug}.`);
				return;
			}
			renderPage(root, payload);
		})
		.catch((err) => {
			renderError(root, 'Could not load launchpad', err.message || String(err));
		});
}
