/* Examples gallery: renders runnable example cards from one source of truth.
 * Every snippet is a complete document that runs against the production CDN
 * bundle and the public production APIs, so "Run" executes exactly the code
 * shown and the results on screen are real: real meshes, real generations,
 * real payment requirements, real on-chain launches. Nothing here is seeded
 * with sample data.
 *
 * Cards are grouped into lanes (avatars, models, agents, economy) so the page
 * reads as "everything a three.ws agent can do", not just "how to embed one".
 * Every API a snippet calls is CORS-open, so a pasted snippet works on any
 * domain, not only on three.ws. */

/* Wrapped in an IIFE because this file and /examples-index.js are both classic
 * scripts on the same page and therefore share one global scope. Both need a
 * `matches` and a `card` helper, and without the wrapper the later script's
 * definitions win for BOTH: the lane filter silently called the repo index's
 * two-argument matcher and threw on every keystroke. */
(function () {
	const CDN = 'https://three.ws/agent-3d/latest/agent-3d.js';
	const AVATAR = 'https://three.ws/avatars/default.glb';
	const API = 'https://three.ws';

	const LANES = [
		{
			id: 'avatars',
			label: 'Avatars & embeds',
			heading: 'Put a body on any page',
			blurb: 'One script tag turns a GLB into a rendered, animated, conversational avatar. These are the embed shapes: inline viewer, talking agent, floating support bubble, your own chat UI, and iframe widgets for platforms that block scripts.',
		},
		{
			id: 'models',
			label: '3D models',
			heading: 'Make, inspect, and animate the 3D itself',
			blurb: 'The model pipeline is a public API. Generate a mesh from a sentence on the free lane, measure any GLB against a triangle budget before it ships, drive a 112-clip animation library, and read the live feed of models autonomous agents paid for.',
		},
		{
			id: 'agents',
			label: 'Agents',
			heading: 'An agent is a file, not a framework',
			blurb: 'A manifest declares the body, the brain, the voice, the memory policy, and the installed skills. Point the element at that file and the agent boots, including capabilities most stacks have no answer for, like signing every reply in ASL.',
		},
		{
			id: 'economy',
			label: 'Agent economy',
			heading: 'Agents that discover, pay, and launch',
			blurb: 'Machine-payable endpoints answer an unpaid request with the exact price, network, and asset an agent needs to settle. These snippets read that handshake and the platform launch record without spending anything.',
		},
	];

	const EXAMPLES = [
		{
			id: 'minimal-viewer',
			lane: 'avatars',
			title: 'Minimal viewer',
			blurb: 'One script tag, one element, zero build step. Drag to rotate, scroll to zoom, full PBR rendering. No API key, no account.',
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
			lane: 'avatars',
			title: 'Talking agent, inline instructions',
			blurb: 'Add brain and instructions attributes and the viewer becomes a conversational agent. The chat input and mic button appear automatically.',
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
			lane: 'avatars',
			title: 'Floating bubble (support widget)',
			blurb: 'Pin the agent to a corner so it persists as users scroll. position accepts bottom-right, bottom-left, top-right, or top-left.',
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
			lane: 'avatars',
			title: 'Custom chat UI over the JS API',
			blurb: 'Hide the built-in chrome with kiosk mode and drive the agent from your own input using say(), events, and the rest of the element API.',
			tags: ['agent', 'js-api'],
			docs: [
				{ label: 'JS API and events', href: '/tutorials/js-api-events' },
				{
					label: 'Embed spec',
					href: 'https://github.com/nirholas/three.ws/blob/main/specs/EMBED_SPEC.md',
				},
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
				.row { display: flex; gap: 8px; position: relative; z-index: 1; }
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
			lane: 'avatars',
			title: 'iframe widget (Notion, Substack, Webflow)',
			blurb: 'No script tag at all: a widget URL in a plain iframe. Generate the src from Widget Studio, then paste it anywhere iframes are allowed.',
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
			lane: 'avatars',
			title: 'Dead-simple copy-paste widget',
			blurb: 'The loader mounts a rotatable 3D viewer into every [data-agent-id] element on the page. Great for WordPress, Ghost, or any static site.',
			tags: ['widget', 'no-build'],
			docs: [
				{ label: 'Embed editor', href: '/studio' },
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
		{
			id: 'text-to-3d',
			lane: 'models',
			title: 'Text to a real 3D model, free',
			blurb: 'Type a sentence, get a textured GLB back, and render it in the viewer on the same page. Public endpoint, CORS-open, no key and no account: 10 generations per IP per day on the free NVIDIA lane. This is the whole pipeline in one file.',
			tags: ['forge', 'api', 'free'],
			docs: [
				{ label: 'Text to 3D API', href: '/docs/api-reference#ai-api--text3d' },
				{ label: 'Forge', href: '/forge' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/pages/examples.html',
			height: 640,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Text to 3D</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px;
					display: grid; gap: 14px; align-content: start; }
				form { display: flex; gap: 8px; }
				input { flex: 1; padding: 10px 12px; border-radius: 8px;
					border: 1px solid #333; background: #16161c; color: inherit; }
				button { padding: 10px 18px; border-radius: 8px; border: 0;
					background: #fff; color: #000; font-weight: 600; cursor: pointer; }
				button[disabled] { opacity: 0.5; cursor: progress; }
				#status { margin: 0; min-height: 20px; color: #9a9aa4; font-size: 14px; }
				#out a { color: #7c8cff; }
				agent-3d { width: 100%; height: 380px; display: block; }
			</style>
		</head>
		<body>
			<form id="gen">
				<input id="prompt" value="a small ceramic robot figurine"
					maxlength="1000" required aria-label="Describe one object" />
				<button id="go" type="submit">Generate</button>
			</form>
			<p id="status">Free lane, no key. 10 generations per IP per day.</p>
			<div id="out"></div>

			<script type="module" src="${CDN}"><\/script>
			<script>
				var API = '${API}';
				var statusEl = document.getElementById('status');
				var out = document.getElementById('out');
				var go = document.getElementById('go');

				function render(glbUrl) {
					var el = document.createElement('agent-3d');
					el.setAttribute('body', glbUrl);
					el.setAttribute('eager', '');
					el.setAttribute('kiosk', '');
					var link = document.createElement('a');
					link.href = glbUrl;
					link.textContent = 'Download this GLB';
					out.replaceChildren(el, link);
				}

				// Big prompts finish on a background worker; the API hands back a job
				// token and this polls the same free job endpoint until the mesh lands.
				async function awaitJob(job) {
					for (var i = 0; i < 90; i++) {
						await new Promise(function (done) { setTimeout(done, 2000); });
						var res = await fetch(API + '/api/forge?job=' + encodeURIComponent(job));
						var job_state = await res.json();
						if (job_state.status === 'done' && job_state.glb_url) return job_state.glb_url;
						if (job_state.status === 'failed') throw new Error(job_state.error || 'the lane could not build this mesh');
						statusEl.textContent = 'Building on the ' + (job_state.backend || 'free') + ' lane...';
					}
					throw new Error('the job is still running; open /forge to keep watching it');
				}

				document.getElementById('gen').addEventListener('submit', async function (event) {
					event.preventDefault();
					go.disabled = true;
					statusEl.textContent = 'Sending the prompt to the free text-to-3D lane...';
					try {
						var res = await fetch(API + '/api/v1/ai/text-to-3d', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ prompt: document.getElementById('prompt').value })
						});
						var payload = await res.json();
						if (res.status === 429) {
							statusEl.textContent = 'Free quota used up for today. The paid forge tiers have no cap.';
							return;
						}
						if (!res.ok) throw new Error(payload.error_description || payload.error || ('HTTP ' + res.status));
						var data = payload.data || payload;
						var url = data.glb_url || (data.job ? await awaitJob(data.job) : '');
						if (!url) throw new Error('the response carried no mesh');
						statusEl.textContent = 'Done, on the ' + (data.backend || 'free') + ' lane. Drag to rotate.';
						render(url);
					} catch (err) {
						statusEl.textContent = 'Failed: ' + err.message;
					} finally {
						go.disabled = false;
					}
				});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'animation-library',
			lane: 'models',
			title: 'The whole animation library, on any rig',
			blurb: 'The clip manifest is public. Fetch it, build a control for every clip, and play them on a loaded avatar. Clips are retargeted onto whatever skeleton the GLB carries, so the same library drives a Mixamo rig, a VRM, a body scan, or a mesh you generated a minute ago.',
			tags: ['animation', 'api'],
			docs: [
				{ label: 'Web component API', href: '/docs/web-component' },
				{ label: 'Animations', href: '/animations' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/src/animation-retarget.js',
			height: 620,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Animation library</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px;
					display: grid; gap: 14px; align-content: start; }
				#clips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 132px;
					overflow-y: auto; position: relative; z-index: 1; }
				#clips button { padding: 6px 12px; border-radius: 999px; cursor: pointer;
					border: 1px solid #333; background: #16161c; color: inherit;
					font: inherit; font-size: 13px; }
				#clips button:hover { border-color: #7c8cff; }
				#clips button[aria-pressed="true"] { background: #fff; color: #000; }
				agent-3d { width: 100%; height: 340px; display: block; }
			</style>
		</head>
		<body>
			<agent-3d id="stage" body="${AVATAR}" eager kiosk></agent-3d>
			<div id="clips" role="group" aria-label="Animation clips">Loading the clip manifest...</div>

			<script type="module" src="${CDN}"><\/script>
			<script>
				var stage = document.getElementById('stage');
				var list = document.getElementById('clips');

				fetch('${API}/animations/manifest.json')
					.then(function (res) { return res.json(); })
					.then(function (clips) {
						list.replaceChildren();
						clips.forEach(function (clip) {
							var button = document.createElement('button');
							button.type = 'button';
							button.textContent = (clip.icon ? clip.icon + ' ' : '') + clip.label;
							button.setAttribute('aria-pressed', 'false');
							button.addEventListener('click', function () {
								list.querySelectorAll('[aria-pressed="true"]').forEach(function (other) {
									other.setAttribute('aria-pressed', 'false');
								});
								button.setAttribute('aria-pressed', 'true');
								// userInitiated plays the motion even under
								// prefers-reduced-motion: a click is an explicit request.
								stage.playClip(clip.name, { userInitiated: true });
							});
							list.appendChild(button);
						});
					})
					.catch(function (err) {
						list.textContent = 'Could not load the clip manifest: ' + err.message;
					});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'inspect-glb',
			lane: 'models',
			title: 'Measure a GLB before you ship it',
			blurb: 'Paste any GLB URL and read its real geometry: triangles, materials, textures, skins, and the glTF extensions it depends on. This is the check to run in CI so an asset that blows the triangle budget fails the build instead of the frame rate.',
			tags: ['quality', 'api', 'ci'],
			docs: [
				{ label: 'Gate 3D assets in CI', href: '/cookbook/asset-quality-gate' },
				{
					label: 'Quality check API',
					href: '/docs/api-reference#model-quality-gate--postapiforge-quality-check',
				},
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/3d/inspect.js',
			height: 520,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Inspect a GLB</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px;
					display: grid; gap: 14px; align-content: start; }
				form { display: flex; gap: 8px; }
				input { flex: 1; padding: 10px 12px; border-radius: 8px;
					border: 1px solid #333; background: #16161c; color: inherit; }
				button { padding: 10px 18px; border-radius: 8px; border: 0;
					background: #fff; color: #000; font-weight: 600; cursor: pointer; }
				table { border-collapse: collapse; font-size: 14px; }
				th, td { text-align: left; padding: 6px 16px 6px 0; }
				th { color: #9a9aa4; font-weight: 500; }
				.verdict { font-weight: 600; }
				.pass { color: #38d39f; }
				.fail { color: #ff6b6b; }
			</style>
		</head>
		<body>
			<form id="check">
				<input id="url" value="${AVATAR}" required aria-label="GLB URL" />
				<button type="submit">Inspect</button>
			</form>
			<p id="verdict" class="verdict"></p>
			<div id="stats"></div>

			<script>
				// Your budget. Fail the build when a model busts it.
				var MAX_TRIANGLES = 60000;

				async function inspect(event) {
					if (event) event.preventDefault();
					var verdict = document.getElementById('verdict');
					var stats = document.getElementById('stats');
					verdict.textContent = 'Reading the file...';
					verdict.className = 'verdict';
					stats.replaceChildren();
					try {
						var url = document.getElementById('url').value;
						var res = await fetch('${API}/api/3d/inspect?url=' + encodeURIComponent(url));
						var report = await res.json();
						if (!res.ok || !report.valid) throw new Error(report.error || 'not a readable GLB');

						var over = report.stats.triangles > MAX_TRIANGLES;
						verdict.textContent = over
							? 'Over budget: ' + report.stats.triangles.toLocaleString() + ' triangles against a cap of ' + MAX_TRIANGLES.toLocaleString()
							: 'Within budget: ' + report.stats.triangles.toLocaleString() + ' triangles.';
						verdict.className = 'verdict ' + (over ? 'fail' : 'pass');

						var table = document.createElement('table');
						Object.keys(report.stats).forEach(function (key) {
							var value = report.stats[key];
							var row = table.insertRow();
							row.insertCell().outerHTML = '<th>' + key + '</th>';
							row.insertCell().textContent = Array.isArray(value)
								? (value.join(', ') || 'none')
								: String(value);
						});
						stats.appendChild(table);
					} catch (err) {
						verdict.textContent = 'Failed: ' + err.message;
						verdict.className = 'verdict fail';
					}
				}

				document.getElementById('check').addEventListener('submit', inspect);
				inspect();
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'agent-forged',
			lane: 'models',
			title: 'The models agents bought with their own money',
			blurb: 'A live feed of meshes that autonomous agents commissioned by paying for them over x402: the prompt, the price in USDC, the payer wallet, and the settled transaction. No human pressed a button for any of these.',
			tags: ['x402', 'api', 'live'],
			docs: [
				{ label: 'Agent-forged gallery', href: '/forged' },
				{
					label: 'Forged feed API',
					href: '/docs/api-reference#agent-forged-gallery-feed--getapiforged',
				},
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/forged.js',
			height: 540,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Agent-forged models</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px; }
				ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
				li { border: 1px solid #26262e; border-radius: 12px; padding: 14px; }
				.prompt { margin: 0 0 6px; }
				.meta { margin: 0; color: #9a9aa4; font-size: 13px; }
				a { color: #7c8cff; }
			</style>
		</head>
		<body>
			<p id="status">Loading the live feed...</p>
			<ul id="feed"></ul>

			<script>
				fetch('${API}/api/forged?limit=6')
					.then(function (res) { return res.json(); })
					.then(function (payload) {
						var props = payload.props || [];
						document.getElementById('status').textContent =
							props.length + ' models, each one paid for by an agent.';
						var feed = document.getElementById('feed');
						props.forEach(function (prop) {
							var item = document.createElement('li');
							var prompt = document.createElement('p');
							prompt.className = 'prompt';
							prompt.textContent = prop.prompt;
							var meta = document.createElement('p');
							meta.className = 'meta';
							meta.textContent =
								'$' + prop.price_usdc + ' USDC · paid by ' + prop.payer_short + ' · ';
							var view = document.createElement('a');
							view.href = '${API}/viewer?src=' + encodeURIComponent(prop.glb_url);
							view.target = '_blank';
							view.rel = 'noopener';
							view.textContent = 'open the mesh';
							meta.appendChild(view);
							item.appendChild(prompt);
							item.appendChild(meta);
							feed.appendChild(item);
						});
					})
					.catch(function (err) {
						document.getElementById('status').textContent =
							'Could not reach the feed: ' + err.message;
					});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'agent-from-files',
			lane: 'agents',
			title: 'An agent defined entirely as files',
			blurb: 'No SDK, no build step, no backend. A manifest declares the body GLB, the brain and its system prompt, the voice, the memory policy, and the skills to install; the element loads it and boots the agent. Copy the directory, swap the GLB, rewrite the prompt: that is the whole authoring model.',
			tags: ['manifest', 'agent'],
			docs: [
				{
					label: 'Manifest spec',
					href: 'https://github.com/nirholas/three.ws/blob/main/specs/AGENT_MANIFEST.md',
				},
				{ label: 'Build your first agent', href: '/walkthroughs/build-your-first-agent' },
			],
			github: 'https://github.com/nirholas/three.ws/tree/main/examples/coach-leo',
			height: 700,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Agent from a manifest</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; display: grid;
					place-items: center; gap: 12px; padding: 24px; }
				pre { margin: 0; max-width: 520px; overflow-x: auto; font-size: 12px;
					color: #9a9aa4; }
				a { color: #7c8cff; }
			</style>
		</head>
		<body>
			<pre>manifest.json
	  body     -> a Mixamo-rigged GLB
	  brain    -> model + instructions.md
	  voice    -> browser TTS and STT
	  skills   -> ../skills/wave/ (installed at boot)
	  memory   -> local, 8192 tokens</pre>
			<a href="${API}/examples/coach-leo/manifest.json" target="_blank" rel="noopener"
				>Read the manifest this page just loaded</a
			>
			<script type="module" src="${CDN}"><\/script>
			<agent-3d
				manifest="${API}/examples/coach-leo/manifest.json"
				mode="inline"
				width="380px"
				height="480px"
				eager
			></agent-3d>
		</body>
	</html>`,
		},
		{
			id: 'sign-language',
			lane: 'agents',
			title: 'An avatar that signs in ASL',
			blurb: 'One boolean attribute and every assistant reply is signed in American Sign Language; sign() performs text you supply yourself, for captions and accessibility overlays. Words in the lexicon are signed, everything else is fingerspelled, in one continuous motion, and the call reports which words went each way. A rig with no finger bones returns null instead of signing something wrong.',
			tags: ['accessibility', 'animation'],
			docs: [
				{ label: 'Sign language engine', href: '/docs/sign-language' },
				{ label: 'ASL alphabet', href: '/asl-alphabet' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/examples/sign-language.html',
			height: 620,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Signing avatar</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; display: grid;
					place-items: center; gap: 12px; padding: 24px; }
				.row { display: flex; gap: 8px; position: relative; z-index: 1; }
				input { padding: 10px 12px; border-radius: 8px; border: 1px solid #333;
					background: #16161c; color: inherit; width: 280px; }
				button { padding: 10px 16px; border-radius: 8px; border: 0;
					background: #fff; color: #000; font-weight: 600; cursor: pointer; }
				#report { margin: 0; color: #9a9aa4; font-size: 13px; min-height: 18px;
					max-width: 460px; text-align: center; }
			</style>
		</head>
		<body>
			<script type="module" src="${CDN}"><\/script>
			<agent-3d id="signer" body="${AVATAR}" sign-language kiosk eager
				style="width:400px;height:480px;display:block"></agent-3d>
			<div class="row">
				<input id="phrase" value="hello friend" aria-label="Text to sign" />
				<button id="go" type="button">Sign it</button>
			</div>
			<p id="report"></p>
			<script>
				var signer = document.getElementById('signer');
				var phrase = document.getElementById('phrase');
				var report = document.getElementById('report');

				async function sign() {
					report.textContent = 'Compiling the utterance...';
					try {
						// sign() performs text you supply: no brain, no round trip.
						var result = await signer.sign(phrase.value);
						report.textContent = result
							? 'signed: ' + (result.signed.join(', ') || 'none') +
								' · fingerspelled: ' + (result.spelled.join(', ') || 'none')
							: 'This rig has no finger bones, so it will not sign.';
					} catch (err) {
						report.textContent = 'Could not sign that: ' + err.message;
					}
				}

				document.getElementById('go').addEventListener('click', sign);
				phrase.addEventListener('keydown', function (event) {
					if (event.key === 'Enter') sign();
				});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'x402-handshake',
			lane: 'economy',
			title: 'Ask a paid endpoint what it charges',
			blurb: 'Call a machine-payable endpoint with no payment and it answers 402 with the price, the network, the asset, and the address to pay: everything an autonomous buyer needs to decide and settle without a human. This snippet reads that answer and spends nothing.',
			tags: ['x402', 'payments', 'api'],
			docs: [
				{ label: 'x402 on three.ws', href: '/x402' },
				{
					label: 'Paid endpoints',
					href: '/docs/api-reference#x402-paid-endpoints--sign-in-with-x-siwx',
				},
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/x402/forge.js',
			height: 520,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>x402 payment requirements</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px;
					display: grid; gap: 14px; align-content: start; }
				table { border-collapse: collapse; font-size: 14px; }
				th, td { text-align: left; padding: 6px 16px 6px 0;
					vertical-align: top; word-break: break-all; }
				th { color: #9a9aa4; font-weight: 500; white-space: nowrap; }
				code { color: #38d39f; }
			</style>
		</head>
		<body>
			<p id="status">Asking the forge endpoint what it charges...</p>
			<div id="terms"></div>

			<script>
				// No X-PAYMENT header: the endpoint replies 402 with its terms, which
				// is how an agent discovers a price before it commits any funds.
				fetch('${API}/api/x402/forge', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ prompt: 'a brass telescope' })
				})
					.then(async function (res) {
						var body = await res.json();
						document.getElementById('status').innerHTML =
							'HTTP <code>' + res.status + '</code>: the endpoint quoted its terms.';
						var accepts = (body.accepts || [])[0] || {};
						var extra = accepts.extra || {};
						// amount is in the asset's base units; decimals makes it human.
						var decimals = Number(extra.decimals || 0);
						var price = accepts.amount
							? (Number(accepts.amount) / Math.pow(10, decimals)) + ' ' + (extra.name || 'units')
							: null;
						var rows = {
							resource: body.resource && body.resource.url,
							price: price,
							asset: accepts.asset,
							network: accepts.network,
							'pay to': accepts.payTo,
							scheme: accepts.scheme,
							'settle within': accepts.maxTimeoutSeconds ? accepts.maxTimeoutSeconds + 's' : null,
							'x402 version': body.x402Version
						};
						var table = document.createElement('table');
						Object.keys(rows).forEach(function (key) {
							if (rows[key] === undefined || rows[key] === null) return;
							var row = table.insertRow();
							row.insertCell().outerHTML = '<th>' + key + '</th>';
							row.insertCell().textContent = String(rows[key]);
						});
						document.getElementById('terms').appendChild(table);
					})
					.catch(function (err) {
						document.getElementById('status').textContent =
							'Could not reach the endpoint: ' + err.message;
					});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'platform-launches',
			lane: 'economy',
			title: 'Coins launched through the platform',
			blurb: 'Agents can mint a token as part of their own workflow. This reads the platform launch record: every mint created through three.ws, straight from the production API, with a link to its on-chain page.',
			tags: ['solana', 'api', 'live'],
			docs: [
				{ label: 'Launches', href: '/launches' },
				{ label: 'Launch API', href: '/docs/api-reference' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/pump/launches.js',
			height: 500,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>Platform launches</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px; }
				ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
				li { border: 1px solid #26262e; border-radius: 10px; padding: 12px;
					display: flex; justify-content: space-between; gap: 12px;
					flex-wrap: wrap; }
				.mint { color: #9a9aa4; font-size: 13px; word-break: break-all; }
				a { color: #7c8cff; }
			</style>
		</head>
		<body>
			<p id="status">Loading the launch record...</p>
			<ul id="list"></ul>

			<script>
				fetch('${API}/api/pump/launches?limit=6')
					.then(function (res) { return res.json(); })
					.then(function (payload) {
						var launches = (payload.data && payload.data.launches) || [];
						document.getElementById('status').textContent =
							launches.length + ' of the most recent launches.';
						var list = document.getElementById('list');
						launches.forEach(function (launch) {
							var item = document.createElement('li');
							var name = document.createElement('strong');
							name.textContent = launch.name + ' (' + launch.symbol + ')';
							var mint = document.createElement('a');
							mint.className = 'mint';
							mint.href = 'https://solscan.io/token/' + launch.mint;
							mint.target = '_blank';
							mint.rel = 'noopener';
							mint.textContent = launch.mint;
							item.appendChild(name);
							item.appendChild(mint);
							list.appendChild(item);
						});
					})
					.catch(function (err) {
						document.getElementById('status').textContent =
							'Could not reach the launch API: ' + err.message;
					});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'avatar-voice',
			lane: 'avatars',
			title: 'Give it a voice, with the mouth to match',
			blurb: 'Synthesize a line on the free text-to-speech lane and hand the audio to the avatar. speakAudio() routes it through the same analyser the built-in voice uses, so the visemes follow the real waveform instead of approximating it. Any audio works: another provider, a recorded clip, a cached line.',
			tags: ['voice', 'lipsync', 'api'],
			docs: [
				{ label: 'Web component API', href: '/docs/web-component' },
				{ label: 'Text to speech API', href: '/docs/api-reference#textspeech' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/src/element.js',
			height: 640,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>An avatar with a voice</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; display: grid;
					place-items: center; gap: 12px; padding: 24px; }
				.row { display: flex; gap: 8px; position: relative; z-index: 1; }
				input { padding: 10px 12px; border-radius: 8px; border: 1px solid #333;
					background: #16161c; color: inherit; width: 320px; }
				button { padding: 10px 16px; border-radius: 8px; border: 0;
					background: #fff; color: #000; font-weight: 600; cursor: pointer; }
				button[disabled] { opacity: 0.5; cursor: progress; }
				#status { margin: 0; color: #9a9aa4; font-size: 13px; min-height: 18px; }
			</style>
		</head>
		<body>
			<script type="module" src="${CDN}"><\/script>
			<agent-3d id="speaker" body="${AVATAR}" kiosk eager
				style="width:400px;height:440px;display:block"></agent-3d>
			<div class="row">
				<input id="line" value="Give your AI a body." aria-label="What to say" />
				<button id="go" type="button">Say it</button>
			</div>
			<p id="status">Free lane: 10 calls a day per IP, no key.</p>

			<script>
				var speaker = document.getElementById('speaker');
				var line = document.getElementById('line');
				var go = document.getElementById('go');
				var statusEl = document.getElementById('status');

				async function say() {
					go.disabled = true;
					statusEl.textContent = 'Synthesizing...';
					try {
						var res = await fetch('${API}/api/v1/ai/tts', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ text: line.value, voice: 'nova' })
						});
						var payload = await res.json();
						if (res.status === 402) {
							statusEl.textContent = 'Free quota used up today. The paid lane costs $0.005 a call.';
							return;
						}
						if (!res.ok) throw new Error(payload.error_description || payload.error || ('HTTP ' + res.status));
						var data = payload.data;
						statusEl.textContent =
							'Speaking on the ' + data.tier + ' lane. ' +
							data.free_remaining_today + ' free calls left today.';
						// A data: URL is same-origin, so the analyser can read it and
						// drive real visemes rather than a generic talking gesture.
						await speaker.speakAudio('data:' + data.content_type + ';base64,' + data.audio);
						statusEl.textContent = 'Done. Say something else.';
					} catch (err) {
						statusEl.textContent = 'Failed: ' + err.message;
					} finally {
						go.disabled = false;
					}
				}

				go.addEventListener('click', say);
				line.addEventListener('keydown', function (event) {
					if (event.key === 'Enter') say();
				});
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'model-vision',
			lane: 'models',
			title: 'What an AI sees when it looks at a model',
			blurb: 'A URL tells a language model nothing about a mesh. This calls the look_at_model tool on the public MCP server: it renders the GLB from four angles, returns the images, and writes a plain-language read on the geometry. That render-and-critique loop is how an agent judges its own output and decides to regenerate.',
			tags: ['mcp', 'agent', 'free'],
			docs: [
				{ label: 'MCP tools', href: '/docs/mcp' },
				{ label: 'A self-correcting 3D set', href: '/cookbook/self-correcting-3d' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/mcp-studio.js',
			height: 620,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>What an AI sees</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px;
					display: grid; gap: 14px; align-content: start; }
				form { display: flex; gap: 8px; }
				input { flex: 1; padding: 10px 12px; border-radius: 8px;
					border: 1px solid #333; background: #16161c; color: inherit; }
				button { padding: 10px 18px; border-radius: 8px; border: 0;
					background: #fff; color: #000; font-weight: 600; cursor: pointer; }
				#views { display: grid; gap: 10px;
					grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
				figure { margin: 0; }
				figure img { width: 100%; border-radius: 10px; border: 1px solid #26262e;
					background: #101016; display: block; }
				figcaption { font-size: 12px; color: #9a9aa4; padding-top: 6px; }
				#read { margin: 0; color: #9a9aa4; line-height: 1.6;
					white-space: pre-wrap; font-size: 14px; }
				#hint { margin: 0; color: #6f6f7a; font-size: 13px; }
			</style>
		</head>
		<body>
			<form id="look">
				<input id="url" value="${AVATAR}" required aria-label="GLB URL" />
				<button type="submit">Look at it</button>
			</form>
			<p id="status">Calling look_at_model on the public MCP server...</p>
			<p id="hint">Four server-side renders take about 20 seconds.</p>
			<div id="views"></div>
			<p id="read"></p>

			<script>
				var statusEl = document.getElementById('status');
				var views = document.getElementById('views');
				var read = document.getElementById('read');

				async function look(event) {
					if (event) event.preventDefault();
					views.replaceChildren();
					read.textContent = '';
					statusEl.textContent = 'Rendering the model...';
					try {
						var res = await fetch('${API}/api/mcp-studio', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								jsonrpc: '2.0',
								id: 1,
								method: 'tools/call',
								params: {
									name: 'look_at_model',
									arguments: { glb_url: document.getElementById('url').value }
								}
							})
						});
						var payload = await res.json();
						if (payload.error) throw new Error(payload.error.message);

						var blocks = payload.result.content || [];
						var caption = '';
						blocks.forEach(function (block, i) {
							if (block.type === 'text') {
								if (i === 0) read.textContent = block.text;
								else caption = block.text;
								return;
							}
							if (block.type !== 'image') return;
							var figure = document.createElement('figure');
							var img = document.createElement('img');
							img.src = 'data:' + block.mimeType + ';base64,' + block.data;
							img.alt = caption || 'A rendered view of the model';
							var cap = document.createElement('figcaption');
							cap.textContent = caption;
							figure.appendChild(img);
							figure.appendChild(cap);
							views.appendChild(figure);
						});
						statusEl.textContent = 'The tool returned ' + views.children.length +
							' rendered view(s) and the read below.';
						document.getElementById('hint').hidden = true;
					} catch (err) {
						statusEl.textContent = 'Failed: ' + err.message;
					}
				}

				document.getElementById('look').addEventListener('submit', look);
				look();
			<\/script>
		</body>
	</html>`,
		},
		{
			id: 'mcp-tools',
			lane: 'agents',
			title: 'Every 3D tool an AI assistant can pick up',
			blurb: 'The platform speaks MCP over a public, CORS-open, no-auth endpoint, so any assistant can generate a mesh, rig it, refine it, save it as a named persona, and make that persona perform a line. This reads the live tool list off the server, which means the page can never advertise a tool that was renamed or dropped.',
			tags: ['mcp', 'agent', 'api'],
			docs: [
				{ label: 'MCP docs', href: '/docs/mcp' },
				{ label: 'Give your assistant a 3D tool', href: '/cookbook/mcp-3d-tool' },
			],
			github: 'https://github.com/nirholas/three.ws/blob/main/api/mcp-studio.js',
			height: 560,
			code: `<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>MCP tools</title>
			<style>
				body { margin: 0; min-height: 100vh; background: #0a0a0a; color: #e8e8ee;
					font-family: system-ui, sans-serif; padding: 24px; }
				ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
				li { border: 1px solid #26262e; border-radius: 10px; padding: 12px 14px; }
				code { color: #38d39f; font-size: 14px; }
				p.desc { margin: 6px 0 0; color: #9a9aa4; font-size: 13px; line-height: 1.55; }
				p.args { margin: 6px 0 0; color: #6f6f7a; font-size: 12px; }
			</style>
		</head>
		<body>
			<p id="status">Asking the MCP server what it can do...</p>
			<ul id="tools"></ul>

			<script>
				// Plain JSON-RPC: the same handshake an assistant makes on connect.
				fetch('${API}/api/mcp-studio', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
				})
					.then(function (res) { return res.json(); })
					.then(function (payload) {
						var tools = payload.result.tools || [];
						document.getElementById('status').textContent =
							tools.length + ' tools, no key and no account required.';
						var list = document.getElementById('tools');
						tools.forEach(function (tool) {
							var item = document.createElement('li');
							var name = document.createElement('code');
							name.textContent = tool.name;
							var desc = document.createElement('p');
							desc.className = 'desc';
							desc.textContent = tool.description || '';
							var props = (tool.inputSchema && tool.inputSchema.properties) || {};
							var args = document.createElement('p');
							args.className = 'args';
							args.textContent = 'arguments: ' + (Object.keys(props).join(', ') || 'none');
							item.appendChild(name);
							item.appendChild(desc);
							item.appendChild(args);
							list.appendChild(item);
						});
					})
					.catch(function (err) {
						document.getElementById('status').textContent =
							'Could not reach the MCP server: ' + err.message;
					});
			<\/script>
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
		const title = el('h3', 'exg-card-title', ex.title);
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

	function laneSection(lane, examples) {
		const section = el('section', 'exg-lane');
		section.id = `lane-${lane.id}`;

		const header = el('div', 'exg-lane-head');
		const label = el('p', 'exg-lane-label', lane.label);
		const heading = el('h2', 'exg-lane-title', lane.heading);
		const blurb = el('p', 'exg-lane-blurb', lane.blurb);
		header.appendChild(label);
		header.appendChild(heading);
		header.appendChild(blurb);
		section.appendChild(header);

		const grid = el('div', 'exg-grid');
		for (const ex of examples) grid.appendChild(card(ex));
		section.appendChild(grid);

		return section;
	}

	// The lane nav doubles as a jump list and a lane filter. Cards stay in the
	// document (hidden, not removed) so a deep link and the browser's own find still
	// resolve; `syncFilter` reveals whatever a hash points at.
	function laneNav(lanes) {
		const nav = el('nav', 'exg-lane-nav');
		nav.setAttribute('aria-label', 'Example lanes');
		for (const lane of lanes) {
			const link = el('a', 'exg-lane-link');
			link.href = `#lane-${lane.id}`;
			link.dataset.lane = lane.id;
			link.appendChild(el('span', 'exg-lane-link-label', lane.label));
			link.appendChild(el('span', 'exg-lane-link-count', '0'));
			nav.appendChild(link);
		}
		return nav;
	}

	/**
	 * Tags worth a chip: the ones that actually group examples, most-used first.
	 * A chip per tag would be two dozen of them, which is a wall rather than a
	 * filter. The long tail is still reachable, because the text box searches
	 * tags too.
	 */
	function chipTags(examples) {
		const counts = new Map();
		for (const ex of examples) {
			for (const tag of ex.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
		}
		return [...counts.entries()]
			.filter(([, n]) => n > 1)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}

	function filterBar(examples, onChange) {
		const bar = el('div', 'exg-filter');

		const field = el('div', 'exg-filter-field');
		const input = el('input', 'exg-filter-input');
		input.type = 'search';
		input.placeholder = `Filter ${examples.length} examples`;
		input.setAttribute('aria-label', 'Filter examples by name, description, or tag');
		const clear = el('button', 'exg-filter-clear', 'Clear');
		clear.type = 'button';
		clear.hidden = true;
		field.appendChild(input);
		field.appendChild(clear);
		bar.appendChild(field);

		const chips = el('div', 'exg-chips');
		chips.setAttribute('role', 'group');
		chips.setAttribute('aria-label', 'Filter examples by tag');
		for (const [tag, n] of chipTags(examples)) {
			const chip = el('button', 'exg-chip');
			chip.type = 'button';
			chip.dataset.tag = tag;
			chip.setAttribute('aria-pressed', 'false');
			chip.appendChild(el('span', null, tag));
			chip.appendChild(el('span', 'exg-chip-count', String(n)));
			chips.appendChild(chip);
		}
		bar.appendChild(chips);

		const state = { text: '', tags: new Set() };
		const emit = () => {
			clear.hidden = !state.text && state.tags.size === 0;
			onChange(state);
		};

		input.addEventListener('input', () => {
			state.text = input.value.trim().toLowerCase();
			emit();
		});
		chips.addEventListener('click', (event) => {
			const chip = event.target.closest('.exg-chip');
			if (!chip) return;
			const { tag } = chip.dataset;
			const on = state.tags.has(tag);
			if (on) state.tags.delete(tag);
			else state.tags.add(tag);
			chip.setAttribute('aria-pressed', String(!on));
			emit();
		});
		clear.addEventListener('click', () => {
			input.value = '';
			state.text = '';
			state.tags.clear();
			for (const chip of chips.children) chip.setAttribute('aria-pressed', 'false');
			emit();
			input.focus();
		});

		return { bar, state, reset: () => clear.click() };
	}

	/** A card matches when every active tag is on it and the text hits any field. */
	function matches(ex, lane, state) {
		for (const tag of state.tags) {
			if (!ex.tags.includes(tag)) return false;
		}
		if (!state.text) return true;
		const haystack = `${ex.title} ${ex.blurb} ${ex.tags.join(' ')} ${lane.label}`;
		return haystack.toLowerCase().includes(state.text);
	}

	const root = document.getElementById('exg-lanes');
	if (root) {
		const lanes = LANES.filter((lane) => EXAMPLES.some((ex) => ex.lane === lane.id));
		const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
		const sections = new Map();
		const cards = new Map();

		const nav = laneNav(lanes);
		const empty = el('p', 'exg-empty');
		empty.hidden = true;

		const live = el('p', 'exg-sr');
		live.setAttribute('aria-live', 'polite');

		const filter = filterBar(EXAMPLES, syncFilter);
		root.appendChild(filter.bar);
		root.appendChild(nav);
		root.appendChild(live);
		root.appendChild(empty);

		for (const lane of lanes) {
			const laneExamples = EXAMPLES.filter((ex) => ex.lane === lane.id);
			const section = laneSection(lane, laneExamples);
			sections.set(lane.id, section);
			for (const ex of laneExamples) cards.set(ex.id, section.querySelector(`#${ex.id}`));
			root.appendChild(section);
		}

		function syncFilter(state) {
			let shown = 0;
			for (const lane of lanes) {
				let inLane = 0;
				for (const ex of EXAMPLES) {
					if (ex.lane !== lane.id) continue;
					const hit = matches(ex, lane, state);
					cards.get(ex.id).hidden = !hit;
					if (hit) inLane++;
				}
				sections.get(lane.id).hidden = inLane === 0;
				const link = nav.querySelector(`[data-lane="${lane.id}"]`);
				link.querySelector('.exg-lane-link-count').textContent = String(inLane);
				link.hidden = inLane === 0;
				shown += inLane;
			}
			empty.hidden = shown > 0;
			empty.textContent = shown
				? ''
				: 'No example matches that. Clear the filter to see all of them again.';
			live.textContent = `${shown} of ${EXAMPLES.length} examples shown`;
		}

		// A deep link must win over an active filter, or /examples#mcp-tools can
		// land on a card the current filter has hidden.
		function revealHashTarget() {
			const id = location.hash.slice(1);
			if (!id) return;
			const target = cards.get(id) || sections.get(id.replace(/^lane-/, ''));
			if (target && target.hidden) {
				filter.reset();
				target.scrollIntoView();
			}
		}
		window.addEventListener('hashchange', revealHashTarget);

		syncFilter(filter.state);
		revealHashTarget();
	}

	const count = document.getElementById('exg-count');
	if (count) count.textContent = String(EXAMPLES.length);

	const laneCount = document.getElementById('exg-lane-count');
	if (laneCount) laneCount.textContent = String(LANES.length);
})();
