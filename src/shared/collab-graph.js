// collab-graph.js — the Team Task dependency graph.
//
// Renders a live multi-agent collaboration as a dependency tree: a LEAD node at
// the top splits one goal into sub-tasks, and each child node is either a free
// DELEGATE turn or a paid HIRE settled over x402 with a real on-chain receipt.
// As the orchestrator (api/_lib/agent-orchestrate.js → api/agent-collab.js)
// streams the task tree through the agent's live screen frames, callers hand the
// compact tree (frame.meta.collab) to `update()` and the graph repaints: status
// rings pulse, edges flow toward whatever is running, cost badges and explorer
// chips appear as hires settle.
//
// Shared by two surfaces so the render never drifts:
//   • src/agent-screen.js  — a floating overlay panel above the lead's screen.
//   • src/agents-live.js    — a compact card overlay on the wall.
//
// Pure DOM + SVG, no network. The compact tree shape (see compactTree() in
// api/agent-collab.js):
//   { v, kind:'collab', taskId, goal, leadAgentId, status, maxUsd, spentUsd,
//     nodes:[{ id, agentId, name, kind, title, status, costUsd, sig, url }],
//     edges:[{ from, to }] }

const SVG_NS = 'http://www.w3.org/2000/svg';

const STATUS_LABEL = {
	planning: 'Planning',
	queued: 'Queued',
	running: 'Working',
	done: 'Done',
	failed: 'Failed',
};

const KIND_ICON = { lead: '◆', delegate: '↳', hire: '⇄' };
const KIND_LABEL = { lead: 'Lead', delegate: 'Delegated', hire: 'Hired' };

const TASK_STATUS_LABEL = {
	planning: 'Planning',
	running: 'Working',
	done: 'Complete',
	completed_with_errors: 'Complete · some failed',
};

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return null;
	return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(2)}`.replace('$0', '$0');
}

function injectStyle() {
	if (document.getElementById('cg-style')) return;
	const st = document.createElement('style');
	st.id = 'cg-style';
	st.textContent = `
.cg-root{position:relative;width:100%;min-height:160px;font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif);color:#e4e4e7}
.cg-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.cg-title{font-size:13px;font-weight:600;color:#fafafa;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font:600 11px/1 var(--font-mono,ui-monospace,monospace);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#a1a1aa;white-space:nowrap}
.cg-chip .cg-dot{width:7px;height:7px;border-radius:50%;background:#a1a1aa}
.cg-chip.running{color:#6ee7ff;border-color:rgba(110,231,255,.38);background:rgba(110,231,255,.1)}
.cg-chip.running .cg-dot{background:#6ee7ff;animation:cg-pulse 1.2s ease-in-out infinite}
.cg-chip.planning{color:#fbbf24;border-color:rgba(251,191,36,.36);background:rgba(251,191,36,.1)}
.cg-chip.planning .cg-dot{background:#fbbf24;animation:cg-pulse 1.2s ease-in-out infinite}
.cg-chip.done{color:#34d399;border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.12)}
.cg-chip.done .cg-dot{background:#34d399}
.cg-chip.completed_with_errors{color:#fbbf24;border-color:rgba(251,191,36,.36);background:rgba(251,191,36,.1)}
.cg-chip.completed_with_errors .cg-dot{background:#fbbf24}
.cg-spend{color:#a1a1aa;font:600 11px/1 var(--font-mono,ui-monospace,monospace)}
.cg-spend b{color:#e4e4e7}
.cg-canvas{position:relative;width:100%}
.cg-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0}
.cg-edge{fill:none;stroke:rgba(255,255,255,.16);stroke-width:1.6}
.cg-edge.flow{stroke:rgba(110,231,255,.55);stroke-dasharray:5 6;animation:cg-flow 1s linear infinite}
.cg-edge.done{stroke:rgba(52,211,153,.4)}
.cg-edge.failed{stroke:rgba(248,113,113,.4)}
.cg-nodes{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:26px}
.cg-lead-row{display:flex;justify-content:center;width:100%}
.cg-child-row{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;width:100%;max-height:340px;overflow-y:auto;padding:2px}
.cg-child-row::-webkit-scrollbar{width:6px}
.cg-child-row::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
.cg-node{position:relative;display:flex;flex-direction:column;gap:6px;width:180px;padding:11px 12px;border-radius:13px;background:rgba(20,20,26,.72);border:1px solid rgba(255,255,255,.1);text-decoration:none;color:inherit;cursor:pointer;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease,background .18s ease}
.cg-node:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.22);background:rgba(28,28,36,.85);box-shadow:0 10px 30px rgba(0,0,0,.4)}
.cg-node:focus-visible{outline:2px solid #6ee7ff;outline-offset:2px}
.cg-node.lead{width:230px;background:linear-gradient(160deg,rgba(34,28,52,.9),rgba(20,20,28,.82));border-color:rgba(154,123,255,.4)}
.cg-node.is-running{border-color:rgba(110,231,255,.5);box-shadow:0 0 0 1px rgba(110,231,255,.25),0 0 26px rgba(110,231,255,.14)}
.cg-node.is-running::before{content:"";position:absolute;inset:-1px;border-radius:13px;border:1.5px solid rgba(110,231,255,.55);animation:cg-ring 1.6s ease-out infinite;pointer-events:none}
.cg-node.is-queued{opacity:.62}
.cg-node.is-done{border-color:rgba(52,211,153,.34)}
.cg-node.is-failed{border-color:rgba(248,113,113,.45);background:rgba(40,18,18,.7)}
.cg-node-top{display:flex;align-items:center;gap:7px}
.cg-node-icon{flex:none;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-size:12px;background:rgba(255,255,255,.07);color:#d4d4d8}
.cg-node.lead .cg-node-icon{background:rgba(154,123,255,.2);color:#c4b5fd}
.cg-node.is-hire .cg-node-icon{background:rgba(110,231,255,.14);color:#6ee7ff}
.cg-node-kind{font:600 9px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:.08em;text-transform:uppercase;color:#71717a}
.cg-node-status{margin-left:auto;font:600 9px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:.04em;text-transform:uppercase;color:#a1a1aa;display:inline-flex;align-items:center;gap:4px}
.cg-node-status .cg-sdot{width:6px;height:6px;border-radius:50%;background:currentColor}
.cg-node.is-running .cg-node-status{color:#6ee7ff}
.cg-node.is-running .cg-sdot{animation:cg-pulse 1.2s ease-in-out infinite}
.cg-node.is-done .cg-node-status{color:#34d399}
.cg-node.is-failed .cg-node-status{color:#f87171}
.cg-node-title{font-size:12.5px;line-height:1.35;color:#e4e4e7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cg-node.lead .cg-node-title{font-weight:600;color:#fafafa;-webkit-line-clamp:3}
.cg-node-name{font-size:11px;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-node-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:1px}
.cg-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;font:600 10px/1 var(--font-mono,ui-monospace,monospace)}
.cg-badge.cost{color:#6ee7ff;background:rgba(110,231,255,.1);border:1px solid rgba(110,231,255,.26)}
.cg-badge.err{color:#f87171;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.28);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cg-receipt{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;font:600 10px/1 var(--font-mono,ui-monospace,monospace);color:#34d399;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);text-decoration:none;transition:background .15s}
.cg-receipt:hover{background:rgba(52,211,153,.2)}
.cg-receipt:focus-visible{outline:2px solid #34d399;outline-offset:1px}
.cg-skel{position:relative;overflow:hidden}
.cg-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);animation:cg-shimmer 1.3s linear infinite}
.cg-empty{text-align:center;color:#a1a1aa;font-size:13px;padding:18px 12px;line-height:1.5}
@keyframes cg-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes cg-ring{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.08);opacity:0}}
@keyframes cg-flow{to{stroke-dashoffset:-11}}
@keyframes cg-shimmer{to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.cg-edge.flow{animation:none}.cg-node.is-running::before{animation:none}.cg-chip .cg-dot{animation:none!important}.cg-skel::after{animation:none}}
`;
	document.head.appendChild(st);
}

// Create a live Team Task graph inside `host`. Returns a controller:
//   update(tree)  — repaint from a compact collab tree (idempotent)
//   clear()       — reset to empty/placeholder
//   destroy()     — tear down listeners + DOM
//
// opts.onOpenAgent(agentId) — invoked when a node is activated (click/Enter);
//   default opens that agent's /agent-screen in a new tab.
//   opts.compact — tighter spacing for the wall card.
//   opts.emptyHint — copy for the no-goal placeholder.
export function createCollabGraph(host, opts = {}) {
	injectStyle();
	const onOpenAgent =
		typeof opts.onOpenAgent === 'function'
			? opts.onOpenAgent
			: (agentId) => {
					if (agentId) window.open(`/agent-screen?agentId=${encodeURIComponent(agentId)}`, '_blank', 'noopener');
				};

	const root = document.createElement('div');
	root.className = 'cg-root' + (opts.compact ? ' cg-compact' : '');
	root.innerHTML = `
<div class="cg-head" hidden>
  <span class="cg-title" data-title></span>
  <span class="cg-spend" data-spend hidden></span>
  <span class="cg-chip" data-task-status><span class="cg-dot"></span><span data-task-status-label>—</span></span>
</div>
<div class="cg-canvas" data-canvas>
  <svg class="cg-edges" data-edges xmlns="${SVG_NS}"></svg>
  <div class="cg-nodes" data-nodes>
    <div class="cg-empty" data-empty>${esc(opts.emptyHint || 'Give the lead agent a goal and watch the team assemble.')}</div>
  </div>
</div>`;
	host.appendChild(root);

	const headEl = root.querySelector('.cg-head');
	const titleEl = root.querySelector('[data-title]');
	const spendEl = root.querySelector('[data-spend]');
	const taskChip = root.querySelector('[data-task-status]');
	const taskChipLabel = root.querySelector('[data-task-status-label]');
	const canvasEl = root.querySelector('[data-canvas]');
	const edgesEl = root.querySelector('[data-edges]');
	const nodesEl = root.querySelector('[data-nodes]');

	const nodeEls = new Map(); // node.id → element
	let leadRow = null;
	let childRow = null;
	let lastTree = null;

	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawEdges()) : null;
	ro?.observe(canvasEl);
	window.addEventListener('resize', drawEdges);

	function ensureRows() {
		if (!leadRow) {
			leadRow = document.createElement('div');
			leadRow.className = 'cg-lead-row';
			nodesEl.appendChild(leadRow);
		}
		if (!childRow) {
			childRow = document.createElement('div');
			childRow.className = 'cg-child-row';
			nodesEl.appendChild(childRow);
		}
	}

	function nodeStatusClass(node) {
		if (node.status === 'running' || node.status === 'planning') return 'is-running';
		if (node.status === 'done') return 'is-done';
		if (node.status === 'failed') return 'is-failed';
		return 'is-queued';
	}

	function buildNode(node) {
		const isLead = node.kind === 'lead';
		const el = document.createElement(node.agentId ? 'a' : 'div');
		el.className = 'cg-node';
		if (el.tagName === 'A') {
			el.href = `/agent-screen?agentId=${encodeURIComponent(node.agentId)}`;
			el.target = '_blank';
			el.rel = 'noopener';
		}
		el.tabIndex = 0;
		el.dataset.nodeId = node.id;
		const open = (e) => {
			if (!node.agentId) return;
			e.preventDefault();
			onOpenAgent(node.agentId);
		};
		el.addEventListener('click', open);
		el.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') open(e);
		});
		return el;
	}

	function paintNode(el, node) {
		const isLead = node.kind === 'lead';
		// Tolerate both the compact frame shape (sig/url) and the full task-tree
		// shape (signature/explorerUrl) so the live stream and the final HTTP
		// response can both drive the graph without re-mapping at the call site.
		const sig = node.sig || node.signature || null;
		const url = node.url || node.explorerUrl || null;
		el.className =
			'cg-node ' +
			nodeStatusClass(node) +
			(isLead ? ' lead' : '') +
			(node.kind === 'hire' ? ' is-hire' : '');
		const statusLabel = STATUS_LABEL[node.status] || node.status || '';
		const costBadge =
			node.costUsd != null
				? `<span class="cg-badge cost" title="Paid over x402">${esc(fmtUsd(node.costUsd) || '')}</span>`
				: '';
		const receipt =
			url && sig
				? `<a class="cg-receipt" href="${esc(url)}" target="_blank" rel="noopener" title="On-chain invocation receipt" data-stop-propagation>⛓ ${esc(String(sig).slice(0, 6))}…</a>`
				: '';
		const errBadge =
			node.status === 'failed' && node.error
				? `<span class="cg-badge err" title="${esc(node.error)}">${esc(node.error)}</span>`
				: '';
		const name = node.name && !isLead ? `<div class="cg-node-name">${esc(node.name)}</div>` : '';
		const title = node.title || (isLead ? 'Goal' : 'Sub-task');
		el.innerHTML = `
<div class="cg-node-top">
  <span class="cg-node-icon">${KIND_ICON[node.kind] || '•'}</span>
  <span class="cg-node-kind">${esc(KIND_LABEL[node.kind] || node.kind)}</span>
  <span class="cg-node-status"><span class="cg-sdot"></span>${esc(statusLabel)}</span>
</div>
<div class="cg-node-title" title="${esc(title)}">${esc(title)}</div>
${name}
<div class="cg-node-foot">${costBadge}${receipt}${errBadge}</div>`;
		el.title = node.agentId ? 'Open this agent’s live screen' : title;
	}

	function update(tree) {
		if (!tree || !Array.isArray(tree.nodes) || !tree.nodes.length) return;
		lastTree = tree;
		ensureRows();
		const empty = nodesEl.querySelector('[data-empty]');
		if (empty) empty.remove();

		// Header: goal + task status + spend.
		headEl.hidden = false;
		titleEl.textContent = tree.goal || 'Team task';
		titleEl.title = tree.goal || '';
		const ts = tree.status || 'running';
		taskChip.className = 'cg-chip ' + ts;
		taskChipLabel.textContent = TASK_STATUS_LABEL[ts] || ts;
		const spent = Number(tree.spentUsd ?? tree.budgetSpentUsd ?? 0);
		if (spent > 0 || tree.maxUsd) {
			spendEl.hidden = false;
			spendEl.innerHTML = `<b>${esc(fmtUsd(spent) || '$0.00')}</b> / ${esc(fmtUsd(tree.maxUsd) || '—')} spent`;
		} else {
			spendEl.hidden = true;
		}

		const seen = new Set();
		for (const node of tree.nodes) {
			seen.add(node.id);
			let el = nodeEls.get(node.id);
			if (!el) {
				el = buildNode(node);
				nodeEls.set(node.id, el);
				(node.kind === 'lead' ? leadRow : childRow).appendChild(el);
			}
			paintNode(el, node);
		}
		// Drop nodes no longer present (a fresh task replaced the tree).
		for (const [nodeId, el] of [...nodeEls]) {
			if (!seen.has(nodeId)) {
				el.remove();
				nodeEls.delete(nodeId);
			}
		}

		requestAnimationFrame(() => drawEdges());
	}

	function drawEdges() {
		if (!lastTree || !Array.isArray(lastTree.edges)) return;
		const box = canvasEl.getBoundingClientRect();
		if (!box.width) return;
		edgesEl.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
		edgesEl.setAttribute('width', box.width);
		edgesEl.setAttribute('height', box.height);
		const center = (el, edge) => {
			const r = el.getBoundingClientRect();
			return {
				x: r.left - box.left + r.width / 2,
				yTop: r.top - box.top,
				yBot: r.bottom - box.top,
			};
		};
		const frag = document.createDocumentFragment();
		const statusOf = (id) => lastTree.nodes.find((n) => n.id === id)?.status;
		for (const edge of lastTree.edges) {
			const fromEl = nodeEls.get(edge.from);
			const toEl = nodeEls.get(edge.to);
			if (!fromEl || !toEl) continue;
			const a = center(fromEl);
			const b = center(toEl);
			const x1 = a.x;
			const y1 = a.yBot;
			const x2 = b.x;
			const y2 = b.yTop;
			const my = (y1 + y2) / 2;
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
			const st = statusOf(edge.to);
			let cls = 'cg-edge';
			if (st === 'running') cls += ' flow';
			else if (st === 'done') cls += ' done';
			else if (st === 'failed') cls += ' failed';
			path.setAttribute('class', cls);
			frag.appendChild(path);
		}
		edgesEl.replaceChildren(frag);
	}

	function clear() {
		nodeEls.forEach((el) => el.remove());
		nodeEls.clear();
		edgesEl.replaceChildren();
		lastTree = null;
		headEl.hidden = true;
		if (!nodesEl.querySelector('[data-empty]')) {
			const e = document.createElement('div');
			e.className = 'cg-empty';
			e.dataset.empty = '1';
			e.textContent = opts.emptyHint || 'Give the lead agent a goal and watch the team assemble.';
			nodesEl.appendChild(e);
		}
	}

	function destroy() {
		ro?.disconnect();
		window.removeEventListener('resize', drawEdges);
		root.remove();
	}

	return { root, update, clear, drawEdges, destroy, get tree() { return lastTree; } };
}
