// director.js — the brain of the Feature Tour. It walks the curriculum stop by
// stop: for each one it finds the real on-page element to showcase, spotlights
// it, walks the guide avatar over to point at it, draws a beam from the avatar
// to the feature, speaks the narration, and — unless paused — advances. When
// the next stop lives on another route it persists progress and navigates; the
// tour re-hydrates from sessionStorage on the new page and picks up exactly
// where it left off. One module owns all of that sequencing and every control.
//
// Navigation is expressed over a *playlist* — the ordered list of stop indices
// the chosen track visits (the Full track is every stop; the Quick track is the
// highlighted heroes). `pos` is where we are in that playlist; `index` is the
// absolute curriculum stop it points at. Switching tracks re-derives the
// playlist and re-anchors `pos` to the nearest stop, so the tour never loses its
// place. The chapter panel can jump to any stop, expanding to the Full track if
// the requested stop isn't in the current one.

import {
	loadCurriculum,
	readState,
	writeState,
	clearState,
	readResume,
	markCompleted,
	buildPlaylist,
	normalizePath,
	stopIndexForPath,
	sectionTitle,
} from './curriculum.js';
import { GuideAvatar } from './guide-avatar.js';
import { Spotlight } from './spotlight.js';
import { Narrator } from './narrator.js';
import { TourControls } from './controls.js';
import { ChapterPanel } from './chapters.js';
import { FreeRoam } from './free-roam.js';

const ADVANCE_BEAT_MS = 900; // pause between finishing a stop and moving on
const Z_BEAM = 2147483280;
const SPEED_CYCLE = [1, 1.25, 1.5, 0.75];

export class TourDirector {
	constructor() {
		this.curriculum = null;
		this.playlist = [];
		this.pos = 0;
		this.index = 0;
		this.track = 'full';
		this.paused = false;
		this.muted = false;
		this.voice = 'nova';
		this.speed = 1;
		this.mounted = false;
		this.offRoute = false;
		this.roam = false;
		this._runToken = 0;
		this._advanceTimer = 0;
		this._seenSections = new Set();
		this._beamRaf = 0;
		this._beamActive = false;
		this._soundNudge = null;
		this._onKey = this._onKey.bind(this);
		this._onUnlockGesture = this._onUnlockGesture.bind(this);
	}

	// ── Entry points ──────────────────────────────────────────────────────────

	// Begin a fresh tour from the very first stop (called by the "Start tour"
	// button / ?tour=start). `track` chooses Quick vs Full; voice/speed default to
	// the visitor's remembered preferences. Navigates to stop 0's page if needed.
	async start(track) {
		this._showLoading();
		await this._ensureCurriculum();
		const prefs = readResume();
		this.track = track || 'full';
		this.voice = prefs.voice || 'nova';
		this.speed = prefs.speed || 1;
		this.muted = false;
		this.paused = false;
		this._seenSections = new Set();
		this.playlist = buildPlaylist(this.curriculum, this.track);
		this.pos = 0;
		this.index = this.playlist[0] ?? 0;
		// Record that the account was actually offered the onboarding tour, so
		// the server-side auto-start check (api/me.js `show_onboarding_tour`)
		// never re-triggers it — even if the visitor abandons this run before
		// the completion card fires.
		if (this.track === 'onboarding') this._reportOnboardingProgress('seen');
		writeState({
			active: true,
			index: this.index,
			track: this.track,
			voice: this.voice,
			speed: this.speed,
			paused: false,
			muted: false,
		});
		const first = this.curriculum.stops[this.index];
		if (normalizePath(first.path) !== normalizePath()) {
			this._navigate(first.path);
			return;
		}
		await this._mount();
		this._runCurrent();
	}

	// Re-hydrate on a normal page load when a tour is already in progress.
	async resume() {
		const state = readState();
		if (!state.active) return;
		this._showLoading();
		await this._ensureCurriculum();
		this.paused = state.paused;
		this.muted = state.muted;
		this.voice = state.voice || 'nova';
		this.speed = state.speed || 1;
		this.track = state.track || 'full';
		this.playlist = buildPlaylist(this.curriculum, this.track);

		const here = stopIndexForPath(this.curriculum, location.pathname, this.playlist);
		// Clamp the persisted index to the live curriculum: a curriculum that lost
		// stops between deploys could otherwise point past the end and silently
		// finish the tour on resume.
		const wanted = Math.min(Math.max(0, state.index || 0), this.curriculum.stops.length - 1);
		if (normalizePath(this.curriculum.stops[wanted]?.path) === normalizePath()) {
			this.index = wanted; // arrived exactly where we were heading
			this.offRoute = false;
		} else if (here >= 0) {
			this.index = here; // visitor hand-navigated to another stop's page
			this.offRoute = false;
			writeState({ index: here });
		} else {
			this.index = wanted; // wandered off the route entirely
			this.offRoute = true;
		}
		this.pos = this._posForAbs(this.index);

		await this._mount();
		if (this.offRoute) {
			this._showOffRoute();
		} else {
			this._runCurrent();
		}
	}

	async _ensureCurriculum() {
		if (!this.curriculum) this.curriculum = await loadCurriculum();
	}

	// ── Mounting ──────────────────────────────────────────────────────────────
	async _mount() {
		if (this.mounted) return;
		this.mounted = true;
		// The site-wide corner companion is the same kind of avatar — during the
		// tour it would just be a second body on screen, so stand it down (and its
		// click-to-walk, which would otherwise fight free roam) and bring it back
		// when the tour ends.
		this._suppressCompanion();
		this._buildBeam();
		this.spotlight = new Spotlight();
		this.narrator = new Narrator();
		// On touch browsers audio is gated behind a gesture (and that permission
		// dies on every navigation the tour makes). Arm a one-time unlock on the
		// first tap of this page, and show a "tap for voice" cue if a clip is
		// blocked before then.
		this.narrator.onBlocked = () => this._showSoundNudge();
		this._armAudioUnlock();
		this.avatar = new GuideAvatar();
		await this.avatar.mount();
		this.freeRoam = new FreeRoam(this.avatar);
		this.controls = new TourControls({
			onMenu: () => this.panel?.toggle(),
			onPrev: () => this._go(this.pos - 1),
			onNext: () => this._go(this.pos + 1),
			onToggle: () => this._togglePause(),
			onSeek: (i) => this._go(i),
			onSpeed: () => this._cycleSpeed(),
			onRoam: () => this._toggleRoam(),
			onMute: () => this._toggleMute(),
			onExit: () => this.exit(),
		});
		this.panel = new ChapterPanel(
			this.curriculum,
			{
				onJump: (abs) => this._jumpToAbs(abs),
				onTrack: (t) => this._applyTrack(t),
				onSpeed: (v) => this._setSpeed(v),
				onVoice: (v) => this._setVoice(v),
				onAvatar: (entry) => this._setAvatar(entry),
				onOpenChange: (open) => this.controls.setMenuOpen(open),
			},
			{
				avatars: this.avatar.avatars(),
				currentId: this.avatar.currentAvatarId(),
				docsUrl: '/avatar-studio',
			},
		);
		this.controls.setMuted(this.muted);
		this.controls.setPaused(this.paused);
		this.controls.setSpeed(this.speed);
		this.panel.setTrack(this.track);
		this.panel.setSpeed(this.speed);
		this.panel.setVoice(this.voice);
		document.addEventListener('keydown', this._onKey);
		this._hideLoading();
	}

	// ── Running a stop ────────────────────────────────────────────────────────
	async _runCurrent() {
		const token = ++this._runToken;
		clearTimeout(this._advanceTimer);
		this.offRoute = false;
		const stop = this.curriculum.stops[this.index];
		if (!stop) return this._finish();

		this._syncControls();
		this.panel?.setActive(this.index);
		writeState({ index: this.index });

		// Chapter bridge — spoken once per section per session.
		if (stop.sectionIntro && !this._seenSections.has(stop.section)) {
			this._seenSections.add(stop.section);
			await this.avatar.park();
			if (token !== this._runToken) return;
			this.avatar.point();
			await this._present(stop.sectionIntro, token);
			if (token !== this._runToken) return;
		}

		// Move to the feature and point at it.
		const target = this._resolveTarget(stop);
		if (target) {
			await this.spotlight.highlight(target);
			if (token !== this._runToken) return;
			await this.avatar.approach(this.spotlight.getRect() || rectOf(target));
			if (token !== this._runToken) return;
			this._startBeam();
		} else {
			this.spotlight.highlight(null);
			this._stopBeam();
			await this.avatar.park();
			if (token !== this._runToken) return;
		}
		this.avatar.point();

		await this._narrateAndMaybeAdvance(token);
	}

	async _narrateAndMaybeAdvance(token) {
		await this._present(this.curriculum.stops[this.index].narration, token);
		if (token !== this._runToken) return;
		if (this.paused) return;
		this._advanceTimer = setTimeout(() => {
			if (token === this._runToken) this._advance();
		}, ADVANCE_BEAT_MS / this.speed);
	}

	// Show caption + speak; resolves when the voice (or timed fallback) ends.
	async _present(text, token) {
		this.avatar.say(text);
		// Surface the unlock cue up front (not after a blocked play() round-trip) so
		// a phone visitor knows one tap brings the voice.
		if (!this.muted && this.narrator.needsUnlock()) this._showSoundNudge();
		await this.narrator.speak(text, { muted: this.muted, voice: this.voice, speed: this.speed });
	}

	_advance() {
		if (this.pos + 1 >= this.playlist.length) return this._finish();
		this._go(this.pos + 1);
	}

	// Go to a playlist position (prev / next / scrub / advance / jump). Cancels
	// anything in flight, then runs the stop here or navigates if it's off-page.
	_go(pos) {
		if (!this.playlist.length) return;
		if (this.roam) {
			// Any explicit navigation leaves free roam and resumes the guided tour.
			this.roam = false;
			this.freeRoam?.disable();
			this.controls?.setRoam(false);
		}
		const clamped = Math.max(0, Math.min(this.playlist.length - 1, pos));
		this._runToken++;
		clearTimeout(this._advanceTimer);
		this.narrator?.cancel();
		this.pos = clamped;
		this.index = this.playlist[clamped];
		writeState({ index: this.index });
		this.panel?.setActive(this.index);
		const stop = this.curriculum.stops[this.index];
		if (normalizePath(stop.path) === normalizePath()) {
			this._runCurrent();
		} else {
			this._navigate(stop.path);
		}
	}

	// Jump to an absolute curriculum stop from the chapter panel. If it isn't in
	// the current track's playlist, switch to whichever track actually contains
	// it — the Onboarding track for an onboarding-section stop (its own,
	// disjoint playlist — see buildPlaylist), or the Full track for everything
	// else — so every stop stays reachable from the chapter map regardless of
	// which track the visitor started on.
	_jumpToAbs(abs) {
		if (this.playlist.indexOf(abs) < 0) {
			const target = this.curriculum.stops[abs]?.section === 'onboarding' ? 'onboarding' : 'full';
			this._applyTrack(target, { silent: true });
		}
		this._go(this._posForAbs(abs));
	}

	_togglePause() {
		if (this.roam) return this._exitRoam(); // play rejoins the tour from roam
		this.paused = !this.paused;
		writeState({ paused: this.paused });
		this.controls.setPaused(this.paused);
		if (this.paused) {
			clearTimeout(this._advanceTimer);
			this.narrator.cancel();
			this._runToken++; // freeze the current sequence
		} else if (this.offRoute) {
			this._go(this.pos);
		} else {
			// Resume re-narrates the current stop, then continues.
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	_toggleMute() {
		this.muted = !this.muted;
		writeState({ muted: this.muted });
		this.controls.setMuted(this.muted);
		this.narrator.cancel();
		if (!this.paused && !this.roam) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	// ── Mobile audio unlock ─────────────────────────────────────────────────────
	// iOS/Android gate audio behind a user gesture, and the permission resets on
	// every page the tour navigates to. We bless the narrator's audio element on
	// the first tap of each page; until then a clip plays as a timed caption.
	_armAudioUnlock() {
		if (!this.narrator?.needsUnlock()) return; // desktop or already unlocked
		document.addEventListener('pointerdown', this._onUnlockGesture, true);
		document.addEventListener('touchend', this._onUnlockGesture, true);
	}

	_disarmAudioUnlock() {
		document.removeEventListener('pointerdown', this._onUnlockGesture, true);
		document.removeEventListener('touchend', this._onUnlockGesture, true);
	}

	async _onUnlockGesture() {
		const ok = await this.narrator.unlock();
		if (!ok) return; // that gesture wasn't enough — keep listening for the next
		this._disarmAudioUnlock();
		this._hideSoundNudge();
		// Re-speak the current stop now that we have a voice, so unlocking mid-caption
		// doesn't cost the visitor this stop's narration.
		if (this.mounted && !this.paused && !this.offRoute && !this.roam) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	_showSoundNudge() {
		if (this._soundNudge || !this.narrator?.needsUnlock()) return;
		ensureNudgeStyles();
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'tws-tour-soundcue';
		chip.setAttribute('aria-label', "Tap to hear the guide's voice");
		chip.innerHTML = '<span class="tws-tour-soundcue__icon" aria-hidden="true">🔊</span> Tap for the guide’s voice';
		chip.addEventListener('click', () => this._onUnlockGesture());
		document.body.appendChild(chip);
		requestAnimationFrame(() => chip.classList.add('is-in'));
		this._soundNudge = chip;
	}

	_hideSoundNudge() {
		const chip = this._soundNudge;
		if (!chip) return;
		this._soundNudge = null;
		chip.classList.remove('is-in');
		setTimeout(() => chip.remove(), 300);
	}

	// ── Track / speed / voice ───────────────────────────────────────────────────
	_applyTrack(track, { silent = false } = {}) {
		if (track === this.track) return;
		const abs = this.index;
		this.track = track;
		this.playlist = buildPlaylist(this.curriculum, track);
		this.pos = this._posForAbs(abs);
		this.index = this.playlist[this.pos];
		writeState({ track, index: this.index });
		this.panel?.setTrack(track);
		this._syncControls();
		if (!silent) this._go(this.pos); // re-anchor to the (possibly new) stop
	}

	_cycleSpeed() {
		const i = SPEED_CYCLE.indexOf(this.speed);
		this._setSpeed(SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length]);
	}

	_setSpeed(value) {
		const next = Math.min(2, Math.max(0.5, Number(value) || 1));
		if (next === this.speed) return;
		this.speed = next;
		writeState({ speed: next });
		this.controls?.setSpeed(next);
		this.panel?.setSpeed(next);
		// Re-narrate the current stop at the new rate if we're actively playing.
		if (!this.paused && !this.offRoute && !this.roam && this.mounted) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	_setVoice(value) {
		if (!value || value === this.voice) return;
		this.voice = value;
		writeState({ voice: value });
		this.panel?.setVoice(value);
		if (!this.paused && !this.offRoute && !this.roam && this.mounted) {
			const token = ++this._runToken;
			this._narrateAndMaybeAdvance(token);
		}
	}

	// Swap the guide to any avatar the visitor picks. The guide persists the choice
	// (shared with the site-wide Walk Companion) and resolves to the entry actually
	// shown — the fallback if the pick failed to load — which we echo back to the
	// panel so its button and the picker's check mark stay truthful.
	async _setAvatar(entry) {
		const shown = await this.avatar.setAvatar(entry);
		if (shown?.id) this.panel?.setAvatarCurrent(shown.id);
	}

	// ── Free roam ───────────────────────────────────────────────────────────────
	// Hand the stage to the visitor: freeze the guided sequence and let them drive
	// the guide around the page (free-roam.js). Toggling off — or any navigation /
	// play — rejoins the tour at the current stop.
	_toggleRoam() {
		this.roam ? this._exitRoam() : this._enterRoam();
	}

	_enterRoam() {
		if (this.roam) return;
		this.roam = true;
		this._runToken++; // freeze whatever the guide was doing
		clearTimeout(this._advanceTimer);
		this.narrator?.cancel();
		this._stopBeam();
		this.spotlight?.highlight(null);
		this.avatar?.hideBubble();
		this.panel?.close();
		this.controls?.setRoam(true);
		this.freeRoam?.enable();
	}

	_exitRoam() {
		if (!this.roam) return;
		this.roam = false;
		this.freeRoam?.disable();
		this.controls?.setRoam(false);
		// Rejoining the tour means playing again from the current stop.
		this.paused = false;
		this.controls?.setPaused(false);
		writeState({ paused: false });
		this._go(this.pos);
	}

	// ── Corner-companion suppression (de-dupe the on-screen avatar) ──────────────
	_suppressCompanion() {
		const w = window.__walkCompanion;
		if (!w) return;
		this._companionWasOn = !!(w.instance?.mounted || (w.isEnabled && w.isEnabled()));
		const hide = () => {
			try {
				if (w.instance?.mounted) w.instance.unmount();
			} catch {
				/* companion mid-mount — the change listener will catch it */
			}
		};
		hide();
		// The companion auto-mounts on load (and on playground return); re-hide it
		// whenever it reappears while the tour owns the screen.
		this._onCompanionChange = hide;
		window.addEventListener('walk-companion:change', this._onCompanionChange);
	}

	_restoreCompanion() {
		if (this._onCompanionChange) {
			window.removeEventListener('walk-companion:change', this._onCompanionChange);
			this._onCompanionChange = null;
		}
		const w = window.__walkCompanion;
		if (!w || !this._companionWasOn) return;
		try {
			if (!w.instance?.mounted) (w.instance ? w.instance.mount() : w.enable?.());
		} catch {
			/* non-fatal — the companion will re-mount on the next page load */
		}
	}

	// Playlist position for an absolute stop index — exact match, else nearest.
	_posForAbs(abs) {
		const p = this.playlist.indexOf(abs);
		if (p >= 0) return p;
		let best = 0;
		let bestD = Infinity;
		this.playlist.forEach((a, i) => {
			const d = Math.abs(a - abs);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		});
		return best;
	}

	// ── Off-route recovery ────────────────────────────────────────────────────
	_showOffRoute() {
		this._stopBeam();
		this.spotlight.highlight(null);
		this.avatar.park();
		this.paused = true;
		writeState({ paused: true });
		this.controls.setPaused(true);
		this._syncControls();
		this.panel?.setActive(this.index);
		this.avatar.say('We stepped off the tour — press play and I’ll take you back to where we were.');
	}

	// ── Finish ────────────────────────────────────────────────────────────────
	async _finish() {
		const token = ++this._runToken;
		this._stopBeam();
		this.spotlight.highlight(null);
		await this.avatar.park();
		this.avatar.point();
		const isOnboarding = this.track === 'onboarding';
		const outro = isOnboarding
			? "And that's the loop — avatar, world, markets, and now your own profile with your first creation on it. Everything you make from here shows up right there. Go make something else."
			: "And that's the whole platform. You've seen how to build an agent, give it a body and a voice, take it on-chain, and put it to work. Go make something — I'll be around if you want to walk it again.";
		await this._present(outro, token);
		if (token !== this._runToken) return; // exited / navigated while the outro played
		markCompleted();
		clearState();
		if (isOnboarding) this._reportOnboardingProgress('completed');
		this._showCompletion();
	}

	// Persists onboarding-tour progress server-side (api/me.js) so the
	// account-linked "should we auto-offer the tour" decision survives across
	// browsers/devices, not just this browser's localStorage. Best-effort and
	// silent on failure — the tour's own UX never depends on this succeeding,
	// and a signed-out visitor (401) simply doesn't get server-side tracking.
	_reportOnboardingProgress(flag) {
		try {
			fetch('/api/me', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ onboarding_tour: flag }),
				keepalive: true,
			}).catch(() => {});
		} catch {
			/* fetch unavailable / blocked — server-side tracking simply skips */
		}
	}

	_showCompletion() {
		const isOnboarding = this.track === 'onboarding';
		const card = document.createElement('div');
		card.className = 'tws-tour-done';
		card.innerHTML = isOnboarding
			? `
			<div class="tws-tour-done__inner" role="dialog" aria-label="Onboarding complete">
				<div class="tws-tour-done__title">You're set up 🎉</div>
				<p class="tws-tour-done__body">Avatar made, world built, markets seen, profile live. Ready to take it on-chain?</p>
				<div class="tws-tour-done__actions">
					<a class="tws-tour-done__btn tws-tour-done__btn--primary" href="/create-agent">Launch a coin</a>
					<a class="tws-tour-done__btn" href="/profile">See my profile</a>
					<button class="tws-tour-done__btn" data-act="close">I'm good for now</button>
				</div>
			</div>`
			: `
			<div class="tws-tour-done__inner" role="dialog" aria-label="Tour complete">
				<div class="tws-tour-done__title">Tour complete 🎉</div>
				<p class="tws-tour-done__body">You've walked the whole of three.ws. Where to next?</p>
				<div class="tws-tour-done__actions">
					<a class="tws-tour-done__btn tws-tour-done__btn--primary" href="/create-agent">Build your agent</a>
					<button class="tws-tour-done__btn" data-act="restart">Walk it again</button>
					<button class="tws-tour-done__btn" data-act="close">Explore on my own</button>
				</div>
			</div>`;
		ensureDoneStyles();
		document.body.appendChild(card);
		requestAnimationFrame(() => card.classList.add('is-in'));
		card.addEventListener('click', (e) => {
			const act = e.target.closest('[data-act]')?.dataset.act;
			if (act === 'restart') {
				// Tear the finished tour fully down before starting a fresh one —
				// otherwise _mount()'s `if (this.mounted) return` makes restart a
				// no-op that reuses the old, half-cleared avatar and listeners.
				this.exit();
				this.start(this.track);
			} else if (act === 'close') {
				card.remove();
				this.exit();
			}
		});
		this._doneCard = card;
	}

	// A lightweight, honest loading state shown while the curriculum manifest and
	// the guide GLB stream in — no fake progress bar, just a live "preparing" cue
	// that clears the moment the real assets are mounted (or the load gives up).
	_showLoading() {
		if (this._loadingEl) return;
		// bootstrap() can fire (via ?tour=/resume) before <body> is parsed — appending
		// to a null document.body threw "Cannot read properties of null (reading
		// 'appendChild')". Defer to DOMContentLoaded once, then mount normally.
		if (typeof document === 'undefined' || !document.body) {
			if (typeof document !== 'undefined') {
				document.addEventListener('DOMContentLoaded', () => this._showLoading(), { once: true });
			}
			return;
		}
		ensureLoadingStyles();
		const el = document.createElement('div');
		el.className = 'tws-tour-loading';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.innerHTML = `
			<div class="tws-tour-loading__inner">
				<div class="tws-tour-loading__orb" aria-hidden="true"></div>
				<div class="tws-tour-loading__label">Waking your guide…</div>
			</div>`;
		document.body.appendChild(el);
		requestAnimationFrame(() => el.classList.add('is-in'));
		this._loadingEl = el;
	}

	_hideLoading() {
		const el = this._loadingEl;
		if (!el) return;
		this._loadingEl = null;
		el.classList.remove('is-in');
		const drop = () => el.remove();
		el.addEventListener('transitionend', drop, { once: true });
		this._loadingDrop = setTimeout(drop, 600); // fallback if transitionend never fires
	}

	// ── Teardown ──────────────────────────────────────────────────────────────
	exit() {
		this._runToken++;
		clearTimeout(this._advanceTimer);
		clearState();
		this._stopBeam();
		this._beam?.remove();
		this._disarmAudioUnlock();
		this._hideSoundNudge();
		document.removeEventListener('keydown', this._onKey);
		this.roam = false;
		this.freeRoam?.disable();
		this.narrator?.dispose();
		this.spotlight?.dispose();
		this.avatar?.dispose();
		this.controls?.dispose();
		this.panel?.dispose();
		this._doneCard?.remove();
		clearTimeout(this._loadingDrop);
		this._loadingEl?.remove();
		this._loadingEl = null;
		this._restoreCompanion();
		this.mounted = false;
	}

	// ── Target resolution ─────────────────────────────────────────────────────
	_resolveTarget(stop) {
		const selectors = [
			...(stop.targets || []),
			'[data-tour-target]',
			'main h1, .hero h1, h1',
			'a.cta, .btn-primary, button[type="submit"], main a.button, .hero a',
		];
		for (const sel of selectors) {
			let el;
			try {
				el = document.querySelector(sel);
			} catch {
				continue;
			}
			if (isVisible(el)) return el;
		}
		return null;
	}

	// ── Pointer beam (avatar → feature) ───────────────────────────────────────
	_buildBeam() {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 'tws-tour-beam');
		svg.style.cssText = `position:fixed;inset:0;width:100vw;height:100vh;z-index:${Z_BEAM};pointer-events:none;opacity:0;transition:opacity .3s ease`;
		svg.innerHTML = `
			<defs>
				<marker id="tws-tour-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M0,0 L10,5 L0,10 z" fill="rgba(122,162,255,.95)"/>
				</marker>
			</defs>
			<line class="tws-tour-beam__line" stroke="rgba(122,162,255,.9)" stroke-width="2.5" stroke-dasharray="2 7" stroke-linecap="round" marker-end="url(#tws-tour-arrow)"/>
		`;
		document.body.appendChild(svg);
		this._beam = svg;
		this._beamLine = svg.querySelector('.tws-tour-beam__line');
	}

	_startBeam() {
		if (this._beamActive) return;
		this._beamActive = true;
		this._beam.style.opacity = '1';
		const tick = () => {
			if (!this._beamActive) return;
			const rect = this.spotlight.getRect();
			const head = this.avatar.headScreen();
			if (rect && head) {
				// Aim at the nearest edge of the feature, not dead-center, so the
				// arrow lands on the box rather than burying itself inside it.
				const tx = clamp(head.x, rect.left, rect.left + rect.width);
				const ty = clamp(head.y, rect.top, rect.top + rect.height);
				this._beamLine.setAttribute('x1', head.x);
				this._beamLine.setAttribute('y1', head.y);
				this._beamLine.setAttribute('x2', tx);
				this._beamLine.setAttribute('y2', ty);
			}
			this._beamRaf = requestAnimationFrame(tick);
		};
		this._beamRaf = requestAnimationFrame(tick);
	}

	_stopBeam() {
		this._beamActive = false;
		cancelAnimationFrame(this._beamRaf);
		if (this._beam) this._beam.style.opacity = '0';
	}

	// ── Misc ──────────────────────────────────────────────────────────────────
	_syncControls() {
		const stop = this.curriculum.stops[this.index];
		this.controls.update({
			chapter: sectionTitle(this.curriculum, stop.section),
			index: this.pos,
			total: this.playlist.length,
		});
	}

	_navigate(path) {
		// Progress is already persisted; the new page's bootstrap calls resume().
		location.assign(path);
	}

	_onKey(e) {
		if (this.panel?.open) return; // the panel owns the keyboard while it's up
		if (isTypingTarget(e.target)) return;
		// In free roam the visitor steers the guide with WASD / arrows — free-roam
		// owns those keys; here we only let them toggle roam off or escape it.
		if (this.roam) {
			if (e.key === 'r' || e.key === 'R') this._toggleRoam();
			else if (e.key === 'Escape') this._exitRoam();
			return;
		}
		if (e.key === ' ' || e.key === 'k') {
			e.preventDefault();
			this._togglePause();
		} else if (e.key === 'ArrowRight') {
			this._go(this.pos + 1);
		} else if (e.key === 'ArrowLeft') {
			this._go(this.pos - 1);
		} else if (e.key === 'm' || e.key === 'M') {
			this._toggleMute();
		} else if (e.key === 'c' || e.key === 'C') {
			this.panel?.toggle();
		} else if (e.key === 'r' || e.key === 'R') {
			this._toggleRoam();
		} else if (e.key === 'Escape') {
			if (this.roam) this._exitRoam();
			else this.exit();
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}
function rectOf(el) {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}
function isVisible(el) {
	if (!el || !el.isConnected) return false;
	const r = el.getBoundingClientRect();
	if (r.width < 4 || r.height < 4) return false;
	const style = getComputedStyle(el);
	return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}
function isTypingTarget(el) {
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

let _nudgeStyles = false;
function ensureNudgeStyles() {
	if (_nudgeStyles) return;
	_nudgeStyles = true;
	const style = document.createElement('style');
	style.textContent = `
.tws-tour-soundcue{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 16px);transform:translateX(-50%) translateY(-12px);z-index:2147483450;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:10px 18px;border:1px solid rgba(122,162,255,.45);border-radius:99px;background:rgba(14,16,22,.94);backdrop-filter:blur(10px);color:#eaf0ff;font:700 14px/1 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5);cursor:pointer;opacity:0;transition:opacity .3s ease,transform .3s ease;-webkit-tap-highlight-color:transparent;animation:tws-soundcue-pulse 1.8s ease-in-out infinite}
.tws-tour-soundcue.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.tws-tour-soundcue:active{transform:translateX(-50%) translateY(0) scale(.96)}
.tws-tour-soundcue__icon{font-size:16px}
@keyframes tws-soundcue-pulse{0%,100%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 0 rgba(122,162,255,.45)}50%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 7px rgba(122,162,255,0)}}
@media (prefers-reduced-motion:reduce){.tws-tour-soundcue{animation:none;transition:opacity .2s ease}}
`;
	document.head.appendChild(style);
}

let _doneStyles = false;
function ensureDoneStyles() {
	if (_doneStyles) return;
	_doneStyles = true;
	const style = document.createElement('style');
	style.textContent = `
.tws-tour-done{position:fixed;inset:0;z-index:2147483500;display:grid;place-items:center;background:rgba(6,8,12,.6);backdrop-filter:blur(6px);opacity:0;transition:opacity .35s ease;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.tws-tour-done.is-in{opacity:1}
.tws-tour-done__inner{background:#11141c;border:1px solid rgba(122,162,255,.25);border-radius:20px;padding:28px 30px;max-width:380px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.tws-tour-done__title{font-size:22px;font-weight:700;color:#f2f4f8;margin-bottom:8px}
.tws-tour-done__body{color:#aeb6c6;font-size:14px;line-height:1.5;margin:0 0 20px}
.tws-tour-done__actions{display:flex;flex-direction:column;gap:10px}
.tws-tour-done__btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#eef1f6;padding:11px 16px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;display:block;transition:background .18s ease,border-color .18s ease}
.tws-tour-done__btn:hover{background:rgba(255,255,255,.1)}
.tws-tour-done__btn--primary{background:linear-gradient(90deg,#7aa2ff,#9d7bff);color:#0b0e16;border-color:transparent}
.tws-tour-done__btn--primary:hover{filter:brightness(1.06)}
`;
	document.head.appendChild(style);
}

let _loadingStyles = false;
function ensureLoadingStyles() {
	if (_loadingStyles) return;
	_loadingStyles = true;
	const style = document.createElement('style');
	style.textContent = `
.tws-tour-loading{position:fixed;inset:0;z-index:2147483400;display:grid;place-items:center;background:rgba(6,8,12,.55);backdrop-filter:blur(5px);opacity:0;transition:opacity .3s ease;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.tws-tour-loading.is-in{opacity:1}
.tws-tour-loading__inner{display:flex;flex-direction:column;align-items:center;gap:16px}
.tws-tour-loading__orb{width:54px;height:54px;border-radius:50%;background:conic-gradient(from 0deg,#7aa2ff,#9d7bff,#7aa2ff);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 0);mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 0);animation:tws-tour-spin 1s linear infinite}
.tws-tour-loading__label{color:#cdd5e6;font-size:14px;font-weight:600;letter-spacing:.01em}
@keyframes tws-tour-spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.tws-tour-loading{transition:none}.tws-tour-loading__orb{animation-duration:2.4s}}
`;
	document.head.appendChild(style);
}
