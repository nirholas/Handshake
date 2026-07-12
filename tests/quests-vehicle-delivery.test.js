// Cross-town / East-West delivery jobs (W05 vehicle extension) — the
// vehicle-gated goto objective is the load-bearing new behaviour: a delivery
// leg must only complete when the player actually drove through the depot,
// never when they merely walked through it.
import { describe, it, expect } from 'vitest';
import {
	MISSIONS, objectiveMatches, applyEvent, acceptMission, newQuestState,
} from '../multiplayer/src/quests.js';
import { questZone, zoneAt } from '../multiplayer/src/quest-zones.js';

describe('vehicle delivery missions', () => {
	it('cross-town-delivery and east-west-express are registered, repeatable, solo jobs', () => {
		for (const id of ['cross-town-delivery', 'east-west-express']) {
			const m = MISSIONS[id];
			expect(m).toBeTruthy();
			expect(m.kind).toBe('job');
			expect(m.repeat).toBe('repeatable');
			expect(m.party).toBe(1);
			expect(m.objectives).toHaveLength(2);
			for (const obj of m.objectives) {
				expect(obj.type).toBe('goto');
				expect(obj.vehicle).toBe(true);
				expect(questZone(obj.zone)).toBeTruthy();
			}
			expect(m.reward.gold).toBeGreaterThan(0);
		}
	});

	it('depot zones resolve from world coordinates via zoneAt (same lookup the room uses)', () => {
		expect(zoneAt(6, -90)?.id).toBe('depot-north');
		expect(zoneAt(-6, 90)?.id).toBe('depot-south');
		expect(zoneAt(90, 6)?.id).toBe('depot-east');
		expect(zoneAt(-90, -6)?.id).toBe('depot-west');
	});

	it('a vehicle:true goto objective does NOT match entering the zone on foot', () => {
		const obj = MISSIONS['cross-town-delivery'].objectives[0];
		expect(objectiveMatches(obj, { type: 'enter-zone', zone: 'depot-north', inVehicle: false })).toBe(false);
	});

	it('a vehicle:true goto objective matches entering the zone while driving', () => {
		const obj = MISSIONS['cross-town-delivery'].objectives[0];
		expect(objectiveMatches(obj, { type: 'enter-zone', zone: 'depot-north', inVehicle: true })).toBe(true);
	});

	it('a plain (non-vehicle) goto objective ignores inVehicle entirely', () => {
		const obj = MISSIONS['daily-grounds-survey'].objectives[0]; // pond-east, no vehicle flag
		expect(objectiveMatches(obj, { type: 'enter-zone', zone: 'pond-east', inVehicle: false })).toBe(true);
		expect(objectiveMatches(obj, { type: 'enter-zone', zone: 'pond-east', inVehicle: true })).toBe(true);
	});

	it('walking through both depots never completes the delivery; driving through both does', () => {
		const mission = MISSIONS['cross-town-delivery'];
		const state = newQuestState();
		const accepted = acceptMission(state, mission.id);
		expect(accepted.ok).toBe(true);
		const run = state.active[mission.id];

		// On foot: neither leg advances the run.
		let res = applyEvent(run, mission, { type: 'enter-zone', zone: 'depot-north', inVehicle: false });
		expect(res.matched).toBe(false);
		expect(run.stage).toBe(0);

		// Driving: both legs advance in order and the mission completes.
		res = applyEvent(run, mission, { type: 'enter-zone', zone: 'depot-north', inVehicle: true });
		expect(res.matched).toBe(true);
		expect(res.objComplete).toBe(true);
		expect(res.missionComplete).toBe(false);
		expect(run.stage).toBe(1);

		res = applyEvent(run, mission, { type: 'enter-zone', zone: 'depot-south', inVehicle: true });
		expect(res.matched).toBe(true);
		expect(res.missionComplete).toBe(true);
		expect(run.stage).toBe(2);
	});
});
