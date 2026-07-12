// Diorama gallery — renders the public wall of recently-forged worlds.
//
// `mountGallery` wires the `#gallery-list` grid + `#empty-state` placeholder to
// the real backend (`GET /api/diorama?list=recent`) and returns a `{ reload }`
// handle the controller calls after every save/compose. Each card is a real
// button whose 3D thumbnail is the world's first forged GLB (lazy-loaded via
// <model-viewer>, which the page already ships), so the wall is live geometry —
// never a screenshot. Degrades honestly: when persistence is off (no database)
// or the list is empty, the designed empty state explains it instead of a blank.

const LIST_URL = (limit) => `/api/diorama?list=recent&limit=${limit}`;

function esc(s) {
	return String(s ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]),
	);
}

function fmtViews(n) {
	const v = Number(n) || 0;
	if (v >= 1000) return `${(v / 1000).toFixed(1)}k views`;
	return `${v} ${v === 1 ? 'view' : 'views'}`;
}

// A single gallery card. The whole card is the button; the model-viewer thumb is
// pointer-inert so a tap always opens the world rather than orbiting the model.
function buildCard(d, onOpen) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'dio-card';
	btn.dataset.id = d.id;
	btn.setAttribute('aria-label', `Open “${d.title || 'Untitled world'}”`);

	const thumb = d.thumbnailGlb
		? `<div class="dio-card__thumb"><model-viewer src="${esc(d.thumbnailGlb)}" ` +
			`loading="lazy" reveal="auto" auto-rotate rotation-per-second="18deg" ` +
			`interaction-prompt="none" disable-zoom camera-orbit="35deg 78deg auto" ` +
			`shadow-intensity="0" exposure="0.9" style="pointer-events:none;--poster-color:transparent" ` +
			`aria-hidden="true"></model-viewer></div>`
		: `<div class="dio-card__thumb"></div>`;

	// Registered creators (d.creatorUsername, set server-side only when the
	// world was saved while signed in) get a real link back to their public
	// portfolio — the same "who made this" wiring as avatars/marketplace
	// listings. Anonymous saves show no byline, never a fabricated one.
	const bylineHtml = d.creatorUsername
		? `<a class="dio-card__by" href="/u/${esc(d.creatorUsername)}">by @${esc(d.creatorUsername)}</a>`
		: '';

	btn.innerHTML =
		thumb +
		`<div class="dio-card__body">` +
		`<p class="dio-card__title">${esc(d.title || 'Untitled world')}</p>` +
		`<p class="dio-card__prompt">${esc(d.prompt || '')}</p>` +
		`<div class="dio-card__foot">` +
		`<span class="dio-card__mood">${esc(d.mood || 'a little world')}</span>` +
		`<span>${d.objectCount || 0} pieces · ${fmtViews(d.views)}</span>` +
		`</div>${bylineHtml}</div>`;

	btn.addEventListener('click', () => {
		if (typeof onOpen === 'function' && d.id) onOpen(d.id);
	});
	// The creator byline is a real nested link (card is a <button> for the
	// primary "open world" action) — stop its click from also firing onOpen.
	btn.querySelector('.dio-card__by')?.addEventListener('click', (e) => e.stopPropagation());
	return btn;
}

/**
 * @param {{ listEl: HTMLElement, emptyEl?: HTMLElement|null, onOpen?: (id:string)=>void, limit?: number }} opts
 * @returns {{ reload: () => Promise<void> }}
 */
export function mountGallery({ listEl, emptyEl = null, onOpen, limit = 24 } = {}) {
	if (!listEl) return { reload: async () => {} };

	function setEmpty(message) {
		listEl.innerHTML = '';
		listEl.setAttribute('aria-busy', 'false');
		if (!emptyEl) return;
		if (message) emptyEl.textContent = message;
		emptyEl.hidden = false;
	}

	let loading = false;
	async function reload() {
		if (loading) return;
		loading = true;
		listEl.setAttribute('aria-busy', 'true');
		try {
			const res = await fetch(LIST_URL(limit), { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const dioramas = Array.isArray(data.dioramas) ? data.dioramas : [];

			if (!dioramas.length) {
				setEmpty(
					data.storage === false
						? 'The public wall lights up once worlds are saved. Compose one above and hit Save & share to be the first.'
						: 'No worlds yet — compose one above and it lands here for everyone to explore.',
				);
				return;
			}

			if (emptyEl) emptyEl.hidden = true;
			const frag = document.createDocumentFragment();
			for (const d of dioramas) frag.appendChild(buildCard(d, onOpen));
			listEl.innerHTML = '';
			listEl.appendChild(frag);
			listEl.setAttribute('aria-busy', 'false');
		} catch {
			// Network/parse failure is non-fatal — the composer above still works.
			setEmpty('Couldn’t load the gallery just now. Your own worlds still forge and save fine.');
		} finally {
			loading = false;
		}
	}

	return { reload };
}
