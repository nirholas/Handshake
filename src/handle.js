// /@<handle> — live profile page for a three.ws user.
//
// Renders the user's primary avatar in a hosted iframe (same /embed/avatar/:handle
// surface third-party sites embed) and surfaces copy-paste embed snippets.
// The iframe is the canonical runtime — this page never touches Three.js
// directly, so it stays small and the avatar runtime is identical wherever
// it shows up.

const main = document.getElementById('main');

const handle = (() => {
	const parts = location.pathname.split('/').filter(Boolean);
	// Accept /@nick, /@/nick, /handle/nick, /u/nick
	for (const p of parts) {
		if (p.startsWith('@')) return p.slice(1).toLowerCase();
	}
	if (parts[0] === 'u' && parts[1]) return parts[1].toLowerCase();
	if (parts[0] === 'handle' && parts[1]) return parts[1].toLowerCase();
	return new URL(location.href).searchParams.get('handle')?.toLowerCase() || '';
})();

if (!handle) {
	renderNotFound('No handle in the URL.');
} else {
	render(handle).catch((err) => {
		console.error('[handle] render failed', err);
		renderNotFound(err?.message || 'Could not load this profile.');
	});
}

async function render(name) {
	const resp = await fetch(`/api/users/${encodeURIComponent(name)}/avatar?bg=dark&idle=on`);
	if (!resp.ok) {
		if (resp.status === 404) {
			renderNotFound(`@${name} doesn't have a public avatar yet.`);
			return;
		}
		const body = await resp.json().catch(() => null);
		throw new Error(body?.message || `request failed (${resp.status})`);
	}
	const data = await resp.json();
	const user = data.user;
	const avatar = data.avatar;

	document.title = `@${user.username} — three.ws`;
	const og = (id, value) => {
		const el = document.getElementById(id);
		if (el) el.setAttribute('content', value);
	};
	og('og-title', `@${user.username} on three.ws`);
	og('tw-title', `@${user.username} on three.ws`);
	const desc = avatar.description || `${user.display_name || user.username}'s live 3D avatar — embed me anywhere.`;
	og('og-description', desc);
	og('tw-description', desc);
	if (avatar.thumbnail_url) {
		og('og-image', avatar.thumbnail_url);
		og('tw-image', avatar.thumbnail_url);
	}

	const stats = [
		{ k: 'morph coverage', v: '—' }, // filled from v1.avatar.ready
		{ k: 'size', v: humanBytes(avatar.size_bytes) },
		{ k: 'version', v: `v${avatar.version || 1}` },
	];

	const embedUrl = data.embed_url || `${location.origin}/embed/avatar/${user.username}`;
	const scriptSnippet =
		data.embed?.script ||
		`<script async src="${location.origin}/embed.js" data-avatar="@${user.username}"></script>`;
	const iframeSnippet =
		data.embed?.iframe ||
		`<iframe src="${embedUrl}" width="420" height="600" frameborder="0" allow="autoplay; camera; clipboard-write; xr-spatial-tracking" style="border-radius:12px;"></iframe>`;

	main.innerHTML = `
		<section class="stage">
			<iframe id="avatar-frame" src="${escapeAttr(embedUrl)}" allow="autoplay; camera; clipboard-write; xr-spatial-tracking" title="@${escapeAttr(user.username)}"></iframe>
			<div class="stage-overlay">
				<button class="chip" data-action="speak">say hello</button>
				<button class="chip" data-action="emote-smile">smile</button>
				<button class="chip" data-action="emote-wink">wink</button>
				<button class="chip" data-action="mocap">webcam mocap</button>
			</div>
		</section>
		<aside class="side">
			<h1>${escapeHtml(user.display_name || user.username)}</h1>
			<div class="handle">@${escapeHtml(user.username)} · <a href="/u/${escapeAttr(user.username)}" style="color:rgba(255,255,255,0.55)">full profile →</a></div>
			${avatar.description ? `<p class="desc">${escapeHtml(avatar.description)}</p>` : ''}
			<div class="stat-grid">
				${stats.map((s) => `<div class="stat"><div class="v" data-stat="${escapeAttr(s.k)}">${escapeHtml(s.v)}</div><div class="k">${escapeHtml(s.k)}</div></div>`).join('')}
			</div>
			<div class="cta-row">
				<a href="${escapeAttr(avatar.base_model_url || avatar.model_url)}" download>download .glb</a>
				<a class="ghost" href="/avatars/${escapeAttr(avatar.id)}">avatar page</a>
			</div>
			<div class="embed-card">
				<h3>Embed anywhere — script tag</h3>
				<pre id="snippet-script">${escapeHtml(scriptSnippet)}</pre>
				<button class="copy" data-copy="snippet-script">Copy snippet</button>
			</div>
			<div class="embed-card">
				<h3>Embed anywhere — iframe</h3>
				<pre id="snippet-iframe">${escapeHtml(iframeSnippet)}</pre>
				<button class="copy" data-copy="snippet-iframe">Copy iframe</button>
			</div>
			<div class="embed-card">
				<h3>API</h3>
				<pre>GET /api/users/${escapeHtml(user.username)}/avatar
GET ${escapeHtml(avatar.model_url)}</pre>
			</div>
		</aside>
	`;

	// ── postMessage bridge to the embed ──────────────────────────────────
	const iframe = document.getElementById('avatar-frame');
	const send = (msg) => {
		try {
			iframe.contentWindow?.postMessage(msg, new URL(embedUrl).origin);
		} catch (err) {
			console.warn('[handle] postMessage failed', err);
		}
	};

	window.addEventListener('message', (ev) => {
		if (ev.source !== iframe.contentWindow) return;
		const msg = ev.data;
		if (!msg || typeof msg !== 'object') return;
		if (msg.type === 'v1.avatar.ready') {
			const cov = msg.conformance
				? `${Math.round((msg.conformance.coverage || 0) * 100)}%`
				: '—';
			const el = document.querySelector('[data-stat="morph coverage"]');
			if (el) el.textContent = cov;
			send({ type: 'v1.avatar.hello' });
		}
	});

	// Optimistically open the handshake — embed will reply with ready when it
	// finishes init, even if our hello arrives early.
	const tryHello = () => send({ type: 'v1.avatar.hello' });
	iframe.addEventListener('load', tryHello);

	// ── Wire the demo chips ───────────────────────────────────────────────
	main.querySelectorAll('[data-action]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const action = btn.dataset.action;
			if (action === 'speak') {
				send({
					type: 'v1.avatar.speak',
					text: `Hey, I'm ${user.display_name || user.username}. You can drop me anywhere.`,
				});
			} else if (action === 'emote-smile') {
				send({ type: 'v1.avatar.morphs', weights: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 } });
				setTimeout(() => send({ type: 'v1.avatar.morphs', weights: { mouthSmileLeft: 0, mouthSmileRight: 0, cheekSquintLeft: 0, cheekSquintRight: 0 } }), 1800);
			} else if (action === 'emote-wink') {
				send({ type: 'v1.avatar.emote', name: 'eyeBlinkLeft', weight: 1 });
				setTimeout(() => send({ type: 'v1.avatar.emote', name: 'eyeBlinkLeft', weight: 0 }), 220);
			} else if (action === 'mocap') {
				send({ type: 'v1.avatar.mocap', enabled: true });
			}
		});
	});

	// ── Copy snippets ─────────────────────────────────────────────────────
	main.querySelectorAll('[data-copy]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const sourceId = btn.dataset.copy;
			const text = document.getElementById(sourceId)?.textContent || '';
			try {
				await navigator.clipboard.writeText(text);
				const original = btn.textContent;
				btn.textContent = 'Copied';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = original;
					btn.classList.remove('copied');
				}, 1400);
			} catch (err) {
				console.warn('[handle] clipboard failed', err);
			}
		});
	});
}

function renderNotFound(reason) {
	main.innerHTML = `
		<div class="not-found" style="grid-column: 1 / -1">
			<h1>Nothing to render</h1>
			<p>${escapeHtml(reason || 'Profile not found.')}</p>
			<p><a href="/explore">Browse avatars on three.ws →</a></p>
		</div>
	`;
}

function humanBytes(n) {
	const v = Number(n) || 0;
	if (!v) return '—';
	const units = ['B', 'KB', 'MB', 'GB'];
	let u = 0;
	let x = v;
	while (x >= 1024 && u < units.length - 1) {
		x /= 1024;
		u++;
	}
	return `${x.toFixed(x < 10 ? 1 : 0)} ${units[u]}`;
}

function escapeHtml(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
function escapeAttr(s) {
	return escapeHtml(s);
}
