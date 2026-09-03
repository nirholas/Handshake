// Scene Studio boot — mounts the vendored three.js editor (r184, MIT, see
// vendor/LICENSE) into the #studio-app container under the three.ws site nav.
// Ported from editor/index.html upstream; local changes: container mount
// instead of document.body, no service worker, three.ws chrome overrides.

import './vendor/css/main.css';
import './studio.css';

// Dark-locked surface: the injected site theme boot honors the user's saved
// theme, but the studio chrome (vendor css + studio.css) only ships dark.
document.documentElement.setAttribute('data-theme', 'dark');

import * as THREE from 'three';

import { Editor } from './vendor/js/Editor.js';
import { AddScriptCommand } from './vendor/js/commands/AddScriptCommand.js';
import { takeSceneHandoff } from '../shared/scene-handoff.js';
import { Viewport } from './vendor/js/Viewport.js';
import { Toolbar } from './vendor/js/Toolbar.js';
import { Script } from './vendor/js/Script.js';
import { Player } from './vendor/js/Player.js';
import { Sidebar } from './vendor/js/Sidebar.js';
import { Menubar } from './vendor/js/Menubar.js';
import { Resizer } from './vendor/js/Resizer.js';
import { AnimationResizer } from './vendor/js/AnimationResizer.js';
import { Animation } from './vendor/js/Animation.js';

import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

import { addGltfBufferToScene as sharedAddGltfBufferToScene } from './loader.js';
import { mountStudioActions } from './actions.js';
import { mountEmptyState } from './empty-state.js';
import { enhanceToolbarA11y } from './toolbar-a11y.js';
import { toastError } from '../shared/toast.js';

window.URL = window.URL || window.webkitURL;
window.BlobBuilder = window.BlobBuilder || window.WebKitBlobBuilder || window.MozBlobBuilder;

const container = document.getElementById('studio-app');

const editor = new Editor();

window.editor = editor; // Expose editor to Console
window.THREE = THREE; // Expose THREE to APP Scripts and Console

THREE.ObjectLoader.registerGeometry('TextGeometry', TextGeometry);

const viewport = new Viewport(editor);
container.appendChild(viewport.dom);

const toolbar = new Toolbar(editor);
container.appendChild(toolbar.dom);

const script = new Script(editor);
container.appendChild(script.dom);

const player = new Player(editor);
container.appendChild(player.dom);

const sidebar = new Sidebar(editor);
container.appendChild(sidebar.dom);

const menubar = new Menubar(editor);
container.appendChild(menubar.dom);

const resizer = new Resizer(editor);
container.appendChild(resizer.dom);

const animation = new Animation(editor);
container.appendChild(animation.dom);

const animationResizer = new AnimationResizer(editor);
container.appendChild(animationResizer.dom);

// Layered quality-of-life bar — Import from Forge / Export presets / Share —
// sibling to the vendored chrome, never touching vendor/**. See actions.js.
mountStudioActions(editor, container);

// The vendored transform buttons ship as icon-only <button>s with no
// accessible name; label them and announce their pressed state.
enhanceToolbarA11y(editor, toolbar.dom);

// First-run guidance over the empty grid. Retires itself as soon as the scene
// holds anything, including a scene restored from the autosave below.
mountEmptyState(editor, container);

editor.signals.animationPanelChanged.add(function (height) {
	const visible = height !== false;

	viewport.dom.classList.toggle('with-animation', visible);
	toolbar.dom.classList.toggle('with-animation', visible);

	if (visible) {
		viewport.dom.style.bottom = height + 'px';
		toolbar.dom.style.bottom = height + 20 + 'px';
	} else {
		viewport.dom.style.bottom = '';
		toolbar.dom.style.bottom = '';
	}

	editor.signals.windowResize.dispatch();
});

//

editor.storage.init(function () {
	editor.storage.get(async function (state) {
		if (isLoadingFromHash) return;

		if (state !== undefined) {
			await editor.fromJSON(state);
		} else {
			editor.signals.sceneEnvironmentChanged.dispatch('Default');
		}

		const selected = editor.config.getKey('selected');

		if (selected !== undefined) {
			editor.selectByUuid(selected);
		}

		importModelFromQuery();
		importHandoffAnimation();
	});

	//

	let timeout;

	function saveState() {
		if (editor.config.getKey('autosave') === false) {
			return;
		}

		clearTimeout(timeout);

		timeout = setTimeout(function () {
			editor.signals.savingStarted.dispatch();

			timeout = setTimeout(function () {
				editor.storage.set(editor.toJSON());

				editor.signals.savingFinished.dispatch();
			}, 100);
		}, 1000);
	}

	const signals = editor.signals;

	signals.geometryChanged.add(saveState);
	signals.objectAdded.add(saveState);
	signals.objectChanged.add(saveState);
	signals.objectRemoved.add(saveState);
	signals.materialChanged.add(saveState);
	signals.sceneBackgroundChanged.add(saveState);
	signals.sceneEnvironmentChanged.add(saveState);
	signals.sceneFogChanged.add(saveState);
	signals.sceneGraphChanged.add(saveState);
	signals.scriptChanged.add(saveState);
	signals.historyChanged.add(saveState);
});

// Deep-link: /scene?model=<glb_url>&name=<label> — e.g. the "Open in Scene
// Studio" hand-off after Forge or Parts Studio finishes. The GLB is fetched
// and added through AddObjectCommand (undo, autosave, and the outliner behave
// as if the user imported it) — deliberately skipping the editor's
// add-or-replace import dialog, since a deep-link arrival has an unambiguous
// intent: add this model to the scene. The query is then stripped from the
// address bar so a reload doesn't import a duplicate — autosave already
// persists the object. The decoder-wired loader itself lives in the sibling
// loader.js module, shared with actions.js's "Import from Forge" affordance.
async function addGltfBufferToScene(contents, label) {
	return sharedAddGltfBufferToScene(editor, contents, label);
}

async function importModelFromQuery() {
	const params = new URLSearchParams(window.location.search);
	const modelUrl = params.get('model');
	if (!modelUrl) return;
	if (!/^https:\/\//.test(modelUrl) && !modelUrl.startsWith('/')) return;

	window.history.replaceState(null, '', window.location.pathname + window.location.hash);

	try {
		const res = await fetch(modelUrl);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const contents = await res.arrayBuffer();

		const urlBase = decodeURIComponent(modelUrl.split('?')[0].split('/').pop() || '');
		const label = (params.get('name') || urlBase.replace(/\.(glb|gltf)$/i, '') || 'Model')
			.replace(/\s+/g, ' ').trim().slice(0, 64) || 'Model';
		await addGltfBufferToScene(contents, label);
	} catch (error) {
		toastError(
			`Could not load the handed-off model: ${error.message}. ` +
				'Download the GLB and drag the file into the editor instead.',
			{ duration: 7000 },
		);
	}
}

// Hand-off from the Animation Studio (/pose): a baked GLB (mesh + embedded clip)
// stashed in IndexedDB. We load it as an object, then attach a player script
// that drives an AnimationMixer — because the Render ▸ Video path runs through
// APP.Player, which animates via object scripts, NOT bare clips. With the script
// in place the clip plays in the live timeline AND records to video. The
// canonical-name clip already binds to the GLB's own nodes, so no retargeting.
const HANDOFF_PLAY_SCRIPT = {
	name: 'Play Animation (three.ws)',
	source: [
		'var mixer = new THREE.AnimationMixer( this );',
		'var clip = ( this.animations && this.animations[ 0 ] ) || null;',
		'if ( clip ) mixer.clipAction( clip ).play();',
		'',
		'function update( event ) {',
		'',
		'\tif ( clip ) mixer.setTime( event.time / 1000 );',
		'',
		'}',
	].join('\n'),
};

async function importHandoffAnimation() {
	const params = new URLSearchParams(window.location.search);
	if (params.get('handoff') !== '1') return;

	window.history.replaceState(null, '', window.location.pathname + window.location.hash);

	let record;
	try {
		record = await takeSceneHandoff();
	} catch {
		return; // IndexedDB unavailable (private mode, etc.) — nothing to load.
	}
	if (!record) return;

	try {
		const object = await addGltfBufferToScene(record.glb, record.name || 'Animation');
		if (object.animations.length > 0) {
			editor.execute(new AddScriptCommand(editor, object, { ...HANDOFF_PLAY_SCRIPT }));
		}
	} catch (error) {
		toastError(
			`Could not load the animation from the Animation Studio: ${error.message}. ` +
				'Try Export GLB on /pose and drag the file in instead.',
			{ duration: 7000 },
		);
	}
}

//

document.addEventListener('dragover', function (event) {
	event.preventDefault();
	event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('drop', function (event) {
	event.preventDefault();

	if (event.dataTransfer.types[0] === 'text/plain') return; // Outliner drop

	if (event.dataTransfer.items) {
		// DataTransferItemList supports folders
		editor.loader.loadItemList(event.dataTransfer.items);
	} else {
		editor.loader.loadFiles(event.dataTransfer.files);
	}
});

function onWindowResize() {
	editor.signals.windowResize.dispatch();
}

window.addEventListener('resize', onWindowResize);

onWindowResize();

//

let isLoadingFromHash = false;
const hash = window.location.hash;

if (hash.slice(1, 6) === 'file=') {
	const file = hash.slice(6);

	if (confirm(editor.strings.getKey('prompt/file/open'))) {
		const loader = new THREE.FileLoader();
		loader.crossOrigin = '';
		loader.load(file, function (text) {
			editor.clear();
			editor.fromJSON(JSON.parse(text));
		});

		isLoadingFromHash = true;
	}
}
