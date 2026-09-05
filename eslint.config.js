// Flat ESLint config (ESLint 10 — eslintrc format is no longer supported).
// Scope: first-party vanilla-JS source at the repo root. Sub-projects that ship
// their own flat config (chat/, agent-payments-sdk/, character-studio/) and
// vendored/generated/build output are ignored here. TypeScript sources are left
// to each package's own tsc/typecheck pipeline, so we lint JS extensions only
// and avoid pulling in typescript-eslint at the root.
import js from '@eslint/js';
import globals from 'globals';

export default [
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/dist-lib/**',
			'**/dist-artifact/**',
			'**/build/**',
			'**/.vercel/**',
			'**/.svelte-kit/**',
			'**/coverage/**',
			// Vendored / external library code
			'contracts/lib/**',
			'character-studio/**',
			'docs/pumpfun-program/**',
			// Vendored third-party browser libs (Draco/Basis compression,
			// the scene-studio editor's bundled acorn/codemirror/esprima/etc.,
			// and MediaPipe's Emscripten-generated WASM glue).
			'**/draco/**',
			'**/basis/**',
			'public/scene-studio/libs/**',
			// Any directory named `vendor` holds third-party code we don't own
			// and must not lint (e.g. extensions/*/vendor/readability.js).
			'**/vendor/**',
			// Complete vendored upstream trees kept as reference material and
			// never built or shipped. See third_party/README.md.
			'third_party/**',
			'**/*.bundle.js',
			'public/dashboard/avaturn-sdk.js',
			// Self-contained sub-projects with their own ESLint flat config
			'chat/**',
			'public/chat/**',
			'agent-payments-sdk/**',
			// Generated output
			'data/_generated/**',
			// Saved Workflow-DSL scripts (top-level await/return + injected
			// runtime globals like agent()/log() — not standalone ES modules).
			'scripts/wf-*.mjs',
			'.claude/workflows/**',
			// Bundled/minified build artifacts
			'**/*.min.js',
			// Bundler output formats (tsup/esbuild IIFE + global builds) and
			// TypeDoc-generated API-doc assets: single-line minified code where
			// minifier variable reuse trips no-redeclare/no-func-assign. These are
			// generated, never hand-edited, and must not gate the lint on real
			// source. (Hand-authored robinhood/**/docs demos stay linted.)
			'**/*.iife.js',
			'**/*.global.js',
			'**/docs/api/assets/**',
			'public/embed-sdk.js',
			'public/embed.js',
			'public/wallet-login.js',
			'public/artifact.js',
			'public/bazaar.js',
			'public/paywall.js',
		],
	},
	js.configs.recommended,
	{
		files: ['**/*.{js,mjs,jsx}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: {
				ecmaFeatures: { jsx: true },
			},
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			// This codebase predates linting, so the first pass is a warn-level
			// baseline: it surfaces issues without failing the gate, and the team
			// ratchets rules up to error as files are cleaned. High-value
			// structural rules that are already clean (no-dupe-keys, no-func-assign)
			// stay at error so regressions are caught immediately.
			'no-unused-vars': 'warn',
			'no-console': 'warn',
			'no-undef': 'warn',
			'no-empty': 'warn',
			'no-constant-condition': 'warn',
			'no-constant-binary-expression': 'warn',
			'no-prototype-builtins': 'warn',
			'no-useless-escape': 'warn',
			'no-useless-assignment': 'off',
			'no-cond-assign': 'warn',
			'no-fallthrough': 'warn',
			'no-irregular-whitespace': 'warn',
			'no-control-regex': 'off',
			'no-unreachable': 'warn',
			'no-unassigned-vars': 'warn',
			'no-async-promise-executor': 'warn',
			'no-misleading-character-class': 'warn',
			'no-unsafe-finally': 'warn',
			'no-unused-private-class-members': 'warn',
			'no-unused-labels': 'warn',
			'preserve-caught-error': 'warn',
		},
	},
	{
		// Service workers run in their own global scope (self, clients,
		// registration, skipWaiting, …). Flat config replaces the old
		// `/* eslint-env serviceworker */` directive with explicit globals.
		files: ['**/push-sw.js', '**/*-sw.js', '**/service-worker.js'],
		languageOptions: {
			globals: { ...globals.serviceworker },
		},
	},
	{
		files: ['**/*.cjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'commonjs',
			globals: { ...globals.node },
		},
		rules: {
			'no-unused-vars': 'warn',
			'no-console': 'warn',
			'no-undef': 'warn',
		},
	},
];
