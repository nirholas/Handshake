/**
 * Homepage token launcher — wires "Launch yours" to the real pump.fun launch
 * flow without leaving the homepage.
 *
 * Flow:
 *   - Resolve the signed-in user's agents (GET /api/agents).
 *   - Signed out          → prompt to sign in.
 *   - Signed in, 0 agents → prompt to create an agent.
 *   - Signed in, ≥1 agent → pick an agent, then open the real LaunchTokenModal
 *                           (deploy-on-Solana step included when needed).
 *
 * No mock launches: every path lands in the production launch pipeline
 * (/api/agents/tokens/launch-prep → wallet sign → launch-confirm).
 */

const AGENTS_URL = '/api/agents';

function esc(s) {
	return String(s ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}

function ensureModalCss() {
	if (document.querySelector('link[data-ltm-css]')) return;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = '/src/pump/launch-token-modal.css';
	link.setAttribute('data-ltm-css', '');
	document.head.appendChild(link);
}

function ensurePickerCss() {
	if (document.getElementById('hpl-styles')) return;
	const style = document.createElement('style');
	style.id = 'hpl-styles';
	style.textContent = `
		.hpl-intro { font-size: .86rem; color: rgba(255,255,255,.6); line-height: 1.5; }
		.hpl-list { display: flex; flex-direction: column; gap: .5rem; }
		.hpl-item {
			display: flex; align-items: center; gap: .75rem; width: 100%;
			padding: .65rem .7rem; border-radius: 10px; text-align: left;
			background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
			color: #e5e5e5; font: inherit; cursor: pointer;
			transition: background .15s, border-color .15s, transform .12s;
		}
		.hpl-item:hover:not(:disabled) { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.18); }
		.hpl-item:active:not(:disabled) { transform: scale(.99); }
		.hpl-item:focus-visible { outline: 2px solid rgba(120,200,140,.7); outline-offset: 2px; }
		.hpl-item:disabled { cursor: default; opacity: .85; }
		.hpl-ava {
			width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
			display: flex; align-items: center; justify-content: center;
			background: linear-gradient(135deg,#2a2a3a,#15151f);
			font: 600 12px var(--font-mono, monospace); color: #fff;
		}
		.hpl-ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
		.hpl-meta { flex: 1; min-width: 0; }
		.hpl-name { font-size: .9rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
		.hpl-sub { font-size: .68rem; color: rgba(255,255,255,.4); margin-top: 1px; }
		.hpl-pill {
			flex-shrink: 0; font: 600 .62rem/1 var(--font-mono, monospace);
			letter-spacing: .04em; text-transform: uppercase;
			padding: .32rem .5rem; border-radius: 99px; white-space: nowrap;
		}
		.hpl-pill.ready  { background: rgba(120,200,140,.16); color: #5fd08a; }
		.hpl-pill.deploy { background: rgba(255,255,255,.08); color: rgba(255,255,255,.7); }
		.hpl-pill.live   { background: rgba(120,200,140,.16); color: #5fd08a; }
		.hpl-empty { text-align: center; padding: .5rem 0 .25rem; }
		.hpl-empty-emoji { font-size: 2rem; }
		.hpl-empty-title { font-size: .95rem; font-weight: 600; color: #fff; margin: .5rem 0 .3rem; }
		.hpl-empty-sub { font-size: .8rem; color: rgba(255,255,255,.55); line-height: 1.5; }
		.hpl-spinner {
			width: 14px; height: 14px; border-radius: 50%; display: inline-block;
			border: 2px solid rgba(255,255,255,.2); border-top-color: rgba(255,255,255,.7);
			animation: hpl-spin .8s linear infinite; vertical-align: -2px; margin-right: .4rem;
		}
		@keyframes hpl-spin { to { transform: rotate(360deg); } }
	`;
	document.head.appendChild(style);
}

class LaunchPicker {
	constructor() {
		this.overlay = null;
		this.keyHandler = null;
	}

	open() {
		ensureModalCss();
		ensurePickerCss();
		if (this.overlay) return;
		const el = document.createElement('div');
		el.className = 'ltm-overlay';
		document.body.appendChild(el);
		this.overlay = el;
		el.addEventListener('click', (e) => {
			if (e.target === el) this.close();
		});
		this.keyHandler = (e) => {
			if (e.key === 'Escape') this.close();
		};
		window.addEventListener('keydown', this.keyHandler);
		requestAnimationFrame(() => el.classList.add('ltm-open'));
		this._renderLoading();
		this._load();
	}

	close() {
		if (!this.overlay) return;
		this.overlay.classList.remove('ltm-open');
		const el = this.overlay;
		this.overlay = null;
		setTimeout(() => el.remove(), 200);
		if (this.keyHandler) {
			window.removeEventListener('keydown', this.keyHandler);
			this.keyHandler = null;
		}
	}

	_shell(title, body, footer) {
		return `
		<div class="ltm-modal" role="dialog" aria-modal="true" aria-label="Launch a token">
			<div class="ltm-header">
				<span class="ltm-title">${esc(title)}</span>
				<div class="ltm-header-right">
					<button class="ltm-close" aria-label="Close">×</button>
				</div>
			</div>
			<div class="ltm-body">${body}</div>
			<div class="ltm-footer">${footer}</div>
		</div>`;
	}

	_paint(html) {
		if (!this.overlay) return;
		this.overlay.innerHTML = html;
		this.overlay.querySelector('.ltm-close')?.addEventListener('click', () => this.close());
	}

	_renderLoading() {
		this._paint(
			this._shell(
				'Launch a token',
				`<div class="hpl-intro"><span class="hpl-spinner"></span>Loading your agents…</div>`,
				`<div></div><button class="ltm-btn" id="hpl-cancel">Cancel</button>`,
			),
		);
		this.overlay.querySelector('#hpl-cancel')?.addEventListener('click', () => this.close());
	}

	async _load() {
		let resp;
		try {
			resp = await fetch(AGENTS_URL, { credentials: 'include', headers: { accept: 'application/json' } });
		} catch {
			this._renderError();
			return;
		}
		if (resp.status === 401) {
			this._renderSignedOut();
			return;
		}
		if (!resp.ok) {
			this._renderError();
			return;
		}
		let agents = [];
		try {
			const data = await resp.json();
			agents = Array.isArray(data?.agents) ? data.agents : [];
		} catch {
			this._renderError();
			return;
		}
		if (!agents.length) {
			this._renderNoAgents();
			return;
		}
		this._renderPicker(agents);
	}

	_renderSignedOut() {
		this._paint(
			this._shell(
				'Launch your agent’s token',
				`<div class="hpl-empty">
					<div class="hpl-empty-emoji">🚀</div>
					<div class="hpl-empty-title">Sign in to launch on pump.fun</div>
					<div class="hpl-empty-sub">
						Tie a real Solana token to your 3D agent — name, ticker, and image set
						from your avatar. You'll sign the launch in your own wallet.
					</div>
				</div>`,
				`<button class="ltm-btn" id="hpl-cancel">Cancel</button>
				<a class="ltm-btn ltm-btn-primary" href="/login?next=/create">Sign in →</a>`,
			),
		);
		this.overlay.querySelector('#hpl-cancel')?.addEventListener('click', () => this.close());
	}

	_renderNoAgents() {
		this._paint(
			this._shell(
				'Create an agent first',
				`<div class="hpl-empty">
					<div class="hpl-empty-emoji">🎭</div>
					<div class="hpl-empty-title">Every token starts with an avatar</div>
					<div class="hpl-empty-sub">
						Create a 3D agent in under a minute — drop a selfie or pick a model —
						then launch its token straight from here.
					</div>
				</div>`,
				`<button class="ltm-btn" id="hpl-cancel">Cancel</button>
				<a class="ltm-btn ltm-btn-primary" href="/create">Create an agent →</a>`,
			),
		);
		this.overlay.querySelector('#hpl-cancel')?.addEventListener('click', () => this.close());
	}

	_renderError() {
		this._paint(
			this._shell(
				'Launch a token',
				`<div class="hpl-empty">
					<div class="hpl-empty-emoji">⚠️</div>
					<div class="hpl-empty-title">Couldn't load your agents</div>
					<div class="hpl-empty-sub">Check your connection and try again.</div>
				</div>`,
				`<button class="ltm-btn" id="hpl-cancel">Close</button>
				<button class="ltm-btn ltm-btn-primary" id="hpl-retry">Retry</button>`,
			),
		);
		this.overlay.querySelector('#hpl-cancel')?.addEventListener('click', () => this.close());
		this.overlay.querySelector('#hpl-retry')?.addEventListener('click', () => {
			this._renderLoading();
			this._load();
		});
	}

	_renderPicker(agents) {
		const rows = agents
			.map((a, i) => {
				const launched = !!a.token?.mint;
				const deployed = a.onchain?.family === 'solana';
				const sym = a.token?.symbol ? `$${esc(a.token.symbol)}` : '';
				const initials = esc(String(a.name || 'A').trim().slice(0, 2).toUpperCase());
				const thumb = a.avatar_thumbnail_url;
				const ava = thumb
					? `<span class="hpl-ava"><img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
					: `<span class="hpl-ava">${initials}</span>`;
				let pill;
				let sub;
				if (launched) {
					pill = `<span class="hpl-pill live">Live ${sym}</span>`;
					sub = 'Token already launched — view on pump.fun';
				} else if (deployed) {
					pill = `<span class="hpl-pill ready">Ready</span>`;
					sub = 'Deployed on Solana · launch its token';
				} else {
					pill = `<span class="hpl-pill deploy">Deploy + launch</span>`;
					sub = 'Deploys on Solana, then launches the token';
				}
				return `<button class="hpl-item" data-i="${i}" ${launched ? 'data-launched="1"' : ''}>
					${ava}
					<span class="hpl-meta">
						<span class="hpl-name">${esc(a.name || 'Untitled agent')}</span>
						<span class="hpl-sub">${sub}</span>
					</span>
					${pill}
				</button>`;
			})
			.join('');

		this._paint(
			this._shell(
				'Choose an agent to tokenize',
				`<div class="hpl-intro">Launch a real pump.fun token tied to your agent. You'll sign every transaction in your own wallet.</div>
				<div class="hpl-list">${rows}</div>`,
				`<a class="ltm-btn" href="/create">+ New agent</a>
				<button class="ltm-btn ltm-btn-primary" id="hpl-cancel">Done</button>`,
			),
		);
		this.overlay.querySelector('#hpl-cancel')?.addEventListener('click', () => this.close());
		this.overlay.querySelectorAll('.hpl-item').forEach((btn) => {
			btn.addEventListener('click', () => {
				const a = agents[Number(btn.dataset.i)];
				if (!a) return;
				if (a.token?.mint) {
					window.open(`https://pump.fun/coin/${a.token.mint}`, '_blank', 'noopener');
					return;
				}
				this._launch(a);
			});
		});
	}

	async _launch(agent) {
		const { openLaunchTokenModal } = await import('/src/pump/launch-token-modal.js');
		const onchain = agent.onchain || agent.meta?.onchain || null;
		const needsDeploy = !onchain || onchain.family !== 'solana';
		const imageUrl = agent.avatar_thumbnail_url || agent.meta?.thumbnail_url || '';
		this.close();
		openLaunchTokenModal({
			agentId: agent.id,
			agentName: agent.name || 'Agent',
			imageUrl,
			needsDeploy,
			agentForDeploy: needsDeploy
				? {
						id: agent.id,
						name: agent.name || 'Agent',
						description: agent.description || '',
						avatar_id: agent.avatar_id || null,
						skills: agent.skills || undefined,
					}
				: null,
		});
	}
}

export function initHomepageLauncher(button) {
	if (!button) return;
	button.addEventListener('click', (e) => {
		e.preventDefault();
		new LaunchPicker().open();
	});
}
