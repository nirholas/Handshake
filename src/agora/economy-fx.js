import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { dracoLoader, meshoptReady } from '../game/avatar-rig.js';

// Economy FX — the completion moment, the part people screenshot.
//
// When a task completes the world should *show* it: a $THREE coin arc flowing
// from the board's escrow to the worker, the reward label, a reputation tick,
// and — for a Sculptor's GLB deliverable — the artifact materialising on a
// plinth the camera glides in to orbit. Everything here is world-position based
// and decoupled from the crowd: the economy layer resolves which citizen earned
// and hands us a world point.
//
// Two hard rules from the DoD:
//   • Dispose every geometry / material / texture for retired coins and plinth
//     models — a completion every few seconds would otherwise leak the heap.
//   • Honour prefers-reduced-motion: swap the coin flight + spin for a calm fade
//     and a static deliverable.

const COIN_GOLD = 0xf0b429;
const COIN_COUNT = 9;
const COIN_FLIGHT = 1.15;        // seconds board → worker
const PLINTH_SPOT = new THREE.Vector3();

// One GLTF loader for deliverables, sharing the app's Draco + meshopt decoders.
const _gltf = new GLTFLoader();
_gltf.setDRACOLoader(dracoLoader);
const _meshoptWired = meshoptReady.then((d) => { if (d) _gltf.setMeshoptDecoder(d); return d; });

const _coinGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.04, 18);

function isGlb(url) {
	if (!url) return false;
	const u = String(url).split('?')[0].toLowerCase();
	return u.endsWith('.glb') || u.endsWith('.gltf');
}

// Pull a "rep 14 → 19" delta out of a real narrative string. Returns null when
// the narrative carries no reputation move (we never invent numbers).
function parseRepDelta(narrative) {
	if (!narrative) return null;
	const m = String(narrative).match(/rep(?:utation)?\s*(\d+)\s*(?:→|->|to)\s*(\d+)/i);
	if (!m) return null;
	const before = parseInt(m[1], 10);
	const after = parseInt(m[2], 10);
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
	return { before, after, delta: after - before };
}

export class EconomyFx {
	constructor(ctx) {
		this.ctx = ctx;                 // { scene, root, worldToScreen, reducedMotion, focusOn, boardPosition }
		this.scene = ctx.scene;
		this.reducedMotion = !!ctx.reducedMotion;
		this.boardTop = (ctx.boardPosition ? ctx.boardPosition.clone() : new THREE.Vector3(0, 0, -6));
		this.boardTop.y += 3.2;

		this._coins = [];               // active coin sprites
		this._labels = [];              // active floating HTML labels
		this._t = 0;
		this._deliverableGen = 0;       // guards overlapping GLB loads (see showDeliverable)
		this._disposed = false;

		this._buildPlinth();
	}

	// ── Plinth ────────────────────────────────────────────────────────────────
	_buildPlinth() {
		// A pedestal that always stands in the Commons; the deliverable model is
		// what swaps in and out. Placed to the side of the board so the camera can
		// orbit it without the board behind.
		const spot = this.plinthSpot = (this.boardTop.clone());
		spot.y = 0; spot.x += 4.2; spot.z += 1.5;

		const grp = new THREE.Group();
		grp.position.copy(spot);

		const colGeo = new THREE.CylinderGeometry(0.7, 0.85, 1.1, 28);
		const colMat = new THREE.MeshStandardMaterial({ color: 0x1a1f2a, roughness: 0.55, metalness: 0.35 });
		const col = new THREE.Mesh(colGeo, colMat);
		col.position.y = 0.55; col.castShadow = true; col.receiveShadow = true;
		grp.add(col);

		const topGeo = new THREE.CylinderGeometry(0.82, 0.82, 0.12, 28);
		const topMat = new THREE.MeshStandardMaterial({ color: 0x2a3344, roughness: 0.4, metalness: 0.5 });
		const top = new THREE.Mesh(topGeo, topMat);
		top.position.y = 1.16; top.castShadow = true;
		grp.add(top);

		// A focused spotlight on the deliverable.
		const spotLight = new THREE.SpotLight(0xffffff, 0, 9, Math.PI / 7, 0.4, 1.2);
		spotLight.position.set(0, 6, 2.5);
		spotLight.target.position.set(0, 1.6, 0);
		grp.add(spotLight, spotLight.target);

		this._plinthGroup = grp;
		this._plinthSpot = spot;
		this._plinthDisposables = [colGeo, colMat, topGeo, topMat];
		this._spotLight = spotLight;
		this._plinthModel = null;
		this._plinthModelHolder = new THREE.Group();
		this._plinthModelHolder.position.y = 1.22;
		grp.add(this._plinthModelHolder);

		this.scene.add(grp);
	}

	// Load and mount a GLB deliverable, disposing whatever stood there before.
	async showDeliverable(url) {
		this._retireDeliverableModel();
		if (!isGlb(url)) return false;
		// Completions can land back-to-back, and a GLB load is slow enough that two
		// can be in flight at once. Without a generation guard the loser's model
		// still gets parented to the plinth and then orphaned when `_plinthModel`
		// is overwritten, invisible to `_retireDeliverableModel` and to dispose(),
		// i.e. exactly the leak this file is supposed to prevent. Stamp each load
		// and let only the newest mount; anything stale is disposed on arrival.
		const generation = ++this._deliverableGen;
		try {
			await _meshoptWired;
			const gltf = await _gltf.loadAsync(url);
			const model = gltf.scene;
			if (generation !== this._deliverableGen || this._disposed) {
				disposeObject(model);
				return false;
			}

			// Normalise to ~1.6m tall, centred on the plinth top.
			const box = new THREE.Box3().setFromObject(model);
			const size = new THREE.Vector3(); box.getSize(size);
			const maxDim = Math.max(size.x, size.y, size.z) || 1;
			const scale = 1.6 / maxDim;
			model.scale.setScalar(scale);
			const center = new THREE.Vector3(); box.getCenter(center);
			model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
			model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = false; } });

			this._plinthModelHolder.add(model);
			this._plinthModel = model;
			this._spotLight.intensity = 6;

			// Glide the camera in to orbit it.
			const focus = this._plinthSpot.clone(); focus.y = 1.4;
			this.ctx.focusOn?.(focus);
			return true;
		} catch (err) {
			console.warn('[agora] deliverable load failed:', err?.message);
			return false;
		}
	}

	_retireDeliverableModel() {
		// Invalidate any load still in flight so it can't mount behind this retire.
		this._deliverableGen++;
		// Dispose by walking the holder, not just the tracked handle, so nothing
		// parented here can survive as an orphan.
		for (const child of [...this._plinthModelHolder.children]) {
			this._plinthModelHolder.remove(child);
			disposeObject(child);
		}
		this._plinthModel = null;
		this._plinthModelHolder.rotation.y = 0;
		this._spotLight.intensity = 0;
	}

	// ── The completion moment ──────────────────────────────────────────────────
	// workerPos: feet position of the earner (or null → coins settle at the
	// plinth). rewardLabel/narrative are real strings from the pulse.
	onCompletion({ workerPos, rewardLabel, narrative, deliverableUrl }) {
		const target = workerPos
			? new THREE.Vector3(workerPos.x, 1.7, workerPos.z)
			: this._plinthSpot.clone().setY(1.4);

		this._coinFlow(target);
		if (rewardLabel) this._floatLabel(target.clone().setY(target.y + 0.5), `+${rewardLabel}`, 'reward');

		const rep = parseRepDelta(narrative);
		if (rep) {
			const tickPos = target.clone(); tickPos.y += 0.95;
			this._floatLabel(tickPos, `rep ${rep.before} → ${rep.after} ▲`, 'rep');
		}

		if (isGlb(deliverableUrl)) this.showDeliverable(deliverableUrl);
	}

	_coinFlow(target) {
		if (this.reducedMotion) {
			// No flight — a single calm "paid" pulse at the target.
			this._floatLabel(target.clone().setY(target.y + 0.2), '$THREE paid', 'reward');
			return;
		}
		const from = this.boardTop.clone();
		const mid = from.clone().lerp(target, 0.5);
		mid.y += Math.max(2.2, from.distanceTo(target) * 0.35);

		for (let i = 0; i < COIN_COUNT; i++) {
			const mat = new THREE.MeshStandardMaterial({
				color: COIN_GOLD, emissive: COIN_GOLD, emissiveIntensity: 0.5,
				roughness: 0.3, metalness: 0.9,
			});
			const coin = new THREE.Mesh(_coinGeo, mat);
			coin.castShadow = false;
			coin.rotation.x = Math.PI / 2;
			this.scene.add(coin);
			this._coins.push({
				mesh: coin, mat,
				from: from.clone(), mid: mid.clone(), to: target.clone(),
				t: -i * 0.06,                     // stagger the stream
				spin: 6 + Math.random() * 6,
			});
		}
	}

	_floatLabel(worldPos, text, kind) {
		const el = document.createElement('div');
		el.className = `agora-econ-float agora-econ-float-${kind}${this.reducedMotion ? ' reduced' : ''}`;
		el.textContent = text;
		this.ctx.root.appendChild(el);
		this._labels.push({ el, worldPos: worldPos.clone(), born: this._t, ttl: 2.0 });
	}

	// ── Per-frame ───────────────────────────────────────────────────────────────
	update(dt) {
		this._t += dt;

		// Coins along their bezier.
		for (let i = this._coins.length - 1; i >= 0; i--) {
			const c = this._coins[i];
			c.t += dt / COIN_FLIGHT;
			if (c.t < 0) continue;
			if (c.t >= 1) {
				this.scene.remove(c.mesh);
				c.mat.dispose();
				this._coins.splice(i, 1);
				continue;
			}
			const u = c.t, iv = 1 - u;
			// Quadratic bezier from → mid → to.
			c.mesh.position.set(
				iv * iv * c.from.x + 2 * iv * u * c.mid.x + u * u * c.to.x,
				iv * iv * c.from.y + 2 * iv * u * c.mid.y + u * u * c.to.y,
				iv * iv * c.from.z + 2 * iv * u * c.mid.z + u * u * c.to.z,
			);
			c.mesh.rotation.z += c.spin * dt;
			c.mat.emissiveIntensity = 0.4 + 0.4 * Math.sin(this._t * 8 + i);
		}

		// Floating labels: project to screen, rise + fade.
		for (let i = this._labels.length - 1; i >= 0; i--) {
			const l = this._labels[i];
			const age = this._t - l.born;
			if (age >= l.ttl) {
				l.el.remove();
				this._labels.splice(i, 1);
				continue;
			}
			const s = this.ctx.worldToScreen(l.worldPos);
			if (!s.visible) { l.el.style.opacity = '0'; continue; }
			const p = age / l.ttl;
			const rise = this.reducedMotion ? 0 : p * 36;
			l.el.style.transform = `translate(-50%, -50%) translate(${s.x}px, ${s.y - rise}px)`;
			l.el.style.opacity = String(p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85);
		}

		// Idle plinth model rotation (unless reduced motion).
		if (this._plinthModel && !this.reducedMotion) {
			this._plinthModelHolder.rotation.y += dt * 0.5;
		}
	}

	// Live prefers-reduced-motion change. Coins already in flight keep their arc
	// (yanking them mid-air is its own jolt); everything that loops (the plinth
	// spin, label rise, future coin flows) settles from the next frame on.
	setReducedMotion(on) {
		this.reducedMotion = !!on;
		if (this.reducedMotion) this._plinthModelHolder.rotation.y = 0;
	}

	dispose() {
		this._disposed = true;
		for (const c of this._coins) { this.scene.remove(c.mesh); c.mat.dispose(); }
		this._coins = [];
		for (const l of this._labels) l.el.remove();
		this._labels = [];
		this._retireDeliverableModel();
		for (const d of this._plinthDisposables) d.dispose?.();
		this._spotLight.dispose?.();
		this.scene.remove(this._plinthGroup);
		// _coinGeo is module-shared across the page lifetime — not disposed here.
	}
}

// Recursively dispose a loaded model's geometries, materials and textures.
function disposeObject(obj) {
	obj.traverse((n) => {
		if (!n.isMesh) return;
		n.geometry?.dispose?.();
		const mats = Array.isArray(n.material) ? n.material : [n.material];
		for (const m of mats) {
			if (!m) continue;
			for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
				m[k]?.dispose?.();
			}
			m.dispose?.();
		}
	});
}
