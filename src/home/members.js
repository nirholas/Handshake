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

import { getHome, listHousehold, inviteToHousehold, removeFromHousehold, revokeHouseholdInvite, setHouseholdRole } from './api.js';
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

	// The scope editor, offered only where scope means anything. A member's row
	// has no button for it because a member is whole-house by definition, and a
	// control that silently does nothing is worse than no control.
	if (member.scoped) {
		const narrow = el('button', 'hm-btn hm-btn-ghost', 'What they can see');
		narrow.type = 'button';
		narrow.setAttribute('aria-expanded', 'false');
		narrow.addEventListener('click', () => editScope(li, main, home, member, rerender, narrow));
		actions.append(narrow);
	}

	const remove = el('button', 'hm-btn hm-btn-danger', 'Remove');
	remove.type = 'button';
	remove.addEventListener('click', () => confirmRemove(li, main, home, member, rerender));

	actions.append(picker, remove);
	li.append(main, actions);
	return li;
}

/**
 * Narrow or widen what one scoped member can reach, in place on their row.
 *
 * Sends only `scope`, leaving `role` untouched, so changing what somebody can
 * see is not silently a change to what they can do.
 */
function editScope(li, main, home, member, rerender, trigger) {
	const existing = li.querySelector('.hm-scope-edit');
	if (existing) {
		existing.remove();
		trigger.setAttribute('aria-expanded', 'false');
		return;
	}
	trigger.setAttribute('aria-expanded', 'true');

	const box = el('div', 'hm-scope-edit');
	box.style.marginTop = 'var(--space-sm)';
	box.style.width = '100%';
	const picker = scopePicker(home, member.scope);
	picker.setRole(member.role);
	box.append(picker.node);

	const actions = el('div', 'hm-card-actions');
	const save = el('button', 'hm-btn hm-btn-primary', 'Save');
	save.type = 'button';
	const cancel = el('button', 'hm-btn hm-btn-ghost', 'Cancel');
	cancel.type = 'button';
	cancel.addEventListener('click', () => {
		box.remove();
		trigger.setAttribute('aria-expanded', 'false');
		trigger.focus();
	});
	save.addEventListener('click', async () => {
		save.disabled = true;
		cancel.disabled = true;
		save.textContent = 'Saving';
		try {
			// `scope: null` from the picker means the whole house; send an explicit
			// {mode:'all'} rather than omitting the field, because omitting it means
			// "leave it as it was" to the endpoint and this press meant a change.
			await setHouseholdRole(home.id, { userId: member.user_id, role: member.role, scope: picker.read() ?? { mode: 'all' } });
			rerender();
		} catch (err) {
			save.disabled = false;
			cancel.disabled = false;
			save.textContent = 'Try again';
			main.append(el('p', 'hm-row-meta', err?.message || 'That change did not go through.'));
		}
	});
	actions.append(save, cancel);
	box.append(actions);
	li.append(box);
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

/**
 * The rooms and devices a scoped role may reach.
 *
 * Built from the house's OWN room graph, fetched once and cached for the panel:
 * a scope written by typing area ids into a box would be a scope nobody can
 * verify, and an area id that does not exist silently grants nothing while
 * looking like it granted something.
 *
 * Two states, and the default is the safe one only where it is honest. Inviting
 * somebody is a deliberate act of sharing, so "the whole house" stays the
 * default for a role that lives there and "only what I choose" is offered
 * plainly for a role that is visiting. Nothing is inferred: whichever is
 * selected is what gets sent, and the server normalizes a non-scoped role back
 * to the whole house regardless of what this control says.
 *
 * @param {object} home
 * @param {object} [initial] an existing scope to start from
 * @returns {{ node: HTMLElement, read: () => object|null, setRole: (role: string) => void }}
 */
function scopePicker(home, initial) {
	const wrap = el('fieldset', 'hm-field');
	wrap.style.border = '0';
	wrap.style.padding = '0';
	wrap.style.margin = 'var(--space-sm) 0 0';
	const legend = el('legend', 'hm-label', 'How much of the house they get');
	wrap.append(legend);

	const name = `scope-mode-${Math.random().toString(36).slice(2, 9)}`;
	const modes = el('div', 'hm-actions');
	const all = radio(name, 'all', 'The whole house');
	const some = radio(name, 'allow', 'Only what I choose');
	modes.append(all.label, some.label);
	wrap.append(modes);

	const detail = el('div');
	detail.style.marginTop = 'var(--space-sm)';
	detail.hidden = true;
	wrap.append(detail);

	const checks = new Map();
	let loaded = false;
	let unavailable = false;

	async function loadRooms() {
		if (loaded) return;
		loaded = true;
		const skeleton = el('div', 'hm-skeleton');
		skeleton.style.height = '2.6rem';
		detail.append(skeleton);
		try {
			const body = await getHome(home.id);
			clear(detail);
			const rooms = body?.graph?.rooms || [];
			if (!rooms.length) {
				unavailable = true;
				// A house that is not answering cannot be divided up honestly, so the
				// control says so instead of offering an empty list that would send an
				// empty allowlist and share nothing.
				detail.append(el('p', 'hm-row-meta', body?.connected === false
					? 'This home is not answering right now, so its rooms cannot be listed. You can invite them to the whole house now and narrow it once the home reconnects.'
					: 'This home has no rooms assigned yet. Assign areas in Home Assistant and they will appear here.'));
				return;
			}
			detail.append(el('p', 'hm-row-meta', 'Everything you do not tick stays hidden from them completely, not just hidden on screen.'));
			const list = el('div');
			list.style.display = 'grid';
			list.style.gap = '0.35rem';
			list.style.marginTop = '0.5rem';
			for (const room of rooms) {
				const box = el('input');
				box.type = 'checkbox';
				box.value = room.id;
				box.id = `${name}-${room.id}`;
				if (initial?.areas?.includes(room.id)) box.checked = true;
				const label = el('label', 'hm-row-meta');
				label.style.display = 'flex';
				label.style.gap = '0.5rem';
				label.style.alignItems = 'center';
				label.htmlFor = box.id;
				label.append(box);
				// A room name is whatever its owner called it in Home Assistant.
				label.append(document.createTextNode(`${room.name} (${room.entities.length} ${room.entities.length === 1 ? 'device' : 'devices'})`));
				checks.set(room.id, box);
				list.append(label);
			}
			detail.append(list);
		} catch (err) {
			clear(detail);
			unavailable = true;
			detail.append(el('p', 'hm-row-meta', err?.message || 'We could not list this home\'s rooms. You can still invite them to the whole house.'));
		}
	}

	const sync = () => {
		detail.hidden = !some.input.checked;
		if (some.input.checked) loadRooms();
	};
	all.input.addEventListener('change', sync);
	some.input.addEventListener('change', sync);

	if (initial?.mode === 'allow') {
		some.input.checked = true;
		sync();
	} else {
		all.input.checked = true;
	}

	return {
		node: wrap,
		/** null means "do not send a scope at all", which the server reads as the whole house. */
		read() {
			if (!some.input.checked || unavailable) return null;
			const areas = [...checks.entries()].filter(([, box]) => box.checked).map(([id]) => id);
			// Individual entities are carried through from an existing scope rather
			// than picked here: a house with 67 devices makes a flat checkbox list
			// unusable, and a room is the unit people actually think in. An entity
			// grant set through the API survives an edit made here.
			const entities = Array.isArray(initial?.entities) ? initial.entities : [];
			return { mode: 'allow', areas, entities };
		},
		/** Scope only means anything for a scoped role; hide it entirely for the rest. */
		setRole(role) {
			const scoped = role === 'guest' || role === 'viewer';
			wrap.hidden = !scoped;
			if (!scoped) all.input.checked = true;
			sync();
		},
	};
}

function radio(name, value, text) {
	const input = el('input');
	input.type = 'radio';
	input.name = name;
	input.value = value;
	const label = el('label', 'hm-row-meta');
	label.style.display = 'flex';
	label.style.gap = '0.45rem';
	label.style.alignItems = 'center';
	label.append(input, document.createTextNode(text));
	return { input, label };
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

	const scope = scopePicker(home);
	form.append(scope.node);
	scope.setRole(role.value);

	role.addEventListener('change', () => {
		explain.textContent = ROLE_COPY[role.value] || '';
		scope.setRole(role.value);
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
			const result = await inviteToHousehold(home.id, { email: email.value.trim(), role: role.value, scope: scope.read() });
			const sentTo = email.value.trim();
			email.value = '';
			// The link is shown once, here, because the server keeps only a hash of
			// it. Telling somebody to "check the invitations list for the link"
			// would be a promise this system cannot keep, and it is shown whether or
			// not the email went out for exactly that reason.
			outcome.append(inviteLinkBlock(result?.invite_url, { emailed: result?.emailed === true, to: sentTo }));
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

function inviteLinkBlock(url, { emailed = false, to = '' } = {}) {
	const wrap = el('div', 'hm-notice hm-notice-ok');
	wrap.setAttribute('role', 'status');
	const inner = el('div');
	inner.append(el('p', 'hm-row-title', emailed ? `Invitation sent to ${to}` : 'Send them this link'));
	// The link is shown either way. When the email went out it is the copy the
	// inviter can paste into a message themselves, which is what people actually
	// do; when it did not, it is the invitation.
	inner.append(el('p', 'hm-row-meta', emailed
		? 'Here is the same link, in case you would rather send it yourself. It works once and then stops, and this is the only time we can show it.'
		: 'We could not email it, so this link is the invitation. It works once and then stops. We only keep a fingerprint of it, so this is the only time it can be shown.'));

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
