// World life, the W08 manager that makes a coin world feel inhabited.
//
// It owns one deterministic nav graph and hangs everything off it: the ambient
// crowd and traffic (ambient-life.js), the interactive NPCs from the catalog
// (npc.js + npc-catalog.js + economy-npcs.js + quest-npcs.js), the quest-zone
// waypoints the jobs board drives (quest-markers.js), the W07-gated mobs
// (mobs.js), and the bit of road geometry that makes the traffic legible.
// coincommunities.js builds one of these per world on enter, ticks it in the
// render loop, routes E / tap to it, and disposes it on leave, the same
// lifecycle the Agent Exchange already uses. The Agent Exchange stays its own
// special module; this manages everyone else.

import {
	Group, Mesh, RingGeometry, MeshBasicMaterial, MeshStandardMaterial,
	DoubleSide, Vector3, Raycaster, Vector2,
} from 'three';
import { NavGraph } from './nav-graph.js';
import { AmbientLife } from './ambient-life.js';
import { openCitizenProfile } from './citizens.js';
import { Npc } from './npc.js';
import { npcCatalogFor } from './npc-catalog.js';
import { economyNpcsFor } from './economy-npcs.js';
import { questNpcsFor } from './quest-npcs.js';
import { QuestMarkers } from './quest-markers.js';
import { MobSystem } from './mobs.js';
import { log } from '../../shared/log.js';

const ROLE_RING = { vendor: 0x46d49a, quest: 0xffce6e, bank: 0xe6b422, flavor: 0xffffff };

export class WorldLife {
	// world: { mint, name, symbol, seed, biome }, biome is the resolved env
	// biome object; name/symbol feed the world-aware NPC chat prompt.
	// onInspectNpc (optional): called with an interactive Npc when the player
	// selects one from outside its interaction range, the host opens its
	// profile (coincommunities wires the shared avatar inspector).
	constructor({ scene, camera, renderer, getPlayer, ui, net, world, radius = 54, onInspectNpc }) {
		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.getPlayer = getPlayer;
		this.ui = ui;
		this.net = net;
		this.world = world || {};
		this.onInspectNpc = onInspectNpc || null;

		this._injectStyles();

		this.nav = new NavGraph({ radius, seed: world?.seed >>> 0 });
		this._paintRoad();

		this.ambient = new AmbientLife({
			scene,
			nav: this.nav,
			biome: world?.biome,
			// Any detailed pedestrian with a gallery identity is selectable: its
			// profile card opens with the real agent behind the avatar, and a
			// "Talk 1-on-1" that starts a live in-character conversation.
			onInspectPed: (ped) => this._inspectPed(ped),
		});
		this.mobs = new MobSystem({ scene });
		// Waypoints for the jobs board's active objectives (W08 hooking W05),
		// pure client render of the same quest-zones.js the server already
		// validates goto/interact against; it drives itself off the 'quests'
		// snapshot, so it needs only the network handle, not the NPC list.
		this.questMarkers = new QuestMarkers({ scene, net: this.net });

		// Interactive NPCs from the data-driven catalog: the Agent Exchange
		// roster (real x402 micro-services), the general-store clerks + bank
		// teller (W04's off-schema cash economy), and the quest-givers (W08
		// hooking W05's jobs board, see quest-npcs.js), fronted by the
		// room's own message channel, no on-chain settlement for either.
		this.npcs = [...npcCatalogFor(), ...economyNpcsFor(), ...questNpcsFor()].map((def) => {
			const npc = new Npc(scene, def);
			npc.marker = this._npcMarker(def);
			// The nameplate is a click target too, exactly like peer nameplates:
			// always visible, no skinned-mesh raycast. In range it runs the role
			// action; from afar it opens the NPC's profile.
			npc.label.style.pointerEvents = 'auto';
			npc.label.style.cursor = 'pointer';
			npc.label.title = def.prompt || `Talk to ${def.name}`;
			npc.label.addEventListener('click', (e) => {
				e.stopPropagation();
				const player = this.getPlayer?.();
				if (player && npc.distanceTo(player) <= npc.range) {
					try { npc.interact({ player, ui: this.ui, net: this.net, world: this.world }); }
					catch (err) { log.warn('[world-life] npc interact failed:', err?.message); }
				} else if (this.onInspectNpc) {
					this.onInspectNpc(npc);
				}
			});
			return npc;
		});

		// One shared "press E" prompt for whichever NPC, or quest zone,
		// you're nearest.
		this.prompt = document.createElement('div');
		this.prompt.className = 'npc-prompt';
		document.body.appendChild(this.prompt);
		this._promptKey = null;

		this._ray = new Raycaster();
		this._ndc = new Vector2();
		this._ringT = 0;
	}

	// A subtle road band + inner kerb so the traffic reads as driving on something,
	// not gliding over grass. Dirt for the frontier town, dark asphalt elsewhere.
	_paintRoad() {
		const r = this.nav.roadRadius, w = this.nav.roadWidth;
		const frontier = this.world?.biome?.town === 'frontier';
		this.roadGroup = new Group();
		const road = new Mesh(
			new RingGeometry(r - w / 2, r + w / 2, 96),
			new MeshStandardMaterial({ color: frontier ? 0x6b5536 : 0x24272c, roughness: 1, metalness: 0 }),
		);
		road.rotation.x = -Math.PI / 2; road.position.y = 0.012; road.receiveShadow = true;
		this.roadGroup.add(road);
		// A pale kerb just inside, hinting a sidewalk for the foot traffic.
		const kerb = new Mesh(
			new RingGeometry(r - w / 2 - 0.5, r - w / 2 - 0.18, 96),
			new MeshBasicMaterial({ color: frontier ? 0x9a8458 : 0x3a3f47, transparent: true, opacity: 0.6, side: DoubleSide }),
		);
		kerb.rotation.x = -Math.PI / 2; kerb.position.y = 0.014;
		this.roadGroup.add(kerb);
		this.scene.add(this.roadGroup);
	}

	// A faint role-tinted ground ring under an interactive NPC so the spot reads as
	// a place (a market, a board) rather than a person standing in a field.
	_npcMarker(def) {
		const ring = new Mesh(
			new RingGeometry(1.0, 1.3, 40),
			new MeshBasicMaterial({ color: ROLE_RING[def.role] || ROLE_RING.flavor, transparent: true, opacity: 0.28, side: DoubleSide }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.set(def.pos.x, 0.02, def.pos.z);
		this.scene.add(ring);
		return ring;
	}

	_injectStyles() {
		if (document.getElementById('npc-styles')) return;
		const s = document.createElement('style');
		s.id = 'npc-styles';
		s.textContent = `
		.npc-name { color: var(--npc-tint, #fff); text-shadow: 0 1px 3px rgba(0,0,0,0.7); }
		.npc-prompt {
			position: fixed; left: 0; top: 0; z-index: 16; pointer-events: none;
			transform: translate(-50%, -100%); white-space: nowrap;
			background: var(--cc-panel-solid, #0c0c0e); border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
			color: var(--cc-text, #f5f5f6); font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
			padding: 6px 11px; border-radius: var(--cc-radius, 4px); box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.25));
			text-transform: uppercase; transition: opacity 0.18s ease; opacity: 0;
		}
		.npc-prompt.npc-show { opacity: 1; }
		.npc-prompt .npc-key {
			display: inline-block; min-width: 16px; text-align: center; margin-right: 5px;
			background: #fff; color: var(--cc-ink, #060607); border-radius: 3px; padding: 0 4px;
		}`;
		document.head.appendChild(s);
	}

	// Project a world point to a screen-space DOM transform (same math the rest of
	// the scene uses). Hidden when behind the camera.
	_place(node, x, y, z) {
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		const v = new Vector3(x, y, z).project(this.camera);
		if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
		node.style.display = '';
		node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
	}

	// Nearest interactive NPC within its own interaction range, else null.
	_nearestNpc(p) {
		let best = null, bestD = Infinity;
		for (const npc of this.npcs) {
			const d = npc.distanceTo(p);
			if (d <= npc.range && d < bestD) { best = npc; bestD = d; }
		}
		return best;
	}

	// The single thing the shared "press E" prompt/interact acts on: whichever
	// of (nearest NPC, nearest in-range quest zone) is actually closer. Quest
	// zones only ever contend for "interact" kind, a goto waypoint has nothing
	// to press E on, so it never enters this contest.
	_nearestInteractable(p) {
		if (!p) return null;
		const npc = this._nearestNpc(p);
		const npcD = npc ? npc.distanceTo(p) : Infinity;
		const qz = this.questMarkers?.nearestInteractZone(p) || null;
		const qzD = qz ? Math.hypot(p.x - qz.zone.x, p.z - qz.zone.z) : Infinity;
		if (!npc && !qz) return null;
		if (qz && qzD < npcD) return { kind: 'quest', zone: qz.zone, label: qz.label };
		return npc ? { kind: 'npc', npc } : null;
	}

	// Tell the ambient crowd how many real players are present so it tapers.
	setRealPeers(n) { this.ambient?.setRealPeers(n); }

	// Open the citizen profile card for a detailed pedestrian (nameplate click or
	// body tap). The card carries the real agent behind the gallery avatar and a
	// "Talk 1-on-1" action into the live NPC chat.
	_inspectPed(ped) {
		if (!ped?.citizen) return;
		openCitizenProfile(ped.citizen, { world: this.world, ui: this.ui, trigger: ped.label || undefined });
	}

	// Click-only raycast pick over every selectable character: interactive NPCs
	// (body or marker ring) and identity-carrying ambient pedestrians. Returns
	// the nearest hit or null. Never run per-frame; skinned-mesh raycasts are
	// too heavy for hover (same rule as the peer picker in coincommunities).
	_characterAt() {
		let best = null;
		for (const npc of this.npcs) {
			const targets = npc.marker ? [npc.rig, npc.marker] : [npc.rig];
			const hits = this._ray.intersectObjects(targets, true);
			if (hits.length && (!best || hits[0].distance < best.d)) best = { d: hits[0].distance, kind: 'npc', npc };
		}
		for (const ped of this.ambient?.peds || []) {
			if (!ped.citizen) continue;
			const hits = this._ray.intersectObject(ped.rig, true);
			if (hits.length && (!best || hits[0].distance < best.d)) best = { d: hits[0].distance, kind: 'ped', ped };
		}
		return best;
	}

	tick(dt) {
		const player = this.getPlayer?.();
		const project = (node, x, y, z) => this._place(node, x, y, z);

		this.ambient?.update(dt, { player, project });
		this.mobs?.update(dt);
		this.questMarkers?.update(dt, { project });

		for (const npc of this.npcs) {
			npc.tick(dt);
			this._place(npc.label, npc.pos.x, npc.height + 0.2, npc.pos.z);
			if (npc.bubble) this._place(npc.bubble, npc.pos.x, npc.height + 0.7, npc.pos.z);
		}

		// Breathe the NPC markers.
		this._ringT += dt;
		const pulse = 0.22 + 0.1 * (0.5 + 0.5 * Math.sin(this._ringT * 2));
		for (const npc of this.npcs) if (npc.marker) npc.marker.material.opacity = pulse;

		// Single proximity prompt for whichever interactable, NPC or quest
		// zone, is nearest right now. Keyed by a stable id so we don't churn
		// the DOM/innerHTML every frame for the same target.
		const nearest = player ? this._nearestInteractable(player) : null;
		const key = nearest ? (nearest.kind === 'npc' ? `npc:${nearest.npc.id}` : `quest:${nearest.zone.id}`) : null;
		if (key !== this._promptKey) {
			this._promptKey = key;
			if (nearest) {
				const label = nearest.kind === 'npc' ? (nearest.npc.def.prompt || 'Talk') : (nearest.label || `Use ${nearest.zone.label}`);
				this.prompt.innerHTML = `<span class="npc-key">E</span> ${label}`;
			}
		}
		if (nearest) {
			this.prompt.classList.add('npc-show');
			if (nearest.kind === 'npc') {
				this._place(this.prompt, nearest.npc.pos.x, nearest.npc.height + 0.9, nearest.npc.pos.z);
				nearest.npc.faceTowards(player); // turn to greet whoever walks up
			} else {
				this._place(this.prompt, nearest.zone.x, 1.9, nearest.zone.z);
			}
		} else {
			this.prompt.classList.remove('npc-show');
		}

		// Walk-up trigger: an NPC with `onApproach` fires it once when the player
		// enters its range, and re-arms only after the player walks away (1 m of
		// hysteresis so boundary jitter can't re-fire it). Driven off the nearest
		// NPC specifically (not the combined prompt target), a quest zone
		// winning the shared prompt shouldn't suppress an NPC's own approach line.
		const nearNpc = player ? this._nearestNpc(player) : null;
		if (player) {
			for (const npc of this.npcs) {
				if (typeof npc.def.onApproach !== 'function') continue;
				if (npc === nearNpc && !npc._approached) {
					npc._approached = true;
					try { npc.def.onApproach({ npc, player, ui: this.ui, net: this.net, world: this.world }); }
					catch (e) { log.warn('[world-life] npc onApproach failed:', e?.message); }
				} else if (npc !== nearNpc && npc._approached && npc.distanceTo(player) > npc.range + 1) {
					npc._approached = false;
				}
			}
		}
	}

	// Player pressed E: talk to / open the nearest NPC, or act at the nearest
	// in-range quest zone (courier pickup/dropoff, a heist terminal, the vault
	// door), whichever is actually closer. The quest path only ever SENDS the
	// intent; the server re-derives the zone from its own authoritative
	// position and rules on it, same as every other off-schema action. Returns
	// true if one consumed the press, so the caller can stop here.
	interact() {
		const player = this.getPlayer?.();
		if (!player) return false;
		const nearest = this._nearestInteractable(player);
		if (!nearest) return false;
		if (nearest.kind === 'quest') {
			this.net?.questInteract?.();
			return true;
		}
		try { nearest.npc.interact({ player, ui: this.ui, net: this.net, world: this.world }); }
		catch (e) { log.warn('[world-life] npc interact failed:', e?.message); }
		return true;
	}

	// Tap/click any character in the world, the touch equivalent of E, extended
	// to every walker. An interactive NPC tapped in range runs its role action
	// (counter, chat, board); tapped from afar it opens its profile instead. An
	// ambient pedestrian with a gallery identity opens its citizen profile card
	// at any distance. Quest-zone waypoint rings keep their in-range activation.
	// Returns true if it consumed the tap.
	tryActivateAt(clientX, clientY) {
		const player = this.getPlayer?.();
		if (!player) return false;
		const el = this.renderer.domElement;
		const rect = el.getBoundingClientRect();
		this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
		this._ray.setFromCamera(this._ndc, this.camera);

		// Quest waypoint rings first: they only ever answer while in range, and a
		// tap on one must not be shadowed by a character standing inside the ring.
		const near = this._nearestInteractable(player);
		if (near?.kind === 'quest' && this.questMarkers) {
			if (this._ray.intersectObjects(this.questMarkers.rayTargets(), true).length > 0) {
				this.net?.questInteract?.();
				return true;
			}
		}

		const hit = this._characterAt();
		if (!hit) return false;
		if (hit.kind === 'ped') {
			this._inspectPed(hit.ped);
			return true;
		}
		const npc = hit.npc;
		if (npc.distanceTo(player) <= npc.range) {
			try { npc.interact({ player, ui: this.ui, net: this.net, world: this.world }); }
			catch (e) { log.warn('[world-life] npc interact failed:', e?.message); }
			return true;
		}
		if (this.onInspectNpc) { this.onInspectNpc(npc); return true; }
		return false;
	}

	dispose() {
		this.ambient?.dispose();
		this.mobs?.dispose();
		this.questMarkers?.dispose();
		for (const npc of this.npcs) {
			npc.dispose();
			if (npc.marker) {
				this.scene.remove(npc.marker);
				npc.marker.geometry.dispose();
				npc.marker.material.dispose();
			}
		}
		this.npcs = [];
		if (this.roadGroup) {
			this.scene.remove(this.roadGroup);
			// Road band + kerb are one-off RingGeometries with their own materials,
			// free them, this group is rebuilt for every world enter.
			for (const child of this.roadGroup.children) {
				child.geometry.dispose();
				child.material.dispose();
			}
			this.roadGroup = null;
		}
		this.prompt?.remove();
		document.getElementById('npc-styles')?.remove();
	}
}
