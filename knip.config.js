// Knip config — finds unused exports, files, deps in a JS-heavy repo.
//
// Treat results as advisory only. This project has lots of dynamic imports
// (Vercel function discovery, vite glob() for skill bundles, runtime route
// dispatching) so Knip's defaults flag many false positives. We narrow scope
// to the parts of the tree where dead-code reports are reliable.

export default {
	entry: [
		'src/**/*.{js,jsx,ts,tsx}',
		'pages/**/*.html',
		'public/**/*.html',
		'api/**/*.js',
	],
	project: ['src/**/*.{js,jsx}', 'api/**/*.js'],
	ignoreDependencies: [
		// Loaded dynamically by Vercel functions; static analysis can't see them.
		'@bonfida/spl-name-service',
		'@coinbase/x402',
		'@x402/extensions',
		'@upstash/qstash',
		'@upstash/ratelimit',
		'@upstash/redis',
		'@neondatabase/serverless',
	],
	ignore: [
		// Generated bundles / archived data.
		'dist/**',
		'data/_generated/**',
		// Worker bundles loaded at runtime, not statically imported.
		'workers/**',
		// Browser-extension / standalone widgets.
		'public/widget.html',
		'public/embed.html',
	],
};
