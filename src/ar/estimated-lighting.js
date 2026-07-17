// Real-world lighting for WebXR placements, via the WebXR Lighting Estimation
// API (three's XREstimatedLight addon).
//
// A model lit by fixed studio lights always reads as pasted onto the camera
// feed: its highlights point the wrong way, its whites are the wrong colour,
// and a chrome surface reflects a room that isn't there. This wrapper replaces
// the studio's baked lights with the room's ACTUAL light the moment the device
// starts estimating it:
//
//   • a LightProbe carrying the room's ambient spherical harmonics (soft fill
//     from every direction, the real colour of the space),
//   • a DirectionalLight aimed along the room's primary light with its measured
//     colour + intensity (a warm lamp vs cool daylight lands correctly), and
//   • a live environment cube map so metal/glass models reflect the real room.
//
// The swap is reversible and self-healing: until estimation actually starts the
// baked lights stay on (no dark flash), and on session end — or if the device
// never estimates — everything is restored byte-for-byte. Depends only on a
// three.js addon; no new package, no custom shader.

import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';

/**
 * @param {object} opts
 * @param {import('three').WebGLRenderer} opts.renderer  Active XR renderer.
 * @param {import('three').Scene} opts.scene
 * @param {import('three').Light[]} opts.baseLights  The studio's own lights,
 *   dimmed to zero while real estimation drives the scene and restored on end.
 * @param {(active: boolean) => void} [opts.onChange]  Fired true when real
 *   estimation takes over, false when it reverts — drives a "lit by your room"
 *   status line, purely informational.
 */
export class EstimatedLighting {
	constructor({ renderer, scene, baseLights = [], onChange }) {
		this._renderer = renderer;
		this._scene = scene;
		this._baseLights = baseLights;
		this._onChange = onChange;

		this._xrLight = null;
		this._active = false;
		this._savedEnv = scene.environment;
		this._savedIntensities = baseLights.map((l) => l.intensity);

		this._onEstimationStart = this._onEstimationStart.bind(this);
		this._onEstimationEnd = this._onEstimationEnd.bind(this);
	}

	/**
	 * Stand up the estimated light. Call AFTER `renderer.xr.setSession` so the
	 * addon's own `sessionstart` listener fires and requests the light probe.
	 * A no-op-safe call: if the UA never delivers an estimate, the baked lights
	 * simply stay on and nothing here ever activates.
	 */
	start() {
		if (this._xrLight) return;
		// environmentEstimation:true → also request the reflection cube map.
		const xrLight = new XREstimatedLight(this._renderer, true);
		xrLight.addEventListener('estimationstart', this._onEstimationStart);
		xrLight.addEventListener('estimationend', this._onEstimationEnd);
		this._scene.add(xrLight);
		this._xrLight = xrLight;
	}

	get active() {
		return this._active;
	}

	_onEstimationStart() {
		if (!this._xrLight) return;
		this._active = true;
		// Hand the scene over to the real room: kill the baked lights so they
		// don't double-expose, and reflect the real environment on PBR surfaces.
		for (const l of this._baseLights) l.intensity = 0;
		if (this._xrLight.environment) this._scene.environment = this._xrLight.environment;
		this._onChange?.(true);
	}

	_onEstimationEnd() {
		// The device stopped estimating (walked into the dark, lost tracking):
		// fall back to the baked look rather than an unlit scene.
		this._active = false;
		this._restoreBase();
		this._onChange?.(false);
	}

	_restoreBase() {
		this._baseLights.forEach((l, i) => { l.intensity = this._savedIntensities[i]; });
		this._scene.environment = this._savedEnv;
	}

	/** Tear down on session end. Restores the baked lights + environment. */
	dispose() {
		if (this._xrLight) {
			this._xrLight.removeEventListener('estimationstart', this._onEstimationStart);
			this._xrLight.removeEventListener('estimationend', this._onEstimationEnd);
			this._scene.remove(this._xrLight);
			this._xrLight.dispose?.();
			this._xrLight = null;
		}
		this._restoreBase();
		this._active = false;
	}
}
