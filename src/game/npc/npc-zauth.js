// zauth — the town's security agent.
//
// zauth (zauth.inc) runs RepoScan, a real paid x402 service: $0.05 USDC buys
// a GitHub repository scan for code provenance, contributor verification,
// and vulnerabilities, returning a 0–100 trust score with a full written
// analysis. Their agent stands in the $THREE town plaza; WALKING UP to it
// calls their x402 endpoint live (the unpaid probe that draws the 402
// payment challenge) and opens the scanner with the real price and terms
// from that challenge. Press the scan button and window.X402.pay settles
// $0.05 from YOUR wallet straight to zauth's address — Solana or Base — via
// the same-origin pass-through at /api/zauth-reposcan (their CORS blocks a
// direct browser payment; the proxy forwards your signed payment untouched).
//
// Scans run 3–6 minutes on zauth's side. The scan keeps polling after the
// panel closes: wander off, and the agent shouts when your report is ready.
//
// Self-contained: reuses the .npc-svc-* panel chrome + the shared overlay
// lifecycle, with a small .zauth-* stylesheet injected once.

import { ensureX402 } from '../../shared/x402-loader.js';
import { log } from '../../shared/log.js';
import { renderMarkdown } from '../../shared/markdown.js';

const ENDPOINT = '/api/zauth-reposcan';
const DEFAULT_REPO = 'nirholas/three.ws';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const POLL_MS = 5000;
const SCAN_MAX_MS = 15 * 60_000;
const ACCENT = '#46d49a';
const ACCENT_LT = '#8df0c4';

// ── tiny DOM helper (mirrors npc-services.js conventions) ─────────────────────
function el(tag, attrs, kids) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === 'class') node.className = v;
			else if (k === 'text') node.textContent = v;
			else if (k.startsWith('on') && typeof v === 'function')
				node.addEventListener(k.slice(2).toLowerCase(), v);
			else node.setAttribute(k, v === true ? '' : v);
		}
	}
	for (const kid of [].concat(kids || [])) {
		if (kid == null || kid === false) continue;
		node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return node;
}

function injectStyles() {
	if (document.getElementById('zauth-term-styles')) return;
	const s = document.createElement('style');
	s.id = 'zauth-term-styles';
	s.textContent = `
	.npc-svc-card.is-zauth { max-width: 680px; }
	.zauth-live { display:inline-flex; align-items:center; gap:5px; font-size:10px; font-weight:800; letter-spacing:0.08em; color:${ACCENT}; }
	.zauth-live::before { content:''; width:7px; height:7px; border-radius:50%; background:${ACCENT}; box-shadow:0 0 8px ${ACCENT}; animation:zauth-pulse 1.6s ease-in-out infinite; }
	@keyframes zauth-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
	.zauth-ask { font-size:13px; color:var(--cc-text,#e9e9ec); margin:2px 0 12px; line-height:1.5; }
	.zauth-meta-row { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px; }
	.zauth-chip { font-size:11px; font-weight:700; letter-spacing:0.04em; color:var(--cc-muted,#9a9aa2); border:1px solid var(--cc-edge,rgba(255,255,255,0.14)); border-radius:999px; padding:4px 11px; }
	.zauth-chip.is-price { color:#06241a; background:${ACCENT}; border-color:${ACCENT}; }
	.zauth-form { display:flex; gap:8px; margin:2px 0 6px; }
	.zauth-form .npc-svc-input { margin:0; flex:1 1 auto; }
	.zauth-go { flex:0 0 auto; border:1px solid var(--cc-edge,rgba(255,255,255,0.14)); background:rgba(70,212,154,0.14); color:${ACCENT_LT}; font-weight:800; border-radius:var(--cc-radius,4px); padding:0 16px; cursor:pointer; transition:background .15s ease, transform .12s ease; }
	.zauth-go:hover { background:rgba(70,212,154,0.26); transform:translateY(-1px); }
	.zauth-go:active { transform:translateY(0); }
	.zauth-go:focus-visible { outline:2px solid ${ACCENT}; outline-offset:2px; }
	.zauth-go:disabled { opacity:0.5; cursor:default; transform:none; }
	.zauth-hint { font-size:11.5px; color:var(--cc-muted,#9a9aa2); margin:8px 0 0; line-height:1.45; }
	.zauth-error { color:#ffb4be; font-size:13px; padding:12px 0; line-height:1.45; }
	.zauth-skel { height:46px; border-radius:6px; background:linear-gradient(90deg,rgba(255,255,255,0.05),rgba(255,255,255,0.11),rgba(255,255,255,0.05)); background-size:200% 100%; animation:zauth-shimmer 1.2s linear infinite; margin-bottom:8px; }
	@keyframes zauth-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
	/* scan progress */
	.zauth-scan-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:4px 0 10px; }
	.zauth-scan-repo { font-size:13.5px; font-weight:800; color:var(--cc-text,#e9e9ec); overflow-wrap:anywhere; }
	.zauth-scan-clock { font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; color:${ACCENT_LT}; }
	.zauth-bar { height:4px; border-radius:2px; background:rgba(255,255,255,0.08); overflow:hidden; margin-bottom:10px; }
	.zauth-bar-fill { display:block; height:100%; width:38%; border-radius:2px; background:linear-gradient(90deg,${ACCENT},#7aa8ff); animation:zauth-sweep 1.8s ease-in-out infinite; }
	@keyframes zauth-sweep { 0%{transform:translateX(-100%)} 100%{transform:translateX(280%)} }
	/* report */
	.zauth-report-head { display:flex; align-items:center; gap:16px; margin:4px 0 14px; }
	.zauth-score { flex:0 0 auto; width:78px; height:78px; border-radius:50%; display:grid; place-items:center; position:relative; }
	.zauth-score::before { content:''; position:absolute; inset:6px; border-radius:50%; background:var(--cc-panel-solid,#0c0c0e); }
	.zauth-score-n { position:relative; font-size:24px; font-weight:800; font-variant-numeric:tabular-nums; }
	.zauth-score-cap { display:block; position:relative; font-size:9px; font-weight:700; letter-spacing:0.08em; color:var(--cc-muted,#9a9aa2); text-align:center; }
	.zauth-verdict { min-width:0; }
	.zauth-verdict-t { font-size:15px; font-weight:800; margin:0 0 3px; }
	.zauth-verdict-d { font-size:12px; color:var(--cc-muted,#9a9aa2); line-height:1.45; }
	.zauth-md { font-size:13px; line-height:1.55; color:var(--cc-text,#e9e9ec); }
	.zauth-md h3 { font-size:13px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase; color:${ACCENT_LT}; margin:18px 0 7px; }
	.zauth-md h3:first-child { margin-top:2px; }
	.zauth-md h4 { font-size:12.5px; font-weight:800; margin:13px 0 5px; }
	.zauth-md p { margin:0 0 9px; }
	.zauth-md ul { margin:0 0 9px; padding-left:18px; }
	.zauth-md li { margin-bottom:4px; }
	.zauth-md a { color:${ACCENT_LT}; text-decoration:none; border-bottom:1px solid rgba(141,240,196,0.4); overflow-wrap:anywhere; }
	.zauth-md a:hover { border-bottom-color:${ACCENT_LT}; }
	.zauth-md code { font-family:ui-monospace,monospace; font-size:12px; background:rgba(255,255,255,0.07); border-radius:3px; padding:1px 5px; overflow-wrap:anywhere; }
	.zauth-again { margin-top:14px; }`;
	document.head.appendChild(s);
}

// ── markdown rendering (zauth returns analysisMarkdown) ──────────────────────
// Third-party analysis text, rendered through the shared sanitized pipeline
// (marked + DOMPurify). Headings shift down two levels so the panel's own
// heading stays dominant. The previous local renderer built DOM nodes by hand
// and supported neither code blocks, italics, nor ordered lists.
function renderZauthMarkdown(md) {
	const root = el('div', { class: 'zauth-md' });
	root.innerHTML = renderMarkdown(md, { demoteHeadings: 2 });
	return root;
}

function scoreTone(score) {
	if (score >= 75) return { color: '#43d6a0', label: 'Looks trustworthy' };
	if (score >= 50) return { color: '#f5a623', label: 'Mixed signals' };
	return { color: '#ff7a8a', label: 'Tread carefully' };
}

function scoreBadge(score) {
	const n = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
	const { color } = scoreTone(n);
	const badge = el('div', { class: 'zauth-score', role: 'img', 'aria-label': `zauth trust score ${n} out of 100` });
	badge.style.background = `conic-gradient(${color} ${n * 3.6}deg, rgba(255,255,255,0.09) 0)`;
	badge.appendChild(el('span', { class: 'zauth-score-n' }, [
		String(n),
		el('span', { class: 'zauth-score-cap', text: '/100' }),
	]));
	badge.querySelector('.zauth-score-n').style.color = color;
	return badge;
}

// ── live challenge probe — the x402 call made on walk-up ──────────────────────
// An unpaid POST draws the real 402 payment challenge from zauth (via the
// pass-through), so the price, rails, and terms on the counter are theirs,
// live — never hardcoded copy.
let challengePromise = null;

function probeChallenge() {
	if (!challengePromise) {
		challengePromise = (async () => {
			const res = await fetch(ENDPOINT, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ repo: DEFAULT_REPO }),
			});
			const header = res.headers.get('payment-required');
			let envelope = null;
			if (header) {
				try { envelope = JSON.parse(atob(header)); } catch { /* fall through */ }
			}
			if (!envelope?.accepts?.length) {
				envelope = await res.json().catch(() => null);
			}
			if (res.status !== 402 || !envelope?.accepts?.length) {
				throw new Error(`scanner unreachable (HTTP ${res.status})`);
			}
			return envelope;
		})().catch((err) => {
			challengePromise = null; // transient failure — re-probe next open
			throw err;
		});
	}
	return challengePromise;
}

function challengePrice(envelope) {
	const amounts = (envelope?.accepts || [])
		.map((a) => Number(a.amount ?? a.maxAmountRequired))
		.filter((n) => isFinite(n) && n > 0);
	if (!amounts.length) return null;
	return Math.min(...amounts) / 1e6;
}

function challengeNetworks(envelope) {
	const nets = new Set();
	for (const a of envelope?.accepts || []) {
		const n = String(a.network || '');
		if (n.startsWith('solana')) nets.add('Solana');
		else if (n === 'eip155:8453') nets.add('Base');
		else if (n) nets.add(n);
	}
	return [...nets];
}

// ── scan lifecycle — outlives the panel ───────────────────────────────────────
// One scan at a time. Polling continues after the panel closes; the agent
// speaks and the HUD toasts when the report lands.
let activeScan = null;

function startPolling(scan) {
	const poll = async () => {
		if (activeScan !== scan) return;
		if (Date.now() - scan.startedAt > SCAN_MAX_MS) {
			scan.status = 'failed';
			scan.error = 'zauth is taking too long — the scan may still finish on their side.';
			scan.ui?.toast?.(`Security scan of ${scan.repo} timed out`, 'error');
			openPanel?.render?.();
			return;
		}
		try {
			const res = await fetch(`${ENDPOINT}?session=${encodeURIComponent(scan.session)}`, {
				headers: { accept: 'application/json' },
			});
			const body = await res.json().catch(() => null);
			if (!res.ok || !body) throw new Error(body?.error || `poll failed (${res.status})`);
			if (body.status === 'completed') {
				scan.status = 'completed';
				scan.score = Number(body.zauthScore);
				scan.markdown = body.analysisMarkdown || '';
				scan.ui?.toast?.(
					`zauth scan complete — ${scan.repo} scored ${scan.score}/100`,
					scan.score >= 50 ? 'success' : 'warn',
				);
				if (!scan.npc?._disposed) {
					scan.npc?.say?.(`Report's in: ${scan.repo} scores ${scan.score}/100. ${scoreTone(scan.score).label}.`);
				}
				openPanel?.render?.();
				return;
			}
			if (body.status && !/scanning|pending|queued|processing|analyzing|in_progress/i.test(body.status)) {
				throw new Error(`scan ended with status "${body.status}"`);
			}
		} catch (err) {
			// One bad poll isn't a failed scan — keep going unless time runs out.
			log.warn('[npc-zauth] poll error:', err?.message);
		}
		scan.timer = setTimeout(poll, POLL_MS);
		openPanel?.render?.();
	};
	scan.timer = setTimeout(poll, POLL_MS);
}

// ── panel lifecycle (single instance, ESC, overlay click) ─────────────────────
let openPanel = null;

export function isZauthPanelOpen() {
	return !!openPanel;
}

function closePanel() {
	if (!openPanel) return;
	const { overlay, onKey, opener } = openPanel;
	document.removeEventListener('keydown', onKey, true);
	overlay.classList.remove('is-in');
	setTimeout(() => overlay.remove(), 180);
	openPanel = null;
	if (opener && typeof opener.focus === 'function') opener.focus();
}

// Open zauth's security scanner. Probes the live 402 challenge immediately;
// the scan itself runs only on an explicit click, paid from the player's own
// wallet. Manages its own lifecycle (no return value).
export function openZauthScanner(npc, { ui } = {}) {
	injectStyles();
	if (openPanel) return; // already up — don't stack scanners
	if (document.querySelector('.npc-svc-overlay')) return; // another counter is open

	const titleId = 'zauth-term-title';
	const card = el('div', {
		class: 'npc-svc-card is-zauth',
		role: 'dialog',
		'aria-modal': 'true',
		'aria-labelledby': titleId,
	});
	const overlay = el('div', { class: 'npc-svc-overlay' }, [card]);
	overlay.addEventListener('mousedown', (e) => {
		if (e.target === overlay) closePanel();
	});

	card.appendChild(
		el('header', { class: 'npc-svc-head' }, [
			el('div', {}, [
				npc?.def?.name ? el('div', { class: 'npc-svc-who', text: npc.def.name }) : null,
				el('h2', { id: titleId, class: 'npc-svc-title' }, [
					'RepoScan ',
					el('span', { class: 'zauth-live', text: 'LIVE x402' }),
				]),
			]),
			el('button', {
				class: 'npc-svc-close',
				type: 'button',
				'aria-label': 'Close',
				text: '✕',
				onclick: closePanel,
			}),
		]),
	);

	const body = el('div', { class: 'npc-svc-result', style: 'display:block' });
	card.appendChild(body);

	let paying = false;

	function fmtElapsed(ms) {
		const s = Math.floor(ms / 1000);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	async function startScan(repo) {
		if (paying || activeScan?.status === 'scanning') return;
		const target = repo.trim();
		if (!REPO_RE.test(target)) {
			ui?.toast?.('Repo must look like owner/repo', 'warn');
			return;
		}
		paying = true;
		render();
		try {
			const X402 = await ensureX402();
			const out = await X402.pay({
				endpoint: ENDPOINT,
				method: 'POST',
				body: { repo: target },
				merchant: 'zauth · RepoScan',
				action: `Security scan of ${target} — provenance, contributors, vulnerabilities`,
			});
			const result = out?.result;
			if (result?.status === 'completed') {
				// Cached report — zauth returns it instantly, no polling needed.
				activeScan = {
					repo: target, status: 'completed', score: Number(result.zauthScore),
					markdown: result.analysisMarkdown || '', startedAt: Date.now(), npc, ui,
				};
				npc?.say?.(`Had that one on file — ${target} scores ${activeScan.score}/100.`);
			} else if (result?.sessionToken) {
				if (activeScan?.timer) clearTimeout(activeScan.timer);
				activeScan = {
					repo: target, session: result.sessionToken, status: 'scanning',
					startedAt: Date.now(), npc, ui,
				};
				startPolling(activeScan);
				npc?.say?.(`Paid and queued. I'm tearing into ${target} — give me a few minutes.`);
			} else {
				throw new Error(result?.error || 'scan did not start');
			}
		} catch (err) {
			const cancelled = /cancel|dismiss|closed|denied/i.test(String(err?.message || ''));
			if (!cancelled) {
				ui?.toast?.(`Scan failed — ${err?.message || 'no funds moved'}`, 'error');
				npc?.say?.('That one bounced — your wallet is untouched.');
			}
		} finally {
			paying = false;
			render();
		}
	}

	function viewOffer() {
		body.appendChild(el('p', {
			class: 'zauth-ask',
			text: 'Name a GitHub repo and I scan it: code provenance, contributor verification, vulnerabilities. One trust score, full report.',
		}));
		const meta = el('div', { class: 'zauth-meta-row' }, [el('div', { class: 'zauth-skel', style: 'width:220px;height:26px;margin:0' })]);
		body.appendChild(meta);

		const input = el('input', {
			class: 'npc-svc-input',
			type: 'text',
			value: activeScan?.repo || DEFAULT_REPO,
			placeholder: 'owner/repo',
			'aria-label': 'GitHub repository to scan',
		});
		const goBtn = el('button', { class: 'zauth-go', type: 'button', text: paying ? 'Paying…' : 'Scan', disabled: paying || null });
		// Keep typing out of the world's movement handlers.
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') { e.preventDefault(); startScan(input.value); }
		});
		input.addEventListener('keyup', (e) => e.stopPropagation());
		goBtn.addEventListener('click', () => startScan(input.value));
		body.appendChild(el('div', { class: 'zauth-form' }, [input, goBtn]));
		body.appendChild(el('p', {
			class: 'zauth-hint',
			text: 'Paid with your wallet, settled on-chain to zauth. Scans take a few minutes — I keep working if you walk away.',
		}));

		probeChallenge().then((envelope) => {
			if (!openPanel || openPanel.overlay !== overlay) return;
			meta.textContent = '';
			const price = challengePrice(envelope);
			meta.appendChild(el('span', { class: 'zauth-chip is-price', text: price != null ? `$${price.toFixed(2)} USDC` : 'paid · x402' }));
			for (const net of challengeNetworks(envelope)) meta.appendChild(el('span', { class: 'zauth-chip', text: net }));
			meta.appendChild(el('span', { class: 'zauth-chip', text: 'pays zauth directly' }));
		}).catch((err) => {
			if (!openPanel || openPanel.overlay !== overlay) return;
			meta.textContent = '';
			meta.appendChild(el('span', { class: 'zauth-chip', text: 'price check failed — retry in a moment' }));
			log.warn('[npc-zauth] challenge probe failed:', err?.message);
		});
	}

	function viewScanning(scan) {
		body.appendChild(el('div', { class: 'zauth-scan-head' }, [
			el('span', { class: 'zauth-scan-repo', text: scan.repo }),
			el('span', { class: 'zauth-scan-clock', text: fmtElapsed(Date.now() - scan.startedAt) }),
		]));
		body.appendChild(el('div', { class: 'zauth-bar' }, [el('span', { class: 'zauth-bar-fill' })]));
		body.appendChild(el('p', {
			class: 'zauth-ask',
			text: 'Scanning provenance, contributors, and vulnerabilities. This takes a few minutes — close this and keep playing; I will call out when the report lands.',
		}));
	}

	function viewReport(scan) {
		const tone = scoreTone(scan.score);
		body.appendChild(el('div', { class: 'zauth-report-head' }, [
			scoreBadge(scan.score),
			el('div', { class: 'zauth-verdict' }, [
				el('p', { class: 'zauth-verdict-t', text: scan.repo }),
				el('p', { class: 'zauth-verdict-d', text: `${tone.label} — zauth trust score ${Math.round(scan.score)}/100, settled and scanned via x402.` }),
			]),
		]));
		body.appendChild(renderZauthMarkdown(scan.markdown));
		body.appendChild(el('button', {
			class: 'zauth-go zauth-again',
			type: 'button',
			text: 'Scan another repo',
			onclick: () => { activeScan = null; render(); },
		}));
	}

	function viewFailed(scan) {
		body.appendChild(el('div', { class: 'zauth-error', text: scan.error || 'The scan failed on zauth’s side.' }));
		body.appendChild(el('button', {
			class: 'zauth-go',
			type: 'button',
			text: 'Start over',
			onclick: () => { activeScan = null; render(); },
		}));
	}

	function render() {
		body.textContent = '';
		if (activeScan?.status === 'scanning') viewScanning(activeScan);
		else if (activeScan?.status === 'completed') viewReport(activeScan);
		else if (activeScan?.status === 'failed') viewFailed(activeScan);
		else viewOffer();
	}

	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			closePanel();
		}
	};

	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	document.addEventListener('keydown', onKey, true);
	document.body.appendChild(overlay);
	openPanel = { overlay, onKey, opener, render };
	requestAnimationFrame(() => {
		overlay.classList.add('is-in');
		render();
	});
}
