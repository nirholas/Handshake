// dashboard-next — IRL agent reputation panel (C3).
//
// A read-only, on-chain reputation surface attached to each placement card in
// irl-placements.js. The headline score + trust tier come from the agent-card
// the dashboard already fetched (the exact figures a passer-by sees on the B2
// tap card, so the owner sees what the public sees); the verified / credentialed
// / disputed breakdown is loaded lazily from /api/agents/solana-reputation the
// first time the owner opens the panel. Solana attestations are the canonical
// reputation source. Writing / disputing attestations lives on the passport —
// this panel only links out there.

import {
	skeletonHTML,
	emptyStateHTML,
	errorStateHTML,
	ensureStateKitStyles,
	attachRetry,
} from '../../shared/state-kit.js';

const STYLE_ID = 'irl-rep-styles';

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = REP_CSS;
	(document.head || document.documentElement).appendChild(s);
}

// Score-band tiers (elite/trusted/emerging/new) — the same bands agent-card
// derives server-side, so the dashboard badge matches the public B2 tap card.
const TIERS = {
	elite:    { label: 'Elite',    color: '#fbbf24' },
	trusted:  { label: 'Trusted',  color: '#4ade80' },
	emerging: { label: 'Emerging', color: '#60a5fa' },
	new:      { label: 'New',      color: 'var(--nxt-ink-faint, #8a8f98)' },
};
const tierMeta = (tier) => TIERS[tier] || TIERS.new;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Attach the reputation panel to a placement card. Idempotent per card.
 *
 * @param {HTMLElement} card  The `.irl-card` element.
 * @param {object} opts
 * @param {object|null} opts.reputation  `card.reputation` from /api/irl/agent-card —
 *   `{ asset, available, score, tier, unique_attesters, ... }` or `{ asset:null, available:false }`.
 * @param {string} opts.agentId  The placed agent's id, for the passport deep-link.
 * @param {string} [opts.pinId]  The pin id, for the "View in IRL" deep-link.
 */
export function mountReputationPanel(card, { reputation, agentId, pinId } = {}) {
	if (!card || !agentId) return;
	if (card.querySelector('[data-reputation]')) return; // already mounted

	ensureStateKitStyles();
	ensureStyles();

	const asset    = reputation?.asset || null;
	const network  = reputation?.network || 'mainnet';
	const passport = `/agents/${encodeURIComponent(agentId)}`;
	const irlHref  = pinId ? `/irl?pin=${encodeURIComponent(pinId)}` : '/irl';

	// Collapsible section, inserted right after the stat chips.
	const section = document.createElement('div');
	section.className = 'irl-section irl-rep-section';
	section.setAttribute('data-reputation', '');
	section.hidden = true;
	section.id = `irl-rep-${pinId || agentId}`;
	section.innerHTML = `
		<div class="irl-section-label">Reputation
			<a href="${passport}" target="_blank" rel="noopener">Manage on passport →</a></div>
		<div class="irl-rep-body" data-rep-body></div>`;
	const stats = card.querySelector('.irl-stats');
	(stats || card).insertAdjacentElement(stats ? 'afterend' : 'beforeend', section);

	// The Reputation stat chip becomes the open/close affordance.
	const chip = card.querySelector('[data-stat="reputation"]');
	if (chip) {
		chip.classList.add('irl-stat--btn');
		chip.setAttribute('role', 'button');
		chip.setAttribute('tabindex', '0');
		chip.setAttribute('aria-expanded', 'false');
		chip.setAttribute('aria-controls', section.id);
		chip.title = 'View on-chain reputation';
	}

	const body = section.querySelector('[data-rep-body]');
	let loaded = false;

	function setOpen(open) {
		section.hidden = !open;
		chip?.setAttribute('aria-expanded', String(open));
		if (open && !loaded) { loaded = true; load(); }
	}

	async function load() {
		// No Solana asset → designed empty state, never an error.
		if (!asset) {
			body.innerHTML = emptyStateHTML({
				compact: true,
				icon: '',
				title: 'No on-chain identity yet',
				body: 'This agent has no Solana asset, so it can’t accrue attestations.',
				actions: [{ label: 'Open passport', href: passport, primary: true }],
			});
			return;
		}

		body.innerHTML = skeletonHTML(1, 'text');
		try {
			const r = await fetch(
				`/api/agents/solana-reputation?asset=${encodeURIComponent(asset)}&network=${encodeURIComponent(network)}`,
			);
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = await r.json();
			const fb = data.feedback || {};

			// Asset exists but no attestations yet → encourage sharing, not an error.
			if (!fb.total) {
				body.innerHTML = emptyStateHTML({
					compact: true,
					icon: '',
					title: 'No attestations yet',
					body: 'Share this agent so people can vouch for it — paid interactions and validations leave on-chain reputation here.',
					actions: [
						{ label: 'Open passport', href: passport, primary: true },
						{ label: 'View in IRL', href: irlHref },
					],
				});
				return;
			}

			body.innerHTML = panelHtml(reputation, fb);
			loadTrend(body, asset, network, reputation);
		} catch {
			body.innerHTML = errorStateHTML({
				title: 'Couldn’t load reputation',
				body: 'The on-chain reputation service didn’t respond. Check your connection and try again.',
			});
			attachRetry(body, () => { body.innerHTML = ''; load(); });
		}
	}

	chip?.addEventListener('click', () => setOpen(section.hidden));
	chip?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(section.hidden); }
	});
}

function panelHtml(rep, fb) {
	const score = Number.isFinite(rep?.score) ? rep.score : 0;
	const t = tierMeta(rep?.tier || 'new');
	const stars = Number(fb.score_avg_weighted || 0);
	const total = fb.total || 0;
	const uniq = fb.unique_attesters || 0;
	const verified = fb.verified || 0;
	const credentialed = fb.credentialed || 0;
	const disputed = fb.disputed || 0;

	return `
		<div class="irl-rep-panel">
			<div class="irl-rep-ring" style="--rep-pct:${score};--rep-color:${t.color}"
				role="img" aria-label="Reputation score ${score} out of 100">
				<span class="irl-rep-score">${score}</span><span class="irl-rep-of">/100</span>
			</div>
			<div class="irl-rep-main">
				<span class="irl-rep-tier" style="--rep-color:${t.color}">${t.label}</span>
				<div class="irl-rep-stars">${stars ? `★ ${stars.toFixed(1)}` : '☆ —'}
					<span class="irl-rep-sub">· ${plural(total, 'attestation')} · ${plural(uniq, 'attester')}</span></div>
				<div class="irl-rep-breakdown">
					<span class="irl-rep-chip ${verified ? 'ok' : ''}">${verified} verified</span>
					<span class="irl-rep-chip ${credentialed ? 'cred' : ''}">${credentialed} credentialed</span>
					<span class="irl-rep-chip ${disputed ? 'bad' : ''}">${disputed} disputed</span>
				</div>
			</div>
		</div>
		<div class="irl-rep-trend" data-rep-trend hidden></div>`;
}

// History sparkline — optional, loaded after the panel paints. Stays silent on
// any failure (incl. 404 / sparse data): the trend is a bonus, never a blocker,
// so it must not surface an error or shift layout when there's nothing to draw.
async function loadTrend(body, asset, network, rep) {
	const slot = body?.querySelector('[data-rep-trend]');
	if (!slot) return;
	try {
		const r = await fetch(
			`/api/agents/solana-reputation-history?asset=${encodeURIComponent(asset)}&network=${encodeURIComponent(network)}&days=30`,
		);
		if (!r.ok) return;
		const { series } = await r.json();
		if (!Array.isArray(series) || series.length < 2) return; // need ≥2 points to draw a line
		slot.innerHTML = sparklineHtml(series, tierMeta(rep?.tier || 'new').color);
		slot.hidden = false;
	} catch { /* trend is optional — never surface an error */ }
}

// Tiny inline-SVG sparkline of the daily reputation score (1–5 band) over the
// trailing window. Stretches to the card width (preserveAspectRatio none) with a
// non-scaling stroke so the line stays crisp; a faint area fill reads as trend at
// a glance. A flat series renders as a centered line rather than a floor-hugging one.
function sparklineHtml(series, color) {
	const W = 220, H = 34, pad = 4;
	const scores = series.map((p) => Number(p.score) || 0);
	const n = scores.length;
	const min = Math.min(...scores), max = Math.max(...scores);
	const flat = max === min;
	const px = (i) => +((i / (n - 1)) * (W - pad * 2) + pad).toFixed(1);
	const py = (s) => flat ? H / 2 : +(H - pad - ((s - min) / (max - min)) * (H - pad * 2)).toFixed(1);
	const line = scores.map((s, i) => `${px(i)},${py(s)}`).join(' ');
	const area = `${pad},${H} ${line} ${W - pad},${H}`;
	const first = scores[0], last = scores[n - 1];
	const trend = last > first ? 'trending up' : last < first ? 'trending down' : 'steady';
	const label = `Reputation trend over the last ${n} days: ${trend}; latest score ${last.toFixed(1)} of 5`;
	return `<svg class="irl-rep-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
			role="img" aria-label="${label}" style="--spark:${color}">
			<polygon class="irl-rep-spark-area" points="${area}" />
			<polyline class="irl-rep-spark-line" points="${line}" />
		</svg>
		<span class="irl-rep-spark-cap">${n}-day trend · latest ★ ${last.toFixed(1)}</span>`;
}

const REP_CSS = `
.irl-rep-section .irl-rep-body { min-height: 24px; }
.irl-rep-panel { display: flex; align-items: center; gap: 14px; }
.irl-rep-ring {
	--sz: 58px;
	width: var(--sz); height: var(--sz); border-radius: 50%; flex-shrink: 0;
	display: flex; align-items: baseline; justify-content: center;
	background: conic-gradient(var(--rep-color) calc(var(--rep-pct) * 1%), var(--nxt-stroke, rgba(255,255,255,.1)) 0);
	position: relative;
}
.irl-rep-ring::before {
	content: ''; position: absolute; inset: 4px; border-radius: 50%;
	background: var(--nxt-panel, var(--nxt-bg-1, #0d1018));
}
.irl-rep-score { position: relative; font-size: 19px; font-weight: 800; color: var(--nxt-ink, #e8e8e8); font-variant-numeric: tabular-nums; line-height: 1; }
.irl-rep-of { position: relative; font-size: 10px; font-weight: 600; color: var(--nxt-ink-faint, #8a8f98); margin-left: 1px; }
.irl-rep-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.irl-rep-tier {
	align-self: flex-start; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
	color: var(--rep-color); background: color-mix(in srgb, var(--rep-color) 14%, transparent);
	border: 1px solid color-mix(in srgb, var(--rep-color) 34%, transparent); padding: 2px 9px; border-radius: 999px;
}
.irl-rep-stars { font-size: 13px; font-weight: 700; color: #fbbf24; }
.irl-rep-sub { color: var(--nxt-ink-faint, #8a8f98); font-weight: 500; }
.irl-rep-breakdown { display: flex; flex-wrap: wrap; gap: 6px; }
.irl-rep-chip {
	font-size: 11px; padding: 2px 8px; border-radius: 999px; font-variant-numeric: tabular-nums;
	background: var(--nxt-bg-2, rgba(255,255,255,.05)); border: 1px solid var(--nxt-stroke, rgba(255,255,255,.1));
	color: var(--nxt-ink-dim, #aab1bb);
}
.irl-rep-chip.ok { color: var(--nxt-success, #4ade80); border-color: color-mix(in srgb, var(--nxt-success, #4ade80) 30%, transparent); }
.irl-rep-chip.cred { color: #a78bfa; border-color: color-mix(in srgb, #a78bfa 30%, transparent); }
.irl-rep-chip.bad { color: var(--nxt-danger, #f87171); border-color: color-mix(in srgb, var(--nxt-danger, #f87171) 30%, transparent); }
.irl-rep-trend { margin-top: 12px; display: flex; flex-direction: column; gap: 3px; }
.irl-rep-spark { width: 100%; height: 34px; display: block; overflow: visible; }
.irl-rep-spark-line { fill: none; stroke: var(--spark, var(--nxt-accent, #4ea1ff)); stroke-width: 1.6; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.irl-rep-spark-area { fill: var(--spark, var(--nxt-accent, #4ea1ff)); opacity: .1; }
.irl-rep-spark-cap { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--nxt-ink-faint, #8a8f98); }
.irl-stat--btn { cursor: pointer; transition: border-color .12s, background .12s; }
.irl-stat--btn:hover { border-color: var(--nxt-stroke-strong, rgba(255,255,255,.25)); }
.irl-stat--btn:focus-visible { outline: 2px solid var(--nxt-accent, #4ea1ff); outline-offset: 2px; }
.irl-stat--btn .v { color: var(--nxt-accent, #4ea1ff); }
@media (prefers-reduced-motion: no-preference) {
	.irl-rep-section[data-reputation]:not([hidden]) .irl-rep-panel { animation: irl-rep-in .18s ease both; }
	.irl-rep-trend { animation: irl-rep-in .2s ease both; }
}
@keyframes irl-rep-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
`;
