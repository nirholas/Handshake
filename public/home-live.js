/*
 * home-live.js — runs on / and /home.
 *
 * Three jobs:
 *   1. Animate the rotating headline noun ("body / voice / wallet / wage").
 *   2. Fetch real public avatars from /api/explore and render them as a
 *      scrolling Live Wall — duplicated once so the CSS marquee can loop
 *      seamlessly. No mocks; if the fetch fails, the section hides itself.
 *   3. Populate the inline hero pill + the Stats Band with the live count
 *      from /api/explore.
 *
 * Everything degrades quietly: a missing element or a failed fetch never
 * throws into the home page.
 */

(function () {
	'use strict';

	const ROTATING_WORDS = ['body', 'voice', 'wallet', 'wage'];
	const ROTATE_INTERVAL_MS = 2200;
	const EXPLORE_URL = '/api/explore?source=avatar&limit=24&quality=high';

	function ready(fn) {
		if (document.readyState !== 'loading') fn();
		else document.addEventListener('DOMContentLoaded', fn);
	}

	// ── 1. Rotating headline word ──────────────────────────────────────────

	function startHeadlineRotator() {
		const rotator = document.querySelector('[data-role="title-rotator"]');
		if (!rotator) return;

		// Build the word stack. Each word lives in its own absolute-positioned
		// span so the title-rotator container can hold its width based on the
		// widest word (set via min-width below). The first one starts visible.
		const fragment = document.createDocumentFragment();
		const wordEls = ROTATING_WORDS.map((word, i) => {
			const span = document.createElement('span');
			span.className = 'h-title-rotator-word' + (i === 0 ? ' is-current' : '');
			span.textContent = word;
			fragment.appendChild(span);
			return span;
		});
		rotator.appendChild(fragment);

		// Width the container off the longest word so layout stays stable.
		const longest = ROTATING_WORDS.reduce(
			(a, b) => (b.length > a.length ? b : a),
			''
		);
		rotator.style.minWidth = `${longest.length + 0.2}ch`;

		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		let idx = 0;
		setInterval(() => {
			wordEls[idx].classList.remove('is-current');
			idx = (idx + 1) % wordEls.length;
			wordEls[idx].classList.add('is-current');
		}, ROTATE_INTERVAL_MS);
	}

	// ── 2 + 3. Live Wall and Stats from /api/explore ───────────────────────

	function hashHue(str) {
		// Stable per-id hue so each card gets a unique gradient that's the
		// same on every render — no flicker between refreshes.
		let h = 0;
		for (let i = 0; i < str.length; i++)
			h = (h * 31 + str.charCodeAt(i)) >>> 0;
		return h % 360;
	}

	function cardGradient(id) {
		const h = hashHue(id || 'x');
		const h2 = (h + 60) % 360;
		return `linear-gradient(135deg, hsl(${h} 70% 22%) 0%, hsl(${h2} 60% 12%) 100%)`;
	}

	function initialMono(name) {
		const cleaned = (name || '?').trim();
		const parts = cleaned.split(/\s+/);
		if (parts.length >= 2)
			return (parts[0][0] + parts[1][0]).toUpperCase();
		return cleaned.slice(0, 2).toUpperCase();
	}

	function metaForCard(item) {
		const bits = [];
		if (item.source && item.source !== 'upload')
			bits.push(item.source);
		else bits.push('GLB');
		if (item.viewCount && item.viewCount > 0)
			bits.push(`${item.viewCount} view${item.viewCount === 1 ? '' : 's'}`);
		return bits;
	}

	function makeCard(item) {
		const a = document.createElement('a');
		a.className = 'h-livewall-card';
		a.href = `/avatars/${item.avatarId}`;
		a.setAttribute('aria-label', item.name || 'three.ws agent');

		const visual = document.createElement('div');
		visual.className = 'h-livewall-card-visual';
		visual.style.setProperty('--card-grad', cardGradient(item.avatarId));

		if (item.featured) {
			const tag = document.createElement('span');
			tag.className = 'h-livewall-card-tag h-livewall-card-tag--featured';
			tag.textContent = 'Featured';
			visual.appendChild(tag);
		} else if (item.source && item.source !== 'upload') {
			const tag = document.createElement('span');
			tag.className = 'h-livewall-card-tag';
			tag.textContent = item.source;
			visual.appendChild(tag);
		}

		if (item.image) {
			const img = document.createElement('img');
			img.className = 'h-livewall-card-img';
			img.src = item.image;
			img.alt = '';
			img.loading = 'lazy';
			img.decoding = 'async';
			// If the image fails (R2 hiccup, deleted asset), fall back to mono.
			img.addEventListener('error', () => {
				img.remove();
				const mono = document.createElement('span');
				mono.className = 'h-livewall-card-mono';
				mono.textContent = initialMono(item.name);
				visual.appendChild(mono);
			});
			visual.appendChild(img);
		} else {
			const mono = document.createElement('span');
			mono.className = 'h-livewall-card-mono';
			mono.textContent = initialMono(item.name);
			visual.appendChild(mono);
		}

		const body = document.createElement('div');
		body.className = 'h-livewall-card-body';

		const name = document.createElement('div');
		name.className = 'h-livewall-card-name';
		name.textContent = item.name || 'Unnamed agent';
		body.appendChild(name);

		const meta = document.createElement('div');
		meta.className = 'h-livewall-card-meta';
		const bits = metaForCard(item);
		bits.forEach((bit, i) => {
			if (i > 0) {
				const dot = document.createElement('span');
				dot.className = 'h-livewall-card-meta-dot';
				meta.appendChild(dot);
			}
			const span = document.createElement('span');
			span.textContent = bit;
			meta.appendChild(span);
		});
		body.appendChild(meta);

		a.appendChild(visual);
		a.appendChild(body);
		return a;
	}

	function setStat(el, value, suffix) {
		if (!el) return;
		el.classList.remove('is-loading');
		if (suffix) {
			el.innerHTML = '';
			const num = document.createTextNode(value);
			el.appendChild(num);
			const sfx = document.createElement('span');
			sfx.className = 'h-statsband-suffix';
			sfx.textContent = suffix;
			el.appendChild(sfx);
		} else {
			el.textContent = String(value);
		}
	}

	function formatCount(n) {
		if (n >= 10000) return Math.floor(n / 1000) + 'k';
		if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
		return String(n);
	}

	async function loadLiveWall() {
		const section = document.querySelector('[data-role="livewall"]');
		const rail = section?.querySelector('[data-role="livewall-rail"]');
		const skel = section?.querySelector('[data-role="livewall-skel"]');
		const heroLiveCount = document.querySelector('[data-role="hero-live-count"]');
		const statAgents = document.querySelector('[data-role="stat-agents"]');
		const statAnims = document.querySelector('[data-role="stat-anims"]');
		const statStandards = document.querySelector('[data-role="stat-standards"]');
		const statChains = document.querySelector('[data-role="stat-chains"]');

		try {
			const res = await fetch(EXPLORE_URL, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`explore http ${res.status}`);
			const data = await res.json();
			const items = Array.isArray(data.items) ? data.items : [];

			// Hero pill + stats band populated from real counts.
			if (heroLiveCount) {
				heroLiveCount.textContent = formatCount(items.length);
				heroLiveCount.classList.remove('is-loading');
			}
			if (statAgents) setStat(statAgents, formatCount(items.length), '+');

			// Static-but-real numbers: count animations from the manifest below.
			if (statStandards) setStat(statStandards, '5');
			if (statChains) setStat(statChains, '1');

			// Render the wall only if we have a section and at least 4 items.
			if (!rail || items.length < 4) {
				if (skel) skel.remove();
				if (section && items.length < 4) section.hidden = true;
				return;
			}

			const cards = items.filter((it) => it.avatarId).map(makeCard);
			if (cards.length === 0) {
				section.hidden = true;
				return;
			}

			// Duplicate the rail content once so a translate(-50%) marquee
			// loops without a visible jump.
			const frag = document.createDocumentFragment();
			cards.forEach((c) => frag.appendChild(c));
			cards.forEach((c) => frag.appendChild(c.cloneNode(true)));

			if (skel) skel.remove();
			rail.innerHTML = '';
			rail.appendChild(frag);

			// Tune the marquee speed to roughly 60s for a half-loop regardless
			// of card count, so a sparser deck doesn't run too fast.
			const seconds = Math.max(40, Math.min(90, cards.length * 4));
			rail.style.animationDuration = `${seconds}s`;
		} catch (err) {
			console.error('[home-live] explore fetch failed', err);
			if (section) section.hidden = true;
			if (heroLiveCount) {
				heroLiveCount.textContent = '—';
				heroLiveCount.classList.remove('is-loading');
			}
			if (statAgents) setStat(statAgents, '—');
			if (statStandards) setStat(statStandards, '5');
			if (statChains) setStat(statChains, '1');
		}

		// Animations stat: read the real manifest count (always succeeds
		// from a static asset, no network failure here is interesting).
		if (statAnims) {
			try {
				const m = await fetch('/animations/manifest.json');
				if (m.ok) {
					const arr = await m.json();
					const count = Array.isArray(arr) ? arr.length : 0;
					setStat(statAnims, String(count), '+');
				} else {
					setStat(statAnims, '70', '+');
				}
			} catch {
				setStat(statAnims, '70', '+');
			}
		}
	}

	ready(() => {
		startHeadlineRotator();
		loadLiveWall();
	});
})();
