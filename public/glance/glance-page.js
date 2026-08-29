/**
 * /glance: the live playground.
 *
 * Everything on this page runs against the real endpoints. The agent it opens
 * on is, in order of preference:
 *   1. ?agent= in the URL (so a card is shareable),
 *   2. the visitor's own agent, when they are signed in (/api/glance/mine),
 *   3. the agent the platform is currently featuring (/api/agents/featured).
 * There is no sample agent and no placeholder card: if all three miss, the page
 * says so and points at /create.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 8000;

const els = {
	select: document.getElementById('agent-select'),
	input: document.getElementById('agent-input'),
	size: document.getElementById('size-select'),
	theme: document.getElementById('theme-select'),
	slot: document.getElementById('element-slot'),
	image: document.getElementById('card-image'),
	source: document.getElementById('glance-source'),
	html: document.getElementById('snippet-html'),
	md: document.getElementById('snippet-md'),
	cli: document.getElementById('snippet-cli'),
	api: document.getElementById('snippet-api'),
};

const state = { agentId: null, size: 'medium', theme: 'auto' };

async function getJson(url) {
	const res = await fetch(url, {
		credentials: 'same-origin',
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res.json();
}

async function discoverAgents() {
	const options = [];
	let note = '';

	const mine = await getJson('/api/glance/mine').catch(() => null);
	if (mine?.signedIn && mine.agents?.length) {
		for (const agent of mine.agents) options.push({ id: agent.id, name: agent.name, mine: true });
		note = 'Showing your agent. Live numbers, straight from your activity.';
	}

	const featured = await getJson('/api/agents/featured').catch(() => null);
	const featuredAgent = featured?.data;
	if (featuredAgent?.id && !options.some((o) => o.id === featuredAgent.id)) {
		options.push({
			id: featuredAgent.id,
			name: featuredAgent.display_name || featuredAgent.name || 'Featured agent',
			mine: false,
		});
		if (!note) note = 'Showing the agent three.ws is featuring right now.';
	}

	return { options, note };
}

function fillSelect(options) {
	els.select.innerHTML = '';
	if (!options.length) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = 'No agent to show yet';
		els.select.append(opt);
		els.select.disabled = true;
		return;
	}
	els.select.disabled = false;
	for (const option of options) {
		const opt = document.createElement('option');
		opt.value = option.id;
		opt.textContent = option.mine ? `${option.name} (yours)` : option.name;
		els.select.append(opt);
	}
}

function render() {
	const { agentId, size, theme } = state;
	if (!agentId) {
		els.slot.innerHTML =
			'<p class="glance-note">No agent selected yet. <a href="/create">Create one</a> and this card fills in.</p>';
		els.image.removeAttribute('src');
		return;
	}

	els.slot.innerHTML = '';
	const card = document.createElement('agent-glance');
	card.setAttribute('agent', agentId);
	card.setAttribute('size', size);
	card.setAttribute('theme', theme);
	els.slot.append(card);

	const imageUrl = `/api/glance/card?agent=${agentId}&format=svg&size=${size}&theme=${theme}`;
	const dims = { small: [240, 240], medium: [480, 200], large: [480, 300] }[size];
	els.image.width = dims[0];
	els.image.height = dims[1];
	els.image.src = imageUrl;
	els.image.alt = `Glance card for the selected agent, ${size} size`;

	const absolute = `https://three.ws${imageUrl}`;
	els.html.textContent = [
		'<script type="module" src="https://three.ws/glance/element.js"></script>',
		`<agent-glance agent="${agentId}" size="${size}" theme="${theme}"></agent-glance>`,
	].join('\n');
	els.md.textContent = `[![three.ws agent](${absolute})](https://three.ws/agents/${agentId})`;
	els.cli.textContent = `npx @three-ws/agent-glance ${agentId} --watch 60`;
	els.api.textContent = `curl -s "https://three.ws/api/glance/card?agent=${agentId}" | jq .metric`;

	const url = new URL(location.href);
	url.searchParams.set('agent', agentId);
	history.replaceState(null, '', url);
}

function wireCopyButtons() {
	for (const button of document.querySelectorAll('button.copy')) {
		button.addEventListener('click', async () => {
			const source = document.getElementById(button.dataset.copy);
			try {
				await navigator.clipboard.writeText(source.textContent);
				button.textContent = 'Copied';
				button.dataset.state = 'done';
			} catch {
				// Clipboard permission denied (or an insecure context): select the
				// text so the copy is still one keystroke away.
				const range = document.createRange();
				range.selectNodeContents(source);
				const selection = getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				button.textContent = 'Press copy';
			}
			setTimeout(() => {
				button.textContent = 'Copy';
				delete button.dataset.state;
			}, 1800);
		});
	}
}

function wireControls() {
	els.select.addEventListener('change', () => {
		if (!els.select.value) return;
		state.agentId = els.select.value;
		els.input.value = '';
		els.input.removeAttribute('aria-invalid');
		render();
	});

	els.input.addEventListener('input', () => {
		const value = els.input.value.trim();
		if (!value) {
			els.input.removeAttribute('aria-invalid');
			return;
		}
		if (!UUID_RE.test(value)) {
			els.input.setAttribute('aria-invalid', 'true');
			return;
		}
		els.input.removeAttribute('aria-invalid');
		state.agentId = value;
		els.source.textContent = 'Showing the agent you pasted.';
		render();
	});

	els.size.addEventListener('change', () => {
		state.size = els.size.value;
		render();
	});
	els.theme.addEventListener('change', () => {
		state.theme = els.theme.value;
		render();
	});
}

/**
 * Android hand-off. The page mints a widget token (POST /api/glance/token)
 * and opens the intent: URL the server returns; Chrome routes it to the app's
 * link activity, which stores the token and offers to pin the widget. A
 * visitor who arrives with ?link=android (the tap target of an unlinked
 * widget) is walked through it without pressing anything.
 */
const android = {
	button: document.getElementById('android-link-button'),
	status: document.getElementById('android-link-status'),
	devices: document.getElementById('devices'),
	list: document.getElementById('device-list'),
};

function deviceLabel() {
	const ua = navigator.userAgent;
	const model = ua.match(/;\s*([^;)]+?)\s+Build\//);
	if (model) return model[1].trim().slice(0, 40);
	return /Android/i.test(ua) ? 'Android phone' : 'Home screen widget';
}

async function linkAndroid({ auto = false } = {}) {
	android.button.disabled = true;
	android.status.textContent = 'Linking…';
	try {
		const res = await fetch('/api/glance/token', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ platform: 'android', label: deviceLabel(), agent: state.agentId || null }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (res.status === 401) {
			const next = encodeURIComponent('/glance?link=android');
			android.status.innerHTML = `<a href="/login?next=${next}">Sign in</a> first, then come back here.`;
			if (auto) location.assign(`/login?next=${next}`);
			return;
		}
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			android.status.textContent = body.message || body.error || `Could not link (${res.status}).`;
			return;
		}
		android.status.textContent = 'Opening the three.ws app…';
		await loadDevices();
		location.assign(body.links.android);
		setTimeout(() => {
			android.status.textContent = 'Linked. Add "Agent glance" from your launcher\u2019s widget picker.';
		}, 1500);
	} catch (err) {
		android.status.textContent = `Could not link: ${err.message}`;
	} finally {
		android.button.disabled = false;
	}
}

function relative(iso) {
	if (!iso) return 'never used';
	const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

async function loadDevices() {
	let tokens;
	try {
		const res = await fetch('/api/glance/token', {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (res.status === 401) {
			android.devices.hidden = true;
			return;
		}
		if (!res.ok) throw new Error(`${res.status}`);
		tokens = (await res.json()).tokens || [];
	} catch {
		android.devices.hidden = true;
		return;
	}

	android.devices.hidden = false;
	android.list.innerHTML = '';
	if (!tokens.length) {
		const li = document.createElement('li');
		li.className = 'glance-device-empty';
		li.textContent = 'No widget is linked yet. Link a phone above and it appears here.';
		android.list.append(li);
		return;
	}
	for (const token of tokens) {
		const li = document.createElement('li');
		li.className = 'glance-device';
		const name = document.createElement('b');
		name.textContent = token.label;
		const prefix = document.createElement('code');
		prefix.textContent = `${token.prefix}…`;
		const meta = document.createElement('span');
		meta.className = 'meta';
		meta.textContent = `${token.platform}, linked ${relative(token.createdAt)}, last seen ${relative(token.lastUsedAt)}`;
		const revoke = document.createElement('button');
		revoke.type = 'button';
		revoke.className = 'glance-btn secondary';
		revoke.textContent = 'Revoke';
		revoke.setAttribute('aria-label', `Revoke the widget token ${token.label}`);
		revoke.addEventListener('click', async () => {
			revoke.disabled = true;
			li.classList.add('is-going');
			try {
				const res = await fetch(`/api/glance/token?id=${encodeURIComponent(token.id)}`, {
					method: 'DELETE',
					credentials: 'same-origin',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
				await loadDevices();
			} catch (err) {
				li.classList.remove('is-going');
				revoke.disabled = false;
				meta.textContent = `Could not revoke: ${err.message}`;
			}
		});
		li.append(name, prefix, meta, revoke);
		android.list.append(li);
	}
}

function wireAndroid() {
	android.button.addEventListener('click', () => linkAndroid());
	loadDevices();
	const params = new URL(location.href).searchParams;
	if (params.get('link') === 'android') {
		document.getElementById('android')?.scrollIntoView({ block: 'center' });
		linkAndroid({ auto: true });
	}
}

async function main() {
	wireControls();
	wireCopyButtons();
	wireAndroid();

	const fromUrl = new URL(location.href).searchParams.get('agent');
	const { options, note } = await discoverAgents();
	fillSelect(options);

	if (fromUrl && UUID_RE.test(fromUrl)) {
		state.agentId = fromUrl;
		els.source.textContent = 'Showing the agent from this link.';
		if (options.some((o) => o.id === fromUrl)) els.select.value = fromUrl;
	} else if (options.length) {
		state.agentId = options[0].id;
		els.select.value = options[0].id;
		els.source.textContent = note;
	} else {
		els.source.textContent = 'No public agent to show yet. Paste an id, or create an agent.';
	}

	render();
}

main();
