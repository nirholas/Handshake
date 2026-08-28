/**
 * What lands on disk after a generation.
 *
 * Pure string builders, so the shape of a generated project is testable without
 * a network, a filesystem, or a real model. The rule for every file here: it
 * must work when the person opens it, with no build step and no server.
 */

export const LOADER_URL = 'https://three.ws/agent-3d/latest/agent-3d.js';

/** A filesystem-safe directory name derived from what the person asked for. */
export function slugify(text, fallback = 'agent') {
	const slug = String(text || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.split('-')
		.filter(Boolean)
		.slice(0, 4)
		.join('-');
	return slug || fallback;
}

// A prompt is a sentence, and the subject is the part before its first
// preposition: "a knight with worn steel armor" is a Knight. Cutting at a fixed
// word count instead produced "Friendly Cartoon Astronaut In" on the first real
// run, and "Knight With Worn Steel" on the second.
const STOP_WORDS = new Set([
	'in', 'on', 'at', 'of', 'with', 'and', 'or', 'for', 'to', 'a', 'an', 'the', 'wearing', 'holding',
	'that', 'who', 'which', 'from', 'over', 'under', 'by',
]);

/** A display name from a prompt: "a friendly cartoon astronaut" -> "Friendly Cartoon Astronaut". */
export function titleFrom(text, fallback = 'Agent') {
	const all = String(text || '')
		.replace(/^(a|an|the)\s+/i, '')
		.split(/[\s,]+/)
		.filter(Boolean);
	const words = [];
	for (const word of all) {
		if (words.length && STOP_WORDS.has(word.toLowerCase())) break;
		words.push(word);
		if (words.length === 4) break;
	}
	if (!words.length) return fallback;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The embed snippet. This is the thing people paste into their own site, so it
 * is also the thing the CLI prints.
 */
export function embedSnippet({ name, glbUrl, instructions }) {
	const attrs = [
		`body="${escapeHtml(glbUrl)}"`,
		`name="${escapeHtml(name)}"`,
		instructions ? `instructions="${escapeHtml(instructions)}"` : null,
		'style="width:100%;max-width:420px;height:520px"',
	].filter(Boolean);
	return [
		`<script type="module" src="${LOADER_URL}"></script>`,
		'',
		`<agent-3d ${attrs.join('\n          ')}></agent-3d>`,
	].join('\n');
}

/**
 * The demo page. It points at the hosted model URL rather than the local file
 * on purpose: a page opened straight off the disk (file://) cannot fetch a
 * neighbouring .glb without a server, and a demo that shows nothing on a double
 * click is worse than no demo. The local copy is there for hosting.
 */
export function demoPage({ name, prompt, glbUrl, viewerUrl, rigged }) {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${escapeHtml(name)}</title>
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<script type="module" src="${LOADER_URL}"></script>
		<style>
			:root { color-scheme: light dark; }
			body {
				margin: 0; min-height: 100vh; display: grid; place-items: center; gap: 24px;
				padding: 40px 20px; box-sizing: border-box;
				font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				background: #0b0b16; color: #f6f7fb;
			}
			@media (prefers-color-scheme: light) { body { background: #fff; color: #0b0b18; } }
			main { display: grid; gap: 18px; justify-items: center; text-align: center; max-width: 560px; }
			h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
			p { margin: 0; opacity: 0.7; font-size: 14px; line-height: 1.6; }
			agent-3d { width: 100%; max-width: 420px; height: 520px; border-radius: 20px; overflow: hidden; }
			code { font-size: 12.5px; opacity: 0.8; }
			a { color: inherit; }
		</style>
	</head>
	<body>
		<main>
			<h1>${escapeHtml(name)}</h1>
			<p>${escapeHtml(prompt)}</p>
			<agent-3d
				body="${escapeHtml(glbUrl)}"
				name="${escapeHtml(name)}"
				style="width:100%;max-width:420px;height:520px"
			></agent-3d>
			<p>
				${rigged ? 'Rigged: this figure has a humanoid skeleton, so it can be posed and animated.' : 'Mesh only: no skeleton on this one.'}
				Open it in the <a href="${escapeHtml(viewerUrl)}">three.ws viewer</a>, or drop
				<code>agent.glb</code> into Blender, Unity, or any glTF tool.
			</p>
		</main>
	</body>
</html>
`;
}

/** The record of what was made. Machine-readable, so a script can pick it up. */
export function agentRecord({ name, prompt, imageUrl, result, createdAt = new Date() }) {
	return `${JSON.stringify(
		{
			name,
			prompt: prompt || null,
			imageUrl: imageUrl || null,
			kind: result.kind,
			rigged: result.rigged,
			glbUrl: result.glbUrl,
			viewerUrl: result.viewerUrl,
			studioUrl: result.studioUrl,
			backend: result.backend,
			generationMs: result.durationMs,
			createdAt: createdAt.toISOString(),
			madeWith: '@three-ws/create-agent',
		},
		null,
		'\t',
	)}\n`;
}

export function readme({ name, prompt, result, dir }) {
	return `# ${name}

Made with one command:

\`\`\`bash
npm create @three-ws/agent "${prompt}"
\`\`\`

## What is in here

| File | What it is |
| --- | --- |
| \`agent.glb\` | The 3D model${result.rigged ? ', with a humanoid skeleton (poseable and animatable)' : ''}. Open it in Blender, Unity, Godot, or any glTF tool. |
| \`index.html\` | A working demo page. Open it in a browser. |
| \`agent.json\` | The record: the prompt, the hosted URLs, and how it was made. |

## Put it on your site

\`\`\`html
${embedSnippet({ name, glbUrl: result.glbUrl, instructions: null })}
\`\`\`

That is the whole integration. The element loads the model, renders it with
three.js, and needs no build step and no API key. Full attribute reference:
<https://three.ws/docs/web-component>.

## Host the model yourself

\`\`\`html
<agent-3d body="/agent.glb" name="${name}"></agent-3d>
\`\`\`

\`agent.glb\` in this folder is yours. Serve it from your own origin and point
\`body\` at it; nothing here calls back to three.ws except the loader script.
Serving the folder locally (\`npx serve ${dir}\`) is enough to try it.

## Links

- Viewer: ${result.viewerUrl}
${result.studioUrl ? `- Pose studio: ${result.studioUrl}\n` : ''}- Hosted model: ${result.glbUrl}
- Docs: <https://three.ws/docs/create-agent>

## Next

- Give it a voice and a personality: <https://three.ws/create>
- Put its live status on your home screen or in a README: <https://three.ws/glance>
- Publish it so other agents can hire it: <https://three.ws/marketplace>
`;
}

/** Every file a generated project contains, as { path: contents }. */
export function projectFiles({ name, prompt, imageUrl, result, dir }) {
	return {
		'index.html': demoPage({
			name,
			prompt: prompt || 'Generated from a reference image.',
			glbUrl: result.glbUrl,
			viewerUrl: result.viewerUrl,
			rigged: result.rigged,
		}),
		'agent.json': agentRecord({ name, prompt, imageUrl, result }),
		'README.md': readme({ name, prompt: prompt || 'a character from a photo', result, dir }),
	};
}
