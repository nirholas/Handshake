// Animation preset gallery for the /pose studio.
//
// Renders a curated, searchable gallery of ready-to-apply motion clips. Click a
// card and the clip retargets onto the loaded rig and plays live in the
// viewport (the shared 3D stage is the preview surface — one figure, like
// Mixamo, rather than N video thumbnails). A transport bar then lets the user
// scrub speed, toggle loop, stop, and export an animated GLB with the motion
// baked in.
//
// This controller owns only its own AnimationMixer and DOM; it borrows the rig
// and render loop from the host (pose-studio) through the callbacks passed to
// the constructor, and signals the host when a preview takes over the figure so
// the keyframe timeline can yield.

import { AnimationMixer, LoopOnce, LoopRepeat } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

import { curate } from './animation-presets.js';
import { buildFingerspellingClip, normalizeWord } from './fingerspelling.js';
import {
	retargetClipToRig,
	scaleClipSpeed,
	parseClipJSON,
	MIN_COVERAGE,
} from './animation-retarget.js';
import { log } from './shared/log.js';

const MANIFEST_URL = '/animations/manifest.json';
// A rig needs a real share of the canonical skeleton before presets read as
// performances rather than twitches. Mirrors AnimationManager's bar.
const MIN_RIG_BONES = 8;

// Text-to-animation job polling (POST /api/forge-motion → poll until the clip
// is ready). The motion model runs ~10–30s on a warm GPU container.
const GEN_POLL_INTERVAL_MS = 2500;
const GEN_MAX_POLL_MS = 90 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function')
			node.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) node.setAttribute(k, v);
	}
	for (const child of Array.isArray(children) ? children : [children]) {
		if (child == null) continue;
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
};

export class AnimationLibrary {
	/**
	 * @param {{
	 *   host: HTMLElement,
	 *   getRig: () => object|null,
	 *   onPreviewStart?: () => void,
	 *   onPreviewStop?: () => void,
	 *   setStatus?: (msg: string, kind?: string) => void,
	 * }} opts
	 */
	constructor(opts) {
		this.host = opts.host;
		this.getRig = opts.getRig;
		this.onPreviewStart = opts.onPreviewStart || (() => {});
		this.onPreviewStop = opts.onPreviewStop || (() => {});
		this.setStatus = opts.setStatus || (() => {});

		/** @type {Array} curated manifest defs (with category) */
		this._defs = [];
		/** @type {Map<string, import('three').AnimationClip>} canonical clips by name */
		this._clipCache = new Map();
		/** @type {string} '' = all categories */
		this._filterCat = '';
		this._query = '';

		this._mixer = null;
		this._mixerRoot = null;
		this._action = null;
		this._activeName = null;
		this._activeDef = null;
		this._speed = 1;
		this._previewing = false;
		this._paused = false;
		this._scrubbing = false;
		this._state = 'loading';

		// Resolves once mount() has finished loading the manifest (success or
		// failure) — openByName() awaits this so a ?anim=<preset> deep-link works
		// even before the gallery has rendered.
		this._readyResolve = null;
		this._ready = new Promise((resolve) => {
			this._readyResolve = resolve;
		});

		// Text-to-animation job state (token-based abort like the forge panels).
		this._genToken = 0;
		this._genTimer = null;

		// Resolved DOM refs (built in _renderShell).
		this._refs = {};
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────
	async mount() {
		this._renderShell();
		this._setState('loading');
		try {
			const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const manifest = await res.json();
			if (!Array.isArray(manifest) || manifest.length === 0)
				throw new Error('empty manifest');
			this._curated = curate(manifest);
			this._defs = [
				this._curated.featured,
				this._curated.groups.flatMap((g) => g.items),
			].flat();
			this._buildCategoryChips();
			this._evaluateRig();
		} catch (err) {
			log.warn('[AnimationLibrary] manifest load failed:', err.message);
			this._setState('error-load');
		} finally {
			this._readyResolve?.();
		}
	}

	/**
	 * Open a preset by its manifest name and play it on the current rig. This is
	 * the ?anim= deep-link path for built-in library clips (keyed by name, e.g.
	 * "idle" or "av-boxer-dance") — the counterpart to PoseLibrary.openById() for
	 * saved community clips, which are keyed by API UUID. Waits for the manifest
	 * to finish loading first. Throws if no preset carries that name; when no
	 * compatible rig is loaded, preview() surfaces its own "load an avatar"
	 * guidance rather than throwing.
	 * @param {string} name  manifest clip name
	 */
	async openByName(name) {
		await this._ready;
		let def = this._defs.find((d) => d.name === name);
		if (!def) def = await this._lookupFullLibrary(name);
		if (!def) throw new Error(`No built-in animation named “${name}”`);
		return this.preview(def);
	}

	/**
	 * Resolve a full-library clip def by name. The /animations gallery
	 * deep-links R2-hosted clips (mx-* names) that aren't in the curated
	 * manifest; their defs carry an absolute CDN url that preview()/_loadClip()
	 * fetch like any other. Returns null when the library doesn't know the
	 * name either (including before the library has been uploaded).
	 * @param {string} name
	 */
	async _lookupFullLibrary(name) {
		try {
			const res = await fetch('/api/animations/library');
			if (!res.ok) return null;
			const data = await res.json();
			return (data.clips || []).find((d) => d.name === name) || null;
		} catch {
			return null;
		}
	}

	/** Called by the host when the active rig changes (avatar load / mannequin). */
	onRigChanged() {
		this._genToken++; // a generation in flight was for the previous rig
		this._stopGenTimer();
		this._setGenBusy(false);
		this.stopPreview({ silent: true });
		this._disposeMixer();
		if (this._defs.length) this._evaluateRig();
	}

	/** Tick the preview mixer. Host calls this from its render loop while previewing. */
	update(dt) {
		this._mixer?.update(dt);
		if (!this._scrubbing) this._syncProgress();
	}

	/** Push the active action's clock into the transport scrubber + time label. */
	_syncProgress() {
		const { transportScrub, transportTime } = this._refs;
		if (!transportScrub || !this._action) return;
		const clip = this._action.getClip?.();
		const dur = clip?.duration || 0;
		if (dur <= 0) return;
		// action.time wraps within [0, duration) for a looping action and clamps
		// for a one-shot, so it reads as clip-local position either way.
		const t = Math.max(0, Math.min(dur, this._action.time));
		transportScrub.value = String(Math.round((t / dur) * 1000));
		if (transportTime) transportTime.textContent = `${t.toFixed(1)} / ${dur.toFixed(1)}s`;
	}

	/** Seek the active clip to a 0..1 fraction and reflect it immediately. */
	_seek(frac) {
		if (!this._action) return;
		const dur = this._action.getClip?.().duration || 0;
		this._action.paused = false;
		this._action.time = Math.max(0, Math.min(0.999, frac)) * dur;
		this._mixer?.update(0);
		if (this._paused) this._action.paused = true;
	}

	/** Toggle play/pause on the live preview. */
	_togglePlay() {
		if (!this._action) return;
		this._paused = !this._paused;
		this._action.paused = this._paused;
		this._updatePlayIcon();
	}

	_updatePlayIcon() {
		const btn = this._refs.transportPlay;
		if (!btn) return;
		btn.textContent = this._paused ? '▶' : '⏸';
		btn.setAttribute('aria-label', this._paused ? 'Play' : 'Pause');
		btn.title = this._paused ? 'Play' : 'Pause';
	}

	isPreviewing() {
		return this._previewing;
	}

	dispose() {
		this._genToken++; // abort any in-flight generation poll
		this._stopGenTimer();
		this.stopPreview({ silent: true });
		this._disposeMixer();
		this._clipCache.clear();
		this.host.innerHTML = '';
	}

	// ── Rig capability ────────────────────────────────────────────────────────
	_rigBoneCount() {
		const rig = this.getRig();
		return rig?.getBones?.().length || 0;
	}

	// Presets target rigged GLB avatars. The primitive mannequin has no skinned
	// skeleton to export, so we steer the user to load a real avatar.
	_evaluateRig() {
		const rig = this.getRig();
		if (!rig || rig.kind === 'mannequin') return this._setState('no-rig');
		if (this._rigBoneCount() < MIN_RIG_BONES) return this._setState('incompatible');
		this._setState('ready');
		this._renderGallery();
	}

	// ── Shell + states ──────────────────────────────────────────────────────
	_renderShell() {
		this.host.innerHTML = '';

		// Generate-from-text: synthesize a brand-new motion from a prompt and play
		// it on the rig exactly like a preset. The capability the preset library
		// can't offer — motion that doesn't pre-exist.
		const genInput = el('input', {
			type: 'text',
			class: 'al-gen-input',
			placeholder: 'Generate a motion — “waving confidently”',
			'aria-label': 'Generate an animation from a text description',
			autocomplete: 'off',
			maxlength: '200',
		});
		const genBtn = el(
			'button',
			{ class: 'al-gen-btn', type: 'button', title: 'Generate a motion from your description' },
			['✨ Generate'],
		);
		const submitGen = () => this.generateFromText(genInput.value);
		genBtn.addEventListener('click', submitGen);
		genInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submitGen();
			}
		});
		const gen = el('div', { class: 'al-gen' }, [genInput, genBtn]);

		// Fingerspell: spell any word in ASL on the avatar's right hand. Built
		// locally and deterministically (src/fingerspelling.js) — no network,
		// instant, and the result exports like any other clip.
		const spellInput = el('input', {
			type: 'text',
			class: 'al-gen-input',
			placeholder: 'Fingerspell in ASL — try your name',
			'aria-label': 'Fingerspell a word in American Sign Language',
			autocomplete: 'off',
			maxlength: '40',
		});
		const spellBtn = el(
			'button',
			{ class: 'al-gen-btn', type: 'button', title: 'Spell the word letter by letter in American Sign Language' },
			['🤟 Spell'],
		);
		const submitSpell = () => this.spellWord(spellInput.value);
		spellBtn.addEventListener('click', submitSpell);
		spellInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submitSpell();
			}
		});
		const spell = el('div', { class: 'al-gen al-spell' }, [spellInput, spellBtn]);

		const search = el('input', {
			type: 'search',
			class: 'al-search',
			placeholder: 'Search animations…',
			'aria-label': 'Search animations',
			autocomplete: 'off',
		});
		search.addEventListener('input', () => {
			this._query = search.value.trim().toLowerCase();
			if (this._state === 'ready') this._renderGallery();
		});

		const chips = el('div', {
			class: 'al-chips',
			role: 'tablist',
			'aria-label': 'Animation categories',
		});
		const grid = el('div', { class: 'al-grid' });
		const empty = el('div', { class: 'al-empty' });

		// Shell refs first; _renderTransport() merges its own sub-refs (label,
		// speed, export button) into this._refs, so it must run after this assign.
		this._refs = { gen, genInput, genBtn, spell, spellInput, spellBtn, search, chips, grid, empty };
		const transport = this._renderTransport();
		this._refs.transport = transport;

		this.host.appendChild(gen);
		this.host.appendChild(spell);
		this.host.appendChild(search);
		// Now-playing transport sits directly under the search so it's visible the
		// moment a clip plays (hidden until then) — not buried below the card grid.
		this.host.appendChild(transport.root);
		this.host.appendChild(chips);
		this.host.appendChild(empty);
		this.host.appendChild(grid);
	}

	_setState(state) {
		this._state = state;
		const { gen, spell, search, chips, grid, empty, transport } = this._refs;
		const ready = state === 'ready';
		if (gen) gen.style.display = ready ? '' : 'none';
		if (spell) spell.style.display = ready ? '' : 'none';
		search.style.display = ready ? '' : 'none';
		chips.style.display = ready ? '' : 'none';
		grid.style.display = ready ? '' : 'none';
		transport.root.style.display = ready && this._activeName ? '' : 'none';
		empty.style.display = ready ? 'none' : '';

		if (ready) return;
		empty.innerHTML = '';
		const make = (icon, title, body, action) => {
			empty.appendChild(el('div', { class: 'al-empty-icon' }, [icon]));
			empty.appendChild(el('div', { class: 'al-empty-title' }, [title]));
			empty.appendChild(el('p', { class: 'al-empty-body' }, [body]));
			if (action) empty.appendChild(action);
		};
		if (state === 'loading') {
			empty.appendChild(
				el(
					'div',
					{ class: 'al-skeleton-grid' },
					Array.from({ length: 6 }, () => el('div', { class: 'al-skeleton' })),
				),
			);
		} else if (state === 'error-load') {
			const retry = el('button', { class: 'al-cta', type: 'button' }, ['Retry']);
			retry.addEventListener('click', () => this.mount());
			make(
				'⚠️',
				'Couldn’t load the animation library',
				'The clip manifest failed to load. Check your connection and try again.',
				retry,
			);
		} else if (state === 'no-rig') {
			const cta = el('button', { class: 'al-cta', type: 'button' }, ['Load a rigged avatar']);
			cta.addEventListener('click', () =>
				document.querySelector('#pose-load-avatar')?.click(),
			);
			make(
				'🦴',
				'Load a rigged avatar to animate',
				'Animation presets apply to a rigged model. Load one of your avatars (or a public avatar) and the full gallery unlocks here.',
				cta,
			);
		} else if (state === 'incompatible') {
			make(
				'🚫',
				'This rig can’t be retargeted',
				`The loaded model exposes only ${this._rigBoneCount()} recognizable humanoid bones — too few to drive the preset library. Try a standard humanoid avatar.`,
				null,
			);
		}
	}

	// ── Category chips ──────────────────────────────────────────────────────
	_buildCategoryChips() {
		const { chips } = this._refs;
		chips.innerHTML = '';
		const mk = (key, label) => {
			const b = el(
				'button',
				{
					class: 'al-chip',
					type: 'button',
					role: 'tab',
					'data-cat': key,
					'aria-selected': String(this._filterCat === key),
				},
				[label],
			);
			b.addEventListener('click', () => {
				this._filterCat = key;
				chips
					.querySelectorAll('.al-chip')
					.forEach((c) => c.setAttribute('aria-selected', String(c.dataset.cat === key)));
				this._renderGallery();
			});
			return b;
		};
		chips.appendChild(mk('', 'All'));
		for (const g of this._curated.groups) chips.appendChild(mk(g.key, `${g.icon} ${g.label}`));
	}

	// ── Gallery ─────────────────────────────────────────────────────────────
	_matches(def) {
		if (this._filterCat && def.category !== this._filterCat) return false;
		if (this._query) {
			const hay = `${def.label || ''} ${def.name}`.toLowerCase();
			if (!hay.includes(this._query)) return false;
		}
		return true;
	}

	_renderGallery() {
		const { grid } = this._refs;
		grid.innerHTML = '';

		// Featured row only when unfiltered and unsearched.
		if (!this._filterCat && !this._query && this._curated.featured.length) {
			grid.appendChild(el('div', { class: 'al-section-label' }, ['Featured']));
			const row = el('div', { class: 'al-cards' });
			for (const def of this._curated.featured) row.appendChild(this._card(def));
			grid.appendChild(row);
		}

		for (const group of this._curated.groups) {
			const items = group.items.filter((d) => this._matches(d));
			if (!items.length) continue;
			grid.appendChild(
				el('div', { class: 'al-section-label' }, [`${group.icon} ${group.label}`]),
			);
			const row = el('div', { class: 'al-cards' });
			for (const def of items) row.appendChild(this._card(def));
			grid.appendChild(row);
		}

		if (!grid.querySelector('.al-card')) {
			grid.appendChild(
				el('p', { class: 'al-no-match' }, [`No animations match “${this._query}”.`]),
			);
		}
	}

	_card(def) {
		const isActive = def.name === this._activeName;
		const card = el(
			'button',
			{
				class: `al-card${isActive ? ' is-active' : ''}`,
				type: 'button',
				'data-name': def.name,
				'aria-pressed': String(isActive),
				title: `${def.label || def.name}${def.loop === false ? '' : ' · loops'}`,
			},
			[
				el('span', { class: 'al-card-icon' }, [def.icon || '🎬']),
				el('span', { class: 'al-card-label' }, [def.label || def.name]),
				el('span', { class: 'al-card-badge' }, [def.loop === false ? 'once' : 'loop']),
				el('span', { class: 'al-card-eq', 'aria-hidden': 'true' }, [
					el('i'),
					el('i'),
					el('i'),
				]),
			],
		);
		card.addEventListener('click', () => this.preview(def));
		return card;
	}

	_markActiveCard() {
		this._refs.grid.querySelectorAll('.al-card').forEach((c) => {
			const on = c.dataset.name === this._activeName;
			c.classList.toggle('is-active', on);
			c.setAttribute('aria-pressed', String(on));
		});
	}

	// ── Preview ─────────────────────────────────────────────────────────────
	async _loadClip(def) {
		if (this._clipCache.has(def.name)) return this._clipCache.get(def.name);
		const res = await fetch(def.url, { cache: 'force-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const clip = parseClipJSON(await res.json(), def.name);
		this._clipCache.set(def.name, clip);
		return clip;
	}

	_ensureMixer(rig) {
		if (this._mixer && this._mixerRoot === rig.root) return this._mixer;
		this._disposeMixer();
		this._mixer = new AnimationMixer(rig.root);
		this._mixerRoot = rig.root;
		return this._mixer;
	}

	/** Load → retarget → play a preset on the current rig. */
	async preview(def) {
		const rig = this.getRig();
		if (!rig || rig.kind === 'mannequin') {
			this.setStatus('Load a rigged avatar to apply animations.', 'error');
			return;
		}
		this.setStatus(`Loading ${def.label || def.name}…`);
		let clip;
		try {
			clip = await this._loadClip(def);
		} catch (err) {
			this._clipCache.delete(def.name);
			this.setStatus(`Couldn’t load “${def.label || def.name}”: ${err.message}`, 'error');
			return;
		}
		this._playClip(clip, def);
	}

	/**
	 * Retarget an already-resolved canonical clip onto the current rig and play
	 * it. Shared by preset preview() and text-to-animation generateFromText() —
	 * one apply path, so a generated motion behaves exactly like a preset
	 * (transport, speed, loop, export all work identically). Returns true on play.
	 */
	_playClip(clip, def) {
		const rig = this.getRig();
		if (!rig || rig.kind === 'mannequin') {
			this.setStatus('Load a rigged avatar to apply animations.', 'error');
			return false;
		}

		const {
			clip: retargeted,
			matched,
			total,
			coverage,
			dropped,
		} = retargetClipToRig(clip, rig);
		if (!retargeted) {
			this.setStatus(
				`“${def.label || def.name}” can’t retarget to this rig — only ${matched}/${total} tracks mapped (need ${Math.round(MIN_COVERAGE * 100)}%).`,
				'error',
			);
			return false;
		}

		const mixer = this._ensureMixer(rig);
		mixer.stopAllAction();
		const action = mixer.clipAction(retargeted);
		action.setLoop(def.loop === false ? LoopOnce : LoopRepeat, Infinity);
		action.clampWhenFinished = def.loop === false;
		action.timeScale = this._speed;
		action.reset().play();
		this._paused = false;
		this._scrubbing = false;
		this._updatePlayIcon();

		this._action = action;
		this._activeName = def.name;
		this._activeDef = def;
		this._activeRetarget = { matched, total, coverage, dropped };

		if (!this._previewing) {
			this._previewing = true;
			this.onPreviewStart();
		}
		this._markActiveCard();
		this._updateTransport();
		this._refs.transport.root.style.display = '';

		const pct = Math.round(coverage * 100);
		const note = dropped.length
			? ` (${matched}/${total} bones · ${dropped.length} not on this rig)`
			: ` (${matched}/${total} bones matched)`;
		this.setStatus(`Playing “${def.label || def.name}” — ${pct}% retargeted${note}.`);
		return true;
	}

	// ── Generate from text ──────────────────────────────────────────────────
	/**
	 * Synthesize a brand-new motion from a prompt (workers/model-text2motion via
	 * /api/forge-motion), then retarget + play it through the same path as a
	 * preset. Token-based abort so a newer request supersedes an in-flight one.
	 */
	async generateFromText(prompt) {
		prompt = (prompt || '').trim();
		if (prompt.length < 3) {
			this.setStatus('Describe the motion in a few words first.', 'error');
			return;
		}
		const rig = this.getRig();
		if (!rig || rig.kind === 'mannequin') {
			this.setStatus('Load a rigged avatar before generating a motion.', 'error');
			return;
		}

		const token = ++this._genToken;
		this._setGenBusy(true);
		const t0 = performance.now();
		const tick = () => {
			if (token !== this._genToken) return;
			const s = Math.floor((performance.now() - t0) / 1000);
			this.setStatus(`Generating “${prompt}” — ${s}s`, 'busy');
		};
		tick();
		this._genTimer = setInterval(tick, 1000);

		try {
			const clipJSON = await this._runMotionJob(prompt, token);
			if (token !== this._genToken || !clipJSON) return; // superseded / aborted
			this._stopGenTimer();
			const name = `gen_${Date.now().toString(36)}`;
			const clip = parseClipJSON(clipJSON, name);
			this._clipCache.set(name, clip);
			const def = {
				name,
				label: prompt.length > 28 ? `${prompt.slice(0, 27)}…` : prompt,
				icon: '✨',
				loop: true,
				generated: true,
			};
			this._playClip(clip, def);
		} catch (err) {
			if (token !== this._genToken) return;
			this._stopGenTimer();
			const msg =
				err?.kind === 'unconfigured'
					? 'Text-to-animation isn’t enabled on this deployment yet.'
					: err?.message || 'Generation failed.';
			this.setStatus(msg, 'error');
		} finally {
			if (token === this._genToken) this._setGenBusy(false);
		}
	}

	/** Submit a motion job and poll until the clip JSON is ready. */
	async _runMotionJob(prompt, token) {
		const submit = await fetch('/api/forge-motion', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prompt }),
		});
		const sub = await submit.json().catch(() => ({}));
		if (submit.status === 503 || sub.error === 'unconfigured') {
			throw Object.assign(new Error(sub.message || 'unconfigured'), { kind: 'unconfigured' });
		}
		if (submit.status === 429) throw new Error('The motion generator is busy. Try again shortly.');
		if (!submit.ok || !sub.job_id) throw new Error(sub.message || `Generator returned ${submit.status}.`);

		const deadline = performance.now() + GEN_MAX_POLL_MS;
		while (token === this._genToken && performance.now() < deadline) {
			await sleep(GEN_POLL_INTERVAL_MS);
			if (token !== this._genToken) return null;
			const res = await fetch(`/api/forge-motion?job=${encodeURIComponent(sub.job_id)}`);
			const data = await res.json().catch(() => ({}));
			if (data.status === 'done' && data.clip_url) {
				const cr = await fetch(data.clip_url);
				if (!cr.ok) throw new Error(`Couldn’t fetch the generated clip (HTTP ${cr.status}).`);
				return cr.json();
			}
			if (data.status === 'failed') throw new Error(data.error || 'Generation failed.');
		}
		if (token !== this._genToken) return null;
		throw new Error('Generation timed out. Try a shorter prompt.');
	}

	// ── Fingerspell ─────────────────────────────────────────────────────────
	/**
	 * Spell a word in American Sign Language on the rig's right hand. The clip
	 * is built locally and deterministically (src/fingerspelling.js) and plays
	 * through the same retarget/transport path as a preset, so speed, scrub,
	 * and animated-GLB export all work on a spelled word. Returns true on play.
	 */
	spellWord(word) {
		const letters = normalizeWord(word);
		if (!letters) {
			this.setStatus('Type a word to fingerspell — letters and numbers.', 'error');
			return false;
		}
		// Reflect the (normalized) word in the input so deep links read back.
		if (this._refs.spellInput) this._refs.spellInput.value = letters;
		const rig = this.getRig();
		if (!rig || rig.kind === 'mannequin') {
			this.setStatus('Load a rigged avatar to fingerspell.', 'error');
			return false;
		}
		let clip;
		try {
			const json = buildFingerspellingClip(letters);
			clip = parseClipJSON(json, json.name);
			this._clipCache.set(json.name, clip);
		} catch (err) {
			this.setStatus(`Couldn’t build the spelling: ${err.message}`, 'error');
			return false;
		}
		const def = {
			name: clip.name,
			label: `Fingerspell “${letters}”`,
			icon: '🤟',
			loop: false,
			spelled: true,
		};
		return this._playClip(clip, def);
	}

	_stopGenTimer() {
		if (this._genTimer) {
			clearInterval(this._genTimer);
			this._genTimer = null;
		}
	}

	_setGenBusy(busy) {
		const { gen, genInput, genBtn } = this._refs;
		if (genInput) genInput.disabled = busy;
		if (genBtn) {
			genBtn.disabled = busy;
			genBtn.textContent = busy ? '✨ Generating…' : '✨ Generate';
		}
		if (gen) gen.dataset.busy = busy ? 'true' : 'false';
	}

	stopPreview({ silent = false } = {}) {
		if (!this._previewing && !this._activeName) return;
		this._mixer?.stopAllAction();
		this._action = null;
		this._activeName = null;
		this._activeDef = null;
		this._previewing = false;
		this._markActiveCard?.();
		if (this._refs.transport) this._refs.transport.root.style.display = 'none';
		// Hand the figure back to the host in a clean rest pose.
		try {
			this.getRig()?.resetPose?.();
		} catch {
			/* rig may be gone */
		}
		this.onPreviewStop();
		if (!silent) this.setStatus('Preview stopped.');
	}

	_setSpeed(v) {
		this._speed = Math.min(2.5, Math.max(0.25, v));
		if (this._action) this._action.timeScale = this._speed;
		this._updateTransport();
	}

	// ── Transport bar (now-playing + speed + loop + stop + export) ────────────
	_renderTransport() {
		const label = el('span', { class: 'al-now-label' });
		const speedVal = el('span', { class: 'al-speed-val' }, ['1.0×']);
		const speed = el('input', {
			type: 'range',
			min: '0.25',
			max: '2.5',
			step: '0.05',
			value: '1',
			class: 'al-speed',
			'aria-label': 'Playback speed',
		});
		speed.addEventListener('input', () => {
			this._setSpeed(parseFloat(speed.value));
		});
		const stop = el('button', { class: 'al-tbtn', type: 'button', title: 'Stop preview' }, [
			'⏹ Stop',
		]);
		stop.addEventListener('click', () => this.stopPreview());

		// Play/pause + scrubbable progress — the clip's own timeline, so users can
		// scrub to any frame, pause on a pose, and see how long the motion runs.
		const play = el('button', { class: 'al-play', type: 'button', title: 'Pause', 'aria-label': 'Pause' }, ['⏸']);
		play.addEventListener('click', () => this._togglePlay());
		const scrub = el('input', {
			type: 'range',
			min: '0',
			max: '1000',
			step: '1',
			value: '0',
			class: 'al-scrub',
			'aria-label': 'Scrub animation timeline',
		});
		const onScrub = () => {
			this._scrubbing = true;
			this._seek(parseInt(scrub.value, 10) / 1000);
		};
		scrub.addEventListener('input', onScrub);
		scrub.addEventListener('change', () => {
			this._scrubbing = false;
		});
		scrub.addEventListener('pointerup', () => {
			this._scrubbing = false;
		});
		const timeLabel = el('span', { class: 'al-time' }, ['0.0 / 0.0s']);

		const exportBtn = el(
			'button',
			{
				class: 'al-export',
				type: 'button',
				title: 'Download a GLB with this animation baked in',
			},
			['Export animated GLB'],
		);
		exportBtn.addEventListener('click', () => this._exportGLB(exportBtn));

		const root = el('div', { class: 'al-transport', style: 'display:none' }, [
			el('div', { class: 'al-now' }, [el('span', { class: 'al-now-dot' }), label]),
			el('div', { class: 'al-scrub-row' }, [play, scrub, timeLabel]),
			el('div', { class: 'al-speed-row' }, [el('label', {}, ['Speed']), speed, speedVal]),
			el('div', { class: 'al-transport-actions' }, [stop, exportBtn]),
		]);

		this._refs = {
			...this._refs,
			transportLabel: label,
			transportSpeedVal: speedVal,
			transportSpeed: speed,
			transportPlay: play,
			transportScrub: scrub,
			transportTime: timeLabel,
			exportBtn,
		};
		return { root };
	}

	_updateTransport() {
		const { transportLabel, transportSpeedVal, transportSpeed } = this._refs;
		if (transportLabel && this._activeDef) {
			transportLabel.textContent = this._activeDef.label || this._activeDef.name;
		}
		if (transportSpeedVal) transportSpeedVal.textContent = `${this._speed.toFixed(2)}×`;
		if (transportSpeed) transportSpeed.value = String(this._speed);
	}

	async _exportGLB(btn) {
		const rig = this.getRig();
		if (!rig || !this._activeDef) return;
		const original = btn.textContent;
		const done = (txt, cls) => {
			btn.classList.remove('is-busy', 'is-ok', 'is-err');
			if (cls) btn.classList.add(cls);
			btn.textContent = txt;
			setTimeout(() => {
				btn.classList.remove('is-ok', 'is-err');
				btn.textContent = original;
			}, 2400);
		};
		btn.classList.add('is-busy');
		btn.textContent = 'Baking…';
		try {
			const base = await this._loadClip(this._activeDef);
			const { clip } = retargetClipToRig(base, rig);
			if (!clip) throw new Error('retarget failed');
			const exportClip = scaleClipSpeed(clip, this._speed);
			exportClip.name = this._activeDef.name;

			// Park the figure on the clip's first frame so the exported rest pose
			// is the animation's start, not wherever the live preview paused.
			if (this._action) {
				this._action.time = 0;
				this._mixer.update(0);
			}

			const exporter = new GLTFExporter();
			const buffer = await exporter.parseAsync(rig.root, {
				binary: true,
				animations: [exportClip],
				embedImages: true,
			});
			const safeRig =
				(rig.root?.name || 'avatar').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40) ||
				'avatar';
			this._download(buffer, `${safeRig}-${this._activeDef.name}.glb`);
			done('Saved ✓', 'is-ok');
			this.setStatus(
				`Exported animated GLB: ${this._activeDef.label || this._activeDef.name}.`,
			);
		} catch (err) {
			log.warn('[AnimationLibrary] export failed:', err);
			done('Failed', 'is-err');
			this.setStatus(`Export failed: ${err.message}`, 'error');
		}
	}

	_download(buffer, filename) {
		const blob =
			buffer instanceof Blob ? buffer : new Blob([buffer], { type: 'model/gltf-binary' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1500);
	}

	_disposeMixer() {
		if (this._mixer) {
			this._mixer.stopAllAction();
			try {
				this._mixer.uncacheRoot(this._mixerRoot);
			} catch {
				/* root already gone */
			}
		}
		this._mixer = null;
		this._mixerRoot = null;
		this._action = null;
	}
}
