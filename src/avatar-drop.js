import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function initAvatarDrop(sectionEl) {
	const canvas  = sectionEl.querySelector('#drop-canvas');
	const sitLine = sectionEl.querySelector('#drop-sit-line');
	const ctaBtn  = sectionEl.querySelector('#drop-cta-btn');
	if (!canvas || !sitLine || !ctaBtn) return;

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.1;

	const scene = new THREE.Scene();

	let PX_PER_UNIT = 120;
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
	camera.position.z = 10;

	function updateFrustum() {
		PX_PER_UNIT = window.innerWidth < 640 ? 92 : 120;
		const rect = sectionEl.getBoundingClientRect();
		const hw = rect.width  / PX_PER_UNIT / 2;
		const hh = rect.height / PX_PER_UNIT / 2;
		camera.left = -hw; camera.right  = hw;
		camera.top  =  hh; camera.bottom = -hh;
		camera.updateProjectionMatrix();
	}

	const _v3 = new THREE.Vector3();
	function domToWorld(screenX, screenY) {
		const rect = sectionEl.getBoundingClientRect();
		_v3.set(
			((screenX - rect.left) / rect.width)  *  2 - 1,
			-((screenY - rect.top) / rect.height) *  2 + 1,
			0
		);
		_v3.unproject(camera);
		return { x: _v3.x, y: _v3.y };
	}

	function resize() {
		const rect = sectionEl.getBoundingClientRect();
		renderer.setSize(rect.width, rect.height, false);
		updateFrustum();
	}

	window.addEventListener('resize', () => { resize(); recalibrateSitAnchor(); });
	resize();

	function smoothstep(t) { return t * t * (3 - 2 * t); }

	let recalSlide = null;
	function lerpAvatarTo(target, ms = 280) {
		if (!avatar) return;
		if (recalSlide) cancelAnimationFrame(recalSlide);
		const fromX = avatar.position.x, fromY = avatar.position.y;
		const t0 = performance.now();
		(function step(now) {
			const sp = Math.min((now - t0) / ms, 1);
			const e  = smoothstep(sp);
			avatar.position.x = fromX + (target.x - fromX) * e;
			avatar.position.y = fromY + (target.y - fromY) * e;
			if (sp < 1) recalSlide = requestAnimationFrame(step);
			else recalSlide = null;
		})(performance.now());
	}

	function recalibrateSitAnchor() {
		if (!avatar) return;
		const next = getSitWorld();
		startW = next;
		if (phase === 'sitting' || phase === 'standingUp' || phase === 'loading')
			lerpAvatarTo(next, 280);
	}

	const sitLineRO = new ResizeObserver(() => recalibrateSitAnchor());
	sitLineRO.observe(sitLine);

	// Lights — neutral/warm to match the monochrome theme
	scene.add(new THREE.AmbientLight(0xffffff, 0.65));
	const key = new THREE.DirectionalLight(0xfff8f0, 1.9);
	key.position.set(3, 6, 5);
	scene.add(key);
	const rim = new THREE.DirectionalLight(0xc0c8e0, 0.5);
	rim.position.set(-4, 3, -2);
	scene.add(rim);
	const fill = new THREE.DirectionalLight(0xffeedd, 0.35);
	fill.position.set(0, 2, 7);
	scene.add(fill);

	// State
	let avatar = null, mixer = null, rootBone = null, baseRootPos = null;
	let sitAction = null, standupAction = null, fallAction = null;
	let phase   = 'loading';
	let startW  = { x: 0, y: 0 };
	let seqT    = 0, landed = false, jumpTarget = { x: 0, y: 0 };

	const pendingTimers = new Set();
	function later(fn, ms) {
		const id = setTimeout(() => { pendingTimers.delete(id); fn(); }, ms);
		pendingTimers.add(id);
		return id;
	}
	function clearTimers() {
		for (const id of pendingTimers) clearTimeout(id);
		pendingTimers.clear();
	}

	const STAND_S     = 2.566;
	const JUMP_CLIP_S = 2.667;
	const JUMP_RATE   = 1.7;
	const JUMP_S      = JUMP_CLIP_S / JUMP_RATE;
	const SIT_DWELL_S = 2.8;
	const LAND_P      = 0.92;
	const LAND_PX     = 14;
	const FADE_S      = 0.3;
	const SIT_OFFSET_PX_BASE = 90;

	function sitOffsetPx() { return SIT_OFFSET_PX_BASE * (PX_PER_UNIT / 120); }

	function getSitWorld() {
		const rect = sitLine.getBoundingClientRect();
		return domToWorld(rect.left + rect.width / 2, rect.top + sitOffsetPx());
	}

	function getButtonWorld() {
		const rect = ctaBtn.getBoundingClientRect();
		return domToWorld(rect.left + rect.width / 2, rect.top);
	}

	function placeAtStart() {
		if (!avatar) return;
		startW = getSitWorld();
		if (phase === 'sitting' || phase === 'loading')
			avatar.position.set(startW.x, startW.y, 0);
	}

	// Button squish + screen shake via Web Animations API
	function fireSquish() {
		ctaBtn.getAnimations().forEach(a => a.cancel());
		ctaBtn.animate([
			{ transform: 'scaleY(1) scaleX(1)',      offset: 0 },
			{ transform: 'scaleY(0.5) scaleX(1.15)', offset: 0.08 },
			{ transform: 'scaleY(1.12) scaleX(0.94)', offset: 0.3 },
			{ transform: 'scaleY(0.96) scaleX(1.02)', offset: 0.55 },
			{ transform: 'scaleY(1.02) scaleX(0.99)', offset: 0.78 },
			{ transform: 'scaleY(1) scaleX(1)',       offset: 1 },
		], { duration: 900, easing: 'ease-out', fill: 'forwards' });

		const content = sectionEl.querySelector('.body-drop-content');
		if (content) {
			content.getAnimations().forEach(a => a.cancel());
			content.animate([
				{ transform: 'translateY(0)' },
				{ transform: 'translateY(-6px)' },
				{ transform: 'translateY(2px)' },
				{ transform: 'translateY(-1px)' },
				{ transform: 'translateY(0)' },
			], { duration: 450, easing: 'ease-out' });
		}
	}

	// Monochrome particle splash
	const SPLASH_GRAVITY = 1800;
	const SPLASH_COUNT   = 32;
	function fireSplash(ox, oy) {
		if (ox == null) {
			const r = ctaBtn.getBoundingClientRect();
			ox = r.left + r.width / 2; oy = r.top + 2;
		}
		const drops = [];
		for (let i = 0; i < SPLASH_COUNT; i++) {
			const size = 4 + Math.random() * 8;
			const el = document.createElement('div');
			el.style.cssText =
				'position:fixed;border-radius:50%;pointer-events:none;z-index:30;will-change:transform,opacity;' +
				`left:${ox - size / 2}px;top:${oy - size / 2}px;` +
				`width:${size}px;height:${size}px;` +
				'background:radial-gradient(circle at 35% 30%,#fff,#bbb 55%,#666);' +
				'box-shadow:0 0 4px rgba(255,255,255,0.35);';
			document.body.appendChild(el);
			const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
			const speed = 320 + Math.random() * 420;
			drops.push({
				el, x: 0, y: 0,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				life: 0, max: 0.8 + Math.random() * 0.5,
			});
		}
		let last = performance.now();
		(function step(now) {
			const dt = Math.min((now - last) / 1000, 0.04);
			last = now;
			let alive = false;
			for (const d of drops) {
				if (!d.el) continue;
				d.life += dt;
				d.vy   += SPLASH_GRAVITY * dt;
				d.x    += d.vx * dt;
				d.y    += d.vy * dt;
				const t = d.life / d.max;
				if (t >= 1) { d.el.remove(); d.el = null; continue; }
				d.el.style.opacity   = String(1 - t * t);
				d.el.style.transform = `translate(${d.x.toFixed(1)}px,${d.y.toFixed(1)}px)`;
				alive = true;
			}
			if (alive) requestAnimationFrame(step);
		})(last);
	}

	function startSit() {
		if (!sitAction) return;
		phase = 'sitting';
		placeAtStart();
		fallAction?.stop();
		standupAction?.stop();
		avatar.rotation.set(0, 0, 0);
		sitAction.reset().play();
		later(startStandup, SIT_DWELL_S * 1000);
	}

	function startStandup() {
		if (!standupAction || phase !== 'sitting') return;
		phase = 'standingUp';
		standupAction.reset();
		standupAction.crossFadeFrom(sitAction, FADE_S, false).play();
		later(triggerJump, (STAND_S - FADE_S) * 1000);
	}

	function triggerJump() {
		if (!avatar || !fallAction || phase === 'jumping') return;
		startW     = getSitWorld();
		const btn  = getButtonWorld();
		jumpTarget = { x: startW.x, y: btn.y };
		phase = 'jumping'; seqT = 0; landed = false;
		fallAction.reset();
		fallAction.crossFadeFrom(standupAction, FADE_S, false).play();
	}

	function updateSeq(dt) {
		if (phase !== 'jumping' || !avatar) return;
		seqT += dt;
		const p = Math.min(seqT / JUMP_S, 1);
		const y = startW.y + (jumpTarget.y - startW.y) * (p * p);
		avatar.position.set(startW.x, y, 0);

		if (!landed && p >= LAND_P) {
			const dyPx = Math.abs(avatar.position.y - jumpTarget.y) * PX_PER_UNIT;
			if (dyPx < LAND_PX) {
				landed = true;
				fireSquish();
				const sitRect = sitLine.getBoundingClientRect();
				const btnRect = ctaBtn.getBoundingClientRect();
				fireSplash(sitRect.left + sitRect.width / 2, btnRect.top + 2);
			}
		}

		if (p >= 1) {
			phase = 'resting';
			later(() => {
				const fromX = avatar.position.x;
				const fromY = avatar.position.y;
				const back  = getSitWorld();
				startW = back;
				avatar.rotation.y = 0;
				const t0 = performance.now();
				(function slide(now) {
					const sp = Math.min((now - t0) / 700, 1);
					avatar.position.x = fromX + (back.x - fromX) * smoothstep(sp);
					avatar.position.y = fromY + (back.y - fromY) * smoothstep(sp);
					if (sp < 1) requestAnimationFrame(slide);
					else {
						avatar.position.set(back.x, back.y, 0);
						startSit();
					}
				})(performance.now());
			}, 1600);
		}
	}

	ctaBtn.addEventListener('click', e => {
		if (phase === 'sitting' || phase === 'standingUp') {
			e.preventDefault();
			triggerJump();
		}
	});

	// Proximity text shadow
	const _proj = new THREE.Vector3();
	function updateProximityShadow() {
		if (!avatar) return;
		const sRect = sectionEl.getBoundingClientRect();
		_proj.set(avatar.position.x, avatar.position.y, avatar.position.z);
		_proj.project(camera);
		const ay   = sRect.top + (1 - _proj.y) * 0.5 * sRect.height;
		const rect = sitLine.getBoundingClientRect();
		const dy   = Math.max(0, rect.top - ay);
		const prox = 1 - Math.min(dy / 220, 1);
		if (prox <= 0.01) {
			sitLine.style.setProperty('--drop-shadow', 'none');
			return;
		}
		const blur    = (10 * (1 - prox) + 2).toFixed(2);
		const offsetY = (2 + 6 * prox).toFixed(2);
		const alpha   = (0.45 * prox).toFixed(3);
		sitLine.style.setProperty(
			'--drop-shadow',
			`0 ${offsetY}px ${blur}px rgba(0,0,0,${alpha})`
		);
	}

	// Resolve GLB URL for dev proxy
	function resolveGlb(url) {
		if (!url) return url;
		const isDev = location.hostname === 'localhost'
			|| location.hostname.includes('.github.dev')
			|| location.hostname.includes('.gitpod.io');
		if (isDev && url.includes('r2.dev')) {
			try { return '/r2-proxy' + new URL(url).pathname; } catch (_) {}
		}
		return url;
	}

	const AVATAR_ID = 'bacff13e-b64b-4ac0-860d-44f0168ad23b';

	fetch(`${location.origin}/api/avatars/${AVATAR_ID}`)
		.then(r => r.json())
		.then(d => {
			const glb = resolveGlb(d.avatar?.model_url || d.avatar?.url);
			if (!glb) return;

			new GLTFLoader().load(glb, gltf => {
				avatar = gltf.scene;
				avatar.traverse(n => {
					if (!rootBone && /^(Hips|Root|mixamorig:?Hips)$/i.test(n.name))
						rootBone = n;
				});
				avatar.rotation.y = 0;
				scene.add(avatar);
				mixer = new THREE.AnimationMixer(avatar);

				const fetchClip = f => fetch(f).then(r => r.json());
				Promise.all([
					fetchClip('/animations/clips/sitidle.json'),
					fetchClip('/animations/clips/standup.json'),
					fetchClip('/animations/clips/jumpdown.json'),
				]).then(([sitJson, standJson, jumpJson]) => {
					sitAction = mixer.clipAction(THREE.AnimationClip.parse(sitJson));
					sitAction.setLoop(THREE.LoopRepeat, Infinity);

					standupAction = mixer.clipAction(THREE.AnimationClip.parse(standJson));
					standupAction.setLoop(THREE.LoopOnce, 1);
					standupAction.clampWhenFinished = true;

					fallAction = mixer.clipAction(THREE.AnimationClip.parse(jumpJson));
					fallAction.setLoop(THREE.LoopOnce, 1);
					fallAction.clampWhenFinished = true;
					fallAction.timeScale = JUMP_RATE;

					if (rootBone) baseRootPos = rootBone.position.clone();

					// Root-bone lock: full clamp during jump, X/Z only during sit/stand
					const _render = renderer.render.bind(renderer);
					renderer.render = (sc, cam) => {
						try {
							if (rootBone && baseRootPos) {
								if (phase === 'jumping') {
									rootBone.position.copy(baseRootPos);
								} else {
									rootBone.position.x = baseRootPos.x;
									rootBone.position.z = baseRootPos.z;
								}
							}
						} catch (_) {}
						_render(sc, cam);
					};

					startSit();
				});
			});
		})
		.catch(e => console.warn('[avatar-drop] boot failed', e));

	// Render loop with visibility pause
	const clock = new THREE.Clock();
	let running = true;

	function tick() {
		if (!running) return;
		requestAnimationFrame(tick);
		try {
			const dt = Math.min(clock.getDelta(), 0.05);
			mixer?.update(dt);
			updateSeq(dt);
			updateProximityShadow();
			renderer.render(scene, camera);
		} catch (_) {}
	}
	tick();

	const visObs = new IntersectionObserver(entries => {
		const vis = entries[0].isIntersecting;
		if (vis && !running) { running = true; clock.getDelta(); tick(); }
		else if (!vis && running) { running = false; }
	}, { threshold: 0 });
	visObs.observe(sectionEl);
}
