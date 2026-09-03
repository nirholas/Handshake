/**
 * The plan page: what your homes cost you, before it costs you anything.
 *
 * The point of this surface is commitment 3 from api/_lib/home/entitlements.js:
 * a quota is SHOWN before it is hit. So every dimension renders whether or not
 * it is anywhere near its ceiling, each with its reset date and the reason it is
 * metered at all, and the two lines that can never apply to a limit are on the
 * page in words rather than buried in a policy nobody opens.
 *
 * The other thing this page exists for is the moment a plan changes under
 * somebody. When that leaves an account with more connected homes than it
 * covers, nothing is disconnected: the excess are PAUSED, and this is where the
 * user swaps which of their houses are live. Every state of that swap is
 * designed here, including the one where the swap is refused because there is no
 * room, because that refusal is the whole reason the pause is reversible.
 */

import { changePlanState, getPlan, HomeApiError } from './api.js';
import { clear, el, noticeEl } from './connect.js';

const root = document.getElementById('hm-plan-root');

/** Bars go amber here and red at the ceiling, so "nearly out" is visible early. */
const WARN_AT = 80;

let busy = false;

boot();

async function boot() {
	try {
		render(await getPlan());
	} catch (err) {
		renderFailure(err);
	}
}

function render(plan) {
	const frag = document.createDocumentFragment();

	if (plan.downgrade?.overBy > 0) frag.append(downgradeNotice(plan.downgrade));
	frag.append(planPanel(plan));
	frag.append(quotaPanel(plan));
	frag.append(homesPanel(plan));
	frag.append(alwaysFreePanel(plan));

	clear(root);
	root.append(frag);
	root.setAttribute('aria-busy', 'false');
}

// ── The plan you are on ──────────────────────────────────────────────────────

function planPanel(plan) {
	const panel = el('section', 'hm-panel');
	const head = el('div', 'hm-panel-head');
	const left = el('div');
	left.append(el('h2', 'hm-panel-title', `You are on ${plan.tier.label}`));

	const sub = el('p', 'hm-panel-sub');
	sub.textContent = plan.holder.isHolder
		? `Your $THREE holding puts you at ${plan.holder.tier}, which multiplies your free quotas by ${plan.holder.multiplier}.`
		: 'Holding $THREE multiplies your free quotas. Every limit below already accounts for what you hold.';
	left.append(sub);
	head.append(left);

	const badges = el('div', 'hm-plan-badges');
	for (const badge of plan.badges) {
		const chip = el('span', 'hm-plan-badge', badge.label);
		chip.style.setProperty('--badge', badge.color);
		badges.append(chip);
	}
	head.append(badges);
	panel.append(head);

	if (plan.override) {
		panel.append(
			noticeEl({
				tone: 'info',
				title: 'This account has agreed limits',
				body: plan.override.note || 'An administrator set custom limits on this account.',
				bullets: plan.override.dimensions.map((d) => `${labelFor(plan, d)} is set for this account specifically.`),
			}),
		);
	}

	const upgrade = el('div', 'hm-actions');
	const link = el('a', 'hm-btn hm-btn-primary', 'See plans');
	link.href = plan.upgradePath || '/pricing';
	upgrade.append(link);
	const back = el('a', 'hm-btn hm-btn-ghost', 'Back to your homes');
	back.href = '/smart-home';
	upgrade.append(back);
	panel.append(upgrade);

	return panel;
}

// ── What you are using ───────────────────────────────────────────────────────

function quotaPanel(plan) {
	const panel = el('section', 'hm-panel');
	const head = el('div', 'hm-panel-head');
	const left = el('div');
	left.append(el('h2', 'hm-panel-title', 'What you are using'));
	left.append(
		el(
			'p',
			'hm-panel-sub',
			`Monthly allowances reset on ${formatDate(plan.period.resetsAt)}. Connected homes, seats and live screens are counted as they are, right now.`,
		),
	);
	head.append(left);
	panel.append(head);

	const list = el('div', 'hm-quotas');
	for (const dimension of plan.dimensions) list.append(quotaRow(dimension));
	panel.append(list);
	return panel;
}

function quotaRow(d) {
	const row = el('div', 'hm-quota');
	if (d.exceeded) row.classList.add('is-over');
	else if (!d.unlimited && d.percent >= WARN_AT) row.classList.add('is-warn');

	const head = el('div', 'hm-quota-head');
	head.append(el('span', 'hm-quota-label', d.label));
	head.append(el('span', 'hm-quota-count', d.unlimited ? `${formatNumber(d.used)} used · unlimited` : `${formatNumber(d.used)} of ${formatNumber(d.limit)}`));
	row.append(head);

	const track = el('div', 'hm-quota-track');
	track.setAttribute('role', 'progressbar');
	track.setAttribute('aria-valuemin', '0');
	track.setAttribute('aria-valuemax', '100');
	track.setAttribute('aria-valuenow', String(d.unlimited ? 0 : d.percent));
	track.setAttribute('aria-label', `${d.label}: ${d.unlimited ? 'unlimited' : `${d.percent}% used`}`);
	const fill = el('div', 'hm-quota-fill');
	fill.style.width = d.unlimited ? '0%' : `${Math.max(2, d.percent)}%`;
	track.append(fill);
	row.append(track);

	const foot = el('p', 'hm-quota-why');
	foot.textContent = d.resetsAt ? `${d.why} Resets ${formatDate(d.resetsAt)}.` : d.why;
	row.append(foot);

	if (d.source === 'holder-multiplier') row.append(el('p', 'hm-quota-note', 'Raised by your $THREE holding.'));
	if (d.source === 'account-override') row.append(el('p', 'hm-quota-note', 'Set for this account specifically.'));

	return row;
}

// ── Which homes are live ─────────────────────────────────────────────────────

function homesPanel(plan) {
	const panel = el('section', 'hm-panel');
	const head = el('div', 'hm-panel-head');
	const left = el('div');
	left.append(el('h2', 'hm-panel-title', 'Which homes are live'));
	left.append(
		el(
			'p',
			'hm-panel-sub',
			'Pausing a home never disconnects it. Its access token, its settings and its whole action log stay exactly where they are, and you can swap which homes are live whenever you like.',
		),
	);
	head.append(left);
	panel.append(head);

	if (!plan.homes.length) {
		const empty = el('div', 'hm-empty');
		empty.append(el('p', 'hm-empty-title', 'No homes connected yet'));
		empty.append(el('p', 'hm-empty-body', 'Connect a Home Assistant instance and it will appear here with everything it counts against.'));
		const cta = el('a', 'hm-btn hm-btn-primary', 'Connect a home');
		cta.href = '/smart-home';
		empty.append(cta);
		panel.append(empty);
		return panel;
	}

	const list = el('div', 'hm-list');
	for (const home of plan.homes) list.append(homeRow(home, plan));
	panel.append(list);
	return panel;
}

function homeRow(home, plan) {
	const card = el('div', 'hm-card');
	if (home.deactivated_at) card.classList.add('is-paused');

	const main = el('div', 'hm-card-main');
	const title = el('div', 'hm-card-label');
	title.textContent = home.label;
	if (home.deactivated_at) title.append(el('span', 'hm-pill', 'Paused'));
	main.append(title);
	main.append(el('div', 'hm-card-url', hostOf(home.base_url)));
	if (home.deactivated_at && home.deactivated_reason) {
		main.append(el('p', 'hm-card-reason', home.deactivated_reason));
	}
	card.append(main);

	const actions = el('div', 'hm-card-actions');
	const paused = Boolean(home.deactivated_at);
	const button = el('button', `hm-btn ${paused ? 'hm-btn-primary' : 'hm-btn-ghost'}`, paused ? 'Make live' : 'Pause');
	button.type = 'button';
	button.addEventListener('click', () => swap(paused ? 'resume' : 'pause', home, button));
	actions.append(button);

	const open = el('a', 'hm-btn hm-btn-ghost', 'Open');
	open.href = `/smart-home/${home.id}`;
	if (paused) {
		open.setAttribute('aria-disabled', 'true');
		open.classList.add('is-disabled');
	}
	actions.append(open);
	card.append(actions);

	void plan;
	return card;
}

async function swap(action, home, button) {
	if (busy) return;
	busy = true;
	const original = button.textContent;
	button.disabled = true;
	button.textContent = action === 'resume' ? 'Making live…' : 'Pausing…';
	try {
		await changePlanState(action, home.id);
		render(await getPlan());
	} catch (err) {
		button.disabled = false;
		button.textContent = original;
		const message =
			err instanceof HomeApiError
				? err.message
				: 'Something went wrong changing which homes are live. Nothing was changed; try again.';
		const notice = noticeEl({ tone: 'error', title: action === 'resume' ? 'Could not make that home live' : 'Could not pause that home', body: message });
		root.prepend(notice);
		notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	} finally {
		busy = false;
	}
}

// ── The two things a limit can never do ──────────────────────────────────────

function alwaysFreePanel(plan) {
	const panel = el('section', 'hm-panel hm-panel-quiet');
	panel.append(el('h2', 'hm-panel-title', 'What a limit can never do'));
	const ul = el('ul', 'hm-ol');
	for (const line of plan.alwaysFree) {
		ul.append(el('li', null, line));
	}
	panel.append(ul);
	return panel;
}

// ── The downgrade moment ─────────────────────────────────────────────────────

function downgradeNotice(downgrade) {
	return noticeEl({
		tone: 'warn',
		title: `${downgrade.overBy} of your homes ${downgrade.overBy === 1 ? 'is' : 'are'} over your plan`,
		body: downgrade.explanation,
		bullets: downgrade.wouldPause.map((h) => `${h.label} would be paused, not disconnected.`),
	});
}

// ── Failure ──────────────────────────────────────────────────────────────────

function renderFailure(err) {
	const signedOut = err instanceof HomeApiError && (err.status === 401 || err.code === 'unauthorized');
	clear(root);
	root.setAttribute('aria-busy', 'false');
	root.append(
		noticeEl({
			tone: 'error',
			title: signedOut ? 'Sign in to see your plan' : 'Could not load your plan',
			body: signedOut
				? 'Your home plan is tied to your three.ws account, so this page needs you signed in.'
				: err?.message || 'We could not read your plan just now. Your homes and your limits are unaffected.',
		}),
	);
	const actions = el('div', 'hm-actions');
	if (signedOut) {
		const login = el('a', 'hm-btn hm-btn-primary', 'Sign in');
		login.href = `/login?next=${encodeURIComponent('/smart-home/plan')}`;
		actions.append(login);
	} else {
		const retry = el('button', 'hm-btn hm-btn-primary', 'Try again');
		retry.type = 'button';
		retry.addEventListener('click', () => {
			root.setAttribute('aria-busy', 'true');
			boot();
		});
		actions.append(retry);
	}
	const back = el('a', 'hm-btn hm-btn-ghost', 'Back to your homes');
	back.href = '/smart-home';
	actions.append(back);
	root.append(actions);
}

// ── Formatting ───────────────────────────────────────────────────────────────

function labelFor(plan, dimensionId) {
	return plan.dimensions.find((d) => d.id === dimensionId)?.label || dimensionId;
}

function formatNumber(n) {
	if (n == null) return '0';
	return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'the first of next month';
	return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
