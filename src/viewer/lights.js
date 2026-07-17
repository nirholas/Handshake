import { AmbientLight, DirectionalLight, HemisphereLight } from 'three';
import { Preset } from './internal.js';

export function addLights(viewer) {
	const { state, options } = viewer;

	if (options.preset === Preset.ASSET_GENERATOR) {
		const hemiLight = new HemisphereLight();
		hemiLight.name = 'hemi_light';
		viewer.scene.add(hemiLight);
		viewer.lights.push(hemiLight);
		return;
	}

	// Studio three-point rig. Ambient, key and fill ride the camera so the
	// avatar stays evenly lit from the viewer's angle as it orbits; the rim/back
	// light is anchored in world space behind-and-above the subject to keep a
	// consistent edge highlight that separates dark avatars from dark cards.
	const ambient = new AmbientLight(state.ambientColor, state.ambientIntensity);
	ambient.name = 'ambient_light';
	viewer.defaultCamera.add(ambient);

	const key = new DirectionalLight(state.directColor, state.directIntensity);
	key.position.set(0.5, 0.6, 0.866); // upper front-right, ~60º
	key.name = 'main_light';
	viewer.defaultCamera.add(key);

	const fill = new DirectionalLight(
		state.fillColor ?? '#DCE6FF',
		state.directIntensity * (state.fillRatio ?? 0.4),
	);
	fill.position.set(-0.9, 0.1, 0.6); // opposite side, near eye level
	fill.name = 'fill_light';
	viewer.defaultCamera.add(fill);

	const rim = new DirectionalLight(
		state.rimColor ?? '#FFFFFF',
		state.directIntensity * (state.rimRatio ?? 0.65),
	);
	rim.position.set(-1.2, 2.4, -2.6); // behind-above, throws a hair/shoulder edge
	rim.name = 'rim_light';
	viewer.scene.add(rim);

	viewer.lights.push(ambient, key, fill, rim);

	// World-anchored overhead light whose only real job is the soft contact
	// shadow on the ground catcher (see viewer.js _updateShadowCatcher). It is
	// deliberately NOT the camera-riding key: a camera-space caster would spin
	// the shadow around the model as the user orbits. Intensity stays low so
	// the calibrated studio rig above still defines the look. Skipped on
	// low-power devices along with the shadow map itself.
	if (!viewer._lowPower) {
		const shadowSun = new DirectionalLight('#FFFFFF', 0.25);
		shadowSun.position.set(1.5, 4, 2.5);
		shadowSun.castShadow = true;
		shadowSun.shadow.mapSize.set(1024, 1024);
		shadowSun.shadow.bias = -0.002;
		shadowSun.name = 'shadow_light';
		viewer.scene.add(shadowSun);
		viewer.lights.push(shadowSun);
	}
}

export function removeLights(viewer) {
	viewer.lights.forEach((light) => light.parent?.remove(light));
	viewer.lights.length = 0;
}
