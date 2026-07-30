/*
 * Cookbook manifest: single source of truth for the recipe library.
 *
 * Loaded as a classic script by /cookbook (the index) and /cookbook/<slug>
 * (the recipe viewer): exposes window.RECIPES.
 *
 * A recipe is not a tutorial. A tutorial teaches you the product through its
 * UI; a recipe hands you a file you can run. Every entry here therefore points
 * at a real, executed artifact under /cookbook/recipes/ (or a notebook), and
 * the prose lives at /docs/cookbook/<slug>.md.
 */
(function () {
	const RECIPES = [
		{
			slug: 'self-correcting-3d',
			title: 'A self-correcting 3D collectible set',
			blurb:
				'An AI art director turns a one-line brief into a themed set of props with parallel function calls, renders each result, inspects it with vision, and rebuilds whatever missed the brief.',
			builds: 'A themed set of QA-passed 3D props, plus an interactive gallery',
			language: 'Python notebook',
			time: '15 min',
			level: 'advanced',
			needs: 'An OpenAI API key',
			tags: ['function calling', 'vision', 'structured outputs', 'agents'],
			/* The notebook is a full nbconvert export, not a markdown recipe. */
			href: '/cookbook/self-correcting-3d',
			external: true,
			download: {
				label: 'Download the notebook',
				href: '/cookbook/text_to_3d_with_function_calling.ipynb',
			},
			poster: '/cookbook/houseplant-set.png',
			alsoOn: {
				label: 'OpenAI Cookbook',
				href: 'https://github.com/openai/openai-cookbook/pull/2874',
			},
		},
		{
			slug: 'text-to-3d-cli',
			title: 'Text to 3D from the command line',
			blurb:
				'Sixty lines of standard-library Python that turn a sentence into a GLB on your disk. Handles the inline-vs-queued split, honors the server poll hint, and fails with a message you can act on.',
			builds: 'A reusable CLI: prompt in, downloaded .glb out',
			language: 'Python',
			time: '3 min',
			level: 'beginner',
			needs: 'Python 3.10+. No API key.',
			tags: ['text to 3d', 'cli', 'no dependencies'],
			href: '/cookbook/text-to-3d-cli',
			download: { label: 'text_to_3d.py', href: '/cookbook/recipes/text_to_3d.py' },
			previewModel: '/animations/robotexpressive.glb',
		},
		{
			slug: 'parallel-asset-pack',
			title: 'Build a whole asset pack in parallel',
			blurb:
				'Fan a list of prompts across the free lane at a sane concurrency, download every model, render a still of each, and emit a manifest plus a browsable gallery. Partial failure degrades, it does not abort.',
			builds: 'A folder of models, stills, a manifest.json, and an interactive gallery',
			language: 'Python',
			time: '5 min',
			level: 'intermediate',
			needs: 'Python 3.10+. No API key.',
			tags: ['batch', 'concurrency', 'gallery'],
			href: '/cookbook/parallel-asset-pack',
			download: { label: 'asset_pack.py', href: '/cookbook/recipes/asset_pack.py' },
			previewModel: '/animations/soldier.glb',
		},
		{
			slug: 'mcp-3d-tool',
			title: 'Give your AI assistant a 3D tool',
			blurb:
				'A Model Context Protocol server that exposes text-to-3D and model rendering as tools, so Claude Code, Claude Desktop, or Cursor can build and look at 3D models mid-conversation.',
			builds: 'An MCP server your assistant can call, registered in one command',
			language: 'Node.js',
			time: '5 min',
			level: 'intermediate',
			needs: 'Node 18+ and an MCP client. No API key.',
			tags: ['mcp', 'agents', 'tools'],
			href: '/cookbook/mcp-3d-tool',
			download: { label: 'mcp_3d_server.mjs', href: '/cookbook/recipes/mcp_3d_server.mjs' },
			previewModel: '/avatars/mannequin.glb',
		},
		{
			slug: 'asset-quality-gate',
			title: 'Gate 3D assets in CI',
			blurb:
				'Generated geometry fails quietly: a model can validate perfectly and still be a 400k-triangle monster. This gate inspects every asset against an explicit budget and exits non-zero so the build fails instead of the launch.',
			builds: 'A CI check that blocks oversized or broken models',
			language: 'Python',
			time: '4 min',
			level: 'intermediate',
			needs: 'Python 3.10+. No API key.',
			tags: ['ci', 'validation', 'performance'],
			href: '/cookbook/asset-quality-gate',
			download: { label: 'asset_gate.py', href: '/cookbook/recipes/asset_gate.py' },
			previewModel: '/animations/robotexpressive.glb',
		},
	];

	window.RECIPES = RECIPES;
	window.recipeBySlug = function (slug) {
		return RECIPES.find((r) => r.slug === slug) || null;
	};
	window.recipeIndex = function (slug) {
		return RECIPES.findIndex((r) => r.slug === slug);
	};
})();
