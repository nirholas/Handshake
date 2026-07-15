// 3D API catalog entry — free text→3D generation.
//
// Consumed by the /api/3d index + OpenAPI assembler (api/_lib/3d-catalog/index.js,
// prompt 14), which globs this directory. Same entry shape as the crypto catalog
// (slug / method / path / title / summary / inputSchema / outputSchema / example),
// so the two free APIs render identically. Stands alone with zero dependency on
// the assembler existing yet.

export default {
	slug: 'generate',
	method: 'POST',
	path: '/api/3d/generate',
	title: 'Text → 3D (free draft)',
	summary:
		'Turn a text prompt into a real textured GLB model. Free, keyless, no account. ' +
		'The draft/NIM tier (single-subject, draft-fidelity geometry, no rigging); ' +
		'higher quality + rigging live behind paid Forge Pro and Rigged Avatars. ' +
		'Returns the GLB inline when the draft finishes fast, otherwise a job token to poll ' +
		'at GET /api/3d/generate?job=<id>.',
	free: true,
	keyless: true,
	inputSchema: {
		type: 'object',
		required: ['prompt'],
		properties: {
			prompt: {
				type: 'string',
				minLength: 3,
				maxLength: 1000,
				description: 'One subject to model, e.g. "a small ceramic robot figurine".',
			},
			format: {
				type: 'string',
				enum: ['glb'],
				default: 'glb',
				description: 'Output format. The free lane returns GLB only.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			status: { type: 'string', enum: ['done', 'pending', 'error'] },
			glbUrl: { type: 'string', description: 'Durable URL to the generated GLB (when status=done).' },
			viewerUrl: { type: 'string', description: 'three.ws viewer link for the GLB (when status=done).' },
			arUrl: {
				type: 'string',
				description:
					'Place-in-your-room AR launch link (when status=done). On a phone it opens AR directly ' +
					'(Scene Viewer on Android, Quick Look on iOS); on desktop it falls back to the viewer.',
			},
			job: { type: 'string', description: 'Opaque job token to poll (when status=pending).' },
			poll: { type: 'string', description: 'GET this URL to poll the job (when status=pending). Carries the prompt as `title` to label the AR/viewer pages.' },
			error: { type: 'string', description: 'Actionable message (when status=error). Free lane: no charge.' },
			format: { type: 'string' },
			tier: { type: 'string' },
			free: { type: 'boolean' },
		},
	},
	poll: {
		method: 'GET',
		path: '/api/3d/generate?job={job}&title={title}',
		description:
			'Poll a queued generation. Returns { status:pending|done|error, glbUrl?, viewerUrl?, arUrl?, error? }. ' +
			'`title` is optional and labels the AR/viewer pages; the pending response embeds it in `poll` already.',
	},
	example: {
		request: {
			method: 'POST',
			path: '/api/3d/generate',
			body: { prompt: 'a small ceramic robot figurine' },
		},
		response: {
			status: 'pending',
			job: 'f1.eyJwIjoibnZpZGlhIiwiayI6InRleHQiLCJ0IjoibmltLXRhc2stMTIzIn0.c2ln',
			poll: '/api/3d/generate?job=f1.eyJwIjoibnZpZGlhIiwiayI6InRleHQiLCJ0IjoibmltLXRhc2stMTIzIn0.c2ln&title=a%20small%20ceramic%20robot%20figurine',
			format: 'glb',
			tier: 'draft',
			free: true,
		},
	},
	paidTiers: [
		{ name: 'Forge Pro', path: '/api/x402/forge', why: 'Higher polygon budgets + PBR textures, quality tiers.' },
		{ name: 'Rigged Avatars', path: '/api/forge?action=rig', why: 'Animation-ready skeleton + skin weights.' },
	],
	useCase:
		'An agent building a game, a scene, or an NFT needs a 3D model from a text prompt — free, no key, no account. ' +
		'It calls this to draft geometry, then upgrades to Forge Pro / Rigged Avatars when it needs production quality.',
};
