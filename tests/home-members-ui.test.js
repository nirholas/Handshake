// @vitest-environment jsdom
//
// The household panel (src/home/members.js), driven the way a person drives it.
//
// This is a UI test rather than a screenshot for a specific reason: the panel's
// job is to render what the SERVER said and never to decide anything itself, and
// that is a property you assert, not one you look at. The interesting cases are
// all negative. A member with no roster authority must get no controls. A scope
// control must not appear for a role that is whole-house by definition, because a
// control that would do nothing is worse than no control. An invitation form must
// send the rooms that were ticked and not a cheerful default.
//
// The API module is mocked at the boundary (api.js), not the network, so these
// tests assert the panel's contract with the endpoints rather than re-testing
// fetch. The endpoint contract itself is covered live in tests/home-roles.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = vi.hoisted(() => ({
	listHousehold: vi.fn(),
	getHome: vi.fn(),
	inviteToHousehold: vi.fn(),
	setHouseholdRole: vi.fn(),
	removeFromHousehold: vi.fn(),
	revokeHouseholdInvite: vi.fn(),
}));

vi.mock('../src/home/api.js', () => api);

const { householdPanel } = await import('../src/home/members.js');

const HOME = { id: '11111111-2222-3333-4444-555555555555', label: 'The office' };

/** One house with three rooms, shaped exactly like buildHomeGraph output. */
const GRAPH = {
	floors: [{ id: 'ground', name: 'Ground', level: 0 }],
	rooms: [
		{ id: 'kitchen', name: 'Kitchen', floorId: 'ground', entities: [{ entityId: 'light.k1' }, { entityId: 'lock.back' }] },
		{ id: 'hall', name: 'Hall', floorId: 'ground', entities: [{ entityId: 'light.h1' }] },
		{ id: 'bedroom', name: 'Bedroom', floorId: 'ground', entities: [{ entityId: 'light.b1' }] },
	],
	unassigned: [],
};

function roster({ role = 'owner', assignable = ['admin', 'member', 'guest', 'viewer'], members = [], invites = [] } = {}) {
	return {
		role,
		scope: { mode: 'all' },
		assignable_roles: assignable,
		members: [
			{ user_id: 'owner-id', role: 'owner', scoped: false, scope: { mode: 'all' }, email: 'owner@example.invalid', display_name: 'Owner', can_manage: false },
			...members,
		],
		invites,
	};
}

/** Open the panel and wait for its first render to settle. */
async function open(data) {
	api.listHousehold.mockResolvedValue(data);
	const panel = householdPanel(HOME);
	document.body.append(panel);
	panel.open = true;
	panel.dispatchEvent(new Event('toggle'));
	await vi.waitFor(() => expect(panel.querySelector('.hm-rows')).toBeTruthy());
	return panel;
}

beforeEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
	api.getHome.mockResolvedValue({ graph: GRAPH, connected: true });
});

describe('the household panel renders what the server said', () => {
	it('fetches nothing until it is opened', () => {
		document.body.append(householdPanel(HOME));
		expect(api.listHousehold).not.toHaveBeenCalled();
	});

	it('gives a role with no roster authority the household and no controls', async () => {
		const panel = await open(roster({
			role: 'guest',
			assignable: [],
			members: [{ user_id: 'guest-id', role: 'guest', scoped: true, scope: { mode: 'allow', areas: ['kitchen'], entities: [] }, email: 'g@example.invalid', display_name: 'Guest', can_manage: false }],
		}));
		// Seeing who else holds keys to the house you are in is not a privilege.
		expect(panel.textContent).toContain('Owner');
		expect(panel.textContent).toContain('Guest');
		// Everything that would change it is absent, not disabled: a button that
		// 403s is a promise the server will refuse.
		expect(panel.querySelector('form')).toBeNull();
		expect(panel.querySelectorAll('select')).toHaveLength(0);
		expect([...panel.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Remove');
	});

	it('says what each role can and cannot do, next to the person holding it', async () => {
		const panel = await open(roster({
			members: [{ user_id: 'g', role: 'guest', scoped: true, scope: { mode: 'allow', areas: ['kitchen'], entities: [] }, email: 'g@example.invalid', display_name: 'Sitter', can_manage: true }],
		}));
		expect(panel.textContent).toContain('never be able to approve unlocking a door');
		expect(panel.textContent).toContain('Limited to 1 room');
	});

	it('offers management only on the rows the server marked manageable', async () => {
		const panel = await open(roster({
			members: [
				{ user_id: 'a', role: 'admin', scoped: false, scope: { mode: 'all' }, email: 'a@example.invalid', display_name: 'Peer admin', can_manage: false },
				{ user_id: 'm', role: 'member', scoped: false, scope: { mode: 'all' }, email: 'm@example.invalid', display_name: 'Housemate', can_manage: true },
			],
		}));
		const rows = [...panel.querySelectorAll('.hm-row')];
		const peer = rows.find((r) => r.textContent.includes('Peer admin'));
		const mate = rows.find((r) => r.textContent.includes('Housemate'));
		expect(peer.querySelector('select')).toBeNull();
		expect(mate.querySelector('select')).toBeTruthy();
	});
});

describe('the scope control appears only where scope means something', () => {
	it('is hidden for a whole-house role and shown for a scoped one', async () => {
		const panel = await open(roster());
		const form = panel.querySelector('form');
		const fieldset = form.querySelector('fieldset');
		const role = form.querySelector('select');

		// The picker defaults weakest-first, so the form opens on a scoped role.
		expect(role.value).toBe('viewer');
		expect(fieldset.hidden).toBe(false);

		role.value = 'member';
		role.dispatchEvent(new Event('change'));
		expect(fieldset.hidden).toBe(true);

		role.value = 'guest';
		role.dispatchEvent(new Event('change'));
		expect(fieldset.hidden).toBe(false);
	});

	it('offers no room list until somebody asks to narrow it', async () => {
		const panel = await open(roster());
		expect(api.getHome).not.toHaveBeenCalled();
		const fieldset = panel.querySelector('form fieldset');
		fieldset.querySelector('input[value="allow"]').click();
		await vi.waitFor(() => expect(api.getHome).toHaveBeenCalledWith(HOME.id));
	});

	it('lists the house own rooms, with how many devices each one holds', async () => {
		const panel = await open(roster());
		const fieldset = panel.querySelector('form fieldset');
		fieldset.querySelector('input[value="allow"]').click();
		await vi.waitFor(() => expect(fieldset.querySelectorAll('input[type=checkbox]')).toHaveLength(3));
		const labels = [...fieldset.querySelectorAll('label')].map((l) => l.textContent).filter((t) => t.includes('device'));
		expect(labels).toEqual(['Kitchen (2 devices)', 'Hall (1 device)', 'Bedroom (1 device)']);
	});

	it('says so rather than offering an empty list when the house is not answering', async () => {
		api.getHome.mockResolvedValue({ graph: null, connected: false });
		const panel = await open(roster());
		const fieldset = panel.querySelector('form fieldset');
		fieldset.querySelector('input[value="allow"]').click();
		// An empty allowlist would share nothing while looking like it shared
		// something, so an unreachable house falls back to the whole house.
		await vi.waitFor(() => expect(fieldset.textContent).toContain('not answering right now'));
		expect(fieldset.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
	});
});

describe('inviting somebody sends what was actually chosen', () => {
	async function invite(panel, { email, role, tick = [] }) {
		const form = panel.querySelector('form');
		form.querySelector('input[type=email]').value = email;
		const picker = form.querySelector('select');
		picker.value = role;
		picker.dispatchEvent(new Event('change'));
		if (tick.length) {
			const fieldset = form.querySelector('fieldset');
			fieldset.querySelector('input[value="allow"]').click();
			await vi.waitFor(() => expect(fieldset.querySelectorAll('input[type=checkbox]').length).toBeGreaterThan(0));
			for (const id of tick) fieldset.querySelector(`input[value="${id}"]`).checked = true;
		}
		form.dispatchEvent(new Event('submit', { cancelable: true }));
	}

	it('sends no scope for a whole-house role', async () => {
		api.inviteToHousehold.mockResolvedValue({ invite_url: 'https://three.ws/smart-home/join?invite=t', emailed: true });
		const panel = await open(roster());
		await invite(panel, { email: 'them@example.invalid', role: 'member' });
		await vi.waitFor(() => expect(api.inviteToHousehold).toHaveBeenCalled());
		expect(api.inviteToHousehold).toHaveBeenCalledWith(HOME.id, { email: 'them@example.invalid', role: 'member', scope: null });
	});

	it('sends exactly the rooms that were ticked', async () => {
		api.inviteToHousehold.mockResolvedValue({ invite_url: 'https://three.ws/smart-home/join?invite=t', emailed: true });
		const panel = await open(roster());
		await invite(panel, { email: 'sitter@example.invalid', role: 'guest', tick: ['kitchen', 'hall'] });
		await vi.waitFor(() => expect(api.inviteToHousehold).toHaveBeenCalled());
		const [, body] = api.inviteToHousehold.mock.calls[0];
		expect(body.role).toBe('guest');
		expect(body.scope).toEqual({ mode: 'allow', areas: ['kitchen', 'hall'], entities: [] });
		expect(body.scope.areas).not.toContain('bedroom');
	});

	it('confirms the address when the email went out, and still shows the link', async () => {
		api.inviteToHousehold.mockResolvedValue({ invite_url: 'https://three.ws/smart-home/join?invite=tok', emailed: true });
		const panel = await open(roster());
		await invite(panel, { email: 'them@example.invalid', role: 'viewer' });
		await vi.waitFor(() => expect(panel.querySelector('.hm-notice-ok')).toBeTruthy());
		const block = panel.querySelector('.hm-notice-ok');
		expect(block.textContent).toContain('Invitation sent to them@example.invalid');
		expect(block.querySelector('input').value).toBe('https://three.ws/smart-home/join?invite=tok');
	});

	it('says the link IS the invitation when the email did not go out', async () => {
		api.inviteToHousehold.mockResolvedValue({ invite_url: 'https://three.ws/smart-home/join?invite=tok', emailed: false });
		const panel = await open(roster());
		await invite(panel, { email: 'them@example.invalid', role: 'viewer' });
		await vi.waitFor(() => expect(panel.querySelector('.hm-notice-ok')).toBeTruthy());
		const block = panel.querySelector('.hm-notice-ok');
		expect(block.textContent).toContain('could not email it');
		expect(block.textContent).toContain('this link is the invitation');
	});

	it('renders the server refusal rather than swallowing it', async () => {
		const err = new Error('an admin cannot invite somebody as an owner');
		api.inviteToHousehold.mockRejectedValue(err);
		const panel = await open(roster());
		await invite(panel, { email: 'them@example.invalid', role: 'viewer' });
		await vi.waitFor(() => expect(panel.querySelector('.hm-notice-error')).toBeTruthy());
		expect(panel.querySelector('.hm-notice-error').textContent).toContain('cannot invite somebody as an owner');
	});
});

describe('editing what one person can see', () => {
	it('sends only the scope, never a role change', async () => {
		api.setHouseholdRole.mockResolvedValue({});
		const panel = await open(roster({
			members: [{ user_id: 'g', role: 'guest', scoped: true, scope: { mode: 'allow', areas: ['kitchen'], entities: ['light.x'] }, email: 'g@example.invalid', display_name: 'Sitter', can_manage: true }],
		}));
		const row = [...panel.querySelectorAll('.hm-row')].find((r) => r.textContent.includes('Sitter'));
		const open_ = [...row.querySelectorAll('button')].find((b) => b.textContent === 'What they can see');
		expect(open_.getAttribute('aria-expanded')).toBe('false');
		open_.click();
		expect(open_.getAttribute('aria-expanded')).toBe('true');

		const box = row.querySelector('.hm-scope-edit');
		await vi.waitFor(() => expect(box.querySelectorAll('input[type=checkbox]').length).toBe(3));
		// The existing scope is reflected, not reset.
		expect(box.querySelector('input[value="kitchen"]').checked).toBe(true);
		box.querySelector('input[value="hall"]').checked = true;

		[...box.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
		await vi.waitFor(() => expect(api.setHouseholdRole).toHaveBeenCalled());
		const [, body] = api.setHouseholdRole.mock.calls[0];
		expect(body.role).toBe('guest');
		expect(body.scope.areas).toEqual(['kitchen', 'hall']);
		// An entity grant set through the API survives an edit made here.
		expect(body.scope.entities).toEqual(['light.x']);
	});

	it('is not offered on a whole-house member', async () => {
		const panel = await open(roster({
			members: [{ user_id: 'm', role: 'member', scoped: false, scope: { mode: 'all' }, email: 'm@example.invalid', display_name: 'Housemate', can_manage: true }],
		}));
		const row = [...panel.querySelectorAll('.hm-row')].find((r) => r.textContent.includes('Housemate'));
		expect([...row.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('What they can see');
	});
});

describe('removing somebody says what it takes with them', () => {
	it('names the standing allowances before the press, not after', async () => {
		api.removeFromHousehold.mockResolvedValue({ removed: true, grants_revoked: ['lock.office_door', 'cover.garage'] });
		const panel = await open(roster({
			members: [{ user_id: 'g', role: 'guest', scoped: true, scope: { mode: 'all' }, email: 'g@example.invalid', display_name: 'Sitter', can_manage: true }],
		}));
		const row = [...panel.querySelectorAll('.hm-row')].find((r) => r.textContent.includes('Sitter'));
		[...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
		const box = row.querySelector('.hm-confirm');
		expect(box.textContent).toContain('any standing allowance they approved is withdrawn at the same moment');
		expect(box.textContent).toContain('Sitter');
	});

	it('backs out without calling anything', async () => {
		const panel = await open(roster({
			members: [{ user_id: 'g', role: 'guest', scoped: true, scope: { mode: 'all' }, email: 'g@example.invalid', display_name: 'Sitter', can_manage: true }],
		}));
		const row = [...panel.querySelectorAll('.hm-row')].find((r) => r.textContent.includes('Sitter'));
		[...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
		[...row.querySelectorAll('button')].find((b) => b.textContent === 'Keep them').click();
		expect(row.querySelector('.hm-confirm')).toBeNull();
		expect(api.removeFromHousehold).not.toHaveBeenCalled();
	});
});

describe('the panel survives a failing server', () => {
	it('renders an error state rather than an empty panel', async () => {
		api.listHousehold.mockRejectedValue(new Error('home not found'));
		const panel = householdPanel(HOME);
		document.body.append(panel);
		panel.open = true;
		panel.dispatchEvent(new Event('toggle'));
		await vi.waitFor(() => expect(panel.querySelector('.hm-notice-error')).toBeTruthy());
		expect(panel.textContent).toContain('home not found');
	});
});
