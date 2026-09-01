	// ── Boot live <agent-3d> instances ─────────────────────────────
	const AVATAR_ID  = 'bacff13e-b64b-4ac0-860d-44f0168ad23b';
	const AGENT_ATTRS = {
		mode: 'inline', responsive: '', background: 'transparent',
		'name-plate': 'off', 'avatar-chat': 'off', kiosk: '', eager: '',
	};
	function devProxyGlb(url) {
		if (!url) return url;
		const isDev = location.hostname === 'localhost' || location.hostname.includes('.github.dev') || location.hostname.includes('.gitpod.io');
		if (isDev && url.includes('r2.dev')) {
			try { return '/r2-proxy' + new URL(url).pathname; } catch (_) {}
		}
		return url;
	}

	// Fetch a pool of unique community avatar GLBs from /api/explore, cached for the page lifetime.
	// pool[0]=WYG, pool[1]=vclose, pool[2..]=LIVE_SPOTS null entries
	var _avatarPoolP = null;
	// Only renderable full-body avatars belong here. The idle_*.glb clips are
	// animation-only (0 meshes) and render as an empty box — never use them as a body.
	var POOL_FALLBACKS = [
		'/avatars/default.glb',
		'/avatars/cz.glb',
		'/animations/robotexpressive.glb',
		'/animations/soldier.glb',
		'/avatars/default.glb',
		'/avatars/cz.glb',
		'/animations/robotexpressive.glb',
		'/animations/soldier.glb',
	];
	function getAvatarPool() {
		if (!_avatarPoolP) {
			_avatarPoolP = fetch(location.origin + '/api/explore?source=all&limit=16&quality=high')
				.then(function(r) { return r.json(); })
				.then(function(d) {
					var items = (d.items || []);
					var pool = items
						.filter(function(it) { return it.glbUrl && it.avatarId !== AVATAR_ID; })
						.map(function(it) { return devProxyGlb(it.glbUrl); })
						.filter(Boolean);
					var fi = 0;
					while (pool.length < 8) {
						pool.push(location.origin + POOL_FALLBACKS[fi++ % POOL_FALLBACKS.length]);
					}
					return pool;
				})
				.catch(function() {
					return POOL_FALLBACKS.map(function(p) { return location.origin + p; });
				});
		}
		return _avatarPoolP;
	}

	function spawnAgent(glbUrl) {
		const el = document.createElement('agent-3d');
		el.classList.add('live-agent');
		el.setAttribute('body', glbUrl);
		for (const [k, v] of Object.entries(AGENT_ATTRS)) el.setAttribute(k, v);
		return el;
	}
	async function fetchAvatarGlb(id) {
		const r = await fetch(`${location.origin}/api/avatars/${id}`);
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const d = await r.json();
		const glb = devProxyGlb(d.avatar?.model_url || d.avatar?.url);
		if (!glb) throw new Error('no model url');
		return glb;
	}
	// The curated hero avatar can disappear (deleted, or a fresh deploy whose
	// DB row hasn't been seeded yet) — fall back to a real featured avatar so
	// the stage is never just an error card.
	async function resolveFeaturedGlb() {
		// Preferred: a curated featured avatar via the detail endpoint (richest
		// metadata). Wrapped so a flaky/unavailable detail route never strands
		// the hero — we drop to the explore pool below instead.
		try {
			const r = await fetch(`${location.origin}/api/avatars/featured?limit=12`);
			if (r.ok) {
				const d = await r.json();
				const list = Array.isArray(d.avatars) ? d.avatars : [];
				for (const a of list) {
					try { return await fetchAvatarGlb(a.id); } catch (_) { /* try next */ }
				}
			}
		} catch (_) { /* fall through to the explore pool */ }
		// Fallback: the explore feed returns ready-to-render GLB URLs directly
		// (and getAvatarPool degrades to bundled /avatars/*.glb), so the stage
		// renders a real avatar even if the per-avatar detail endpoint is down.
		const pool = await getAvatarPool();
		const glb = pool.find(Boolean);
		if (!glb) throw new Error('no renderable avatar found');
		return glb;
	}
	function showHeroSlowNotice(heroInner) {
		const copy = heroInner.querySelector('.hero-stage-loading-copy');
		if (!copy || heroInner.querySelector('#hero-retry')) return;
		copy.textContent = 'Still loading the live agent ';
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'btn btn--sm';
		retry.id = 'hero-retry';
		retry.textContent = 'Retry';
		retry.addEventListener('click', () => {
			heroInner.innerHTML = '';
			bootHeroAvatar();
		});
		copy.appendChild(retry);
	}
	function showHeroFallback(heroInner) {
		heroInner.innerHTML = '<div class="hero-stage-fallback" role="status">'
			+ '<p>The live preview couldn’t load right now.</p>'
			+ '<button type="button" class="btn btn--sm" id="hero-retry">Retry</button></div>';
		heroInner.querySelector('#hero-retry')?.addEventListener('click', () => {
			heroInner.innerHTML = '';
			bootHeroAvatar();
		});
	}
	// The <agent-3d> loader is a separate CDN script — if it fails (network
	// blip, missing local dist-lib build in dev), the element never upgrades
	// and the stage would sit silently black. Surface the designed fallback
	// instead of nothing.
	function agentElementDefined(timeoutMs) {
		return Promise.race([
			customElements.whenDefined('agent-3d').then(() => true),
			new Promise((res) => setTimeout(() => res(false), timeoutMs)),
		]);
	}
	// The stage's first-impression loading state: a breathing agent silhouette
	// instead of a silent void while the GLB + <agent-3d> loader resolve. Shown at
	// the very start of the boot, removed the instant the avatar is ready.
	function heroLoadingMarkup() {
		return '<div class="hero-stage-loading" role="status" aria-label="Loading the live agent preview">'
			+ '<svg class="hero-stage-loading-figure" viewBox="0 0 64 72" fill="currentColor" aria-hidden="true">'
			+ '<circle cx="32" cy="21" r="14"/><path d="M6 72c0-14.4 11.6-26 26-26s26 11.6 26 26z"/></svg>'
			+ '<span class="hero-stage-loading-copy">Summoning your agent<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>'
			+ '</div>';
	}
	function hideHeroLoading(heroInner) {
		const el = heroInner?.querySelector('.hero-stage-loading');
		if (!el) return;
		el.classList.add('is-hiding');
		setTimeout(() => el.remove(), 520);
	}
	async function bootHeroAvatar() {
		const heroInner = document.getElementById('hero-stage-inner');
		// Fill the stage immediately, before any await, so the first paint is alive.
		if (heroInner) heroInner.innerHTML = heroLoadingMarkup();
		try {
			let glb;
			try {
				glb = await fetchAvatarGlb(AVATAR_ID);
			} catch (_) {
				glb = await resolveFeaturedGlb();
			}
			if (heroInner) {
				if (!(await agentElementDefined(15000))) {
					throw new Error('agent-3d element never registered — loader script failed');
				}
				const heroEl = spawnAgent(glb);
				let ready = false;
				// Fade the hero in on agent:ready and retire the loading silhouette in
				// the same beat. Attached before the element is appended so the event
				// can never be missed (a stage-level MutationObserver raced anything
				// else that touched the stage first, e.g. seasonal.js injecting its
				// Fireworks chip, and left the avatar stuck at opacity 0).
				heroEl.addEventListener('agent:ready', () => {
					ready = true;
					heroEl.classList.add('loaded');
					hideHeroLoading(heroInner);
				}, { once: true });
				// Append alongside the loading overlay (which sits on top via z-index
				// and fades out on ready), so the stage never blinks back to empty
				// between clearing the placeholder and the model's first frame.
				// A boot failure (GLB fetch or decode, renderer) is reported by the
				// element itself, and that is the only signal that retires a booting
				// hero. A 22-second wall-clock timer used to do it, and on a slow
				// device or connection it fired while the avatar was still loading:
				// the visitor saw "couldn't load" for a model that was about to
				// appear, and tearing down a mid-boot viewer forces a WebGL context
				// loss, which under Lighthouse froze the page for the rest of the run.
				heroEl.addEventListener('agent:error', () => {
					if (!ready) showHeroFallback(heroInner);
				}, { once: true });
				heroInner.appendChild(heroEl);
				initHeroWalk(heroEl);
				initHeroChips(heroEl);
				// Unusually slow but not failed: keep the element booting (a teardown
				// would discard the work already done) and hand the visitor the
				// choice to retry instead of making it for them.
				setTimeout(() => {
					if (!ready && heroInner.querySelector('.hero-stage-loading')) showHeroSlowNotice(heroInner);
				}, 45000);
			}
		} catch (e) {
			console.warn('[home] avatar boot failed', e);
			if (heroInner) showHeroFallback(heroInner);
		}
	}
	bootHeroAvatar();

	// ── What You Get: avatar viewer + animation gallery ────────────
	(function initWygSection() {
		var viewer = document.getElementById('wyg-viewer');
		var scroll = document.getElementById('wyg-anim-scroll');
		var stopBtn = document.getElementById('wyg-anim-stop');
		var skelEl  = document.getElementById('wyg-viewer-skel');
		if (!viewer || !scroll) return;

		var wygAgent = null;
		var activeChip = null;
		var loopAnims = new Set(['idle','walk','av-walk-feminine','av-walk-crouching',
			'av-idle-breath','av-waiting','av-idle-male','av-idle-female',
			'av-vtubing','av-chilling','av-leaning-wall','av-listening-music',
			'av-smoking','sitidle','av-idle-anim']);

		var wygObs = new IntersectionObserver(function(entries) {
			if (!entries[0].isIntersecting) return;
			wygObs.disconnect();
			bootWyg();
		}, { rootMargin: '150px' });
		wygObs.observe(viewer);

		function bootWyg() {
			getAvatarPool()
				.then(function(pool) {
					var glb = pool[0];
					if (!glb) return;
					var el = spawnAgent(glb);
					viewer.insertBefore(el, viewer.firstChild);
					wygAgent = el;
					el.addEventListener('agent:ready', function() {
						el.classList.add('loaded');
						if (skelEl) skelEl.style.display = 'none';
						el.play?.('idle', { loop: true, fade_ms: 400 });
						var firstChip = scroll.querySelector('[data-anim="idle"]');
						if (firstChip) firstChip.dataset.active = 'true';
						activeChip = firstChip;
					}, { once: true });
				})
				.catch(function(e) { console.warn('[wyg] avatar boot failed', e); });
		}

		scroll.addEventListener('click', function(e) {
			var btn = e.target.closest('.wyg-anim-chip');
			if (!btn || !wygAgent) return;
			var clip = btn.dataset.anim;
			if (!clip) return;
			if (activeChip) delete activeChip.dataset.active;
			btn.dataset.active = 'true';
			activeChip = btn;
			wygAgent.play?.(clip, { loop: loopAnims.has(clip), fade_ms: 400 });
		});

		if (stopBtn) {
			stopBtn.addEventListener('click', function() {
				if (!wygAgent) return;
				wygAgent.play?.('idle', { loop: true, fade_ms: 400 });
				if (activeChip) delete activeChip.dataset.active;
				var idleChip = scroll.querySelector('[data-anim="idle"]');
				if (idleChip) idleChip.dataset.active = 'true';
				activeChip = idleChip;
			});
		}
	})();

	// ── Hero walk cycle ─────────────────────────────────────────────
	let _heroChipActive = false;

	function initHeroWalk(heroAgent) {
		const WALK_CLIP = 'av-walk-feminine';
		const IDLE_CLIP = 'idle';
		let active = true;
		let running = false;

		// Ambient idle↔walk loop. Re-entrancy guarded so a second call (visibility
		// flip, or an emote handing the avatar back) never spins up parallel timers.
		async function walkCycle() {
			if (running) return;
			running = true;
			try {
				while (active && !_heroChipActive) {
					await new Promise(r => setTimeout(r, 2000));
					if (!active || _heroChipActive) break;
					heroAgent.play?.(WALK_CLIP, { loop: true, fade_ms: 400 });
					await new Promise(r => setTimeout(r, 5000));
					if (!active || _heroChipActive) break;
					heroAgent.play?.(IDLE_CLIP, { loop: true, fade_ms: 600 });
					await new Promise(r => setTimeout(r, 3000));
				}
			} finally {
				running = false;
			}
		}
		// Expose the cycle so the chip handler can hand the avatar back to its rhythm.
		heroAgent._heroAmbient = walkCycle;

		heroAgent.addEventListener('agent:ready', walkCycle, { once: true });
		if (heroAgent._viewer) walkCycle();

		document.addEventListener('visibilitychange', () => {
			active = !document.hidden;
			if (active && !_heroChipActive) walkCycle();
		});
	}

	// Pray → walk: finish the prayer one-shot, then rise straight into a looping
	// walk via a single crossfade — no snap back to idle at the clip boundary.
	function playPrayToWalk(heroAgent) {
		const am = heroAgent?._viewer?.animationManager;
		if (am && typeof am.playOnce === 'function') {
			am.playOnce('pray', { settleTo: 'av-walk-feminine', fade: 0.45 });
			return;
		}
		// Animation manager not reachable yet: play the one-shot, then walk once it
		// ends (pray clip ≈ 6.87s).
		heroAgent.play?.('pray', { loop: false, fade_ms: 400 });
		clearTimeout(heroAgent._prayWalkTimer);
		heroAgent._prayWalkTimer = setTimeout(() => {
			heroAgent.play?.('av-walk-feminine', { loop: true, fade_ms: 450 });
		}, 6900);
	}

	// ── Hero animation chips ─────────────────────────────────────────
	function initHeroChips(heroAgent) {
		const ANIMS = ['wave','dance','capoeira','jump','thriller','pray','celebrate','rumba','falling','kiss','taunt','idle'];
		const chipsEl  = document.getElementById('hero-chips');
		const counter  = document.getElementById('hero-chips-counter');
		let lastAnim   = null;
		let moveCount  = 0;

		if (!chipsEl) return;

		chipsEl.addEventListener('click', (e) => {
			const btn = e.target.closest('.hero-chip');
			if (!btn) return;
			const animKey = btn.dataset.anim;
			if (!animKey) return;

			let clip = animKey;
			if (animKey === '__random') {
				const pool = ANIMS.filter(a => a !== lastAnim);
				clip = pool[Math.floor(Math.random() * pool.length)];
			}
			lastAnim = clip;

			chipsEl.querySelectorAll('.hero-chip').forEach(c => delete c.dataset.active);
			btn.dataset.active = 'true';

			_heroChipActive = true;
			if (clip === 'pray') {
				playPrayToWalk(heroAgent);
			} else {
				heroAgent.play?.(clip, { loop: false, fade_ms: 400 });
			}

			moveCount += 1;
			if (counter) counter.innerHTML = `<strong>${moveCount}</strong> ${moveCount === 1 ? 'move' : 'moves'}`;

			// Pray runs ~6.9s then walks; hold the chip-active window longer so the
			// walk reads before the ambient idle↔walk rhythm takes back over.
			clearTimeout(chipsEl._resumeTimer);
			chipsEl._resumeTimer = setTimeout(() => {
				_heroChipActive = false;
				delete btn.dataset.active;
				heroAgent._heroAmbient?.();
			}, clip === 'pray' ? 11000 : 6000);
		});
	}

	// ── Hero parallax tilt ──────────────────────────────────────────
	const stage = document.getElementById('hero-stage');
	const inner = document.getElementById('hero-stage-inner');
	if (stage && inner && window.matchMedia('(min-width: 980px)').matches) {
		let rx = 0, ry = 0, tx = 0, ty = 0;
		const lerp = (a, b, t) => a + (b - a) * t;
		// Cache the stage rect and refresh only on layout changes, so the hot
		// mousemove path never forces a synchronous reflow per pointer event.
		let r = stage.getBoundingClientRect();
		const refreshRect = () => { r = stage.getBoundingClientRect(); };
		window.addEventListener('resize', refreshRect, { passive: true });
		window.addEventListener('scroll', refreshRect, { passive: true });
		stage.addEventListener('mousemove', (e) => {
			tx = ((e.clientX - r.left) / r.width - 0.5) * 6;
			ty = -((e.clientY - r.top) / r.height - 0.5) * 4;
		}, { passive: true });
		stage.addEventListener('mouseleave', () => { tx = 0; ty = 0; });
		(function tick() {
			rx = lerp(rx, ty, 0.08);
			ry = lerp(ry, tx, 0.08);
			inner.style.transform = `perspective(1400px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
			requestAnimationFrame(tick);
		})();
	}

	// ── Playground ──────────────────────────────────────────────────
	(function initPlayground() {
		const textarea  = document.getElementById('pg-textarea');
		const highlight = document.getElementById('pg-highlight');
		const preview   = document.getElementById('pg-preview');
		const avatarRow = document.getElementById('pg-avatars');
		const modeChips = document.getElementById('pg-mode-chips');
		const bgChips   = document.getElementById('pg-bg-chips');
		const optChips  = document.getElementById('pg-option-chips');
		const animsEl   = document.getElementById('pg-anims');
		const tabsEl    = document.getElementById('pg-tabs');
		const copyBtn   = document.getElementById('pg-copy');
		if (!textarea || !preview) return;

		const state = {
			avatarId: AVATAR_ID,
			glbUrl: '',
			mode: 'inline',
			background: 'transparent',
			options: { responsive: true, 'name-plate': 'off', 'avatar-chat': 'off', eager: true },
			flavor: 'html',
		};
		let liveAgent = null;

		function genCode() {
			const attrs = [];
			var isDemo = state.avatarId.indexOf('avatar_demo_') === 0;
			if (isDemo && state.glbUrl) {
				attrs.push('body="' + state.glbUrl + '"');
			} else {
				attrs.push('src="https://three.ws/api/avatars/' + state.avatarId + '"');
			}
			if (state.mode !== 'inline') attrs.push('mode="' + state.mode + '"');
			if (state.background !== 'transparent') attrs.push('background="' + state.background + '"');
			for (const [k, v] of Object.entries(state.options)) {
				// responsive defaults on, so disabling it must be explicit.
				if (k === 'responsive') { attrs.push(v ? 'responsive' : 'responsive="false"'); continue; }
				if (!v || v === 'off') continue;
				attrs.push(typeof v === 'string' ? k + '="' + v + '"' : k);
			}
			const indent = state.flavor === 'html' ? '  ' : '    ';
			const attrBlock = attrs.map(function(a) { return indent + a; }).join('\n');

			if (state.flavor === 'html') {
				return '<script type="module"\n  src="https://three.ws/agent-3d/latest/agent-3d.js"\n><\/script>\n\n<agent-3d\n' + attrBlock + '\n></agent-3d>';
			}
			if (state.flavor === 'react') {
				return "import 'https://three.ws/agent-3d/latest/agent-3d.js';\n\nexport default function MyAgent() {\n  return (\n    <agent-3d\n" + attrBlock + "\n    />\n  );\n}";
			}
			return '<script setup>\nimport \'https://three.ws/agent-3d/latest/agent-3d.js\';\n<\/script>\n\n<template>\n  <agent-3d\n' + attrBlock + '\n  />\n</template>';
		}

		function hl(code) {
			var tokens = [];
			var ph = function(cls, txt) { var id = '\x00' + tokens.length + '\x00'; tokens.push('<span class="' + cls + '">' + txt + '</span>'); return id; };
			var s = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
			s = s.replace(/(&lt;\/?[a-z][a-z0-9-]*)/gi, function(m) { return ph('tag', m); });
			s = s.replace(/\b(import|from|export|default|function|return|const|let|var)\b/g, function(m) { return ph('kw', m); });
			s = s.replace(/(\s)([a-z][a-z0-9-]*)(=)/gi, function(_, ws, name, eq) { return ws + ph('attr', name) + eq; });
			s = s.replace(/("(?:[^"\\]|\\.)*?")/g, function(m) { return ph('str', m); });
			s = s.replace(/(\/\/.*?)$/gm, function(m) { return ph('com', m); });
			return s.replace(/\x00(\d+)\x00/g, function(_, i) { return tokens[parseInt(i)]; });
		}

		function syncCode() {
			var code = genCode();
			textarea.value = code;
			highlight.innerHTML = hl(code);
		}

		// The live agent paints its own canvas, but it may not fill the preview
		// frame (responsive width / aspect). Match the surrounding area to the
		// chosen background so the preview reads as one surface. 'transparent'
		// returns '' so the default stage backdrop shows through behind the avatar.
		function resolvePreviewBg(bg) {
			if (bg === 'transparent') return '';
			if (bg === 'dark') return '#0d0d0d';
			if (bg === 'light') return '#f5f5f5';
			return bg;
		}

		function setLiveOption(k, v) {
			// String-valued options (name-plate, avatar-chat) must be reflected
			// explicitly — the component hides the plate only on `name-plate="off"`,
			// not on the attribute's absence, so removing it would leave it visible.
			if (typeof v === 'string') liveAgent.setAttribute(k, v);
			else if (v) liveAgent.setAttribute(k, '');
			else liveAgent.removeAttribute(k);
		}

		function showPreviewMessage() {
			if (preview.querySelector('.pg-preview-msg')) return;
			var msg = document.createElement('div');
			msg.className = 'pg-preview-msg';
			msg.setAttribute('role', 'status');
			msg.innerHTML = 'Couldn\'t load a live avatar right now.<br /><a href="/gallery">Browse the gallery</a> or pick another avatar below.';
			preview.appendChild(msg);
		}
		function clearPreviewMessage() {
			var msg = preview.querySelector('.pg-preview-msg');
			if (msg) msg.remove();
		}
		function updatePreview() {
			if (!state.glbUrl) { showPreviewMessage(); return; }
			clearPreviewMessage();
			// `kiosk` and `eager` are read once at boot (not observed attributes),
			// so a change to either requires recreating the element. kiosk is tied
			// to the chat toggle: with chat on we drop kiosk so the chat chrome
			// renders; with chat off we keep kiosk for a clean avatar-only tile.
			var wantKiosk = state.options['avatar-chat'] !== 'on';
			var wantEager = !!state.options.eager;
			var needsRebuild = !liveAgent
				|| liveAgent.hasAttribute('kiosk') !== wantKiosk
				|| liveAgent.hasAttribute('eager') !== wantEager;
			if (needsRebuild) {
				if (liveAgent) liveAgent.remove();
				liveAgent = document.createElement('agent-3d');
				if (wantKiosk) liveAgent.setAttribute('kiosk', '');
				if (wantEager) liveAgent.setAttribute('eager', '');
				liveAgent.setAttribute('body', state.glbUrl);
				preview.appendChild(liveAgent);
			} else {
				liveAgent.setAttribute('body', state.glbUrl);
			}
			liveAgent.setAttribute('mode', state.mode);
			liveAgent.setAttribute('background', state.background);
			// Runtime-observed surface attributes — applied live without a reboot.
			// `responsive` is off only when explicitly "false"; an absent attribute
			// defaults to responsive-on, so we must set the literal value.
			liveAgent.setAttribute('responsive', state.options.responsive ? '' : 'false');
			setLiveOption('name-plate', state.options['name-plate']);
			setLiveOption('avatar-chat', state.options['avatar-chat']);
			preview.style.backgroundColor = resolvePreviewBg(state.background);
		}

		function fetchGlb(id) {
			return fetch(location.origin + '/api/avatars/' + id)
				.then(function(r) { return r.json(); })
				.then(function(d) { return devProxyGlb(d.avatar && (d.avatar.model_url || d.avatar.url)) || ''; })
				// The per-avatar detail endpoint can be unavailable; rather than
				// strand the preview on a blank model, borrow a real, renderable
				// GLB from the explore-backed pool so the playground always shows
				// a live agent.
				.catch(function() {
					return getAvatarPool().then(function(pool) { return pool.find(Boolean) || ''; }).catch(function() { return ''; });
				});
		}

		function switchAvatar(id, directGlb) {
			state.avatarId = id;
			avatarRow.querySelectorAll('.pg-avatar-item').forEach(function(el) {
				el.classList.toggle('active', el.dataset.id === id);
			});
			var resolve = directGlb
				? Promise.resolve(devProxyGlb(directGlb))
				: fetchGlb(id);
			resolve.then(function(glb) {
				state.glbUrl = glb;
				syncCode();
				if (liveAgent) { liveAgent.remove(); liveAgent = null; }
				updatePreview();
			}).catch(function() { showPreviewMessage(); });
		}

		function renderAvatars(list) {
			avatarRow.innerHTML = '';
			list.forEach(function(a) {
				var btn = document.createElement('button');
				btn.className = 'pg-avatar-item' + (a.id === state.avatarId ? ' active' : '');
				btn.dataset.id = a.id;
				if (a.glb) btn.dataset.glb = a.glb;
				btn.title = a.name || a.id.slice(0, 8);
				var initial = document.createElement('span');
				initial.className = 'pg-avatar-initial';
				initial.textContent = (a.name || '?').charAt(0);
				btn.appendChild(initial);
				if (a.thumb) {
					var img = document.createElement('img');
					// Lazy-load must be declared before src: setting src first starts
					// the fetch immediately, and the strip's full-size thumbnails
					// (100-300 KB each) were all downloading on page load for a row
					// three screens down.
					img.loading = 'lazy';
					img.decoding = 'async';
					img.width = 28;
					img.height = 28;
					img.alt = a.name || '';
					img.src = a.thumb;
					img.onerror = function() { this.style.display = 'none'; initial.style.display = 'flex'; };
					btn.appendChild(img);
				} else {
					initial.style.display = 'flex';
				}
				btn.addEventListener('click', function() { switchAvatar(a.id, a.glb); });
				avatarRow.appendChild(btn);
			});
		}

		function loadAvatars() {
			var O = location.origin;
			var defaults = [
				{ id: 'avatar_demo_disk_cz', name: 'CZ', glb: O + '/avatars/cz.glb' },
				{ id: 'avatar_demo_disk_ansem', name: 'Ansem', glb: O + '/avatars/default.glb' },
				{ id: 'avatar_demo_disk_boss_vernington', name: 'Boss Vernington', glb: O + '/animations/soldier.glb' },
				{ id: 'avatar_demo_disk_goblin', name: 'Goblin', glb: O + '/animations/robotexpressive.glb' },
				{ id: 'avatar_demo_disk_claude', name: 'Claude', glb: O + '/avatars/default.glb' },
				{ id: 'avatar_demo_disk_agent', name: 'Agent', glb: O + '/animations/soldier.glb' },
				{ id: 'avatar_demo_disk_ai', name: 'AI', glb: O + '/animations/robotexpressive.glb' },
			];
			renderAvatars(defaults);
			// Source the picker from the explore feed, which returns a ready-to-render
			// glbUrl per avatar. Carrying the GLB on each chip means selecting one
			// uses the direct-GLB path in switchAvatar and never depends on the
			// per-avatar detail endpoint.
			fetch(O + '/api/explore?source=avatar&only3d=1&limit=24&quality=high', { headers: { accept: 'application/json' } })
				.then(function(r) { return r.json(); })
				.then(function(d) {
					var items = (Array.isArray(d.items) ? d.items : []).filter(function(it) { return it.glbUrl && it.avatarId; });
					// The explore feed is newest-first, and a freshly forged avatar rarely has
					// a thumbnail yet — left alone they monopolise the strip and every chip
					// renders as a bare initial. Stable-partition thumbnailed avatars to the
					// front so the picker shows what you're selecting; the rest still fill any
					// slots left over.
					items = items.filter(function(it) { return it.image; })
						.concat(items.filter(function(it) { return !it.image; }));
					var list = defaults.slice();
					var seen = {};
					defaults.forEach(function(da) { seen[da.id] = true; });
					items.forEach(function(item) {
						var id = item.avatarId;
						if (!id || seen[id]) return;
						seen[id] = true;
						list.push({
							id: id,
							name: item.name || '',
							glb: devProxyGlb(item.glbUrl),
							// `image` is the avatar's stored thumbnail URL, or null when it has
							// none. Pass the null straight through — renderAvatars() then draws
							// the initial-letter chip. Never synthesise a thumb/<id>.png URL as
							// a fallback: that object was never written, so R2 answers 404 with
							// a text/plain body and Chrome blocks it (ERR_BLOCKED_BY_ORB).
							thumb: item.image || null,
						});
					});
					renderAvatars(list.slice(0, 14));
				}).catch(function() {});
		}

		function chipSelect(container, cb) {
			container.addEventListener('click', function(e) {
				var chip = e.target.closest('.pg-chip');
				if (!chip) return;
				container.querySelectorAll('.pg-chip').forEach(function(c) { c.classList.remove('active'); });
				chip.classList.add('active');
				cb(chip);
			});
		}

		chipSelect(modeChips, function(chip) {
			state.mode = chip.dataset.val;
			syncCode(); updatePreview();
		});

		var colorTrigger  = document.getElementById('pg-color-trigger');
		var colorPopover  = document.getElementById('pg-color-popover');
		var colorSwatches = document.getElementById('pg-color-swatches');
		var colorHexInput = document.getElementById('pg-color-hex');
		var colorPreview  = document.getElementById('pg-color-preview');

		var palette = [
			'#1b1b1b','#212121','#0f3460','#533483','#e94560','#ff6b6b',
			'#ffa07a','#ffd93d','#6bcb77','#4d96ff','#845ec2','#d65db1',
			'#333333','#636e72','#b2bec3','#dfe6e9','#fdcb6e','#e17055',
			'#00b894','#00cec9','#0984e3','#6c5ce7','#fd79a8','#e84393',
		];

		palette.forEach(function(hex) {
			var btn = document.createElement('button');
			btn.className = 'pg-color-swatch';
			btn.style.background = hex;
			btn.dataset.color = hex;
			btn.setAttribute('aria-label', hex);
			colorSwatches.appendChild(btn);
		});

		function applyPickedColor(hex) {
			state.background = hex;
			colorTrigger.classList.add('active', 'has-color');
			colorTrigger.style.setProperty('--pg-picked-color', hex);
			colorPreview.style.background = hex;
			colorHexInput.value = hex;
			bgChips.querySelectorAll('.pg-chip').forEach(function(c) { c.classList.remove('active'); });
			colorSwatches.querySelectorAll('.pg-color-swatch').forEach(function(s) {
				s.classList.toggle('active', s.dataset.color === hex);
			});
			syncCode(); updatePreview();
		}

		chipSelect(bgChips, function(chip) {
			state.background = chip.dataset.val;
			colorTrigger.classList.remove('active', 'has-color');
			colorPopover.classList.remove('open');
			colorSwatches.querySelectorAll('.pg-color-swatch').forEach(function(s) { s.classList.remove('active'); });
			syncCode(); updatePreview();
		});

		var popoverMoved = false;
		function positionPopover() {
			var rect = colorTrigger.getBoundingClientRect();
			var pw = 220;
			var left = rect.left + rect.width / 2 - pw / 2;
			if (left < 8) left = 8;
			if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
			colorPopover.style.position = 'fixed';
			colorPopover.style.transform = 'none';
			colorPopover.style.top = (rect.bottom + 8) + 'px';
			colorPopover.style.left = left + 'px';
		}

		colorTrigger.addEventListener('click', function(e) {
			e.stopPropagation();
			if (!popoverMoved) {
				document.body.appendChild(colorPopover);
				popoverMoved = true;
			}
			positionPopover();
			colorPopover.classList.toggle('open');
		});

		window.addEventListener('scroll', function() {
			if (colorPopover.classList.contains('open')) positionPopover();
		}, { passive: true });
		window.addEventListener('resize', function() {
			if (colorPopover.classList.contains('open')) positionPopover();
		});

		colorSwatches.addEventListener('click', function(e) {
			var swatch = e.target.closest('.pg-color-swatch');
			if (!swatch) return;
			applyPickedColor(swatch.dataset.color);
		});

		colorHexInput.addEventListener('input', function() {
			var v = colorHexInput.value.trim();
			if (!v.startsWith('#')) v = '#' + v;
			if (/^#[0-9a-fA-F]{6}$/.test(v)) applyPickedColor(v);
		});

		colorHexInput.addEventListener('keydown', function(e) {
			if (e.key === 'Enter') {
				var v = colorHexInput.value.trim();
				if (!v.startsWith('#')) v = '#' + v;
				if (/^#[0-9a-fA-F]{6}$/.test(v)) {
					applyPickedColor(v);
					colorPopover.classList.remove('open');
				}
			}
		});

		document.addEventListener('click', function(e) {
			if (!colorPopover.contains(e.target) && e.target !== colorTrigger) {
				colorPopover.classList.remove('open');
			}
		});

		optChips.addEventListener('click', function(e) {
			var chip = e.target.closest('.pg-chip');
			if (!chip) return;
			var attr = chip.dataset.attr;
			var isOn = chip.classList.toggle('active');
			state.options[attr] = isOn ? (chip.dataset.val || true) : (chip.dataset.val ? 'off' : false);
			syncCode(); updatePreview();
		});

		tabsEl.addEventListener('click', function(e) {
			var tab = e.target.closest('.pg-tab');
			if (!tab) return;
			state.flavor = tab.dataset.flavor;
			tabsEl.querySelectorAll('.pg-tab').forEach(function(t) { t.classList.toggle('active', t === tab); });
			syncCode();
		});

		var editDebounce = null;
		textarea.addEventListener('input', function() {
			highlight.innerHTML = hl(textarea.value);
			clearTimeout(editDebounce);
			editDebounce = setTimeout(function() {
				var code = textarea.value;
				var m = code.match(/<agent-3d([^>]*?)(?:\/>|>)/i);
				if (!m) return;
				var as = m[1];
				var ga = function(n) { var x = as.match(new RegExp(n + '="([^"]*)"', 'i')); return x ? x[1] : null; };
				var ha = function(n) { return new RegExp('\\b' + n + '\\b', 'i').test(as); };
				var src = ga('src');
				if (src) {
					var idm = src.match(/avatars\/([a-f0-9-]+)/);
					if (idm && idm[1] !== state.avatarId) { switchAvatar(idm[1]); return; }
				}
				var mode = ga('mode');
				if (mode && mode !== state.mode) state.mode = mode;
				var bg = ga('background');
				if (bg !== null) state.background = bg;
				state.options.responsive = ga('responsive') !== 'false';
				state.options['name-plate'] = ga('name-plate') === 'on' ? 'on' : 'off';
				state.options['avatar-chat'] = ga('avatar-chat') === 'on' ? 'on' : 'off';
				state.options.eager = ha('eager');
				updatePreview();
			}, 350);
		});

		textarea.addEventListener('scroll', function() {
			highlight.scrollTop = textarea.scrollTop;
			highlight.scrollLeft = textarea.scrollLeft;
		});

		textarea.addEventListener('keydown', function(e) {
			if (e.key === 'Tab') {
				e.preventDefault();
				var s = textarea.selectionStart, end = textarea.selectionEnd;
				textarea.value = textarea.value.substring(0, s) + '  ' + textarea.value.substring(end);
				textarea.selectionStart = textarea.selectionEnd = s + 2;
				textarea.dispatchEvent(new Event('input'));
			}
		});

		copyBtn.addEventListener('click', function() {
			navigator.clipboard.writeText(textarea.value).then(function() {
				copyBtn.classList.add('copied');
				copyBtn.textContent = 'Copied';
				setTimeout(function() { copyBtn.classList.remove('copied'); copyBtn.textContent = 'Copy'; }, 1600);
			}).catch(function() {
				copyBtn.textContent = 'Copy blocked';
				setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1600);
			});
		});

		animsEl.addEventListener('click', function(e) {
			var btn = e.target.closest('.pg-anim');
			if (!btn || !liveAgent) return;
			var clip = btn.dataset.anim;
			if (liveAgent.play) liveAgent.play(clip, { loop: clip === 'idle', fade_ms: 400 });
			animsEl.querySelectorAll('.pg-anim').forEach(function(c) { c.classList.remove('active'); });
			btn.classList.add('active');
			if (clip !== 'idle') {
				clearTimeout(animsEl._t);
				animsEl._t = setTimeout(function() { btn.classList.remove('active'); }, 5000);
			}
		});

		// The preview is a full <agent-3d> viewer (its own WebGL context, a GLB
		// decode, a shader compile) three screens below the hero. Booting it on
		// page load had it competing with the hero for the main thread while
		// nobody could see it; it boots as the playground scrolls near instead.
		function bootPlayground() {
			fetchGlb(state.avatarId).then(function(glb) {
				state.glbUrl = glb;
				syncCode();
				updatePreview();
				loadAvatars();
			}).catch(function() { showPreviewMessage(); });
		}
		if ('IntersectionObserver' in window) {
			var pgObs = new IntersectionObserver(function(entries) {
				if (!entries.some(function(e) { return e.isIntersecting; })) return;
				pgObs.disconnect();
				bootPlayground();
			}, { rootMargin: '400px 0px' });
			pgObs.observe(preview);
		} else {
			bootPlayground();
		}
	})();

	// ── Showcase 3D — live agent grid ──────────────────────────────
	(function () {
		const SHOWCASE_ANIMS = ['idle', 'dance', 'wave', 'celebrate', 'capoeira', 'thriller'];
		const SHOWCASE_TAGS = ['3D', 'animated', 'rigged', 'ERC-8004', 'pay-per-call', 'community'];
		// Pull real public 3D avatars (each a distinct GLB). source=all is dominated
		// by GLB-less on-chain registrations, which would fall through to duplicated
		// placeholder models — so we ask the avatar source for 3D rows only, then
		// dedupe by model + name and take the first 6 unique ones.
		const EXPLORE_SHOWCASE_URL = '/api/explore?source=avatar&only3d=1&category=avatar,creature&limit=24&quality=high';
		const grid = document.getElementById('showcase-3d-grid');
		if (!grid) return;

		function hashHue(str) {
			var h = 0;
			for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
			return h % 360;
		}

		function makeAgentCard(item, idx) {
			var card = document.createElement('a');
			card.className = 'showcase-agent-card';
			// The canonical avatar detail page, not the bare GLB viewer: the
			// detail template carries chat, skills, embed, and launch actions.
			card.href = item.detailUrl || ('/avatars/' + (item.avatarId || item.agentId));

			var h = hashHue(item.avatarId || item.agentId || item.name || String(idx));
			var h2 = (h + 50) % 360;
			var grad = document.createElement('div');
			grad.className = 'showcase-card-grad';
			grad.style.background = 'radial-gradient(ellipse at 50% 80%, hsl(' + h + ' 60% 18% / 0.6) 0%, hsl(' + h2 + ' 50% 6% / 0.3) 70%, transparent 100%)';
			card.appendChild(grad);

			var skel = document.createElement('div');
			skel.className = 'showcase-card-skel';
			skel.innerHTML = '<div class="showcase-card-skel-ring"></div>';
			card.appendChild(skel);

			var floor = document.createElement('div');
			floor.className = 'showcase-card-floor';
			card.appendChild(floor);

			var glbUrl = item.glbUrl || '';
			if (glbUrl) {
				glbUrl = devProxyGlb(glbUrl);
			} else if (item.avatarId) {
				(async function() {
					try {
						var r = await fetch('/api/avatars/' + item.avatarId);
						var d = await r.json();
						var url = devProxyGlb(d.avatar?.model_url || d.avatar?.url);
						if (url) bootAgent(card, skel, url, idx);
					} catch (_) {}
				})();
			}

			if (item.kind === 'onchain') {
				var tag = document.createElement('span');
				tag.className = 'showcase-card-tag';
				tag.textContent = 'Blockchain';
				card.appendChild(tag);
			} else if (idx === 0) {
				var ftag = document.createElement('span');
				ftag.className = 'showcase-card-tag';
				ftag.textContent = 'Featured';
				card.appendChild(ftag);
			}

			var animLabel = document.createElement('span');
			animLabel.className = 'showcase-card-anim-tag';
			animLabel.textContent = SHOWCASE_TAGS[idx % SHOWCASE_TAGS.length];
			card.appendChild(animLabel);

			var meta = document.createElement('div');
			meta.className = 'showcase-card-meta';
			meta.innerHTML = '<div class="showcase-card-name">' + escHtml(item.name || 'Agent') + '</div>'
				+ '<div class="showcase-card-sub">' + escHtml(item.description ? item.description.slice(0, 50) : (item.kind === 'onchain' ? 'ERC-8004' : 'GLB')) + '</div>';
			card.appendChild(meta);

			if (glbUrl) bootAgent(card, skel, glbUrl, idx);

			return card;
		}

		function bootAgent(card, skel, glbUrl, idx) {
			var el = document.createElement('agent-3d');
			el.setAttribute('body', glbUrl);
			el.setAttribute('mode', 'inline');
			el.setAttribute('responsive', '');
			el.setAttribute('background', 'transparent');
			el.setAttribute('name-plate', 'off');
			el.setAttribute('avatar-chat', 'off');
			el.setAttribute('kiosk', '');
			card.insertBefore(el, skel);

			el.addEventListener('agent:ready', function () {
				el.classList.add('loaded');
				if (skel && skel.parentNode) skel.remove();
				var anim = SHOWCASE_ANIMS[idx % SHOWCASE_ANIMS.length];
				if (anim !== 'idle') {
					el.play?.(anim, { loop: true, fade_ms: 600 });
				}
			}, { once: true });
		}

		function makeCta(href, icon, label, sub) {
			var a = document.createElement('a');
			a.className = 'showcase-cta-card';
			a.href = href;
			a.innerHTML = '<span class="showcase-cta-icon">' + icon + '</span>'
				+ '<span class="showcase-cta-label">' + label + '</span>'
				+ '<span class="showcase-cta-sub">' + sub + '</span>';
			return a;
		}

		function escHtml(s) {
			var d = document.createElement('span');
			d.textContent = s;
			return d.innerHTML;
		}

		// Drop repeats so every showcase card is a distinct character: collapse on
		// both the underlying model (glbUrl/avatarId) and the display name.
		function dedupeAgents(list) {
			var seen = Object.create(null);
			return list.filter(function (it) {
				var modelKey = String(it.glbUrl || it.avatarId || '').toLowerCase();
				var nameKey = String(it.name || '').trim().toLowerCase();
				if (modelKey && seen['m:' + modelKey]) return false;
				if (nameKey && seen['n:' + nameKey]) return false;
				if (modelKey) seen['m:' + modelKey] = true;
				if (nameKey) seen['n:' + nameKey] = true;
				return true;
			});
		}

		function renderShowcase(agentItems) {
			agentItems.forEach(function (item, i) {
				grid.appendChild(makeAgentCard(item, i));
			});
			grid.appendChild(makeCta('/discover', '→', 'Browse all', 'Public agent directory'));
			grid.appendChild(makeCta('/create', '✨', 'Make your own', 'Selfie → agent · 60s'));
		}

		var showcaseBooted = false;
		var showcaseObs = new IntersectionObserver(function (entries) {
			if (!entries[0].isIntersecting || showcaseBooted) return;
			showcaseBooted = true;
			showcaseObs.disconnect();

			fetch(EXPLORE_SHOWCASE_URL, { headers: { accept: 'application/json' } })
				.then(function (r) { return r.json(); })
				.then(function (data) {
					var items = Array.isArray(data.items) ? data.items : [];
					var agentItems = dedupeAgents(items.filter(function (it) { return it.glbUrl || it.avatarId; })).slice(0, 6);
					// Real avatars only. If the feed is thin or empty the grid
					// degrades to its two CTA cards (Browse all / Make your own) —
					// never to fabricated demo agents.
					renderShowcase(agentItems);
				})
				.catch(function () {
					renderShowcase([]);
				});
		}, { rootMargin: '200px' });
		showcaseObs.observe(grid);
	})();

		// ── Vclose section ──────────────────────────────────────────────
	(async () => {
		try {
			const pool = await getAvatarPool();
			const glb = pool[1];
			if (!glb) return;

			const slot = document.getElementById('vclose-agent-slot');
			if (!slot) return;
			const vcloseEl = document.createElement('agent-3d');
			vcloseEl.id = 'vclose-agent';
			vcloseEl.className = 'vclose-agent';
			vcloseEl.setAttribute('body', glb);
			vcloseEl.setAttribute('mode', 'inline');
			vcloseEl.setAttribute('responsive', '');
			vcloseEl.setAttribute('background', 'transparent');
			vcloseEl.setAttribute('name-plate', 'off');
			vcloseEl.setAttribute('avatar-chat', 'off');
			vcloseEl.setAttribute('kiosk', '');
			slot.replaceWith(vcloseEl);

			let vcloseInited = false;
			const ANIMS = ['wave','dance','capoeira','jump','thriller','pray','celebrate','rumba','falling','kiss','taunt'];
			let vcloseLast = null;

			function vcloseReady() {
				if (vcloseInited) return;
				vcloseInited = true;
				vcloseEl.classList.add('loaded');
				vcloseEl.play?.('idle', { loop: true, fade_ms: 400 });
			}
			vcloseEl.addEventListener('agent:ready', vcloseReady, { once: true });

			const vcloseChips = document.getElementById('vclose-chips');
			if (vcloseChips) {
				vcloseChips.addEventListener('click', (e) => {
					const btn = e.target.closest('.hero-chip');
					if (!btn) return;
					let clip = btn.dataset.anim;
					if (clip === '__random') {
						const pool = ANIMS.filter(a => a !== vcloseLast);
						clip = pool[Math.floor(Math.random() * pool.length)];
					}
					vcloseLast = clip;
					vcloseChips.querySelectorAll('.hero-chip').forEach(c => delete c.dataset.active);
					btn.dataset.active = 'true';
					vcloseEl.play?.(clip, { loop: false, fade_ms: 400 });
					clearTimeout(vcloseChips._timer);
					vcloseChips._timer = setTimeout(() => delete btn.dataset.active, 6000);
				});
			}

			const vcloseSection = document.getElementById('vclose');
			if (vcloseSection) {
				const io = new IntersectionObserver((entries) => {
					if (entries[0].isIntersecting && !vcloseInited) {
						vcloseReady();
					}
				}, { threshold: 0, rootMargin: '200px' });
				io.observe(vcloseSection);
			}
		} catch (e) {
			console.warn('[home] vclose avatar boot failed', e);
		}
	})();

	// ── Reveal on scroll (IntersectionObserver) ────────────────────
	{
		const revealEls = document.querySelectorAll('.reveal');
		if (revealEls.length) {
			const revealObs = new IntersectionObserver((entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						entry.target.classList.add('vis');
						revealObs.unobserve(entry.target);
					}
				});
			}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
			revealEls.forEach((el) => revealObs.observe(el));
		}
	}

	// ── Hero text entrance ──────────────────────────────────────────
	requestAnimationFrame(() => {
		const heroText = document.querySelector('.hero-text');
		if (heroText) heroText.classList.add('entered');
	});

	// ── 3D Stack section: mouse-tracked perspective + spotlight ─────
	{
		const scene = document.getElementById('stack-3d-scene');
		const wrap  = document.getElementById('stack-3d');
		if (scene && wrap && window.matchMedia('(min-width: 601px)').matches
			&& !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			let rx = 0, ry = 0, tx = 0, ty = 0;
			const lerp = (a, b, t) => a + (b - a) * t;

			wrap.addEventListener('mousemove', (e) => {
				const r = wrap.getBoundingClientRect();
				const nx = (e.clientX - r.left) / r.width;
				const ny = (e.clientY - r.top) / r.height;
				tx = (nx - 0.5) * 8;
				ty = -(ny - 0.5) * 5;
			});
			wrap.addEventListener('mouseleave', () => { tx = 0; ty = 0; });

			(function tick() {
				rx = lerp(rx, ty, 0.06);
				ry = lerp(ry, tx, 0.06);
				scene.style.transform =
					`rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
				requestAnimationFrame(tick);
			})();

			// Cache the card list + rects once and batch CSS-var writes into a
			// single rAF per frame, so the glow no longer forces a layout read per
			// card on every mousemove (the landing page's worst thrash hot path).
			const glowCards = Array.from(scene.querySelectorAll('.stack-card'));
			let glowRects = glowCards.map((c) => c.getBoundingClientRect());
			const refreshGlowRects = () => { glowRects = glowCards.map((c) => c.getBoundingClientRect()); };
			window.addEventListener('resize', refreshGlowRects, { passive: true });
			window.addEventListener('scroll', refreshGlowRects, { passive: true });
			let glowX = 0, glowY = 0, glowPending = false;
			scene.addEventListener('mousemove', (e) => {
				glowX = e.clientX; glowY = e.clientY;
				if (glowPending) return;
				glowPending = true;
				requestAnimationFrame(() => {
					glowPending = false;
					for (let i = 0; i < glowCards.length; i++) {
						const cr = glowRects[i];
						glowCards[i].style.setProperty('--mx', (glowX - cr.left) + 'px');
						glowCards[i].style.setProperty('--my', (glowY - cr.top) + 'px');
					}
				});
			}, { passive: true });
		}

		if (wrap) {
			setTimeout(() => wrap.classList.add('settled'), 800);
		}
	}


	// ── Live feature agents ─────────────────────────────────────────
	(function initLiveFeatures() {
		var O = location.origin;
		// `clip` is declarative: the <agent-3d> component honors each clip's
		// manifest loop flag automatically — one-shots (wave) play once and settle
		// into idle, loops (rumba/idle) loop seamlessly. No forced loop, so the old
		// celebrate hard-snap is gone. `framing="portrait"` crops head-to-mid-thigh
		// so the avatar fills the card instead of standing tiny-and-low.
		//
		// Portrait framing sizes the camera to the avatar's *load-time* bounding box
		// (before any retargeted clip applies), so the body MUST ship arms-down at
		// rest. T-pose-authored rigs (michelle, xbot — arms stretched horizontally)
		// blow up the box width, push the camera far back, and leave a tiny figure
		// stranded at the bottom of the card. Use rest-arms-down bodies here:
		// default.glb and cz.glb (both in the curated portrait-safe POOL_FALLBACKS).
		var LIVE_SPOTS = [
			{ id: 'door-create',  clip: 'wave',  framing: 'portrait', glb: O + '/avatars/default.glb' },
			{ id: 'door-embed',   clip: 'rumba', framing: 'portrait', glb: O + '/avatars/cz.glb' },
			{ id: 'bento-studio', clip: 'idle',  framing: 'portrait', glb: null },
			{ id: 'bento-anim',   clip: 'idle',  framing: 'full',     glb: null }
		];

		function spawnMini(container, glb, opts) {
			var el = document.createElement('agent-3d');
			el.setAttribute('body', glb);
			el.setAttribute('mode', 'inline');
			el.setAttribute('responsive', '');
			el.setAttribute('background', 'transparent');
			el.setAttribute('name-plate', 'off');
			el.setAttribute('avatar-chat', 'off');
			el.setAttribute('kiosk', '');
			if (opts.clip) el.setAttribute('clip', opts.clip);
			if (opts.framing) el.setAttribute('framing', opts.framing);
			el.setAttribute('eager', '');
			container.appendChild(el);
			// The component autoplays the declared clip with the polished embed
			// defaults (skeleton load state, loop-honoring + one-shot→idle settle,
			// reduced-motion static pose, offscreen render pause). No ready hook.
			return el;
		}

		// Assign unique pool avatars to spots that don't have a hardcoded local GLB.
		// pool[0] and pool[1] are reserved for WYG and vclose; null spots start at pool[2].
		getAvatarPool()
			.then(function(pool) {
				var nullIdx = 2;
				LIVE_SPOTS.forEach(function(spot) {
					if (!spot.glb) {
						spot.glb = pool[nullIdx++ % pool.length];
					}
				});
				var io = new IntersectionObserver(function(entries) {
					entries.forEach(function(entry) {
						if (!entry.isIntersecting) return;
						var spot = LIVE_SPOTS.find(function(s) { return s.id === entry.target.id; });
						if (!spot || entry.target.querySelector('agent-3d')) return;
						io.unobserve(entry.target);
						spawnMini(entry.target, spot.glb, spot);
					});
				}, { rootMargin: '150px' });
				LIVE_SPOTS.forEach(function(spot) {
					var el = document.getElementById(spot.id);
					if (el) io.observe(el);
				});
			}).catch(function() {});

		// Bento animation pills
		var animPills = document.getElementById('bento-anim-pills');
		if (animPills) {
			animPills.addEventListener('click', function(e) {
				var btn = e.target.closest('.bento-pill-btn');
				if (!btn) return;
				e.preventDefault(); e.stopPropagation();
				var clip = btn.dataset.anim;
				var agent = document.querySelector('#bento-anim agent-3d');
				// Explicit user gesture → playClip honors the clip's loop flag,
				// settles one-shots into idle, and is allowed to animate even under
				// reduced motion. Fall back to play() on older bundles.
				if (agent && agent.playClip) agent.playClip(clip, { userInitiated: true });
				else if (agent && agent.play) agent.play(clip, { loop: clip === 'idle', fade_ms: 400 });
				animPills.querySelectorAll('.bento-pill-btn').forEach(function(p) { p.classList.remove('active'); });
				btn.classList.add('active');
			});
		}

		// Earn door — one-time count-up reveal of an illustrative example figure.
		// The number is labeled "example earnings" in the markup; it is not live
		// platform data (real earnings live behind auth on /dashboard/monetize).
		var earnVal = document.getElementById('door-earn-val');
		var earnViz = document.getElementById('door-earn-viz');
		if (earnVal) {
			var started = false;
			var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			var EARN_EXAMPLE = 128.40;
			var earnObs = new IntersectionObserver(function(entries) {
				if (!entries[0].isIntersecting || started) return;
				started = true; earnObs.disconnect();
				if (earnViz) earnViz.classList.add('is-live');

				if (reduceMotion) {
					earnVal.textContent = '$' + EARN_EXAMPLE.toFixed(2);
					return;
				}
				var val = 0;
				(function tick() {
					val += (EARN_EXAMPLE - val) * 0.025;
					if (val >= EARN_EXAMPLE - 0.01) val = EARN_EXAMPLE;
					earnVal.textContent = '$' + val.toFixed(2);
					if (val < EARN_EXAMPLE) requestAnimationFrame(tick);
				})();
			}, { threshold: 0.35 });
			earnObs.observe(earnVal);
		}
	})();
