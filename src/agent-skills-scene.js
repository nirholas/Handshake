/**
 * 3D Scene Manipulation Skills
 * ----------------------------
 * Skills for creating and manipulating objects in the Three.js scene.
 */
import {
	SphereGeometry,
	ConeGeometry,
	CylinderGeometry,
	BoxGeometry,
	MeshStandardMaterial,
	Color,
	Mesh,
} from 'three';

// Store a reference to the viewer instance
let viewer;
export function setSceneViewer(viewerInstance) {
	viewer = viewerInstance;
}

/**
 * @param {import('./agent-skills.js').AgentSkills} skills
 */
export function registerSceneSkills(skills) {
	skills.register({
		name: 'scene-create-object',
		description: 'Create a new 3D object in the scene.',
		instruction: `Create a 3D object with the specified shape, color, and position.`,
		animationHint: 'gesture-magic',
		voicePattern: 'Okay, creating a {{shape}}.',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				shape: { type: 'string', description: 'The shape of the object (box, sphere, cone, cylinder)', enum: ['box', 'sphere', 'cone', 'cylinder'] },
				color: { type: 'string', description: 'Color of the object (e.g., "#ff0000", "red")' },
				position: { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, description: 'The x, y, z position of the object.'},
				scale: { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, description: 'The x, y, z scale of the object.'}
			},
			required: ['shape'],
		},
		handler: async (args) => {
			if (!viewer) return { success: false, output: '3D viewer is not available.' };

			const { shape = 'box', color = '#ffffff', position = {x: 0, y: 1, z: 0}, scale = {x: 1, y: 1, z: 1} } = args;

			let geometry;
			switch (shape) {
				case 'sphere':
					geometry = new SphereGeometry(0.5, 32, 32);
					break;
				case 'cone':
					geometry = new ConeGeometry(0.5, 1, 32);
					break;
				case 'cylinder':
					geometry = new CylinderGeometry(0.5, 0.5, 1, 32);
					break;
				case 'box':
				default:
					geometry = new BoxGeometry(1, 1, 1);
					break;
			}

			const material = new MeshStandardMaterial({ color: new Color(color) });
			const mesh = new Mesh(geometry, material);
			mesh.position.set(position.x, position.y, position.z);
			mesh.scale.set(scale.x, scale.y, scale.z);
			mesh.name = `${shape}_${Date.now()}`;

			viewer.scene.add(mesh);
			viewer.render();

			return { success: true, output: `I've created a ${shape} in the scene.` };
		},
	});

	skills.register({
		name: 'scene-find-object',
		description: 'Finds an object in the scene by its name.',
		instruction: 'Find an object by its given name and return it.',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The name of the object to find.' },
			},
			required: ['name'],
		},
		handler: async (args) => {
			if (!viewer) return { success: false, output: '3D viewer is not available.' };
			const object = viewer.scene.getObjectByName(args.name);
			if (object) {
				return { success: true, output: `Found object: ${args.name}`, data: { object } };
			}
			return { success: false, output: `Could not find an object named ${args.name}` };
		}
	});

	skills.register({
		name: 'scene-update-object',
		description: 'Update properties of a 3D object in the scene.',
		instruction: 'Update the color, position, rotation, or scale of a named object.',
		animationHint: 'gesture-manipulate',
		voicePattern: 'Okay, updating the {{name}}.',
		mcpExposed: true,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The name of the object to update.' },
				color: { type: 'string', description: 'New color for the object (e.g., "#00ff00")' },
				position: { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, description: 'New x, y, z position.'},
				rotation: { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, description: 'New x, y, z Euler rotation in radians.'},
				scale: { type: 'object', properties: { x: {type: 'number'}, y: {type: 'number'}, z: {type: 'number'} }, description: 'New x, y, z scale.'},
			},
			required: ['name'],
		},
		handler: async (args) => {
			if (!viewer) return { success: false, output: '3D viewer is not available.' };
			const { name, color, position, rotation, scale } = args;
			const object = viewer.scene.getObjectByName(name);

			if (!object) {
				return { success: false, output: `Object not found: ${name}` };
			}

			if (color && object.material) {
				object.material.color.set(new Color(color));
			}
			if (position) {
				object.position.set(position.x, position.y, position.z);
			}
			if (rotation) {
				object.rotation.set(rotation.x, rotation.y, rotation.z);
			}
			if (scale) {
				object.scale.set(scale.x, scale.y, scale.z);
			}

			viewer.render();
			return { success: true, output: `I've updated the ${name}.` };
		},
	});
}
