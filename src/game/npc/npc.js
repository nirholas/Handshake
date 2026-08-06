// A generalized interactive NPC — the reusable engine behind the Agent Exchange.
//
// agent-commerce.js proved the pattern: a GLB-bodied character standing in the
// world, a proximity prompt, a dialogue beat, and a real role action on E/tap.
// This class is that pattern with the x402-specific bits lifted out, so vendors
// (W04), quest-givers (W05), and flavor townsfolk are all the same object with a
// different `def`. The Agent Exchange remains its own special module; everything
// else in the world is an Npc.
//
// The NPC owns only its body, nameplate, and speech bubble. The single shared
// "press E" prompt and interaction dispatch live on the world-life manager, so a
// plaza full of NPCs shows one prompt for whichever you're closest to, never a
// thicket of them.

import { Group, Vector3 } from 'three';
import { AnimationManager } from '../../animation-manager.js';
import { resolveAvatarUrl, buildAvatar, CLIP_IDLE, CLIP_WALK } from '../avatar-rig.js';
import { playEmoteClip } from '../avatar-rig.js';

const BUBBLE_MS = 4600;

// Role → nameplate accent. Monochrome-first to match the site tokens; the marker
// ring under the NPC carries the only colour, so the world stays calm.
const ROLE_TINT = {
	vendor: 'rgba(120, 220, 160, 0.95)',
	quest:  'rgba(255, 210, 120, 0.95)',
	bank:   'rgba(230, 180, 34, 0.95)',
	flavor: 'rgba(255, 255, 255, 0.92)',
};

export class Npc {
	// def: { id, name, role, avatar, pos:{x,z}, yaw, prompt, dialogue:[], onInteract }
	constructor(scene, def) {
		this.scene = scene;
		this.def = def;
		this.id = def.id;
		this.name = def.name;
		this.role = def.role || 'flavor';
		this.height = 1.7;
		this._disposed = false;
		this._dialogueIdx = 0;
		this._faceUntil = 0;

		this.pos = new Vector3(def.pos.x, 0, def.pos.z);
		this.baseYaw = def.yaw ?? 0;

		this.rig = new Group();
		this.rig.position.copy(this.pos);
		this.rig.rotation.y = this.baseYaw;
		scene.add(this.rig);

		this.anim = new AnimationManager();

		this.label = document.createElement('div');
		this.label.className = 'cc-label npc-name';
		this.label.style.setProperty('--npc-tint', ROLE_TINT[this.role] || ROLE_TINT.flavor);
		this.label.textContent = def.name;
		document.body.appendChild(this.label);

		this.bubble = null;
		this._bubbleTimer = null;

		// Locomotion clips only: ~21 NPCs per world must not each pull the whole
		// emote library. emote() below lazy-loads any clip on demand.
		resolveAvatarUrl(def.avatar)
			.then((u) => buildAvatar(this.rig, u, this.anim, { clips: 'locomotion' }))
			.then(({ height }) => { if (!this._disposed) this.height = height; })
			.catch(() => {});
	}

	// How close a player must be to interact, in metres.
	get range() { return this.def.range || 4.5; }

	// Distance² from a player position to this NPC (cheap proximity test).
	distanceTo(p) {
		const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
		return Math.hypot(dx, dz);
	}

	say(text) {
		if (!text) return;
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble npc-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, BUBBLE_MS);
	}

	// Turn to face a point for a couple of seconds (called when the player walks
	// up). Returns to the post heading afterwards in tick().
	faceTowards(p) {
		const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
		if (dx === 0 && dz === 0) return;
		this._targetYaw = Math.atan2(dx, dz);
		this._faceUntil = (typeof performance !== 'undefined' ? performance.now() : 0) + 2600;
	}

	async emote(name) {
		try { await playEmoteClip(this.anim, name, 'idle'); } catch { /* clip missing */ }
	}

	// Run the NPC's role action. Custom `onInteract` (vendor/quest) takes over;
	// otherwise cycle the flavor dialogue line by line so repeated taps feel like
	// a conversation, not a stuck record.
	interact(ctx) {
		this.faceTowards(ctx.player);
		if (typeof this.def.onInteract === 'function') {
			try { this.def.onInteract({ npc: this, ...ctx }); } catch { /* role action failed — stay silent rather than crash the loop */ }
			return;
		}
		const lines = this.def.dialogue || [];
		if (!lines.length) return;
		this.say(lines[this._dialogueIdx % lines.length]);
		this._dialogueIdx++;
	}

	tick(dt) {
		// Smoothly settle toward either the look-at-player yaw or the post heading.
		const now = (typeof performance !== 'undefined' ? performance.now() : 0);
		const want = (this._faceUntil > now && this._targetYaw != null) ? this._targetYaw : this.baseYaw;
		let d = want - this.rig.rotation.y;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		this.rig.rotation.y += d * Math.min(1, dt * 6);
		this.anim.update(dt);
	}

	dispose() {
		this._disposed = true;
		this.scene.remove(this.rig);
		this.label.remove();
		this.bubble?.remove();
		clearTimeout(this._bubbleTimer);
		this.anim.dispose?.();
	}
}

export { CLIP_IDLE, CLIP_WALK };
