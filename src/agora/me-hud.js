// Agora — the human "you" layer (Task 08). A self-mounting overlay that turns a
// signed-in visitor into a first-class citizen of the Commons: it joins them
// (provisioning a custodial wallet + placing their avatar in the world via the
// agora_citizens projection), then exposes every human action — post a bounty,
// hire a citizen, claim + complete a task yourself, and vouch — through one
// accessible HUD + drawer.
//
// Decoupled by design (the trust-surface precedent): it never imports the
// scaffold (agora-world.js) or the economy/trust layers. It only:
//   • reads context from window events the other layers already emit
//       'agora:open-job'      {detail:{task}}      → the job you're looking at
//       'agora:open-passport' {detail:{agentPda}}  → the citizen you're looking at
//       'agora:vouch-prompt'  {detail:{agentPda,…}}→ verify.js confirmed a
//           deliverable; open the drawer straight to a one-click vouch for the
//           citizen who produced it (the Verify → vouch loop, Task 08 DoD).
//   • re-emits 'agora:open-job' after a claim/complete so the open job panel
//     refreshes itself.
// Signed-out visitors keep the world fully watchable and get an honest
// "sign in to join the Commons" CTA — nothing is gated behind auth except acting.

import { Panel, h, clear, copyChip } from './panel.js';
import { fetchPassport } from './api.js';
import { injectHumansCss } from './humans.css.js';
import { getMe, join, postTask, hire, claim, complete, vouch } from './actions.js';

const state = {
	loading: true,
	user: null,    // signed-in user (or null)
	me: null,      // citizen HUD payload from join() (or null if not joined)
	job: null,     // { taskPda, cluster, title } — the job currently open
	subject: null, // { id, name } — the citizen currently open (for hire/vouch)
};

let dock, toasts, panel, root;
let dockResize = null;

// Publish the dock's live height as --agora-dock-h on :root.
//
// On a phone the dock spans the full width at the bottom of the world, and the
// page's other bottom furniture (the "Enter the Commons" button, the job board
// panel) has to sit above it or be swallowed by it. The dock's height is not a
// constant the stylesheets could hardcode: it grows and shrinks with the signed
// out invite, the signed in citizen card, and whatever job is in flight. So the
// dock measures itself and the layout is expressed against that number, which
// keeps the stack correct through every state instead of only the one somebody
// measured once.
function publishDockHeight() {
	if (!dock || typeof ResizeObserver === 'undefined') return;
	const push = () => {
		const h = Math.round(dock.getBoundingClientRect().height);
		document.documentElement.style.setProperty('--agora-dock-h', `${h}px`);
	};
	dockResize = new ResizeObserver(push);
	dockResize.observe(dock);
	push();
}

function boot() {
	if (typeof document === 'undefined') return;
	injectHumansCss();
	root = h('div', { class: 'agora-h-root' });
	dock = h('div', { id: 'agora-humans-dock' });
	toasts = h('div', { id: 'agora-humans-toasts', 'aria-live': 'polite' });
	root.append(dock, toasts);
	document.body.appendChild(root);
	publishDockHeight();

	panel = new Panel({ id: 'agora-you' }).mount(document.body);

	window.addEventListener('agora:open-job', onOpenJob);
	window.addEventListener('agora:open-passport', onOpenPassport);
	// The Verify → vouch bridge (verify.js dispatches this after a matching verdict).
	window.addEventListener('agora:vouch-prompt', onVouchPrompt);

	renderDock();
	refreshMe(true);
}

// ── data ──────────────────────────────────────────────────────────────────────

async function refreshMe(autoJoin = false) {
	try {
		state.user = await getMe();
	} catch {
		state.user = null;
	}
	state.loading = false;

	if (state.user && (autoJoin || state.me)) {
		// Joining is free (no funds move) + idempotent — the DoD's "first
		// authenticated visit upserts a human citizen + places their avatar".
		try {
			const res = await join({});
			state.me = res?.me || state.me;
			// The new citizen row now exists; nudge the world to repopulate.
			window.dispatchEvent(new CustomEvent('agora:citizens-changed'));
		} catch (err) {
			// Auth ok but join failed (e.g. endpoint not yet deployed) — keep the
			// user, surface a Join button rather than silently degrading.
			if (err?.status !== 401) console.warn('[agora] join failed:', err?.message);
		}
	}
	renderDock();
	if (panel?.isOpen) renderYou();
}

// ── dock ────────────────────────────────────────────────────────────────────

function renderDock() {
	clear(dock);
	if (state.loading) { dock.style.display = 'none'; return; }
	dock.style.display = 'flex';

	if (!state.user) {
		dock.appendChild(h('div', { class: 'agora-h-card' }, [
			h('div', { class: 'agora-h-meta' }, [
				h('span', { class: 'agora-h-name' }, ['Watching the Commons']),
				h('span', { class: 'agora-h-line' }, ['Sign in to join, post bounties & earn $THREE']),
			]),
			h('a', { class: 'agora-btn agora-btn-primary agora-h-btn-sm', href: `/login?next=${encodeURIComponent('/agora')}` }, ['Sign in to join']),
		]));
		return;
	}

	if (!state.me) {
		dock.appendChild(h('div', { class: 'agora-h-card' }, [
			h('div', { class: 'agora-h-dot' }, [initial(state.user.display_name || state.user.handle)]),
			h('div', { class: 'agora-h-meta' }, [
				h('span', { class: 'agora-h-name' }, [state.user.display_name || 'three.ws citizen']),
				h('span', { class: 'agora-h-line' }, ['Not yet a citizen']),
			]),
			h('button', { class: 'agora-btn agora-btn-primary agora-h-btn-sm', type: 'button', onclick: () => refreshMe(true) }, ['Join Agora']),
		]));
		return;
	}

	const me = state.me;
	dock.appendChild(h('div', { class: 'agora-h-card' }, [
		h('div', { class: 'agora-h-dot' }, me.avatarUrl ? [h('img', { src: me.avatarUrl, alt: '' })] : [initial(me.displayName)]),
		h('div', { class: 'agora-h-meta' }, [
			h('span', { class: 'agora-h-name' }, [me.displayName]),
			h('span', { class: 'agora-h-line' }, [
				h('span', { class: `agora-h-status-pill is-${me.status}` }),
				statusLabel(me),
			]),
		]),
		h('div', { class: 'agora-h-dock-btns' }, [
			h('button', { class: 'agora-btn agora-btn-primary agora-h-btn-sm', type: 'button', onclick: () => openYou('post') }, ['Post bounty']),
			h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button', onclick: () => openYou() }, ['You ▸']),
		]),
	]));
}

function statusLabel(me) {
	const bal = balanceText(me);
	return `${cap(me.status)}${bal ? ' · ' + bal : ''}`;
}

function balanceText(me) {
	if (!me?.balances) return '';
	if (me.cluster === 'mainnet') return me.balances.three != null ? `${fmt(me.balances.three)} $THREE` : '';
	return me.balances.sol != null ? `${fmt(me.balances.sol)} SOL` : '';
}

// ── "You" drawer ───────────────────────────────────────────────────────────

function openYou(initialView) {
	if (!state.me) { refreshMe(true); return; }
	panel.open(document.activeElement);
	renderYou(initialView);
}

function renderYou(view) {
	const me = state.me;
	panel.setHeader('You in Agora', `${cap(me.cluster)} · ${shortAddr(me.walletAddress)}`);

	if (view === 'post') { renderPostView(); return; }

	const sections = [];

	// Status grid.
	sections.push(section('Your standing', h('div', { class: 'agora-h-stats' }, [
		stat('Status', cap(me.status)),
		stat('Reputation', String(me.reputation ?? 0)),
		stat('Posted', String(me.tasksPosted ?? 0)),
		stat('Completed', String(me.tasksCompleted ?? 0)),
		stat('Earned', me.cluster === 'mainnet' ? `${fmtAtomic(me.earnedThreeAtomic)} $THREE` : '—'),
		stat('Balance', balanceText(me) || '—'),
	])));

	// Wallet.
	if (me.walletAddress) {
		sections.push(section('Custodial wallet', h('div', { class: 'agora-h-wallet' }, [
			copyChip(me.walletAddress, 'wallet address'),
			h('span', {}, [me.cluster === 'devnet' ? 'Auto-funded with devnet SOL on first action.' : `Send $THREE here to fund bounties.`]),
		])));
	}

	// Post a bounty.
	sections.push(section('Post work', h('div', {}, [
		h('p', { class: 'agora-h-hint' }, ['Escrow a real bounty for any profession. It hits the board for an agent — or you — to fulfil.']),
		h('button', { class: 'agora-btn agora-btn-primary', type: 'button', onclick: () => renderPostView() }, ['Compose a bounty']),
	])));

	// Your open bounties.
	const open = me.openPosted || [];
	sections.push(section(`Your open bounties (${open.length})`, open.length
		? h('ul', { class: 'agora-h-list' }, open.map((t) => h('li', {}, [
			h('span', {}, [`${cap(t.profession || 'task')} · ${t.rewardLabel || ''}`]),
			h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button', onclick: () => openJobByPda(t.taskPda) }, ['Open']),
		])))
		: h('p', { class: 'agora-h-empty' }, ['No open bounties. Post one above.'])));

	// Contextual: work the open job.
	if (state.job?.taskPda) sections.push(renderJobSection());

	// Contextual: vouch for the open citizen.
	if (state.subject?.id && state.subject.id !== me.citizenId) sections.push(renderVouchSection());

	panel.setBody(sections);
}

function renderPostView() {
	panel.open(document.activeElement);
	panel.setHeader('Post a bounty', 'Escrow a reward on AgenC — real, on-chain');
	const form = buildComposeForm(null);
	const back = h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button', onclick: () => renderYou() }, ['‹ Back']);
	panel.setBody([h('div', { class: 'agora-h-section' }, [back]), form]);
}

function renderHireView(subject) {
	panel.open(document.activeElement);
	panel.setHeader(`Hire ${subject.name}`, 'Post a bounty routed to this citizen — real, on-chain');
	const form = buildComposeForm({ id: subject.id, name: subject.name, profession: subject.profession });
	const back = h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button', onclick: () => renderYou() }, ['‹ Back']);
	panel.setBody([h('div', { class: 'agora-h-section' }, [back]), form]);
}

function buildComposeForm(hireTarget) {
	// Lazy import keeps the form code out of the initial dock paint.
	const placeholder = h('div', { class: 'agora-h-hint' }, ['Loading form…']);
	import('./post-form.js').then(({ buildPostForm }) => {
		const form = buildPostForm({
			cluster: 'devnet',
			hireTarget,
			onSubmit: async (payload) => {
				const res = hireTarget ? await hire(payload) : await postTask(payload);
				toast(`${hireTarget ? 'Hired' : 'Bounty posted'} — ${res.reward?.label || ''}`, 'ok', res.explorerUrl);
				await refreshMe();
				window.dispatchEvent(new CustomEvent('agora:citizens-changed'));
				return res;
			},
		});
		placeholder.replaceWith(form);
	}).catch((e) => { placeholder.textContent = `Could not load the form: ${e?.message || 'error'}`; });
	return placeholder;
}

function renderJobSection() {
	const job = state.job;

	// Your own bounty is a designed state, not a failed click: AgenC refuses a
	// self-claim, so show what the job is actually waiting for instead of a Claim
	// button that can only ever come back rejected.
	if ((state.me?.openPosted || []).some((t) => t.taskPda === job.taskPda)) {
		return section('Your bounty', h('div', {}, [
			h('p', { class: 'agora-h-hint' }, [
				`You posted ${job.title || shortAddr(job.taskPda)}. It stays on the board until a citizen claims it, then you'll see the work land here live.`,
			]),
		]));
	}

	const proof = h('textarea', { class: 'agora-h-input agora-h-textarea', placeholder: 'Paste your deliverable (text or a URL). It is sha256-hashed into the on-chain proof.' });
	const status = h('div', { class: 'agora-h-status', role: 'status', 'aria-live': 'polite' });

	const claimBtn = h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button' }, ['Claim this task']);
	claimBtn.addEventListener('click', async () => {
		claimBtn.disabled = true; status.className = 'agora-h-status'; status.textContent = 'Claiming…';
		try {
			const res = await claim({ taskPda: job.taskPda, cluster: job.cluster });
			status.className = 'agora-h-status is-ok'; status.textContent = 'Claimed.';
			toast('Task claimed', 'ok', res.explorerUrl);
			reopenJob(); await refreshMe();
		} catch (err) {
			status.className = 'agora-h-status is-error'; status.textContent = err?.message || 'Claim failed.';
		} finally { claimBtn.disabled = false; }
	});

	const submitBtn = h('button', { class: 'agora-btn agora-btn-primary', type: 'button' }, ['Submit proof']);
	submitBtn.addEventListener('click', async () => {
		const deliverable = proof.value.trim();
		if (!deliverable) { status.className = 'agora-h-status is-error'; status.textContent = 'Add your deliverable first.'; return; }
		submitBtn.disabled = true; status.className = 'agora-h-status'; status.textContent = 'Submitting proof…';
		try {
			const res = await complete({ taskPda: job.taskPda, deliverable, cluster: job.cluster });
			status.className = 'agora-h-status is-ok'; clear(status);
			status.append(`Completed — earned ${res.reward?.label || ''}. `, res.explorerUrl ? h('a', { class: 'agora-h-link', href: res.explorerUrl, target: '_blank', rel: 'noopener' }, ['tx ↗']) : '');
			toast(`Completed — earned ${res.reward?.label || ''}`, 'ok', res.explorerUrl);
			reopenJob(); await refreshMe();
		} catch (err) {
			status.className = 'agora-h-status is-error'; status.textContent = err?.message || 'Could not submit the proof.';
		} finally { submitBtn.disabled = false; }
	});

	return section('Work this job', h('div', {}, [
		h('p', { class: 'agora-h-hint' }, [`Open job: ${state.job.title || shortAddr(job.taskPda)}`]),
		h('div', { class: 'agora-h-actions' }, [claimBtn]),
		h('div', { class: 'agora-h-field' }, [h('span', { class: 'agora-h-field-label' }, ['Your deliverable']), proof]),
		h('div', { class: 'agora-h-actions' }, [submitBtn]),
		status,
	]));
}

function renderVouchSection() {
	const subj = state.subject;
	const note = h('input', { id: 'agora-vouch-note', class: 'agora-h-input', type: 'text', maxlength: '280', placeholder: `Why ${subj.name} earned your vouch (optional)` });
	const status = h('div', { class: 'agora-h-status', role: 'status', 'aria-live': 'polite' });
	const btn = h('button', { class: 'agora-btn agora-btn-primary', type: 'button' }, [`Vouch for ${subj.name}`]);
	btn.addEventListener('click', async () => {
		btn.disabled = true; status.className = 'agora-h-status'; status.textContent = 'Recording on-chain…';
		try {
			const res = await vouch({ subjectCitizenId: subj.id, taskPda: state.job?.taskPda || null, note: note.value.trim() });
			status.className = 'agora-h-status is-ok'; clear(status);
			status.append(`${res.refreshed ? 'Vouch refreshed' : 'Vouched'}. `, res.explorerUrl ? h('a', { class: 'agora-h-link', href: res.explorerUrl, target: '_blank', rel: 'noopener' }, ['tx ↗']) : '');
			toast(`Vouched for ${subj.name}`, 'ok', res.explorerUrl);
		} catch (err) {
			status.className = 'agora-h-status is-error'; status.textContent = err?.message || 'The vouch was not recorded.';
		} finally { btn.disabled = false; }
	});
	const hireBtn = h('button', { class: 'agora-btn agora-h-btn-sm', type: 'button', onclick: () => renderHireView(subj) }, [`Hire ${subj.name}`]);
		return section(subj.name, h('div', {}, [
			h('div', { class: 'agora-h-actions' }, [hireBtn]),
		h('p', { class: 'agora-h-hint' }, ['Leaves a real on-chain attestation that this citizen does good work — verify their deliverable first, then vouch.']),
		h('div', { class: 'agora-h-field' }, [note]),
		h('div', { class: 'agora-h-actions' }, [btn]),
		status,
	]));
}

// ── event context ────────────────────────────────────────────────────────────

function onOpenJob(e) {
	const t = e.detail?.task || e.detail || {};
	if (!t.taskPda) return;
	state.job = { taskPda: t.taskPda, cluster: t.cluster || t.agenc?.cluster || 'devnet', title: t.title || t.narrative || null };
	if (panel?.isOpen) renderYou();
}

async function onOpenPassport(e) {
	const agentPda = e.detail?.agentPda;
	const id = e.detail?.id;
	try {
		const data = id ? await fetchPassport({ id }) : (agentPda ? await fetchPassport({ agentPda }) : null);
		if (data?.citizen) state.subject = { id: data.citizen.id, name: data.citizen.displayName };
	} catch { /* leave subject unchanged */ }
	if (panel?.isOpen) renderYou();
}

// The Verify → vouch bridge. A matching verification (verify.js) dispatches this
// with the worker who produced the deliverable. We resolve them to a Commons
// citizen, join the viewer if needed, and open the drawer straight to the vouch
// section — so confirming work and attesting to it is genuinely one flow. Every
// dead end is an honest, designed state (not a citizen / yourself / signed out).
async function onVouchPrompt(e) {
	const d = e.detail || {};
	let subject = null;
	try {
		const data = d.citizenId ? await fetchPassport({ id: d.citizenId })
			: (d.agentPda ? await fetchPassport({ agentPda: d.agentPda }) : null);
		if (data?.citizen) subject = { id: data.citizen.id, name: data.citizen.displayName };
	} catch { /* resolution failed → honest message below */ }
	if (!subject) {
		toast('This worker isn’t a Commons citizen yet — nothing to vouch for.', 'error');
		return;
	}

	// Vouching moves value (a real on-chain attestation) → it needs a signed-in,
	// joined citizen. Surface the honest gate rather than silently doing nothing.
	if (!state.user) { try { state.user = await getMe(); } catch { state.user = null; } }
	if (!state.user) {
		toast('Sign in to vouch for this work.', 'error');
		renderDock();
		return;
	}
	if (!state.me) await refreshMe(true);
	if (!state.me) { toast('Could not join Agora to vouch — try again.', 'error'); return; }

	if (subject.id === state.me.citizenId) {
		toast('That’s your own work — you can’t vouch for yourself.', 'error');
		return;
	}

	state.subject = subject;
	if (d.taskPda) state.job = { taskPda: d.taskPda, cluster: d.cluster || state.me.cluster || 'devnet', title: state.job?.title || null };

	panel.open(document.activeElement);
	renderYou();
	focusVouchSection();
}

// Bring the (freshly rendered) vouch note into view + focus it, so a click on the
// verifier's "Vouch" button lands the viewer right on the attestation control.
function focusVouchSection() {
	setTimeout(() => {
		const note = document.getElementById('agora-vouch-note');
		if (!note) return;
		try { note.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { note.scrollIntoView(); }
		note.focus({ preventScroll: true });
	}, 60);
}

function openJobByPda(taskPda) {
	window.dispatchEvent(new CustomEvent('agora:open-job', { detail: { task: { taskPda, cluster: state.me?.cluster || 'devnet' } } }));
}

function reopenJob() {
	if (state.job?.taskPda) {
		window.dispatchEvent(new CustomEvent('agora:open-job', { detail: { task: { taskPda: state.job.taskPda, cluster: state.job.cluster } } }));
	}
}

// ── ui helpers ────────────────────────────────────────────────────────────────

function section(title, body) {
	return h('div', { class: 'agora-h-section' }, [h('h3', {}, [title]), body]);
}
function stat(k, v) {
	return h('div', { class: 'agora-h-stat' }, [h('span', { class: 'k' }, [k]), h('span', { class: 'v' }, [v])]);
}
function toast(msg, kind = '', explorerUrl = null) {
	const el = h('div', { class: `agora-h-toast${kind ? ' is-' + kind : ''}`, role: 'status' }, [
		h('span', {}, [msg]),
		explorerUrl ? h('span', {}, [' ', h('a', { href: explorerUrl, target: '_blank', rel: 'noopener' }, ['view ↗'])]) : null,
	]);
	toasts.appendChild(el);
	setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 5200);
}
function initial(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
function cap(s) { return s ? String(s)[0].toUpperCase() + String(s).slice(1) : ''; }
function shortAddr(a) { return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—'; }
function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function fmtAtomic(atomic) {
	try { return (BigInt(atomic || '0') / 1_000_000n).toLocaleString('en-US'); } catch { return '0'; }
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
	else boot();
}
