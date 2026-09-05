// Paste-ready source for one three.ws library asset.
//
// A catalog is only half an answer: an agent that finds the right prop still has
// to know which tag renders it, which script to load, and how to pin it. This
// module turns a normalized catalog item (api/_lib/asset-catalog.js) into code
// that runs as-is on any site, in the same shapes three.ws itself ships:
//
//   agent-3d      the <agent-3d> web component (what our own embeds use)
//   model-viewer  the <model-viewer> tag the /objects and /character-library
//                 grids render each card with
//   three         plain three.js with GLTFLoader, for an existing scene
//   react         the web component wrapped as a React component
//
// The <agent-3d> snippet is pinned to the exact version this deployment serves
// and carries its Subresource Integrity hash, both read from the release
// manifest `npm run publish:lib` writes into dist/. A snippet that says "latest"
// is a snippet that can break under the reader with no action on their side, so
// we never emit one.

import { readFileSync } from 'node:fs';

const VERSIONS_PATH = new URL('../../dist/agent-3d/versions.json', import.meta.url);

// Read once per process: the manifest changes only when a new image is built,
// and every miss would otherwise cost a synchronous disk read per tool call.
let RELEASE = undefined;

/**
 * The published <agent-3d> release: { version, integrity } when the manifest is
 * readable, else null. Null degrades the snippet to the major-version channel
 * (still stable, just not byte-pinned) rather than emitting a wrong hash.
 */
export function agentElementRelease() {
	if (RELEASE !== undefined) return RELEASE;
	try {
		const manifest = JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
		const version = String(manifest?.latest || '').trim();
		const integrity = manifest?.channels?.[version]?.integrity?.['agent-3d.js'] || null;
		RELEASE = version ? { version, integrity } : null;
	} catch {
		RELEASE = null;
	}
	return RELEASE;
}

/** Drop the memo so a test can exercise both the pinned and the fallback path. */
export function resetReleaseCache() {
	RELEASE = undefined;
}

// The <model-viewer> build and hash the /objects and /character-library pages
// load. Kept identical to pages/objects.html on purpose: a reader who copies
// this snippet gets exactly the renderer they saw on the site.
const MODEL_VIEWER_SRC =
	'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
const MODEL_VIEWER_SRI =
	'sha384-sr9b4Ux0WhAUGclJ0ym0FSY2zSOMmNSn0bP/SA0e6bNCrpn/5W3QL8mm+LdlQMKw';

export const MODEL_FRAMEWORKS = ['agent-3d', 'model-viewer', 'three', 'react'];
export const CLIP_FRAMEWORKS = ['three', 'react', 'agent-3d'];

/** Which frameworks apply to an item, most appropriate first. */
export function frameworksFor(item) {
	if (item?.kind === 'animation') return CLIP_FRAMEWORKS;
	// A prop is not an embodied agent: the object grid renders it with
	// <model-viewer>, so that is what we recommend first for objects, and the
	// avatar component comes first for a rigged character.
	return item?.kind === 'object'
		? ['model-viewer', 'three', 'agent-3d', 'react']
		: MODEL_FRAMEWORKS;
}

function attrEscape(value) {
	return String(value ?? '').replace(/[&<>"]/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
	})[c]);
}

function jsString(value) {
	return JSON.stringify(String(value ?? ''));
}

function agentScriptTag() {
	const release = agentElementRelease();
	if (release?.version && release.integrity) {
		return {
			tag:
				`<script\n  type="module"\n  src="https://three.ws/agent-3d/${release.version}/agent-3d.js"\n` +
				`  integrity="${release.integrity}"\n  crossorigin="anonymous"\n></script>`,
			note: `Pinned to agent-3d ${release.version} with its published SRI hash. Release data: https://three.ws/agent-3d/versions.json`,
		};
	}
	return {
		tag:
			'<script type="module" src="https://three.ws/agent-3d/1/agent-3d.js" crossorigin="anonymous"></script>',
		note:
			'Pinned to the agent-3d 1.x channel. For production, read https://three.ws/agent-3d/versions.json and pin the exact version plus its integrity hash.',
	};
}

function modelSnippets(item, origin) {
	const url = item.url;
	const alt = item.title;
	const script = agentScriptTag();
	const react = `import { useEffect } from "react";

const AGENT_3D_SRC = ${jsString(
		agentElementRelease()?.version
			? `https://three.ws/agent-3d/${agentElementRelease().version}/agent-3d.js`
			: 'https://three.ws/agent-3d/1/agent-3d.js',
	)};

/** Renders the three.ws ${alt} model. The custom element is defined once per page. */
export function ${componentName(item)}() {
  useEffect(() => {
    if (document.querySelector('script[data-agent-3d]')) return;
    const s = document.createElement("script");
    s.type = "module";
    s.src = AGENT_3D_SRC;
    s.crossOrigin = "anonymous";
    s.dataset.agent3d = "1";
    document.head.appendChild(s);
  }, []);

  return (
    <agent-3d
      body=${jsString(url)}
      mode="section"
      style={{ width: "100%", height: 420, display: "block" }}
    />
  );
}`;

	return {
		'agent-3d': {
			language: 'html',
			code: `${script.tag}\n\n<agent-3d\n  body="${attrEscape(url)}"\n  mode="section"\n  style="width:100%;height:420px;display:block"\n></agent-3d>`,
			notes: [
				script.note,
				'The bundle is served with access-control-allow-origin: *, so it loads from any domain.',
			],
		},
		'model-viewer': {
			language: 'html',
			code: `<script\n  type="module"\n  src="${MODEL_VIEWER_SRC}"\n  integrity="${MODEL_VIEWER_SRI}"\n  crossorigin="anonymous"\n></script>\n\n<model-viewer\n  src="${attrEscape(url)}"\n  alt="${attrEscape(alt)}"\n  camera-controls\n  auto-rotate\n  ar\n  shadow-intensity="1"\n  style="width:100%;height:420px"\n></model-viewer>`,
			notes: [
				'This is the exact renderer and build the three.ws browse grids use.',
				'Drop the `ar` attribute if you do not want the mobile AR button.',
			],
		},
		three: {
			language: 'javascript',
			code: `import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const gltf = await loader.loadAsync(${jsString(url)});
scene.add(gltf.scene);${
				item.kind === 'character'
					? `

// The character ships rigged. Drive it with any clip from the three.ws motion
// library (see the "animation" kind in search_catalog).
const mixer = new THREE.AnimationMixer(gltf.scene);
if (gltf.animations.length) mixer.clipAction(gltf.animations[0]).play();
// Call mixer.update(delta) from your render loop.`
					: ''
			}`,
			notes: [
				`The GLB is served cross-origin from the three.ws CDN; no proxy or re-hosting is needed.${
					item.bytes ? ` It is ${formatBytes(item.bytes)}.` : ''
				}`,
			],
		},
		react: { language: 'jsx', code: react, notes: [script.note] },
		_links: modelLinks(item, origin),
	};
}

function clipSnippets(item, origin) {
	const url = item.url;
	return {
		three: {
			language: 'javascript',
			code: `import * as THREE from "three";

// three.ws motion clips are plain THREE.AnimationClip JSON.
const json = await fetch(${jsString(url)}).then((r) => r.json());
const clip = THREE.AnimationClip.parse(json);

// Track names use the canonical (Mixamo) bone names. Any avatar whose rig maps
// to that skeleton plays it directly; retarget first if yours does not.
const mixer = new THREE.AnimationMixer(avatar);
const action = mixer.clipAction(clip);
action.setLoop(${item.loop ? 'THREE.LoopRepeat, Infinity' : 'THREE.LoopOnce, 1'});
action.play();
// Call mixer.update(delta) from your render loop.`,
			notes: [
				item.duration_seconds
					? `The clip runs ${item.duration_seconds.toFixed(2)}s and ${item.loop ? 'loops' : 'plays once'}.`
					: `The clip ${item.loop ? 'loops' : 'plays once'}.`,
				'To bake this clip onto your own rig server-side instead, call the apply_animation MCP tool with your GLB url and this clip name.',
			],
		},
		react: {
			language: 'jsx',
			code: `import { useEffect } from "react";
import * as THREE from "three";

const CLIP_URL = ${jsString(url)};

/** Plays the three.ws "${item.title}" clip on an existing avatar object. */
export function use${componentName(item)}(avatar) {
  useEffect(() => {
    if (!avatar) return;
    let mixer;
    let raf;
    let cancelled = false;
    const clock = new THREE.Clock();

    fetch(CLIP_URL)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        mixer = new THREE.AnimationMixer(avatar);
        const action = mixer.clipAction(THREE.AnimationClip.parse(json));
        action.setLoop(${item.loop ? 'THREE.LoopRepeat, Infinity' : 'THREE.LoopOnce, 1'});
        action.play();
        const tick = () => {
          mixer.update(clock.getDelta());
          raf = requestAnimationFrame(tick);
        };
        tick();
      });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      mixer?.stopAllAction();
    };
  }, [avatar]);
}`,
			notes: ['Pair this with the three snippet for the avatar itself.'],
		},
		'agent-3d': {
			language: 'html',
			code: `${agentScriptTag().tag}\n\n<agent-3d\n  body="https://three.ws/avatars/default.glb"\n  clip="idle"\n  mode="section"\n  style="width:100%;height:420px;display:block"\n></agent-3d>`,
			notes: [
				'The `clip` attribute resolves names from the built-in gesture manifest (https://three.ws/animations/manifest.json), which is a curated subset and does not include this library clip.',
				`To use "${item.title}" in an embed, bake it onto your avatar first with the apply_animation MCP tool, then point \`body\` at the returned GLB.`,
			],
		},
		_links: clipLinks(item, origin),
	};
}

function componentName(item) {
	const pascal = String(item.title || item.name)
		.replace(/[^A-Za-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('');
	// A component identifier cannot start with a digit, and a purely numeric
	// title (the motion library has clips named for angles) would produce one.
	return /^[A-Za-z]/.test(pascal) ? pascal : `Asset${pascal}`;
}

function formatBytes(n) {
	const mb = n / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function modelLinks(item, origin) {
	const model = encodeURIComponent(item.url || '');
	if (!item.url) return { browse: `${origin}/${item.kind === 'object' ? 'objects' : 'character-library'}` };
	if (item.kind === 'object') {
		return {
			browse: `${origin}/objects`,
			preview: `${origin}/app#model=${model}&kind=object&title=${encodeURIComponent(item.title)}`,
			ar: `${origin}/ar/studio?src=${model}&title=${encodeURIComponent(item.title)}`,
			download: item.url,
		};
	}
	return {
		browse: `${origin}/character-library`,
		preview: `${origin}/app#model=${model}`,
		use: `${origin}/studio?model=${model}`,
		animate: `${origin}/pose?src=${model}&title=${encodeURIComponent(item.title)}`,
		download: item.url,
	};
}

function clipLinks(item, origin) {
	return {
		browse: `${origin}/animations`,
		preview: `${origin}/animations?clip=${encodeURIComponent(item.name)}`,
		download: item.url,
	};
}

/**
 * Every snippet for an item, plus the site links that go with it.
 *
 * @param {object} item    A normalized catalog item.
 * @param {string} origin  Absolute site origin for links.
 * @returns {{ frameworks: string[], snippets: object, links: object }}
 */
export function sourceFor(item, origin) {
	const built = item.kind === 'animation' ? clipSnippets(item, origin) : modelSnippets(item, origin);
	const { _links: links, ...snippets } = built;
	return { frameworks: frameworksFor(item), snippets, links };
}

/**
 * One framework's snippet, or null when the framework does not apply to the
 * item (asking for `model-viewer` on a motion clip, say).
 */
export function snippetFor(item, framework, origin) {
	const { snippets, links, frameworks } = sourceFor(item, origin);
	const chosen = framework || frameworks[0];
	const snippet = snippets[chosen];
	if (!snippet) return null;
	return { framework: chosen, ...snippet, links, available_frameworks: frameworks };
}
