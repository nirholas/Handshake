/**
 * /smart-home/join: accepting an invitation to somebody's household.
 *
 * The link is a bearer credential for a role in a physical building, so the
 * order of this page is deliberate and is the opposite of a login wall:
 *
 *   1. Say what the invitation is FOR, before asking anyone to identify
 *      themselves. `GET /api/home/invites/:token` inspects without spending, so
 *      a person can see which home, which role and what that role can never do
 *      while still deciding whether they want it at all.
 *   2. Only then ask for an account. A visitor without one is sent through the
 *      existing register flow with `?next=` pointing back at this exact link, so
 *      they land on the invitation again rather than on a dashboard wondering
 *      what happened to the email they clicked.
 *   3. Spend it on an explicit press. Nothing here accepts on page load: an
 *      invitation redeemed by a link preview fetcher is an invitation the person
 *      never got.
 *
 * Four dead ends are separate screens on purpose. "This expired", "somebody
 * already used this", "this was withdrawn" and "this link is not valid" need
 * different words and different next steps, and collapsing them into one error
 * is how a person ends up mailing support to ask which one happened.
 */

import { acceptInvite, inspectInvite } from './api.js';
import { clear, el, noticeEl } from './connect.js';

const ROLE_LABEL = {
	admin: 'Admin',
	member: 'Member',
	guest: 'Guest',
	viewer: 'Viewer',
};

/** What the role lets them do, and the thing it will never let them do. */
const ROLE_CAN = {
	admin: 'Control everything in the home, approve unlocking a door, invite other people and set what they may reach.',
	member: 'Control everything in the home and approve unlocking a door, the same as anybody who lives there.',
	guest: 'Control the things you have been given, and nothing else in the house.',
	viewer: 'Watch the things you have been given. You will not be able to change anything.',
};

const ROLE_CANNOT = {
	admin: 'You will not be able to disconnect the home from three.ws. Only the person who connected it can.',
	member: 'You will not be able to invite anyone else, leave a standing allowance on a lock, or disconnect the home.',
	guest: 'You will never be able to approve unlocking a door, opening a garage or disarming an alarm, even when the agent asks. Only the people who live there can.',
	viewer: 'You will never be able to turn anything on or off, and never be able to approve unlocking a door.',
};

/** A dead end, with the words and the next step that actually fit it. */
const DEAD_ENDS = {
	invite_expired: {
		title: 'This invitation has expired.',
		body: 'Invitations stop working after a week, so the link in an old email is no longer good. Ask whoever sent it to invite you again; it takes them a moment.',
	},
	invite_spent: {
		title: 'This invitation has already been used.',
		body: 'Each link works exactly once. If that was you, the home is already on your homes page. If it was not, tell the person who invited you, and they can remove whoever accepted it.',
	},
	invite_revoked: {
		title: 'This invitation was withdrawn.',
		body: 'The person who sent it took it back before it was used. If that was not intentional, ask them to send a new one.',
	},
	invite_not_found: {
		title: 'This invitation link is not valid.',
		body: 'The link may have been cut short by an email client. Copy the whole address from the message and open it again, or ask for a new invitation.',
	},
	home_revoked: {
		title: 'That home is no longer connected.',
		body: 'The home this invitation was for has been disconnected from three.ws, so there is nothing left to join.',
	},
};

const root = document.getElementById('hm-join-root');
const token = new URLSearchParams(window.location.search).get('invite') || '';

start();

async function start() {
	if (!token) {
		return show(deadEnd({
			title: 'This page needs an invitation link.',
			body: 'Open the link you were sent rather than this page on its own. If you already have access to a home, it is on your homes page.',
		}));
	}
	try {
		const invite = await inspectInvite(token);
		show(invitation(invite));
	} catch (err) {
		const known = DEAD_ENDS[err?.code];
		show(known ? deadEnd(known) : deadEnd({
			title: 'We could not read that invitation.',
			body: err?.message || 'Try opening the link again in a moment.',
		}));
	}
}

function show(node) {
	clear(root);
	root.setAttribute('aria-busy', 'false');
	root.append(node);
}

function invitation(invite) {
	const role = invite?.role;
	const panel = el('section', 'hm-panel');

	const label = invite?.home?.label || 'a home';
	const title = el('h2', 'hm-panel-title');
	// The label is a string its owner typed. Text only, always.
	title.append(document.createTextNode('You have been invited to '));
	title.append(document.createTextNode(label));
	panel.append(title);

	const line = el('p', 'hm-panel-sub');
	line.append(document.createTextNode('as '));
	line.append(el('span', 'hm-tag', ROLE_LABEL[role] || role || 'a member'));
	panel.append(line);

	const can = el('div');
	can.style.marginTop = 'var(--space-md)';
	can.append(el('p', 'hm-row-title', 'What you will be able to do'));
	can.append(el('p', 'hm-row-meta', ROLE_CAN[role] || 'Reach this home from your three.ws account.'));
	panel.append(can);

	const cannot = el('div');
	cannot.style.marginTop = 'var(--space-sm)';
	cannot.append(el('p', 'hm-row-title', 'What you will not be able to do'));
	cannot.append(el('p', 'hm-row-meta', ROLE_CANNOT[role] || 'Anything the person who invited you did not give you.'));
	panel.append(cannot);

	if (invite?.scope?.mode === 'allow') {
		const areas = invite.scope.areas?.length || 0;
		const entities = invite.scope.entities?.length || 0;
		const parts = [];
		if (areas) parts.push(areas === 1 ? '1 room' : `${areas} rooms`);
		if (entities) parts.push(entities === 1 ? '1 individual device' : `${entities} individual devices`);
		const scope = el('div');
		scope.style.marginTop = 'var(--space-sm)';
		scope.append(el('p', 'hm-row-title', 'How much of the house you will see'));
		scope.append(el('p', 'hm-row-meta', parts.length
			? `${parts.join(' and ')}. The rest of the home stays hidden from you completely, not just hidden from view.`
			: 'Nothing has been shared with you yet. Whoever invited you can add rooms or devices at any time.'));
		panel.append(scope);
	}

	panel.append(el('p', 'hm-hint', `This link works once, and stops working ${relativeWhen(invite?.expires_at)}.`));

	const actions = el('div', 'hm-actions');
	const accept = el('button', 'hm-btn hm-btn-primary', 'Accept and join');
	accept.type = 'button';
	const decline = el('a', 'hm-btn hm-btn-ghost', 'Not now');
	decline.href = '/smart-home';
	actions.append(accept, decline);
	panel.append(actions);

	const outcome = el('div');
	panel.append(outcome);

	accept.addEventListener('click', async () => {
		clear(outcome);
		accept.disabled = true;
		accept.textContent = 'Joining';
		try {
			const joined = await acceptInvite(token);
			clear(root);
			root.append(joinedPanel(joined, label));
		} catch (err) {
			if (err?.status === 401) {
				accept.disabled = false;
				accept.textContent = 'Accept and join';
				outcome.append(signInBlock());
				return;
			}
			const known = DEAD_ENDS[err?.code];
			if (known) {
				show(deadEnd(known));
				return;
			}
			accept.disabled = false;
			accept.textContent = 'Try again';
			outcome.append(noticeEl({
				tone: 'error',
				title: 'We could not add you to that home.',
				body: err?.message || 'Try again in a moment.',
			}));
		}
	});

	return panel;
}

/**
 * The account step, shown only when the server says one is needed.
 *
 * `next` carries the whole invitation URL, so registering or signing in returns
 * the person to this exact invitation rather than to a homepage. The invitation
 * is untouched by a failed accept, so coming back and pressing again works.
 */
function signInBlock() {
	const here = `${window.location.pathname}${window.location.search}`;
	const next = encodeURIComponent(here);
	const wrap = el('div', 'hm-notice hm-notice-info');
	wrap.setAttribute('role', 'status');
	const inner = el('div');
	inner.append(el('p', 'hm-row-title', 'You need a three.ws account first'));
	inner.append(el('p', 'hm-row-meta', 'Accepting adds this home to an account, so there has to be one. Your invitation stays valid while you make it, and you will come straight back here.'));
	const actions = el('div', 'hm-actions');
	const register = el('a', 'hm-btn hm-btn-primary', 'Create an account');
	register.href = `/register?next=${next}`;
	const login = el('a', 'hm-btn hm-btn-ghost', 'I already have one');
	login.href = `/login?next=${next}`;
	actions.append(register, login);
	inner.append(actions);
	wrap.append(inner);
	return wrap;
}

function joinedPanel(joined, fallbackLabel) {
	const panel = el('section', 'hm-panel');
	const label = joined?.home?.label || fallbackLabel;
	const title = el('h2', 'hm-panel-title');
	title.append(document.createTextNode(joined?.already_member ? 'You were already in ' : 'You have joined '));
	title.append(document.createTextNode(label));
	panel.append(title);

	const role = joined?.role;
	const sub = el('p', 'hm-panel-sub');
	sub.append(document.createTextNode('Your role there is '));
	sub.append(el('span', 'hm-tag', ROLE_LABEL[role] || role || 'member'));
	sub.append(document.createTextNode('. '));
	sub.append(document.createTextNode(ROLE_CAN[role] || ''));
	panel.append(sub);

	if (joined?.already_member) {
		panel.append(el('p', 'hm-row-meta', 'The invitation did not change what you can do there. An invitation is a way in, not a way to be quietly moved to a different role, so ask whoever sent it if your role should be different.'));
	}

	const actions = el('div', 'hm-actions');
	const open = el('a', 'hm-btn hm-btn-primary', 'Open this home');
	open.href = joined?.home?.id ? `/smart-home/${encodeURIComponent(joined.home.id)}` : '/smart-home';
	const all = el('a', 'hm-btn hm-btn-ghost', 'All your homes');
	all.href = '/smart-home';
	actions.append(open, all);
	panel.append(actions);
	return panel;
}

function deadEnd({ title, body }) {
	const panel = el('section', 'hm-panel');
	panel.append(noticeEl({ tone: 'error', title, body }));
	const actions = el('div', 'hm-actions');
	const home = el('a', 'hm-btn hm-btn-ghost', 'Your homes');
	home.href = '/smart-home';
	const learn = el('a', 'hm-btn hm-btn-ghost', 'What a household is');
	learn.href = '/docs/home-households';
	actions.append(home, learn);
	panel.append(actions);
	return panel;
}

/** "in 6 days", "today". An expiry nobody can read is an expiry nobody plans around. */
function relativeWhen(iso) {
	const at = Date.parse(iso || '');
	if (!Number.isFinite(at)) return 'soon';
	const days = Math.round((at - Date.now()) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'tomorrow';
	return `in ${days} days`;
}
