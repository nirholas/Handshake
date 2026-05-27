/**
 * home-v4 scroll orchestration:
 * - Scroll reveal animations
 * - Experience section: Act2Viewer + animation chips + model picker
 * - Stats bar from /api/home-stats
 * - CTA section wave avatar
 */

const LOW_MEMORY = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory < 2;

/* ── Scroll reveal ───────────────────────────────────── */
(function initReveals() {
	const els = document.querySelectorAll('.v4-reveal');
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					entry.target.classList.add('revealed');
					observer.unobserve(entry.target);
				}
			}
		},
		{ root: null, threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
	);
	for (const el of els) {
		const siblings = Array.from(el.parentElement.querySelectorAll('.v4-reveal'));
		const idx = siblings.indexOf(el);
		el.style.transitionDelay = idx * 0.08 + 's';
		observer.observe(el);
	}
})();

/* ── Stats ───────────────────────────────────────────── */
(async function loadStats() {
	try {
		const r = await fetch('/api/home-stats');
		if (!r.ok) return;
		const data = await r.json();
		if (!data || data.available === false) return;
		const agentEl = document.querySelector('[data-stat="agents"]');
		const onchainEl = document.querySelector('[data-stat="onchain"]');
		if (agentEl && data.agents != null) agentEl.textContent = formatNum(data.agents);
		if (onchainEl && data.onchain != null) onchainEl.textContent = formatNum(data.onchain);
	} catch { /* non-critical */ }
})();

function formatNum(n) {
	if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
	return String(n);
}

/* ── Experience section: Act2Viewer + animation chips ── */
(function initExperience() {
	const canvas = document.getElementById('v4-exp-canvas');
	if (!canvas || LOW_MEMORY) return;

	let viewer = null;
	let currentModelUrl = '/avatars/cz.glb';
	let activeChip = null;

	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting && !viewer) {
				observer.disconnect();
				boot();
			}
		},
		{ rootMargin: '600px' },
	);
	observer.observe(canvas);

	function boot() {
		if (!window.Act2Viewer) return;
		viewer = new window.Act2Viewer(canvas, { fov: 14 });

		viewer.onClipsReady = (clips) => {
			buildChips(clips);
		};

		viewer.loadModel(currentModelUrl);

		const modelBtns = document.querySelectorAll('.v4-model-btn');
		for (const btn of modelBtns) {
			btn.addEventListener('click', () => {
				const url = btn.dataset.model;
				if (url === currentModelUrl) return;
				currentModelUrl = url;
				for (const b of modelBtns) b.classList.remove('active');
				btn.classList.add('active');
				viewer.loadModel(url);
			});
		}
	}

	function buildChips(clips) {
		const container = document.getElementById('v4-anim-chips');
		if (!container) return;
		container.innerHTML = '';
		activeChip = null;

		for (const def of clips) {
			const btn = document.createElement('button');
			btn.className = 'v4-chip';
			btn.textContent = def.label || def.name;
			btn.addEventListener('click', () => {
				if (activeChip) activeChip.classList.remove('active');
				btn.classList.add('active');
				activeChip = btn;
				viewer.playClip(def.name);
			});
			container.appendChild(btn);
		}
	}
})();

/* ── CTA section wave avatar ─────────────────────────── */
(function initCloseViewer() {
	const canvas = document.getElementById('v4-close-canvas');
	if (!canvas || LOW_MEMORY) return;

	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting) {
				observer.disconnect();
				boot();
			}
		},
		{ rootMargin: '400px' },
	);
	observer.observe(canvas);

	async function boot() {
		if (!window.Act2Viewer) return;
		const viewer = new window.Act2Viewer(canvas, { fov: 14 });
		await viewer.loadModel('/avatars/cz.glb', { autoPlay: false });
		const waveClip = viewer.listAvailableClips().find(c => /wave|waving/i.test(c.name));
		if (waveClip) {
			viewer.playClip(waveClip.name);
		} else {
			const clips = viewer.listAvailableClips();
			if (clips.length) viewer.playClip(clips[0].name);
		}
	}
})();
