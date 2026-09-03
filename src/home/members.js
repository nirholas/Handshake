/**
 * The household panel: who else can reach this house, and what they may do.
 *
 * Mounted on every home card in the manage view. It renders what the SERVER
 * says, never what it decided for itself: the roster response carries this
 * caller's own role, the roles they are allowed to hand out, and a per-member
 * flag for whether they may administer that person. A member with no roster
 * authority sees the household and no controls, because hiding the fact that
 * other people hold keys to the house you are in would be the wrong secret to
 * keep, and showing a button that 403s would be the wrong promise to make.
 *
 * The rule this panel exists to make legible, said in the UI rather than only in
 * the schema: a guest can turn a light on and can never authorise unlocking a
 * door. Every role's line says what it can and cannot do, at the moment somebody
 * chooses one, rather than in documentation nobody opens.
 */

import { listHousehold, inviteToHousehold, removeFromHousehold, revokeHouseholdInvite, setHouseholdRole } from './api.js';
import { clear, el, noticeEl } from './connect.js';

/**
 * One line per role, shown next to the picker.
 *
 * Written for the person choosing, not for the schema. "Cannot" comes second and
 * is never omitted: a role is a decision about what somebody may not do, and a
 * description that lists only powers is how a house sitter ends up an admin.
 */
const ROLE_COPY = {
	owner: 'Connected this home. Can do everything, including disconnecting it.',
	admin: 'Runs the household: invites, roles, standing allowances. Cannot disconnect the home.',
	member: 'Lives here. Can control everything and approve unlocking a door. Cannot invite anyone.',
	guest: 'Visiting. Can control what you give them, and can never approve unlocking a door.',
	viewer: 'Can watch what you give them and change nothing. For a wall display or a screen at a desk.',
};

const ROLE_LABEL = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
	guest: 'Guest',
	viewer: 'Viewer',
};

/**
 * The collapsed panel, fetching on first open.
 *
 * Deliberately not loaded with the page: somebody with six houses should not pay
 * six extra round trips to see a roster that in most homes is one line long.
 *
 * @param {object} home a row from GET /api/home
 * @returns {HTMLElement}
 */
export function householdPanel(home) {
	const wrap = el('details', 'hm-panel');
	wrap.style.marginTop = 'var(--space-sm)';
	wrap.style.background = 'transparent';

	const head = el('summary');
	head.style.cursor = 'pointer';
	head.append(el('span', '', 'Who can reach this home'));
	wrap.append(head);

	wrap.append(el('p', 'hm-hint', 'The people in this household, what each of them may do, and any invitation you have sent.'));

	const body = el('div');
	body.style.marginTop = 'var(--space-sm)';
	wrap.append(body);

	let loaded = false;
	const run = async () => {
		clear(body);
		const skeleton = el('div', 'hm-skeleton');
		skeleton.style.height = '3.4rem';
		body.append(skeleton);
		try {
			const data = await listHousehold(home.id);
			clear(body);
			body.append(renderHousehold(home, data, run));
		} catch (err) {
			clear(body);
			body.append(noticeEl({
				tone: 'error',
				title: 'We could not load this household.',
				body: err?.message || 'Try opening it again in a moment.',
			}));
		}
	};

	wrap.addEventListener('toggle', () => {
		if (!wrap.open || loaded) return;
		loaded = true;
		run();
	});
	return wrap;
}

function renderHousehold(home, data, rerender) {
	const frag = document.createDocumentFragment();
	const members = Array.isArray(data?.members) ? data.members : [];
	const invites = Array.isArray(data?.invites) ? data.invites : [];
	const assignable = Array.isArray(data?.assignable_roles) ? data.assignable_roles : [];
	const canAdminister = assignable.length > 0;

	frag.append(yourRoleLine(data?.role, data?.scope));

	const list = el('ul', 'hm-rows');
	for (const member of members) list.append(memberRow(home, member, { assignable, rerender }));
	frag.append(list);

	if (invites.length) {
		frag.append(el('p', 'hm-row-meta', invites.length === 1 ? 'One invitation is waiting to be used.' : `${invites.length} invitations are waiting to be used.`));
		const pending = el('ul', 'hm-rows');
		for (const invite of invites) pending.append(inviteRow(home, invite, { canAdminister, rerender }));
		frag.append(pending);
	}

	if (canAdminister) {
		frag.append(inviteForm(home, { assignable, rerender }));
	} else if (members.length === 1) {
		// The only person in the household, and no way to change that from here.
		// Saying who can is more useful than an empty panel.
		frag.append(emptyBlock(
			'You are the only person here.',
			'Whoever connected this home, or an admin they added, can invite somebody and choose exactly what that person may reach.',
		));
	}

	return frag;
}

/** What this caller may do, said plainly, before the list of everybody else. */
function yourRoleLine(role, scope) {
	const wrap = el('div');
	wrap.style.marginBottom = 'var(--space-sm)';
	const line = el('p', 'hm-row-title');
	line.append(el('span', 'hm-tag', ROLE_LABEL[role] || role || 'Unknown'));
	line.append(document.createTextNode(' is your role in this home.'));
	wrap.append(line);
	wrap.append(el('p', 'hm-row-meta', ROLE_COPY[role] || 'Your access to this home is set by whoever connected it.'));
	if (scope && scope.mode === 'allow') wrap.append(el('p', 'hm-row-meta', scopeSentence(scope)));
	return wrap;
}

/** "The kitchen, and 2 individual devices." Never a raw JSON blob. */
function scopeSentence(scope) {
	const areas = Array.isArray(scope?.areas) ? scope.areas.length : 0;
	const entities = Array.isArray(scope?.entities) ? scope.entities.length : 0;
	if (!areas && !entities) return 'Nothing in this home has been shared yet.';
	const parts = [];
	if (areas) parts.push(areas === 1 ? '1 room' : `${areas} rooms`);
	if (entities) parts.push(entities === 1 ? '1 individual device' : `${entities} individual devices`);
	return `Limited to ${parts.join(' and ')}. Everything else in this home stays hidden.`;
}

function memberRow(home, member, { assignable, rerender }) {
	const li = el('li', 'hm-row');
	const main = el('div', 'hm-row-main');

	const title = el('p', 'hm-row-title');
	// Every one of these is a string somebody typed into a sign-up form.
	title.append(document.createTextNode(member.display_name || member.username || member.email || 'Someone'));
	title.append(document.createTextNode(' '));
	title.append(el('span', 'hm-tag', ROLE_LABEL[member.role] || member.role));
	main.append(title);

	if (member.email && member.display_name) main.append(el('p', 'hm-row-meta', member.email));
	main.append(el('p', 'hm-row-meta', ROLE_COPY[member.role] || ''));
	if (member.scoped) main.append(el('p', 'hm-row-meta', scopeSentence(member.scope)));

	// `can_manage` comes from the server. An owner row is never manageable, and an
	// admin cannot administer a peer admin, so this flag is the only thing the UI
	// consults rather than re-deriving the rank comparison and drifting from it.
	if (!member.can_manage) {
		li.append(main);
		return li;
	}

	const actions = el('div', 'hm-card-actions');

	const picker = el('select', 'hm-input');
	picker.style.width = 'auto';
	picker.setAttribute('aria-label', `Role for ${member.display_name || member.email || 'this person'}`);
	for (const role of assignable) {
		const option = el('option', '', ROLE_LABEL[role] || role);
		option.value = role;
		if (role === member.role) option.selected = true;
		picker.append(option);
	}
	picker.addEventListener('change', async () => {
		const next = picker.value;
		picker.disabled = true;
		try {
			await setHouseholdRole(home.id, { userId: member.user_id, role: next });
			rerender();
		} catch (err) {
			picker.disabled = false;
			picker.value = member.role;
			main.append(el('p', 'hm-row-meta', err?.message || 'That change did not go through.'));
		}
	});

	const remove = el('button', 'hm-btn hm-btn-danger', 'Remove');
	remove.type = 'button';
	remove.addEventListener('click', () => confirmRemove(li, main, home, member, rerender));

	actions.append(picker, remove);
	li.append(main, actions);
	return li;
}

/**
 * Removing somebody is not undoable and it revokes their standing allowances
 * with them, so the panel says exactly that before it happens rather than after.
 */
function confirmRemove(li, main, home, member, rerender) {
	if (li.querySelector('.hm-confirm')) return;
	const box = el('div', 'hm-confirm');
	box.style.marginTop = 'var(--space-sm)';
	box.append(el('p', 'hm-row-title', `Remove ${member.display_name || member.email || 'this person'} from this home?`));
	box.append(el('p', 'hm-row-meta', 'They lose access immediately, and any standing allowance they approved is withdrawn at the same moment. You can invite them again later.'));

	const actions = el('div', 'hm-card-actions');
	const yes = el('button', 'hm-btn hm-btn-danger', 'Remove them');
	yes.type = 'button';
	const no = el('button', 'hm-btn hm-btn-ghost', 'Keep them');
	no.type = 'button';
	no.addEventListener('click', () => box.remove());
	yes.addEventListener('click', async () => {
		yes.disabled = true;
		no.disabled = true;
		yes.textContent = 'Removing';
		try {
			const result = await removeFromHousehold(home.id, member.user_id);
			const revoked = Array.isArray(result?.grants_revoked) ? result.grants_revoked.length : 0;
			rerender();
			if (revoked) {
				main.append(el('p', 'hm-row-meta', revoked === 1
					? 'Their standing allowance was withdrawn with them.'
					: `${revoked} standing allowances were withdrawn with them.`));
			}
		} catch (err) {
			yes.disabled = false;
			no.disabled = false;
			yes.textContent = 'Try again';
			box.append(el('p', 'hm-row-meta', err?.message || 'That did not go through.'));
		}
	});
	actions.append(yes, no);
	box.append(actions);
	li.append(box);
	yes.focus();
}

function inviteRow(home, invite, { canAdminister, rerender }) {
	const li = el('li', 'hm-row');
	const main = el('div', 'hm-row-main');

	const title = el('p', 'hm-row-title');
	title.append(document.createTextNode(invite.email));
	title.append(document.createTextNode(' '));
	title.append(el('span', 'hm-tag', ROLE_LABEL[invite.role] || invite.role));
	main.append(title);
	main.append(el('p', 'hm-row-meta', `Invited, not yet accepted. The link stops working ${relativeWhen(invite.expires_at)}.`));

	li.append(main);
	if (!canAdminister) return li;

	const withdraw = el('button', 'hm-btn hm-btn-danger', 'Withdraw');
	withdraw.type = 'button';
	withdraw.addEventListener('click', async () => {
		withdraw.disabled = true;
		withdraw.textContent = 'Withdrawing';
		try {
			await revokeHouseholdInvite(home.id, invite.id);
			rerender();
		} catch (err) {
			withdraw.disabled = false;
			withdraw.textContent = 'Try again';
			main.append(el('p', 'hm-row-meta', err?.message || 'That did not go through.'));
		}
	});
	li.append(withdraw);
	return li;
}

function inviteForm(home, { assignable, rerender }) {
	const form = el('form', 'hm-panel');
	form.style.marginTop = 'var(--space-sm)';
	form.style.background = 'transparent';
	form.append(el('h3', 'hm-panel-title', 'Invite somebody'));
	form.append(el('p', 'hm-panel-sub', 'They get a link that works once and expires. Accepting it needs a three.ws account; if they do not have one, the link walks them through making one and brings them straight back.'));

	const emailField = el('label', 'hm-field');
	emailField.append(el('span', 'hm-label', 'Their email address'));
	const email = el('input', 'hm-input');
	email.type = 'email';
	email.required = true;
	email.autocomplete = 'email';
	email.placeholder = 'them@example.com';
	emailField.append(email);
	form.append(emailField);

	const roleField = el('label', 'hm-field');
	roleField.append(el('span', 'hm-label', 'What they may do'));
	const role = el('select', 'hm-input');
	// Weakest first: the safe choice should be the one nearest the top, and a
	// guest is the right answer for almost everybody who is not family.
	for (const value of [...assignable].reverse()) {
		const option = el('option', '', ROLE_LABEL[value] || value);
		option.value = value;
		role.append(option);
	}
	roleField.append(role);
	form.append(roleField);

	const explain = el('p', 'hm-row-meta', ROLE_COPY[role.value] || '');
	form.append(explain);
	role.addEventListener('change', () => {
		explain.textContent = ROLE_COPY[role.value] || '';
	});

	const submit = el('button', 'hm-btn hm-btn-primary', 'Send invitation');
	submit.type = 'submit';
	const actions = el('div', 'hm-card-actions');
	actions.append(submit);
	form.append(actions);

	const outcome = el('div');
	form.append(outcome);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		clear(outcome);
		submit.disabled = true;
		submit.textContent = 'Sending';
		try {
			const result = await inviteToHousehold(home.id, { email: email.value.trim(), role: role.value });
			email.value = '';
			// The link is shown once, here, because the server keeps only a hash of
			// it. Telling somebody to "check the invitations list for the link"
			// would be a promise this system cannot keep.
			outcome.append(inviteLinkBlock(result?.invite_url));
			rerender();
		} catch (err) {
			outcome.append(noticeEl({
				tone: 'error',
				title: 'That invitation was not sent.',
				body: err?.message || 'Check the address and try again.',
			}));
		} finally {
			submit.disabled = false;
			submit.textContent = 'Send invitation';
		}
	});

	return form;
}

function inviteLinkBlock(url) {
	const wrap = el('div', 'hm-notice hm-notice-ok');
	wrap.setAttribute('role', 'status');
	const inner = el('div');
	inner.append(el('p', 'hm-row-title', 'Send them this link'));
	inner.append(el('p', 'hm-row-meta', 'It works once and then stops. We only keep a fingerprint of it, so this is the only time it can be shown.'));

	const field = el('div', 'hm-card-actions');
	const box = el('input', 'hm-input');
	box.readOnly = true;
	box.value = url || '';
	box.addEventListener('focus', () => box.select());
	const copy = el('button', 'hm-btn hm-btn-ghost', 'Copy');
	copy.type = 'button';
	copy.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(box.value);
			copy.textContent = 'Copied';
		} catch {
			// A browser that refuses clipboard access is not an error state: the
			// link is already on screen and selectable.
			box.focus();
			copy.textContent = 'Select and copy';
		}
	});
	field.append(box, copy);
	inner.append(field);
	wrap.append(inner);
	return wrap;
}

function emptyBlock(title, body) {
	const wrap = el('div', 'hm-empty');
	wrap.style.padding = 'var(--space-md) 0';
	wrap.append(el('p', 'hm-empty-title', title), el('p', 'hm-empty-body', body));
	return wrap;
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
