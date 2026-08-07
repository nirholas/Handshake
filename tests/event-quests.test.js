// Event quest line (order 04) — the gate is the whole feature. An event job must
// be invisible, unacceptable and unpayable outside the event window, and fully
// playable inside it, judged from the SERVER's read of public/event.json. These
// cases pin both halves plus the new `defeat` objective the combat job runs on.
import { describe, it, expect } from 'vitest';
import {
	MISSIONS, EVENT_MISSION_IDS, isEventMission,
	boardOffers, canAccept, acceptMission, applyEvent, objectiveMatches,
	newQuestState, questSnapshot, pruneClosedEventRuns, missionReward,
} from '../multiplayer/src/quests.js';
import { questZone } from '../multiplayer/src/quest-zones.js';
import { DANGER_ZONES } from '../multiplayer/src/world-features.js';
import { parseEventWindow, isEventLive } from '../multiplayer/src/event-window.js';

const LIVE = { eventLive: true };
const CLOSED = { eventLive: false };
const DAY = '2026-08-07';

describe('event mission registry', () => {
	it('registers a quest line of 3 to 5 event jobs, all repeatable solo work', () => {
		expect(EVENT_MISSION_IDS.length).toBeGreaterThanOrEqual(3);
		expect(EVENT_MISSION_IDS.length).toBeLessThanOrEqual(5);
		for (const id of EVENT_MISSION_IDS) {
			const m = MISSIONS[id];
			expect(m.event).toBe(true);
			expect(m.kind).toBe('job');
			expect(m.repeat).toBe('repeatable');
			expect(m.party).toBe(1);
			expect(missionReward(m).gold).toBeGreaterThan(0);
		}
	});

	it('spans gathering, vehicle delivery, combat and a landmark tour', () => {
		const types = EVENT_MISSION_IDS.flatMap((id) => MISSIONS[id].objectives.map((o) => o.type));
		expect(types).toContain('collect');
		expect(types).toContain('defeat');
		expect(types).toContain('goto');
		const driving = MISSIONS['event-supply-run'].objectives;
		expect(driving.every((o) => o.type === 'goto' && o.vehicle === true)).toBe(true);
	});

	it('every event objective points at a real zone the server can resolve', () => {
		for (const id of EVENT_MISSION_IDS) {
			for (const obj of MISSIONS[id].objectives) {
				if (obj.zone) expect(questZone(obj.zone), `${id}:${obj.zone}`).toBeTruthy();
				if (obj.dangerZone) {
					expect(DANGER_ZONES.some((z) => z.id === obj.dangerZone), `${id}:${obj.dangerZone}`).toBe(true);
				}
			}
		}
	});

	it('isEventMission only claims the event jobs', () => {
		expect(isEventMission('event-plaza-catch')).toBe(true);
		expect(isEventMission('daily-anglers-haul')).toBe(false);
		expect(isEventMission('nope')).toBe(false);
	});
});

describe('the event window gates the board', () => {
	it('hides every event job when the window is closed', () => {
		const offers = boardOffers(newQuestState(DAY), DAY, CLOSED).map((o) => o.id);
		for (const id of EVENT_MISSION_IDS) expect(offers).not.toContain(id);
		// The everyday board is untouched by the gate.
		expect(offers).toContain('harbor-courier');
	});

	it('offers every event job when the window is open, event jobs first', () => {
		const offers = boardOffers(newQuestState(DAY), DAY, LIVE);
		const ids = offers.map((o) => o.id);
		for (const id of EVENT_MISSION_IDS) expect(ids).toContain(id);
		expect(offers.slice(0, EVENT_MISSION_IDS.length).every((o) => o.event)).toBe(true);
	});

	it('defaults to CLOSED when no context is passed at all', () => {
		const ids = boardOffers(newQuestState(DAY), DAY).map((o) => o.id);
		for (const id of EVENT_MISSION_IDS) expect(ids).not.toContain(id);
	});

	it('refuses to accept an event job out of window, and says why', () => {
		const state = newQuestState(DAY);
		expect(canAccept(state, MISSIONS['event-plaza-catch'], DAY, CLOSED)).toBe(false);
		const res = acceptMission(state, 'event-plaza-catch', DAY, CLOSED);
		expect(res.ok).toBe(false);
		expect(res.reason).toBe('event-closed');
		expect(state.active['event-plaza-catch']).toBeUndefined();
	});

	it('accepts an event job in window', () => {
		const state = newQuestState(DAY);
		const res = acceptMission(state, 'event-plaza-catch', DAY, LIVE);
		expect(res.ok).toBe(true);
		expect(state.active['event-plaza-catch']).toBeTruthy();
	});

	it('drops a run left over when the window shuts, and keeps ordinary runs', () => {
		const state = newQuestState(DAY);
		acceptMission(state, 'event-plaza-catch', DAY, LIVE);
		acceptMission(state, 'harbor-courier', DAY, LIVE);
		expect(pruneClosedEventRuns(state, LIVE)).toEqual([]); // still live: nothing dropped
		expect(pruneClosedEventRuns(state, CLOSED)).toEqual(['event-plaza-catch']);
		expect(state.active['event-plaza-catch']).toBeUndefined();
		expect(state.active['harbor-courier']).toBeTruthy();
	});

	it('reports the live flag on the snapshot the client renders from', () => {
		expect(questSnapshot(newQuestState(DAY), DAY, LIVE).eventLive).toBe(true);
		expect(questSnapshot(newQuestState(DAY), DAY, CLOSED).eventLive).toBe(false);
	});
});

describe('the defeat objective (the combat event job)', () => {
	const obj = MISSIONS['event-wilds-patrol'].objectives[0];

	it('matches a mob kill inside its named danger zone', () => {
		expect(objectiveMatches(obj, { type: 'defeat', target: 'mob', zone: 'southern-wilds' })).toBe(true);
	});

	it('ignores a kill in a different danger zone', () => {
		expect(objectiveMatches(obj, { type: 'defeat', target: 'mob', zone: 'northern-wilds' })).toBe(false);
	});

	it('ignores a kill with no zone at all (a town kill can never happen, but a null must not count)', () => {
		expect(objectiveMatches(obj, { type: 'defeat', target: 'mob', zone: null })).toBe(false);
	});

	it('ignores a player kill when the objective asks for mobs', () => {
		expect(objectiveMatches(obj, { type: 'defeat', target: 'player', zone: 'southern-wilds' })).toBe(false);
	});

	it('counts one per kill and completes at the required count', () => {
		const run = { id: 'event-wilds-patrol', stage: 0, counts: {}, startedAt: 0, day: DAY };
		const mission = MISSIONS['event-wilds-patrol'];
		const kill = { type: 'defeat', target: 'mob', zone: 'southern-wilds' };
		const need = mission.objectives[0].count;
		for (let i = 1; i < need; i++) {
			const res = applyEvent(run, mission, kill);
			expect(res.matched).toBe(true);
			expect(res.missionComplete).toBe(false);
			expect(run.counts[0]).toBe(i);
		}
		expect(applyEvent(run, mission, kill).missionComplete).toBe(true);
	});
});

describe('the window itself is parsed from the config, never hardcoded', () => {
	const doc = { id: 'e1', name: 'Meetup', startsAt: '2026-08-07T17:00:00Z', endsAt: '2026-08-07T19:00:00Z' };
	const win = parseEventWindow(doc);

	it('parses id and bounds off the same fields the client reads', () => {
		expect(win.id).toBe('e1');
		expect(win.startsAt).toBe(Date.parse(doc.startsAt));
		expect(win.endsAt).toBe(Date.parse(doc.endsAt));
	});

	it('is live inside the window and closed on either side of it', () => {
		expect(isEventLive(win, Date.parse('2026-08-07T16:59:59Z'))).toBe(false);
		expect(isEventLive(win, Date.parse('2026-08-07T17:00:00Z'))).toBe(true);
		expect(isEventLive(win, Date.parse('2026-08-07T18:59:59Z'))).toBe(true);
		expect(isEventLive(win, Date.parse('2026-08-07T19:00:00Z'))).toBe(false);
	});

	it('defaults a missing end to six hours, matching the client parser', () => {
		const open = parseEventWindow({ id: 'e2', startsAt: '2026-08-07T17:00:00Z' });
		expect(open.endsAt - open.startsAt).toBe(6 * 3600 * 1000);
	});

	it('treats a missing or malformed config as no event, so the gate stays closed', () => {
		expect(parseEventWindow(null)).toBeNull();
		expect(parseEventWindow({})).toBeNull();
		expect(parseEventWindow({ startsAt: 'not a date' })).toBeNull();
		expect(isEventLive(null, Date.now())).toBe(false);
	});
});
