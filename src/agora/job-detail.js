// Agora — the job detail panel. Click a board marker (an open task) or a
// completed-task row in a passport, and this renders the job's real on-chain
// lifecycle: created → claimed → completed, each step with its actor and a
// Solana Explorer link to the actual transaction. For a completed task it also
// mounts the public deliverable verifier (verify.js) so anyone can re-hash the
// artifact and confirm it against the on-chain proofHash.

import { h, infoRow, rewardChip, copyChip } from './panel.js';
import { fetchTask } from './api.js';
import { mountVerifier } from './verify.js';
import { injectTrustSurfaceCss } from './trust-surface.css.js';
import {
	explorerTxUrl, explorerAddressUrl, shortId, timeAgo, absoluteTime,
	professionLabel, formatThree,
} from './format.js';

// Ordered lifecycle steps we render even before they've happened, so a partly-
// complete job reads as a path with the remaining steps shown as upcoming.
const LIFECYCLE_STEPS = [
	{ match: /^create/i, key: 'created', label: 'Created', desc: 'Bounty posted & reward escrowed' },
	{ match: /^claim/i, key: 'claimed', label: 'Claimed', desc: 'Worker took the job' },
	{ match: /^(complete|prove|submit)/i, key: 'completed', label: 'Completed', desc: 'Proof accepted, reward released' },
];

function stateBadge(state) {
	const s = String(state || 'Unknown');
	const cls = {
		Open: 'is-open', Claimed: 'is-claimed', Completed: 'is-completed',
		Cancelled: 'is-cancelled', Disputed: 'is-disputed', Expired: 'is-expired',
	}[s] || 'is-unknown';
	return h('span', { class: `agora-badge ${cls}` }, [s]);
}

// Render the job into the shared panel. opts carries everything the caller knows;
// the on-chain truth (state + timeline) is (re)fetched here.
//
//   opts: { taskPda, creator, taskId, cluster, title, profession, reward,
//           proofHash, deliverableUrl, txSignature }
//   ctx:  { onOpenPassport(actorPda) }  — optional cross-links
export async function renderJobDetail(panel, opts = {}, ctx = {}) {
	injectTrustSurfaceCss();
	const cluster = opts.cluster === 'mainnet' ? 'mainnet' : 'devnet';

	// An x402 bazaar service marker isn't an on-chain AgenC task with a lifecycle —
	// it's a pay-per-call endpoint. Render its real detail honestly instead of a
	// timeline that doesn't exist.
	if (opts.source === 'x402' || (!opts.taskPda && !(opts.creator && opts.taskId) && opts.resource)) {
		panel.setHeader(opts.title || 'Service', 'x402 service · pay-per-call');
		panel.open(opts.opener);
		panel.setBody(buildService(opts));
		return;
	}

	panel.setHeader(opts.title || 'Job', opts.taskPda ? jobSubheader(opts.taskPda, cluster) : 'On-chain task');
	panel.setLoading('Loading job lifecycle…');
	panel.open(opts.opener);

	if (!opts.taskPda && !(opts.creator && opts.taskId)) {
		panel.setError('This job has no on-chain task reference to load.');
		return;
	}

	const ac = new AbortController();
	panel._jobAbort?.abort();
	panel._jobAbort = ac;

	let data;
	try {
		data = await fetchTask({
			taskPda: opts.taskPda, creator: opts.creator, taskId: opts.taskId,
			cluster, lifecycle: true,
		}, { signal: ac.signal });
	} catch (err) {
		if (ac.signal.aborted) return;
		// not_found is a real, designed state — the PDA is referenced but the
		// on-chain account is gone or on another cluster (the API 404s, which the
		// client surfaces as a thrown error). Everything else is a retryable error.
		if (/not.?found|404/i.test(err.message || '')) {
			panel.setHeader(opts.title || 'Job', opts.taskPda ? jobSubheader(opts.taskPda, cluster) : 'On-chain task');
			panel.setBody(buildNotFound(opts, cluster));
		} else {
			panel.setError(`Couldn't load this job from the chain: ${err.message}`, () => renderJobDetail(panel, opts, ctx));
		}
		return;
	}
	if (ac.signal.aborted) return;

	if (!data || data.ok === false) {
		panel.setBody(buildNotFound(opts, cluster));
		return;
	}

	const task = data.task || {};
	const lifecycle = data.lifecycle || null;
	const state = task.state || lifecycle?.currentState || 'Unknown';

	panel.setHeader(opts.title || 'Job', jobSubheader(opts.taskPda || data.taskPda, cluster));
	panel.setBody(buildJob({ opts, data, task, lifecycle, state, cluster }, ctx));
}

function jobSubheader(taskPda, cluster) {
	const frag = h('span', { class: 'agora-sub-row' }, [
		h('span', { class: 'agora-chip agora-chip-cluster' }, [cluster]),
		h('code', { class: 'agora-sub-code' }, [shortId(taskPda, 4, 4)]),
		copyChip(taskPda, 'task PDA'),
	]);
	return frag;
}

function buildJob({ opts, task, lifecycle, state, cluster }, ctx) {
	const reward = opts.reward || (task.rewardAmount != null ? {
		label: `${formatThree(task.rewardAmount)} $THREE`,
		amountAtomic: String(task.rewardAmount),
	} : null);

	const meta = h('div', { class: 'agora-job-meta' }, [
		h('div', { class: 'agora-job-state' }, [stateBadge(state)]),
		reward ? h('div', { class: 'agora-job-reward' }, [
			h('span', { class: 'agora-kv-key' }, ['Reward']),
			rewardChip(reward.label?.replace(/\s*\$THREE$/i, '') || formatThree(reward.amountAtomic), '$THREE'),
		]) : null,
	].filter(Boolean));

	const facts = h('div', { class: 'agora-facts' }, [
		opts.profession ? infoRow('Profession', h('span', { class: 'agora-chip agora-chip-prof' }, [professionLabel(opts.profession)])) : null,
		infoRow('Workers', `${task.currentWorkers ?? 0} / ${task.maxWorkers ?? 1}`),
		task.creator ? infoRow('Creator', addressLink(task.creator, cluster)) : null,
		task.deadline ? infoRow('Deadline', absoluteTime(Number(task.deadline))) : null,
		task.private ? infoRow('Visibility', 'Private (constraint-gated)') : null,
	].filter(Boolean));

	const timeline = buildTimeline(lifecycle, cluster, ctx);

	// The worker who produced the deliverable (for the Verify → vouch bridge):
	// the actor on the completion event, falling back to the claim actor.
	const worker = completerFromLifecycle(lifecycle, opts, cluster);
	// The caller (board / passport row) usually hands us the deliverable; a deep
	// link (/agora?task=<pda>) carries only the PDA, so fall back to the proof the
	// lifecycle itself reports. Without this, arriving by URL shows "no proofHash
	// recorded" for work that is in fact verifiable.
	const proof = {
		deliverableUrl: opts.deliverableUrl || lifecycle?.deliverableUrl || null,
		proofHash: opts.proofHash || lifecycle?.proofHash || null,
	};
	const verifySection = buildVerifySection({ ...opts, ...proof }, state, worker);

	return [meta, facts, timeline, verifySection];
}

// Pull the citizen who did the work from the on-chain lifecycle so a matching
// verification can offer a one-click vouch for them. Prefer the completion
// actor; fall back to the claim actor. Returns null when unknown (no vouch CTA).
function completerFromLifecycle(lifecycle, opts, cluster) {
	const events = lifecycle?.timeline || [];
	const done = events.find((e) => /^(complete|prove|submit)/i.test(e.eventName || ''));
	const claimed = events.find((e) => /^claim/i.test(e.eventName || ''));
	const agentPda = done?.actor || claimed?.actor || null;
	if (!agentPda) return null;
	return { agentPda, cluster, taskPda: opts.taskPda || null };
}

function buildTimeline(lifecycle, cluster, ctx) {
	const section = h('section', { class: 'agora-section' }, [
		h('h3', { class: 'agora-section-title' }, ['Lifecycle']),
	]);

	const events = lifecycle?.timeline || [];
	if (!events.length) {
		section.appendChild(h('p', { class: 'agora-muted agora-section-empty' }, [
			'No on-chain lifecycle events recorded yet for this task.',
		]));
		return section;
	}

	const list = h('ol', { class: 'agora-timeline' });
	for (const ev of events) {
		const step = LIFECYCLE_STEPS.find((s) => s.match.test(ev.eventName)) || null;
		list.appendChild(h('li', { class: 'agora-timeline-item is-done' }, [
			h('span', { class: 'agora-timeline-dot', 'aria-hidden': 'true' }),
			h('div', { class: 'agora-timeline-body' }, [
				h('div', { class: 'agora-timeline-head' }, [
					h('span', { class: 'agora-timeline-label' }, [step?.label || ev.eventName]),
					ev.timestamp ? h('time', { class: 'agora-timeline-time', title: absoluteTime(Number(ev.timestamp)) }, [timeAgo(Number(ev.timestamp))]) : null,
				].filter(Boolean)),
				step?.desc ? h('div', { class: 'agora-timeline-desc' }, [step.desc]) : null,
				h('div', { class: 'agora-timeline-links' }, [
					ev.actor ? actorLink(ev.actor, cluster, ctx) : null,
					ev.txSignature ? h('a', {
						class: 'agora-tx-link',
						href: explorerTxUrl(ev.txSignature, cluster),
						target: '_blank', rel: 'noopener noreferrer',
						title: 'View transaction on Solana Explorer',
					}, ['tx ', shortId(ev.txSignature, 4, 4), ' ↗']) : h('span', { class: 'agora-muted agora-tx-link' }, ['no tx recorded']),
				].filter(Boolean)),
			]),
		]));
	}
	section.appendChild(list);
	return section;
}

function buildVerifySection(opts, state, worker = null) {
	const section = h('section', { class: 'agora-section' }, [
		h('h3', { class: 'agora-section-title' }, [
			'Verify deliverable',
			h('span', { class: 'agora-section-hint' }, ['re-hash it yourself — no trust required']),
		]),
	]);
	const isCompleted = /complete/i.test(String(state));
	if (!isCompleted && !opts.deliverableUrl) {
		section.appendChild(h('p', { class: 'agora-muted agora-section-empty' }, [
			'This task isn\'t completed yet — there\'s no deliverable to verify.',
		]));
		return section;
	}
	const mount = h('div', { class: 'agora-verify-mount' });
	section.appendChild(mount);
	mountVerifier(mount, { deliverableUrl: opts.deliverableUrl, proofHash: opts.proofHash, worker });
	return section;
}

function actorLink(pda, cluster, ctx) {
	// Open the actor's passport: prefer an explicit callback, else broadcast the
	// decoupled event the passport panel listens for. Always keep the raw Explorer
	// link so the on-chain account is one click away.
	const btn = h('button', {
		class: 'agora-actor-link', type: 'button',
		title: 'Open this citizen\'s passport',
	}, [shortId(pda, 4, 4)]);
	btn.addEventListener('click', () => {
		if (typeof ctx.onOpenPassport === 'function') ctx.onOpenPassport(pda);
		else window.dispatchEvent(new CustomEvent('agora:open-passport', { detail: { agentPda: pda } }));
	});
	return h('span', { class: 'agora-timeline-actor' }, [
		h('span', { class: 'agora-muted' }, ['by ']), btn,
		h('a', { class: 'agora-addr-ext', href: explorerAddressUrl(pda, cluster), target: '_blank', rel: 'noopener noreferrer', title: 'View account on Explorer', 'aria-label': 'View account on Explorer' }, ['↗']),
	]);
}

// An x402 service marker's honest detail: what it does, what it costs, and a link
// to call it. No lifecycle/verify — it's a live endpoint, not a proven artifact.
function buildService(opts) {
	const reward = opts.reward || null;
	return [
		opts.description ? h('p', { class: 'agora-service-desc' }, [opts.description]) : null,
		h('div', { class: 'agora-facts' }, [
			infoRow('Type', 'x402 · pay-per-call'),
			opts.profession ? infoRow('Profession', h('span', { class: 'agora-chip agora-chip-prof' }, [professionLabel(opts.profession)])) : null,
			reward ? infoRow('Price', h('span', { class: 'agora-mono-sm' }, [reward.label || '—'])) : null,
			reward?.network ? infoRow('Network', reward.network) : null,
			reward?.currency ? infoRow('Currency', reward.currency) : null,
		].filter(Boolean)),
		opts.resource ? h('div', { class: 'agora-verify-actions' }, [
			h('a', { class: 'agora-btn agora-btn-ghost', href: opts.resource, target: '_blank', rel: 'noopener noreferrer' }, ['Open endpoint ↗']),
		]) : null,
		h('p', { class: 'agora-muted agora-section-empty' }, [
			'A Fetcher citizen claims this by calling the endpoint and returning the result — value flows multi-hop through the Commons.',
		]),
	].filter(Boolean);
}

function addressLink(address, cluster) {
	return h('a', {
		class: 'agora-addr', href: explorerAddressUrl(address, cluster),
		target: '_blank', rel: 'noopener noreferrer',
		title: `${address} — view on Solana Explorer`,
	}, [shortId(address, 4, 4), ' ↗']);
}

function buildNotFound(opts, cluster) {
	return h('div', { class: 'agora-state agora-state-empty' }, [
		h('div', { class: 'agora-state-icon', 'aria-hidden': 'true' }, ['◌']),
		h('p', { class: 'agora-state-msg' }, ['This task isn\'t on the ', cluster, ' chain.']),
		h('p', { class: 'agora-state-hint' }, [
			'The projection references it but the on-chain account wasn\'t found — it may be on another cluster or has been closed.',
		]),
		opts.taskPda ? h('div', { class: 'agora-hash-row' }, [
			h('code', { class: 'agora-hash' }, [shortId(opts.taskPda, 8, 8)]),
			copyChip(opts.taskPda, 'task PDA'),
		]) : null,
	].filter(Boolean));
}
