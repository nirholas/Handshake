/* Examples gallery: renders runnable example cards from one source of truth.
 * Every snippet is a complete document that runs against the production CDN
 * bundle, so "Run" executes exactly the code shown. */

const CDN = 'https://three.ws/agent-3d/latest/agent-3d.js';
const AVATAR = 'https://three.ws/avatars/default.glb';

const EXAMPLES = [
	{
		id: 'minimal-viewer',
		title: 'Minimal viewer',
		blurb:
			'One script tag, one element, zero build step. Drag to rotate, scroll to zoom, full PBR rendering. No API key, no account.',
		tags: ['viewer', 'no-build'],
		docs: [
			{ label: 'Web component docs', href: '/docs/web-component' },
			{ label: 'Embed in 30 seconds', href: '/tutorials/embed-in-30-seconds' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/examples/minimal.html',
		height: 560,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>3D Viewer</title>
		<style>
			body { margin: 0; background: #0a0a0a; display: flex;
				align-items: center; justify-content: center; height: 100vh; }
			agent-3d { width: 400px; height: 560px; display: block; }
		</style>
	</head>
	<body>
		<script type="module" src="${CDN}"><\/script>
		<agent-3d body="${AVATAR}"></agent-3d>
	</body>
</html>`,
	},
	{
		id: 'talking-agent',
		title: 'Talking agent, inline instructions',
		blurb:
			'Add brain and instructions attributes and the viewer becomes a conversational agent. The chat input and mic button appear automatically.',
		tags: ['agent', 'chat', 'llm'],
		docs: [
			{ label: 'Agent system docs', href: '/docs/agent-system' },
			{ label: 'Connect an AI brain', href: '/tutorials/connect-ai-brain' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/examples/one-line-demo.html',
		height: 620,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<style>
			body { margin: 0; background: #0a0a0a; display: flex;
				align-items: center; justify-content: center; height: 100vh; }
		</style>
	</head>
	<body>
		<script type="module" src="${CDN}"><\/script>
		<agent-3d
			body="${AVATAR}"
			brain="claude-sonnet-4-6"
			name="Aria"
			instructions="You are Aria, a friendly AI guide. Be warm, concise, and
				occasionally playful. When someone greets you, wave at them.
				Keep replies to 2-3 sentences."
			mode="inline"
			width="400px"
			height="560px"
		></agent-3d>
	</body>
</html>`,
	},
	{
		id: 'floating-bubble',
		title: 'Floating bubble (support widget)',
		blurb:
			'Pin the agent to a corner so it persists as users scroll. position accepts bottom-right, bottom-left, top-right, or top-left.',
		tags: ['agent', 'widget'],
		docs: [
			{ label: 'Embed on your website', href: '/tutorials/embed-on-website' },
			{ label: 'Build a site concierge', href: '/tutorials/build-a-site-concierge' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/examples/minimal.html',
		height: 560,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<style>
			body { margin: 0; min-height: 100vh; background: #101014;
				color: #e8e8ee; font-family: system-ui, sans-serif; padding: 48px; }
		</style>
	</head>
	<body>
		<h1>Your product page</h1>
		<p>Scroll around. The assistant stays pinned to the corner.</p>
		<script type="module" src="${CDN}"><\/script>
		<agent-3d
			body="${AVATAR}"
			brain="claude-sonnet-4-6"
			instructions="You are a helpful product assistant."
			mode="floating"
			position="bottom-right"
			width="320px"
			height="420px"
		></agent-3d>
	</body>
</html>`,
	},
	{
		id: 'custom-chat-ui',
		title: 'Custom chat UI over the JS API',
		blurb:
			'Hide the built-in chrome with kiosk mode and drive the agent from your own input using say(), events, and the rest of the element API.',
		tags: ['agent', 'js-api'],
		docs: [
			{ label: 'JS API and events', href: '/tutorials/js-api-events' },
			{ label: 'Embed spec', href: 'https://github.com/nirholas/three.ws/blob/main/specs/EMBED_SPEC.md' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/examples/two-agents.html',
		height: 700,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<style>
			body { margin: 0; background: #0a0a0a; color: #e8e8ee;
				font-family: system-ui, sans-serif; display: grid;
				place-items: center; min-height: 100vh; gap: 12px; }
			.row { display: flex; gap: 8px; }
			input { padding: 10px 12px; border-radius: 8px; border: 1px solid #333;
				background: #16161c; color: inherit; width: 280px; }
			button { padding: 10px 16px; border-radius: 8px; border: 0;
				background: #fff; color: #000; cursor: pointer; }
		</style>
	</head>
	<body>
		<agent-3d id="agent" body="${AVATAR}"
			brain="claude-sonnet-4-6" kiosk
			style="width:400px;height:520px;display:block"></agent-3d>
		<div class="row">
			<input id="msg" type="text" placeholder="Ask something..." />
			<button id="send">Send</button>
		</div>
		<script type="module" src="${CDN}"><\/script>
		<script>
			const agent = document.getElementById('agent');
			const input = document.getElementById('msg');
			async function send() {
				const text = input.value.trim();
				if (!text) return;
				input.value = '';
				await agent.say(text);
			}
			document.getElementById('send').addEventListener('click', send);
			input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
			agent.addEventListener('brain:message', (e) => {
				if (e.detail.role === 'assistant') console.log('Agent:', e.detail.content);
			});
		<\/script>
	</body>
</html>`,
	},
	{
		id: 'iframe-widget',
		title: 'iframe widget (Notion, Substack, Webflow)',
		blurb:
			'No script tag at all: a widget URL in a plain iframe. Generate the src from Widget Studio, then paste it anywhere iframes are allowed.',
		tags: ['widget', 'iframe'],
		docs: [
			{ label: 'Widget Studio', href: '/studio' },
			{ label: 'Widgets docs', href: '/docs/widgets' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/examples/widget-rpc.html',
		height: 620,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<style>
			body { margin: 0; background: #0a0a0a; display: grid;
				place-items: center; min-height: 100vh; }
		</style>
	</head>
	<body>
		<iframe
			src="https://three.ws/agents/demo/embed"
			width="400"
			height="560"
			frameborder="0"
			allow="microphone"
			style="border-radius: 16px"
		></iframe>
	</body>
</html>`,
	},
	{
		id: 'copy-paste-widget',
		title: 'Dead-simple copy-paste widget',
		blurb:
			'The loader mounts a rotatable 3D viewer into every [data-agent-id] element on the page. Great for WordPress, Ghost, or any static site.',
		tags: ['widget', 'no-build'],
		docs: [
			{ label: 'Embed editor', href: '/embed' },
			{ label: 'Share your agent', href: '/tutorials/share-your-agent' },
		],
		github: 'https://github.com/nirholas/three.ws/blob/main/public/artifact.js',
		height: 560,
		code: `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<style>
			body { margin: 0; background: #0a0a0a; display: grid;
				place-items: center; min-height: 100vh; }
		</style>
	</head>
	<body>
		<div data-agent-id="demo" style="width: 400px; height: 500px"></div>
		<script type="module" src="https://three.ws/artifact.js"><\/script>
	</body>
</html>`,
	},
];

function el(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

function card(ex) {
	const root = el('article', 'exg-card');
	root.id = ex.id;

	const head = el('div', 'exg-card-head');
	const title = el('h2', 'exg-card-title', ex.title);
	const tags = el('div', 'exg-tags');
	for (const t of ex.tags) tags.appendChild(el('span', 'exg-tag', t));
	head.appendChild(title);
	head.appendChild(tags);
	root.appendChild(head);

	root.appendChild(el('p', 'exg-blurb', ex.blurb));

	const pre = el('pre', 'exg-pre');
	const code = el('code', null, ex.code);
	pre.appendChild(code);
	root.appendChild(pre);

	const actions = el('div', 'exg-actions');
	const runBtn = el('button', 'exg-btn exg-btn--primary', 'Run this example');
	runBtn.type = 'button';
	runBtn.setAttribute('aria-expanded', 'false');
	const copyBtn = el('button', 'exg-btn', 'Copy code');
	copyBtn.type = 'button';
	const src = el('a', 'exg-btn exg-btn--link', 'Source on GitHub');
	src.href = ex.github;
	src.target = '_blank';
	src.rel = 'noopener';
	actions.appendChild(runBtn);
	actions.appendChild(copyBtn);
	actions.appendChild(src);
	root.appendChild(actions);

	const docs = el('p', 'exg-docs');
	docs.appendChild(document.createTextNode('Learn more: '));
	ex.docs.forEach((d, i) => {
		if (i) docs.appendChild(document.createTextNode(' · '));
		const a = el('a', null, d.label);
		a.href = d.href;
		docs.appendChild(a);
	});
	root.appendChild(docs);

	const stage = el('div', 'exg-stage');
	stage.hidden = true;
	root.appendChild(stage);

	runBtn.addEventListener('click', () => {
		const open = !stage.hidden;
		if (open) {
			stage.hidden = true;
			stage.replaceChildren();
			runBtn.textContent = 'Run this example';
			runBtn.setAttribute('aria-expanded', 'false');
			return;
		}
		const frame = document.createElement('iframe');
		frame.className = 'exg-frame';
		frame.style.height = `${ex.height}px`;
		frame.setAttribute('title', `${ex.title} (running)`);
		frame.setAttribute('allow', 'microphone');
		frame.setAttribute('loading', 'lazy');
		frame.srcdoc = ex.code;
		stage.replaceChildren(frame);
		stage.hidden = false;
		runBtn.textContent = 'Stop';
		runBtn.setAttribute('aria-expanded', 'true');
	});

	copyBtn.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(ex.code);
			copyBtn.textContent = 'Copied';
		} catch {
			// Clipboard API can be unavailable (permissions, http); fall back to selection.
			const range = document.createRange();
			range.selectNodeContents(code);
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			copyBtn.textContent = 'Press Ctrl+C';
		}
		setTimeout(() => {
			copyBtn.textContent = 'Copy code';
		}, 1600);
	});

	return root;
}

const grid = document.getElementById('exg-grid');
for (const ex of EXAMPLES) grid.appendChild(card(ex));

const count = document.getElementById('exg-count');
if (count) count.textContent = String(EXAMPLES.length);
