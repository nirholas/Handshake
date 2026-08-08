// Hostile mobs & enforcers (W08 × W07).
//
// Mobs are consequential, they deal damage and drop loot, so unlike the
// ambient crowd they are NOT client-authoritative. Their existence, health,
// damage, movement, and rewards belong to the combat system (W07). This module
// is the *visual* half: given an authoritative hostile from W07, it puts a body
// in the world at the position W07 streams every frame and turns it to face the
// way it is actually moving; contact is only ever *reported* to W07, which
// decides the outcome. Nothing here can be spoofed from the client because
// nothing here grants an effect.
//
// W07 isn't merged yet, so this system is fully gated: with no `window.twsCombat`
// contract present it spawns nothing and fakes no combat, it simply sleeps until
// the foundation it depends on lands. The contract it consumes:
//
//   window.twsCombat.onHostileSpawn(cb)    cb({ id, kind, pos, target, speed })
//   window.twsCombat.onHostileState(cb)    cb({ id, pos?, target? })   // server moves
//   window.twsCombat.onHostileDespawn(cb)  cb({ id })
//   window.twsCombat.reportContact(id)     // mob reached melee range, server rules
//
// When W07 ships, mobs light up with zero changes here.

import { Group, Mesh, Vector3, CapsuleGeometry, SphereGeometry, MeshStandardMaterial } from 'three';

// Real W07 mob kinds (multiplayer/src/items.js MOB_STATS) plus the original
// placeholder kinds, kept for any caller still spawning by the old vocabulary.
const MOB_TINT = {
	enforcer: 0x3a4656, bandit: 0x5a2a2a,
	dummy: 0x9aa3b2, goblin: 0x5f8a3a, ogre: 0x8a6a3a, troll: 0x4a6a6a,
};
const CONTACT_RANGE = 1.6;       // metres, when we tell W07 the mob is in melee
const YAW_EPSILON_M = 0.005;     // per-frame moves smaller than this don't steer
const YAW_LERP = 10;             // 1/s, how fast the body turns into its heading

function shortestAngle(a, b) {
	let d = b - a;
	while (d > Math.PI) d -= Math.PI * 2;
	while (d < -Math.PI) d += Math.PI * 2;
	return d;
}

// A single hostile body, a menacing capsule until W07 supplies a model. The
// server (via W07's per-frame setPos stream) owns where it stands; this class
// only makes the body face the way it is actually moving and reports melee
// contact. It never decides anything.
class Mob {
	constructor(scene, spec) {
		this.scene = scene;
		this.id = spec.id;
		this.speed = spec.speed || 2.4;
		this.target = new Vector3(spec.target?.x || 0, 0, spec.target?.z || 0);
		this._yaw = 0;
		this._contacted = false;

		this.rig = new Group();
		this.rig.position.set(spec.pos?.x || 0, 0, spec.pos?.z || 0);
		const tint = MOB_TINT[spec.kind] || MOB_TINT.enforcer;
		const body = new Mesh(new CapsuleGeometry(0.32, 0.8, 4, 10), new MeshStandardMaterial({ color: tint, roughness: 0.85 }));
		body.position.y = 0.95; body.castShadow = true;
		const head = new Mesh(new SphereGeometry(0.26, 12, 10), new MeshStandardMaterial({ color: tint, roughness: 0.8 }));
		head.position.y = 1.65; head.castShadow = true;
		this.rig.add(body, head);
		scene.add(this.rig);
	}

	setTarget(pos) { if (pos) this.target.set(pos.x || 0, 0, pos.z || 0); }

	// W07 hard-sets the position every frame; derive the facing from the delta of
	// consecutive updates so the body looks where it is going instead of frozen at
	// its spawn heading. Sub-epsilon deltas (idle jitter) leave the yaw alone.
	setPos(pos) {
		if (!pos) return;
		const p = this.rig.position;
		const nx = pos.x || 0, nz = pos.z || 0;
		const dx = nx - p.x, dz = nz - p.z;
		if (Math.hypot(dx, dz) > YAW_EPSILON_M) this._yaw = Math.atan2(dx, dz);
		p.set(nx, 0, nz);
	}

	update(dt, onContact) {
		// Ease the body toward its latest heading, a small lerp keeps turns smooth
		// even though the heading itself updates in discrete per-frame steps.
		this.rig.rotation.y += shortestAngle(this.rig.rotation.y, this._yaw) * Math.min(1, dt * YAW_LERP);

		// Reached melee range of its target: report once and let W07 rule on it.
		const tx = this.target.x - this.rig.position.x, tz = this.target.z - this.rig.position.z;
		if (!this._contacted && Math.hypot(tx, tz) < CONTACT_RANGE) {
			this._contacted = true;
			onContact?.(this.id);
		} else if (this._contacted && Math.hypot(tx, tz) > CONTACT_RANGE * 1.5) {
			this._contacted = false; // left melee, allow a future contact report
		}
	}

	// Mobs respawn continuously all session, free the GPU resources, not just the
	// scene-graph node, or every kill leaks a capsule + sphere + two materials.
	dispose() {
		this.scene.remove(this.rig);
		this.rig.traverse((o) => {
			if (o.isMesh) {
				o.geometry.dispose();
				if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
				else o.material.dispose();
			}
		});
	}
}

export class MobSystem {
	constructor({ scene }) {
		this.scene = scene;
		this.mobs = new Map();
		this._unsub = [];

		const combat = typeof window !== 'undefined' ? window.twsCombat : null;
		this.enabled = !!(combat && typeof combat.onHostileSpawn === 'function');
		if (!this.enabled) return; // W07 absent, sleep, spawn nothing, fake nothing

		this.combat = combat;
		this._unsub.push(combat.onHostileSpawn((spec) => this._spawn(spec)));
		if (combat.onHostileState) this._unsub.push(combat.onHostileState((s) => this._state(s)));
		if (combat.onHostileDespawn) this._unsub.push(combat.onHostileDespawn(({ id }) => this._despawn(id)));
	}

	_spawn(spec) {
		if (!spec?.id || this.mobs.has(spec.id)) return;
		this.mobs.set(spec.id, new Mob(this.scene, spec));
	}
	_state(s) {
		const m = this.mobs.get(s?.id);
		if (!m) return;
		if (s.target) m.setTarget(s.target);
		if (s.pos) m.setPos(s.pos);
	}
	_despawn(id) {
		const m = this.mobs.get(id);
		if (m) { m.dispose(); this.mobs.delete(id); }
	}

	update(dt) {
		if (!this.enabled || !this.mobs.size) return;
		const report = (id) => { try { this.combat.reportContact?.(id); } catch { /* contract optional */ } };
		for (const m of this.mobs.values()) m.update(dt, report);
	}

	dispose() {
		for (const fn of this._unsub) { try { fn?.(); } catch { /* ignore */ } }
		this._unsub = [];
		for (const m of this.mobs.values()) m.dispose();
		this.mobs.clear();
	}
}
