// Team Task — multi-agent collaboration surface.
//
// One goal, one lead agent. The lead decomposes the goal and either delegates
// sub-tasks (free LLM turns) or HIRES teammate agents over real x402 — every
// handoff stamped with a real on-chain receipt. This module renders the live
// dependency graph: nodes pulse as they run, edges flow on handoff, cost badges
// and explorer chips appear on real paid hires.
//
// It is self-contained and context-aware, so it can ride two pages without
// touching their existing scripts:
//   • /agents-live   — injects a "Team Task" launcher into the hero; the user
//     picks one of their agents as lead and gives it a goal.
//   • /agent-screen  — adds a "Team" toggle to the task bar; submitting a goal
//     runs the current agent as lead and opens the graph inline.
//
// Backend: POST /api/agent-collab kicks off the run and returns the final tree;
// live transitions stream back over /api/agent-screen-stream (the lead's screen),
// where each frame carries the current graph snapshot in `frame.meta.collab`.

const HARD_MAX_USD = 5;
const DEFAULT_MAX_USD = 1;

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

function truncate(s, n) {
	const str = String(s ?? '');
	return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// ── styles (injected once) ────────────────────────────────────────────────────

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const css = `
.tt-launch{display:inline-flex;align-items:center;gap:8px;margin-top:18px;padding:10px 18px;border-radius:999px;
  border:1px solid rgba(120,180,255,.35);background:linear-gradient(180deg,rgba(80,140,255,.18),rgba(80,140,255,.07));
  color:#dCE9ff;font:600 13px/1 Inter,system-ui,sans-serif;cursor:pointer;transition:transform .15s,border-color .2s,box-shadow .2s;}
.tt-launch:hover{transform:translateY(-1px);border-color:rgba(120,180,255,.7);box-shadow:0 6px 22px rgba(60,120,255,.22);}
.tt-launch:active{transform:translateY(0);}
.tt-launch:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px;}
.tt-launch-ico{font-size:15px;line-height:1;}

.tt-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,12,.72);backdrop-filter:blur(8px);opacity:0;transition:opacity .2s;padding:24px;}
.tt-overlay.tt-open{opacity:1;}
.tt-panel{position:relative;width:min(1040px,96vw);max-height:92vh;overflow:auto;border-radius:18px;
  border:1px solid rgba(255,255,255,.1);background:linear-gradient(180deg,#0d1018,#0a0c12);
  box-shadow:0 30px 90px rgba(0,0,0,.6);transform:translateY(8px) scale(.99);transition:transform .2s;}
.tt-overlay.tt-open .tt-panel{transform:none;}
.tt-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 22px 14px;
  border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;background:rgba(13,16,24,.92);backdrop-filter:blur(6px);z-index:2;}
.tt-title{font:700 16px/1.2 Inter,system-ui,sans-serif;color:#f1f4fb;margin:0;}
.tt-sub{font:400 12px/1.4 Inter,system-ui,sans-serif;color:#8a93a6;margin-top:4px;}
.tt-close{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#cdd4e2;
  width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;flex:none;transition:background .15s,border-color .15s;}
.tt-close:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);}
.tt-close:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px;}

.tt-body{padding:18px 22px 24px;}
.tt-form{display:grid;gap:12px;}
.tt-row{display:flex;gap:12px;flex-wrap:wrap;}
.tt-field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:160px;}
.tt-label{font:600 11px/1 Inter,system-ui,sans-serif;color:#8a93a6;text-transform:uppercase;letter-spacing:.04em;}
.tt-input,.tt-select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.03);color:#eef2fb;font:500 14px/1.3 Inter,system-ui,sans-serif;}
.tt-input:focus,.tt-select:focus{outline:none;border-color:rgba(120,180,255,.6);background:rgba(120,180,255,.06);}
textarea.tt-input{resize:vertical;min-height:64px;}
.tt-budget{max-width:130px;}
.tt-go{align-self:flex-end;padding:11px 20px;border-radius:10px;border:1px solid rgba(120,180,255,.4);
  background:linear-gradient(180deg,#3a78ff,#2b5fe0);color:#fff;font:700 14px/1 Inter,system-ui,sans-serif;cursor:pointer;
  transition:transform .15s,box-shadow .2s,opacity .2s;}
.tt-go:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(50,110,255,.35);}
.tt-go:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}
.tt-hint{font:400 11px/1.4 Inter,system-ui,sans-serif;color:#6f788c;}
.tt-examples{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}
.tt-chip{font:500 11px/1 Inter,system-ui,sans-serif;color:#aeb8cc;border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.03);border-radius:999px;padding:6px 10px;cursor:pointer;transition:background .15s,border-color .15s;}
.tt-chip:hover{background:rgba(120,180,255,.1);border-color:rgba(120,180,255,.4);color:#dCE9ff;}

.tt-status{margin:14px 0 6px;font:500 12px/1.4 Inter,system-ui,sans-serif;color:#9aa3b6;display:flex;align-items:center;gap:8px;min-height:18px;}
.tt-status.err{color:#ff8d8d;}
.tt-status.ok{color:#7fe0a3;}
.tt-spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(120,180,255,.3);border-top-color:#6aa8ff;animation:tt-spin .7s linear infinite;}
@keyframes tt-spin{to{transform:rotate(360deg)}}

.tt-stage{position:relative;margin-top:8px;min-height:260px;border-radius:14px;border:1px solid rgba(255,255,255,.06);
  background:radial-gradient(120% 100% at 50% 0%,rgba(40,70,140,.12),rgba(10,12,18,0) 70%),#090b11;overflow:hidden;padding:18px;}
.tt-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}
.tt-edge{fill:none;stroke:rgba(120,170,255,.28);stroke-width:2;}
.tt-edge.flow{stroke:rgba(130,190,255,.85);stroke-dasharray:6 8;animation:tt-flow .8s linear infinite;}
@keyframes tt-flow{to{stroke-dashoffset:-28}}
.tt-nodes{position:relative;display:flex;flex-direction:column;gap:26px;align-items:center;}
.tt-lead-row{display:flex;justify-content:center;}
.tt-child-row{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;}

.tt-node{position:relative;width:190px;border-radius:13px;border:1px solid rgba(255,255,255,.1);
  background:linear-gradient(180deg,rgba(22,26,36,.96),rgba(14,17,24,.96));padding:12px 12px 11px;cursor:default;
  transition:transform .18s,border-color .2s,box-shadow .25s;text-decoration:none;color:inherit;display:block;}
a.tt-node{cursor:pointer;}
a.tt-node:hover{transform:translateY(-2px);border-color:rgba(120,180,255,.6);box-shadow:0 10px 28px rgba(40,90,200,.28);}
a.tt-node:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px;}
.tt-node.lead{width:230px;border-color:rgba(120,180,255,.4);background:linear-gradient(180deg,rgba(30,44,78,.95),rgba(16,20,30,.96));}
.tt-node-top{display:flex;align-items:center;gap:8px;margin-bottom:7px;}
.tt-ring{width:11px;height:11px;border-radius:50%;flex:none;position:relative;background:#3a4252;}
.tt-ring.queued{background:#4a5266;}
.tt-ring.running{background:#5aa0ff;box-shadow:0 0 0 0 rgba(90,160,255,.6);animation:tt-pulse 1.3s infinite;}
.tt-ring.planning{background:#9a7bff;box-shadow:0 0 0 0 rgba(154,123,255,.6);animation:tt-pulse 1.3s infinite;}
.tt-ring.done{background:#46d188;}
.tt-ring.failed{background:#ff6b6b;}
@keyframes tt-pulse{0%{box-shadow:0 0 0 0 rgba(90,160,255,.55)}70%{box-shadow:0 0 0 8px rgba(90,160,255,0)}100%{box-shadow:0 0 0 0 rgba(90,160,255,0)}}
.tt-kind{font:700 9px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#7f8aa0;
  border:1px solid rgba(255,255,255,.1);border-radius:5px;padding:3px 5px;}
.tt-kind.hire{color:#ffd27f;border-color:rgba(255,200,110,.35);}
.tt-kind.lead{color:#9fc4ff;border-color:rgba(140,180,255,.4);}
.tt-node-title{font:600 12.5px/1.35 Inter,system-ui,sans-serif;color:#eef2fb;}
.tt-node-name{font:500 11px/1.3 Inter,system-ui,sans-serif;color:#8a93a6;margin-top:3px;}
.tt-node-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px;min-height:18px;}
.tt-cost{font:700 10px/1 Inter,system-ui,sans-serif;color:#0a0c12;background:#ffd27f;border-radius:5px;padding:3px 6px;}
.tt-receipt{display:inline-flex;align-items:center;gap:4px;font:600 10px/1 Inter,system-ui,sans-serif;color:#9fe0b8;
  border:1px solid rgba(110,220,160,.35);border-radius:5px;padding:3px 6px;text-decoration:none;}
.tt-receipt:hover{background:rgba(110,220,160,.12);}
.tt-err{font:500 10.5px/1.3 Inter,system-ui,sans-serif;color:#ff9b9b;}
.tt-node-result{font:400 11px/1.4 Inter,system-ui,sans-serif;color:#aab3c6;margin-top:8px;
  max-height:0;overflow:hidden;transition:max-height .25s;}
.tt-node:hover .tt-node-result,.tt-node.lead .tt-node-result{max-height:120px;}

.tt-meter{display:flex;align-items:center;gap:8px;margin-top:14px;font:500 11px/1 Inter,system-ui,sans-serif;color:#8a93a6;}
.tt-meter-bar{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden;}
.tt-meter-fill{height:100%;background:linear-gradient(90deg,#ffd27f,#ff9f5a);width:0;transition:width .3s;}

.tt-empty,.tt-error{text-align:center;padding:40px 20px;color:#8a93a6;font:500 13px/1.5 Inter,system-ui,sans-serif;}
.tt-error{color:#ff9b9b;}
.tt-empty a{color:#9fc4ff;}

/* agent-screen task-bar team toggle */
.tt-toggle{display:inline-flex;align-items:center;gap:6px;margin-left:8px;padding:6px 10px;border-radius:999px;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:#aeb8cc;cursor:pointer;
  font:600 11px/1 Inter,system-ui,sans-serif;transition:background .15s,border-color .15s,color .15s;white-space:nowrap;}
.tt-toggle[aria-pressed="true"]{background:linear-gradient(180deg,rgba(80,140,255,.22),rgba(80,140,255,.08));
  border-color:rgba(120,180,255,.6);color:#dCE9ff;}
.tt-toggle:focus-visible{outline:2px solid #6aa8ff;outline-offset:2px;}
.tt-toggle-dot{width:7px;height:7px;border-radius:50%;background:#5a6273;}
.tt-toggle[aria-pressed="true"] .tt-toggle-dot{background:#6aa8ff;box-shadow:0 0 8px rgba(106,168,255,.8);}
`;
	const el = document.createElement('style');
	el.id = 'tt-styles';
	el.textContent = css;
	document.head.appendChild(el);
}

// ── graph rendering ───────────────────────────────────────────────────────────

// Render the task tree into `stage`. Reuses node elements across snapshots (keyed
// by id) so status changes animate in place rather than flashing the whole graph.
function renderGraph(stage, tree, { full = false } = {}) {
	if (!tree || !Array.isArray(tree.nodes)) return;
	let svg = stage.querySelector('.tt-svg');
	let nodesWrap = stage.querySelector('.tt-nodes');
	if (!nodesWrap) {
		stage.innerHTML = `
<svg class="tt-svg" preserveAspectRatio="none"></svg>
<div class="tt-nodes">
  <div class="tt-lead-row"></div>
  <div class="tt-child-row"></div>
</div>
<div class="tt-meter" hidden>
  <span>Spend</span><div class="tt-meter-bar"><div class="tt-meter-fill"></div></div>
  <span class="tt-meter-val"></span>
</div>`;
		svg = stage.querySelector('.tt-svg');
		nodesWrap = stage.querySelector('.tt-nodes');
	}
	const leadRow = nodesWrap.querySelector('.tt-lead-row');
	const childRow = nodesWrap.querySelector('.tt-child-row');

	const lead = tree.nodes.find((n) => n.id === 'lead') || tree.nodes[0];
	const children = tree.nodes.filter((n) => n.id !== 'lead');

	upsertNode(leadRow, lead, { lead: true, full });
	const seen = new Set(['lead']);
	children.forEach((c) => { upsertNode(childRow, c, { full }); seen.add(c.id); });
	// Drop any node elements no longer in the tree.
	childRow.querySelectorAll('[data-node-id]').forEach((el) => {
		if (!seen.has(el.dataset.nodeId)) el.remove();
	});

	drawEdges(stage, svg, tree);
	updateMeter(stage, tree);
}

function nodeHref(node) {
	return node.agentId ? `/agent-screen?agentId=${encodeURIComponent(node.agentId)}` : null;
}

function upsertNode(row, node, { lead = false, full = false } = {}) {
	let el = row.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
	const href = nodeHref(node);
	const tag = href ? 'a' : 'div';
	if (!el || el.tagName.toLowerCase() !== tag) {
		if (el) el.remove();
		el = document.createElement(tag);
		el.dataset.nodeId = node.id;
		el.className = `tt-node${lead ? ' lead' : ''}`;
		row.appendChild(el);
	}
	if (href) {
		el.href = href;
		el.target = '_blank';
		el.rel = 'noopener';
		el.title = 'Open this agent’s live screen';
	}
	const kind = lead ? 'lead' : node.kind;
	const result = full && node.result ? `<div class="tt-node-result">${esc(truncate(node.result, 280))}</div>` : '';
	const foot = nodeFoot(node);
	el.innerHTML = `
<div class="tt-node-top">
  <span class="tt-ring ${esc(node.status)}"></span>
  <span class="tt-kind ${esc(kind)}">${esc(kind)}</span>
</div>
<div class="tt-node-title">${esc(truncate(node.title, lead ? 110 : 72))}</div>
${node.name ? `<div class="tt-node-name">${esc(truncate(node.name, 36))}</div>` : ''}
<div class="tt-node-foot">${foot}</div>
${result}`;
}

function nodeFoot(node) {
	if (node.status === 'failed') {
		return `<span class="tt-err">⚠ ${esc(truncate(node.error || 'failed', 48))}</span>`;
	}
	const bits = [];
	if (node.costUsd != null && Number(node.costUsd) > 0) {
		bits.push(`<span class="tt-cost">$${Number(node.costUsd).toFixed(2)}</span>`);
	}
	const url = node.url || node.explorerUrl;
	const sig = node.sig || node.signature;
	if (url && sig) {
		bits.push(`<a class="tt-receipt" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">⛓ ${esc(truncate(sig, 6))}</a>`);
	}
	if (!bits.length && node.status === 'running') return `<span class="tt-err" style="color:#7f8aa0">working…</span>`;
	return bits.join('');
}

// Draw lead→child edges as curves; the edge "flows" while its child is running.
function drawEdges(stage, svg, tree) {
	const sr = stage.getBoundingClientRect();
	if (!sr.width) return;
	svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
	const center = (el) => {
		const r = el.getBoundingClientRect();
		return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top, yb: r.bottom - sr.top, h: r.height };
	};
	const leadEl = stage.querySelector('.tt-node.lead');
	if (!leadEl) { svg.innerHTML = ''; return; }
	const lc = center(leadEl);
	const paths = [];
	(tree.edges || []).forEach((e) => {
		const childEl = stage.querySelector(`[data-node-id="${CSS.escape(e.to)}"]`);
		if (!childEl) return;
		const cc = center(childEl);
		const x1 = lc.x, y1 = lc.yb, x2 = cc.x, y2 = cc.y;
		const my = (y1 + y2) / 2;
		const node = tree.nodes.find((n) => n.id === e.to);
		const flow = node && (node.status === 'running');
		paths.push(`<path class="tt-edge${flow ? ' flow' : ''}" d="M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}"/>`);
	});
	svg.innerHTML = paths.join('');
}

function updateMeter(stage, tree) {
	const meter = stage.querySelector('.tt-meter');
	if (!meter) return;
	const cap = Number(tree.maxUsd) || 0;
	const spent = Number(tree.spentUsd ?? tree.budgetSpentUsd) || 0;
	if (cap <= 0 || (spent <= 0 && tree.status !== 'done')) { meter.hidden = true; return; }
	meter.hidden = false;
	const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
	meter.querySelector('.tt-meter-fill').style.width = `${pct}%`;
	meter.querySelector('.tt-meter-val').textContent = `$${spent.toFixed(2)} / $${cap.toFixed(2)}`;
}

// ── run a team task ────────────────────────────────────────────────────────────

// Drives one collaboration: kicks the backend, subscribes to the lead's live
// stream for graph snapshots, and resolves with the authoritative final tree.
function runTeamTask({ leadAgentId, goal, maxUsd, stage, statusEl }) {
	let settled = false;
	let es = null;

	const setStatus = (text, cls = '') => {
		if (!statusEl) return;
		statusEl.className = `tt-status ${cls}`.trim();
		statusEl.innerHTML = cls === '' && text
			? `<span class="tt-spin"></span>${esc(text)}`
			: esc(text);
	};

	// Seed an immediate planning graph so the stage is never blank.
	renderGraph(stage, {
		nodes: [{ id: 'lead', kind: 'lead', title: goal, status: 'planning', agentId: leadAgentId }],
		edges: [], maxUsd, spentUsd: 0, status: 'planning',
	});
	setStatus('Lead agent is planning the work…');

	// Live transitions over the lead's screen stream (frame.meta.collab snapshots).
	try {
		es = new EventSource(`/api/agent-screen-stream?agentId=${encodeURIComponent(leadAgentId)}`);
		es.addEventListener('frame', (e) => {
			if (settled) return;
			try {
				const frame = JSON.parse(e.data);
				const snap = frame?.meta?.collab;
				if (snap && snap.kind === 'collab') {
					renderGraph(stage, snap);
					setStatus(statusForTree(snap));
				}
			} catch { /* malformed frame */ }
		});
		es.onerror = () => { /* EventSource auto-retries; the POST is the source of truth */ };
	} catch { /* SSE unsupported — the final POST result still renders */ }

	const done = (tree) => {
		settled = true;
		if (es) { try { es.close(); } catch { /* */ } }
		renderGraph(stage, compactFromFull(tree), { full: true });
		const failed = tree.status === 'completed_with_errors';
		setStatus(failed ? 'Team task complete — some sub-tasks could not finish' : 'Team task complete', failed ? 'err' : 'ok');
	};

	const fail = (msg) => {
		settled = true;
		if (es) { try { es.close(); } catch { /* */ } }
		setStatus(msg || 'The team task could not be started', 'err');
	};

	const promise = fetchCsrfToken().then((token) => fetch('/api/agent-collab', {
		method: 'POST',
		credentials: 'include',
		headers: token
			? { 'content-type': 'application/json', 'x-csrf-token': token }
			: { 'content-type': 'application/json' },
		body: JSON.stringify({ leadAgentId, goal, maxUsd }),
	})).then(async (res) => {
		const data = await res.json().catch(() => ({}));
		if (res.ok && data.tree) { done(data.tree); return data; }
		if (res.status === 401) { fail('Sign in to run a team task'); return null; }
		fail(data.error_description || data.message || 'The team task failed — try again'); return null;
	}).catch(() => { fail('Network error — check your connection'); return null; });

	return { promise, cancel: () => { if (es) try { es.close(); } catch { /* */ } } };
}

// The final POST returns the rich tree (full results, full signatures); reshape
// it to the same field names renderGraph reads from a stream snapshot.
function compactFromFull(tree) {
	return {
		kind: 'collab',
		taskId: tree.taskId,
		status: tree.status,
		maxUsd: tree.maxUsd,
		spentUsd: tree.budgetSpentUsd,
		edges: tree.edges,
		nodes: tree.nodes.map((n) => ({
			id: n.id, agentId: n.agentId, name: n.name, kind: n.kind, title: n.title,
			status: n.status, costUsd: n.costUsd, sig: n.signature, url: n.explorerUrl,
			result: n.result, error: n.error,
		})),
	};
}

function statusForTree(tree) {
	if (tree.status === 'planning') return 'Lead agent is planning the work…';
	const running = tree.nodes.find((n) => n.status === 'running');
	if (running) return running.kind === 'hire' ? `Hiring a teammate — ${truncate(running.title, 40)}` : `Working — ${truncate(running.title, 44)}`;
	const queued = tree.nodes.some((n) => n.status === 'queued');
	if (queued) return 'Coordinating the team…';
	return 'Wrapping up…';
}

// Fetch a one-time CSRF token for the session write, mirroring the rest of the
// app (GET /api/csrf-token → echo in the x-csrf-token header). Bearer sessions are
// CSRF-exempt server-side, so a null token still works for them.
async function fetchCsrfToken() {
	try {
		const res = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!res.ok) return null;
		const j = await res.json();
		return j.data?.token || j.token || null;
	} catch {
		return null;
	}
}

// ── overlay ────────────────────────────────────────────────────────────────────

const EXAMPLE_GOALS = [
	'Research the $THREE token and draft a one-paragraph launch summary',
	'Scan sentiment for a trending Solana coin and recommend a position',
	'Profile three competing AI-agent platforms and list their gaps',
];

function buildOverlay() {
	ensureStyles();
	const overlay = document.createElement('div');
	overlay.className = 'tt-overlay';
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', 'Team Task');
	overlay.innerHTML = `
<div class="tt-panel">
  <div class="tt-head">
    <div>
      <h2 class="tt-title">Team Task</h2>
      <div class="tt-sub">One goal. A lead agent splits the work, hires teammates over x402, and proves every handoff on-chain.</div>
    </div>
    <button class="tt-close" type="button" aria-label="Close">✕</button>
  </div>
  <div class="tt-body">
    <form class="tt-form" data-tt-form>
      <div class="tt-field" data-lead-field hidden>
        <label class="tt-label" for="tt-lead">Lead agent</label>
        <select class="tt-select" id="tt-lead" data-lead></select>
      </div>
      <div class="tt-field">
        <label class="tt-label" for="tt-goal">Goal</label>
        <textarea class="tt-input" id="tt-goal" data-goal placeholder="Give the lead agent a goal…" maxlength="2000"></textarea>
        <div class="tt-examples" data-examples></div>
      </div>
      <div class="tt-row">
        <div class="tt-field tt-budget">
          <label class="tt-label" for="tt-budget">Budget (USD)</label>
          <input class="tt-input" id="tt-budget" data-budget type="number" min="0.1" max="${HARD_MAX_USD}" step="0.1" value="${DEFAULT_MAX_USD}">
        </div>
        <button class="tt-go" type="submit" data-go>Launch team →</button>
      </div>
      <div class="tt-hint">Spend is hard-capped at $${HARD_MAX_USD.toFixed(2)} and split across paid hires; each hire is gated by the agent's own spend policy.</div>
    </form>
    <div class="tt-status" data-status></div>
    <div class="tt-stage" data-stage hidden></div>
  </div>
</div>`;
	return overlay;
}

function openOverlay({ leads = [], presetGoal = '' } = {}) {
	const overlay = buildOverlay();
	document.body.appendChild(overlay);
	document.body.style.overflow = 'hidden';
	requestAnimationFrame(() => overlay.classList.add('tt-open'));

	const close = () => {
		overlay.classList.remove('tt-open');
		document.body.style.overflow = '';
		setTimeout(() => overlay.remove(), 200);
		window.removeEventListener('keydown', onKey);
	};
	const onKey = (e) => { if (e.key === 'Escape') close(); };
	window.addEventListener('keydown', onKey);
	overlay.querySelector('.tt-close').addEventListener('click', close);
	overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

	const form = overlay.querySelector('[data-tt-form]');
	const goalEl = overlay.querySelector('[data-goal]');
	const budgetEl = overlay.querySelector('[data-budget]');
	const stage = overlay.querySelector('[data-stage]');
	const statusEl = overlay.querySelector('[data-status]');
	const go = overlay.querySelector('[data-go]');
	const examples = overlay.querySelector('[data-examples]');

	// Lead picker (only on surfaces that don't already imply a lead).
	const leadField = overlay.querySelector('[data-lead-field]');
	const leadSel = overlay.querySelector('[data-lead]');
	if (leads.length > 1 || (leads.length === 1 && !presetGoal)) {
		leadField.hidden = false;
		leadSel.innerHTML = leads.map((a) => `<option value="${esc(a.id)}">${esc(a.name || 'Agent')}</option>`).join('');
	}
	const resolveLead = () => (leads.length ? (leadSel.value || leads[0].id) : null);

	EXAMPLE_GOALS.forEach((g) => {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'tt-chip';
		chip.textContent = truncate(g, 52);
		chip.addEventListener('click', () => { goalEl.value = g; goalEl.focus(); });
		examples.appendChild(chip);
	});

	if (presetGoal) goalEl.value = presetGoal;
	setTimeout(() => goalEl.focus(), 60);

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const goal = goalEl.value.trim();
		const leadAgentId = resolveLead();
		if (!goal) { goalEl.focus(); return; }
		if (!leadAgentId) {
			statusEl.className = 'tt-status err';
			statusEl.textContent = 'No agent available to lead — create one first.';
			return;
		}
		const maxUsd = Math.min(HARD_MAX_USD, Math.max(0.1, Number(budgetEl.value) || DEFAULT_MAX_USD));
		go.disabled = true; goalEl.disabled = true; budgetEl.disabled = true; leadSel.disabled = true;
		stage.hidden = false;
		runTeamTask({ leadAgentId, goal, maxUsd, stage, statusEl }).promise.finally(() => {
			go.disabled = false; goalEl.disabled = false; budgetEl.disabled = false; leadSel.disabled = false;
			go.textContent = 'Run another →';
		});
	});

	return { overlay, close };
}

// ── owned-agent roster ─────────────────────────────────────────────────────────

async function fetchOwnedAgents() {
	try {
		const res = await fetch('/api/agents', { credentials: 'include', headers: { accept: 'application/json' } });
		if (!res.ok) return [];
		const data = await res.json();
		return (data.agents || []).map((a) => ({ id: a.id, name: a.name || a.display_name || 'Agent' }));
	} catch {
		return [];
	}
}

// ── context wiring ─────────────────────────────────────────────────────────────

// /agents-live — inject a launcher into the hero.
function mountOnLiveWall() {
	const hero = document.querySelector('.al-hero');
	if (!hero || hero.querySelector('.tt-launch')) return;
	ensureStyles();
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tt-launch';
	btn.innerHTML = `<span class="tt-launch-ico">⊹</span> Run a Team Task`;
	btn.addEventListener('click', async () => {
		btn.disabled = true;
		const leads = await fetchOwnedAgents();
		btn.disabled = false;
		if (!leads.length) {
			// Empty state: route the user to create an agent to lead with.
			const { overlay } = openOverlay({ leads: [] });
			const stage = overlay.querySelector('[data-stage]');
			const status = overlay.querySelector('[data-status]');
			overlay.querySelector('[data-tt-form]').hidden = true;
			stage.hidden = false;
			stage.innerHTML = `<div class="tt-empty">You need an agent to lead the team.<br><a href="/create-agent">Create an agent →</a> then come back and give it a goal.</div>`;
			status.textContent = '';
			return;
		}
		openOverlay({ leads });
	});
	hero.appendChild(btn);
}

// /agent-screen — add a "Team" toggle to the task bar. When on, intercept the
// task submit (capture phase, before agent-screen.js's own handler) and run the
// current agent as the team lead.
function mountOnAgentScreen() {
	const form = document.getElementById('asc-task-form');
	const input = document.getElementById('asc-task-input');
	const send = document.getElementById('asc-task-send');
	if (!form || !input || !send) return;
	const params = new URLSearchParams(location.search);
	const leadAgentId = params.get('agentId');
	if (!leadAgentId) return;
	ensureStyles();

	const toggle = document.createElement('button');
	toggle.type = 'button';
	toggle.className = 'tt-toggle';
	toggle.setAttribute('aria-pressed', 'false');
	toggle.title = 'Run this goal as a team — the agent splits the work and hires teammates';
	toggle.innerHTML = `<span class="tt-toggle-dot"></span>Team`;
	let teamMode = false;
	toggle.addEventListener('click', () => {
		teamMode = !teamMode;
		toggle.setAttribute('aria-pressed', String(teamMode));
		input.placeholder = teamMode
			? 'Give a goal — the team will split it and hire teammates…'
			: input.dataset.soloPlaceholder || input.placeholder;
	});
	input.dataset.soloPlaceholder = input.placeholder;
	send.insertAdjacentElement('afterend', toggle);

	form.addEventListener('submit', (e) => {
		if (!teamMode) return; // solo path — let agent-screen.js handle it
		e.preventDefault();
		e.stopImmediatePropagation();
		const goal = input.value.trim();
		if (!goal) return;
		input.value = '';
		const leadName = document.querySelector('.asc-agent-name')?.textContent?.trim() || null;
		openTeamForAgent(leadAgentId, leadName, goal);
	}, true);
}

// Open the overlay pre-targeted at a known lead, immediately launching the goal.
function openTeamForAgent(leadAgentId, leadName, goal) {
	const { overlay } = openOverlay({ leads: [{ id: leadAgentId, name: leadName || 'this agent' }], presetGoal: goal });
	// Auto-submit so the graph starts right away.
	const form = overlay.querySelector('[data-tt-form]');
	requestAnimationFrame(() => form.requestSubmit());
}

// ── boot ────────────────────────────────────────────────────────────────────────

function boot() {
	if (document.getElementById('al-grid')) mountOnLiveWall();
	if (document.getElementById('asc-task-form')) mountOnAgentScreen();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot);
} else {
	boot();
}
