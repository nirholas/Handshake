// Spatial MCP reference renderer: renders any conformant Spatial MCP artifact.
//
// A small, dependency-light, framework-free renderer that turns a Spatial MCP
// artifact (specs/SPATIAL_MCP.md) into an interactive <model-viewer> scene:
// orbit/zoom, animation playback, an AR button, and graceful fallback for every
// missing optional field. It is the REFERENCE IMPLEMENTATION of the spec: any
// MCP host or third-party app can adopt this shape and use (or reimplement) this
// renderer. Zero payment/wallet/coin surface, so it drops into the free OpenAI
// track unchanged.
//
// Usage:
//   import { renderSpatialArtifact } from './spatial-renderer.js';
//   renderSpatialArtifact(document.getElementById('mount'), artifact);
//
// It expects the <model-viewer> custom element to be available on the page (load
// @google/model-viewer). It never fetches anything itself beyond the GLB the
// artifact points at, and only ever loads https assets.
//
// Every state is designed, never a blank frame. The mount carries
// `data-spatial-state` through the whole lifecycle so a host can style each one:
//   "empty"   the payload is unusable; a `.spatial-empty` message is shown
//   "loading" the GLB is downloading; a `.spatial-loading` skeleton sits under
//             the viewer until it decodes
//   "ready"   the scene is on screen
//   "error"   the GLB could not be fetched or decoded; the viewer is replaced by
//             a `.spatial-error` message that names the host, says what to
//             check, and offers a `.spatial-retry` button that re-renders

function isHttps(u) {
	try {
		return typeof u === 'string' && new URL(u).protocol === 'https:';
	} catch {
		return false;
	}
}

// Minimal structural check mirroring api/_lib/spatial-mcp.js validateSpatialArtifact,
// enough to render safely. The full validator is the authority; this keeps the
// renderer standalone (no build-time import) while refusing an unusable payload.
export function canRenderSpatialArtifact(artifact) {
	return (
		artifact &&
		typeof artifact === 'object' &&
		typeof artifact.spatialMcpVersion === 'string' &&
		artifact.scene &&
		isHttps(artifact.scene.glbUrl)
	);
}

/** The host a scene is served from, for the error copy. */
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return String(url);
	}
}

function setState(mount, state) {
	mount.dataset.spatialState = state;
	if (state === 'loading') mount.setAttribute('aria-busy', 'true');
	else mount.removeAttribute('aria-busy');
}

/**
 * The designed error state: what a host shows when the asset behind a conformant
 * artifact is unreachable. Actionable by construction: it names the host, lists
 * the three things that make a GLB unfetchable from a browser, and retries in
 * place.
 */
function renderLoadError(mount, artifact, attempt) {
	mount.textContent = '';
	setState(mount, 'error');

	const box = document.createElement('div');
	box.className = 'spatial-error';
	box.setAttribute('role', 'alert');

	const title = document.createElement('strong');
	title.textContent = 'The 3D scene could not be loaded.';

	const detail = document.createElement('p');
	detail.textContent =
		`${hostOf(artifact.scene.glbUrl)} did not return a readable GLB. Check that the URL is reachable, ` +
		'served over https with an Access-Control-Allow-Origin header, and is a valid .glb file, then try again.';

	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = 'spatial-retry';
	retry.textContent = 'Try again';
	retry.addEventListener('click', () => render(mount, artifact, attempt + 1));

	box.append(title, detail, retry);
	mount.appendChild(box);
}

/**
 * The URL handed to <model-viewer>. model-viewer keeps a per-URL cache of loaded
 * scenes and, after a failed fetch, parks an empty scene under that URL, so a
 * retry with the identical string would show the failure again without a
 * single new request. A fragment is never sent to the server (the fetch, any
 * signature on the URL, and the CDN cache are all unchanged) but it is a
 * different cache key, so each retry genuinely refetches.
 */
function sourceUrl(glbUrl, attempt) {
	return attempt > 0 ? `${glbUrl}#spatial-retry-${attempt}` : glbUrl;
}

/**
 * Render a Spatial MCP artifact into `mount`. Returns the created <model-viewer>
 * element (or null when the artifact can't be rendered; the mount then shows a
 * designed fallback message instead of a blank frame).
 */
export function renderSpatialArtifact(mount, artifact) {
	return render(mount, artifact, 0);
}

function render(mount, artifact, attempt) {
	if (!mount) return null;
	mount.textContent = '';

	if (!canRenderSpatialArtifact(artifact)) {
		setState(mount, 'empty');
		const msg = document.createElement('div');
		msg.className = 'spatial-empty';
		msg.textContent = 'No renderable 3D scene in this payload.';
		mount.appendChild(msg);
		return null;
	}

	const scene = artifact.scene;
	const camera = artifact.camera || {};
	const env = artifact.environment || {};
	const affordances = artifact.affordances || {};
	const ar = artifact.ar || {};

	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', sourceUrl(scene.glbUrl, attempt));
	mv.setAttribute('alt', scene.alt || (artifact.meta && artifact.meta.title) || 'Interactive 3D model');
	if (isHttps(scene.poster)) mv.setAttribute('poster', scene.poster);

	// Camera / interaction: honor affordances, default to a framed, orbitable view.
	if (affordances.orbit !== false) mv.setAttribute('camera-controls', '');
	if (camera.autoRotate !== false) mv.setAttribute('auto-rotate', '');
	if (typeof camera.orbit === 'string') mv.setAttribute('camera-orbit', camera.orbit);
	if (typeof camera.fieldOfView === 'string') mv.setAttribute('field-of-view', camera.fieldOfView);
	if (affordances.zoom === false) mv.setAttribute('disable-zoom', '');
	mv.setAttribute('touch-action', 'pan-y');
	mv.setAttribute('interaction-prompt', 'none');

	// Environment / lighting.
	mv.setAttribute('environment-image', typeof env.image === 'string' ? env.image : 'neutral');
	if (typeof env.exposure === 'number') mv.setAttribute('exposure', String(env.exposure));
	if (typeof env.shadowIntensity === 'number') mv.setAttribute('shadow-intensity', String(env.shadowIntensity));
	mv.setAttribute('tone-mapping', 'aces');

	// Animation: autoplay when the artifact declares an animation block.
	if (artifact.animation) {
		if (artifact.animation.autoplay !== false) mv.setAttribute('autoplay', '');
		if (Array.isArray(artifact.animation.clips) && artifact.animation.clips.length) {
			mv.setAttribute('animation-name', String(artifact.animation.clips[0]));
		}
	}

	// AR handoff: enable AR when the artifact declares an AR asset/link, or always
	// offer WebXR/Scene-Viewer/Quick-Look from the GLB itself as a graceful default.
	mv.setAttribute('ar', '');
	mv.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
	mv.setAttribute('ar-scale', 'auto');
	if (isHttps(ar.usdzUrl)) mv.setAttribute('ios-src', ar.usdzUrl);

	mv.style.width = '100%';
	mv.style.height = '100%';
	mv.style.background = 'transparent';
	// The viewer paints above the skeleton; the skeleton shows through its
	// transparent canvas until the scene decodes, then goes away.
	mv.style.position = 'relative';
	mv.style.zIndex = '1';

	const skeleton = document.createElement('div');
	skeleton.className = 'spatial-loading';
	skeleton.setAttribute('aria-hidden', 'true');

	setState(mount, 'loading');
	mount.append(skeleton, mv);

	// A mount can be re-rendered while a previous viewer is still downloading.
	// That viewer is detached but its load still settles, so its events must not
	// touch the mount's current state: only a viewer that is still the mount's
	// child may report.
	const current = () => mv.parentNode === mount;
	mv.addEventListener(
		'load',
		() => {
			if (!current()) return;
			skeleton.remove();
			setState(mount, 'ready');
		},
		{ once: true },
	);
	// model-viewer reports a failed fetch or decode as an `error` event with
	// `detail.type === 'loadfailure'` (other types, such as a lost WebGL context,
	// are transient and the viewer recovers on its own).
	mv.addEventListener('error', (event) => {
		if (!current()) return;
		const type = event.detail && event.detail.type;
		if (type && type !== 'loadfailure') return;
		renderLoadError(mount, artifact, attempt);
	});

	return mv;
}
