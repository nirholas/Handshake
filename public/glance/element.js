/**
 * <agent-glance> — a live three.ws agent card for any page.
 *
 *   <script type="module" src="https://three.ws/glance/element.js"></script>
 *   <agent-glance agent="0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34"></agent-glance>
 *
 * Attributes
 *   agent    (required) the agent uuid
 *   size     small | medium | large      default medium
 *   theme    auto | light | dark         default auto
 *   refresh  seconds between refreshes   default 300, 0 disables
 *   origin   override the API origin (self-hosted / staging)
 *
 * This is the hosted, dependency-free build, served the same way the 3D embed
 * is (public/embed/v1.js). The npm client that talks to the same endpoint is
 * @three-ws/agent-glance; it deliberately does not ship a second copy of this
 * element, so there is one implementation of the card UI, not two.
 *
 * The card is real DOM, not an image, so it is selectable, screen-reader
 * readable, keyboard reachable and hoverable. Every state is drawn: skeleton
 * while loading, a retry affordance on failure, an invitation when the agent
 * has never acted. It stops polling when the tab is hidden or the element
 * scrolls out of view, because a decoration that drains a laptop battery gets
 * deleted.
 */

const GLANCE_SIZES = ['small', 'medium', 'large'];
const GLANCE_THEMES = ['auto', 'light', 'dark'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 8000;

async function fetchGlanceCard(agentId, { origin } = {}) {
	if (!UUID_RE.test(String(agentId || ''))) {
		const err = new Error('not a three.ws agent id');
		err.status = 400;
		throw err;
	}
	const url = new URL('/api/glance/card', origin || location.origin);
	url.searchParams.set('agent', agentId);
	const res = await fetch(url, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		const err = new Error(`three.ws answered ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}


const SIZE_WIDTH = { small: 240, medium: 480, large: 480 };

const STYLE = `
:host{display:inline-block;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color-scheme:light dark}
:host([hidden]){display:none}
.card{--bg:#fff;--panel:#f4f5f9;--text:#0b0b18;--muted:#5b5f73;--line:#e4e6ef;
 position:relative;display:block;box-sizing:border-box;width:100%;padding:20px;border:1px solid var(--line);
 border-radius:20px;background:var(--bg);color:var(--text);text-decoration:none;overflow:hidden;
 transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.card::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--from),var(--to))}
.card::after{content:'';position:absolute;inset:-40% 55% 30% -30%;background:radial-gradient(circle,var(--from),transparent 68%);opacity:.16;pointer-events:none}
a.card:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(8,8,20,.16);border-color:var(--from)}
a.card:active{transform:translateY(0)}
a.card:focus-visible{outline:2px solid var(--from);outline-offset:3px}
@media (prefers-reduced-motion:reduce){.card,a.card:hover{transition:none;transform:none}}
@media (prefers-color-scheme:dark){.card{--bg:#0b0b16;--panel:#15162a;--text:#f6f7fb;--muted:#a2a7bd;--line:#262842}}
:host([theme="dark"]) .card{--bg:#0b0b16;--panel:#15162a;--text:#f6f7fb;--muted:#a2a7bd;--line:#262842}
:host([theme="light"]) .card{--bg:#fff;--panel:#f4f5f9;--text:#0b0b18;--muted:#5b5f73;--line:#e4e6ef}
.top{display:flex;gap:14px;align-items:center;position:relative}
.pic{width:56px;height:56px;border-radius:16px;flex:0 0 auto;object-fit:cover;background:linear-gradient(135deg,var(--from),var(--to));
 display:grid;place-items:center;color:#fff;font-weight:700;font-size:22px}
.who{min-width:0;flex:1 1 auto}
.name{font-weight:700;font-size:18px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{font-size:12.5px;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#64748b}
.dot[data-status="active"]{background:#22c55e}
.dot[data-status="idle"]{background:#f59e0b}
.metric{display:flex;align-items:baseline;gap:8px;margin-top:18px}
.metric b{font-size:38px;line-height:1;font-weight:800;letter-spacing:-.02em}
.metric span{font-size:13px;color:var(--muted)}
.last{margin-top:6px;font-size:11.5px;color:var(--muted)}
.stats{display:flex;gap:8px;margin-top:16px}
.stat{flex:1 1 0;background:var(--panel);border-radius:12px;padding:8px 10px;min-width:0}
.stat b{display:block;font-size:15px}
.stat span{font-size:10.5px;color:var(--muted)}
:host([size="small"]) .stats,:host([size="small"]) .sub{display:none}
:host([size="small"]) .metric b{font-size:32px}
:host([size="medium"]) .stats{display:none}
:host([size="medium"]) .rail{position:absolute;right:0;top:52px;text-align:right;font-size:12px;color:var(--muted);line-height:1.9}
:host([size="medium"]) .rail b{color:var(--text)}
:host(:not([size="medium"])) .rail{display:none}
.skel{animation:pulse 1.4s ease-in-out infinite;background:var(--panel);border-radius:8px;color:transparent}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.skel{animation:none}}
.err{font-size:12.5px;color:var(--muted)}
button{font:inherit;font-size:12px;margin-top:10px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);
 background:var(--panel);color:var(--text);cursor:pointer;transition:border-color .15s ease}
button:hover{border-color:var(--from)}
button:focus-visible{outline:2px solid var(--from);outline-offset:2px}
`;

export class AgentGlanceElement extends HTMLElement {
	static observedAttributes = ['agent', 'size', 'theme', 'refresh', 'origin'];

	#root = this.attachShadow({ mode: 'open' });
	#timer = null;
	#observer = null;
	#visible = true;
	#card = null;
	#loading = false;

	connectedCallback() {
		if (!this.hasAttribute('size')) this.setAttribute('size', 'medium');
		this.#root.innerHTML = `<style>${STYLE}</style><div class="host"></div>`;
		this.#renderSkeleton();
		this.#watchVisibility();
		this.#load();
	}

	disconnectedCallback() {
		this.#stopTimer();
		this.#observer?.disconnect();
		document.removeEventListener('visibilitychange', this.#onVisibility);
	}

	attributeChangedCallback(name, before, after) {
		if (before === after || !this.isConnected) return;
		if (name === 'refresh') return this.#scheduleRefresh();
		this.#load();
	}

	get #size() {
		const size = this.getAttribute('size');
		return GLANCE_SIZES.includes(size) ? size : 'medium';
	}

	get #theme() {
		const theme = this.getAttribute('theme');
		return GLANCE_THEMES.includes(theme) ? theme : 'auto';
	}

	get #refreshMs() {
		const seconds = Number(this.getAttribute('refresh'));
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		return 300_000;
	}

	#onVisibility = () => {
		this.#visible = !document.hidden;
		this.#scheduleRefresh();
	};

	#watchVisibility() {
		document.addEventListener('visibilitychange', this.#onVisibility);
		if (typeof IntersectionObserver === 'function') {
			this.#observer = new IntersectionObserver((entries) => {
				const onScreen = entries.some((e) => e.isIntersecting);
				if (onScreen !== this.#visible) {
					this.#visible = onScreen;
					this.#scheduleRefresh();
				}
			});
			this.#observer.observe(this);
		}
	}

	#stopTimer() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	#scheduleRefresh() {
		this.#stopTimer();
		const every = this.#refreshMs;
		if (!every || !this.#visible || !this.isConnected) return;
		this.#timer = setTimeout(() => this.#load(), every);
	}

	async #load() {
		const agent = this.getAttribute('agent');
		if (!agent) return this.#renderError('No agent id set on this element.', false);
		if (this.#loading) return;
		this.#loading = true;
		try {
			const card = await fetchGlanceCard(agent, { origin: this.getAttribute('origin') || undefined });
			this.#card = card;
			this.#renderCard(card);
			this.dispatchEvent(new CustomEvent('glance:load', { detail: card, bubbles: true }));
		} catch (err) {
			// A card that already rendered keeps what it has: a blip must not blank
			// out a working card on someone else's page.
			if (this.#card) this.#renderCard(this.#card, { stale: true });
			else this.#renderError(describe(err), true);
			this.dispatchEvent(new CustomEvent('glance:error', { detail: err, bubbles: true }));
		} finally {
			this.#loading = false;
			this.#scheduleRefresh();
		}
	}

	#host() {
		return this.#root.querySelector('.host');
	}

	#renderSkeleton() {
		this.#host().innerHTML = `
<div class="card" style="--from:#8b8fa3;--to:#5b5f73" aria-busy="true" aria-label="Loading agent card">
	<div class="top"><div class="pic skel"></div><div class="who">
		<div class="name skel">Loading agent</div><div class="sub skel">Fetching live activity</div>
	</div></div>
	<div class="metric"><b class="skel">00</b><span class="skel">moves today</span></div>
	<div class="stats"><div class="stat skel"><b>0</b><span>.</span></div><div class="stat skel"><b>0</b><span>.</span></div><div class="stat skel"><b>0</b><span>.</span></div></div>
</div>`;
	}

	#renderError(message, retryable) {
		this.#host().innerHTML = `
<div class="card" style="--from:#8b8fa3;--to:#5b5f73" role="group" aria-label="Agent card unavailable">
	<div class="top"><div class="pic">3</div><div class="who">
		<div class="name">Card unavailable</div><div class="sub">three.ws</div>
	</div></div>
	<p class="err">${escapeHtml(message)}</p>
	${retryable ? '<button type="button" part="retry">Try again</button>' : ''}
</div>`;
		this.#host()
			.querySelector('button')
			?.addEventListener('click', () => {
				this.#renderSkeleton();
				this.#load();
			});
	}

	#renderCard(card, { stale = false } = {}) {
		const width = SIZE_WIDTH[this.#size];
		this.style.maxWidth = `${width}px`;
		const sub = stale ? `${card.headline} (offline)` : card.description || card.headline;
		const portrait = card.image
			? `<img class="pic" src="${escapeHtml(card.image)}" alt="" loading="lazy" decoding="async">`
			: `<div class="pic" aria-hidden="true">${escapeHtml(card.monogram)}</div>`;
		const rail = card.stats
			.map((s) => `${escapeHtml(s.label)} <b>${escapeHtml(s.value)}</b>`)
			.join('<br>');
		const stats = card.stats
			.map((s) => `<div class="stat"><b>${escapeHtml(s.value)}</b><span>${escapeHtml(s.label)}</span></div>`)
			.join('');
		const last = card.lastAction
			? `last: ${escapeHtml(card.lastAction.type)} ${escapeHtml(card.lastAction.relative)}`
			: 'no activity yet';

		this.#host().innerHTML = `
<a class="card" href="${escapeHtml(card.url)}" style="--from:${escapeHtml(card.accent.from)};--to:${escapeHtml(card.accent.to)}"
   aria-label="${escapeHtml(`${card.name}: ${card.metric.value} ${card.metric.label.toLowerCase()}. Open on three.ws`)}">
	<div class="top">
		${portrait}
		<div class="who">
			<div class="name">${escapeHtml(card.name)}</div>
			<div class="sub">${escapeHtml(sub)}</div>
		</div>
		<span class="dot" data-status="${escapeHtml(card.status)}" title="${escapeHtml(card.status)}"></span>
	</div>
	<div class="rail">${rail}</div>
	<div class="metric"><b>${escapeHtml(card.metric.value)}</b><span>${escapeHtml(card.metric.label.toLowerCase())}</span></div>
	<div class="last">${last}</div>
	<div class="stats">${stats}</div>
</a>`;
	}
}

function describe(err) {
	if (err?.status === 404) return 'That agent is not on three.ws.';
	return 'Could not reach three.ws just now.';
}

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

if (typeof customElements !== 'undefined' && !customElements.get('agent-glance')) {
	customElements.define('agent-glance', AgentGlanceElement);
}
