export function loadConfig() {
	const required = ['AGENT_ID', 'AGENT_JWT'];
	for (const k of required) {
		if (!process.env[k]) throw new Error(`Missing required env var: ${k}`);
	}

	const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY || '';
	// Browserbase resolves the project from the API key alone. BROWSERBASE_PROJECT_ID
	// is NOT required and the caster never asks for one. It's still read (optional) so
	// an environment that happens to set it keeps working, but its absence is normal.
	const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID || '';

	// Stagehand's act()/extract() are LLM-driven. Without a model + key they throw
	// on the first real interaction. The provider-prefixed form
	// ("anthropic/<model>") is what Stagehand's model registry expects, so it
	// routes straight to its Anthropic client. Navigation-only casters don't need
	// it, so this is a loud warning rather than a hard requirement.
	const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
	const MODEL_NAME = process.env.STAGEHAND_MODEL || 'anthropic/claude-opus-4-8';

	if (!ANTHROPIC_API_KEY) {
		console.warn(
			'[config] ANTHROPIC_API_KEY is not set. The agent can navigate and screenshot, ' +
				'but act()/extract() (typing, clicking, reading) will fail. ' +
				'Set ANTHROPIC_API_KEY to enable full task execution.',
		);
	}

	return {
		AGENT_ID: process.env.AGENT_ID,
		AGENT_JWT: process.env.AGENT_JWT,
		PUSH_URL: process.env.PUSH_URL || 'https://three.ws/api/agent-screen-push',
		TASK_URL: process.env.TASK_URL || 'https://three.ws/api/agent-task',
		// Neutral home the agent rests on while idle (no task queued). Coin-agnostic
		// by design: defaults to the platform home.
		HOME_URL: process.env.HOME_URL || 'https://three.ws',
		BROWSERBASE_API_KEY,
		BROWSERBASE_PROJECT_ID,
		ANTHROPIC_API_KEY,
		MODEL_NAME,
		LOCAL_LAUNCH_OPTIONS: localLaunchOptions(),
		CYCLE_MS: Number(process.env.CYCLE_MS || 30_000),
		// Whether to capture a screenshot on every pushFrame call (can be throttled)
		SCREENSHOT_INTERVAL_MS: Number(process.env.SCREENSHOT_INTERVAL_MS || 5_000),
	};
}

/**
 * Launch options for LOCAL browser mode.
 *
 * Stagehand v3 drives Chrome over CDP through `chrome-launcher`. It does NOT use
 * Playwright's bundled browsers, so LOCAL mode needs a real Chrome/Chromium on
 * the machine: either one `chrome-launcher` finds on its own (google-chrome,
 * chromium, Chrome Canary in the usual locations) or an explicit `CHROME_PATH`.
 * A Playwright-installed Chromium works fine, it just has to be pointed at:
 *
 *   CHROME_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())")
 *
 * The Chrome sandbox is kept ON wherever it can work. Chrome refuses to start a
 * sandboxed browser as uid 0, which is the default inside a container, so the
 * sandbox is dropped only in that case. `CHROME_NO_SANDBOX=1` forces it off for
 * hosts whose kernel blocks user namespaces even for an unprivileged user.
 *
 * Stagehand allows 15s for Chrome to open its debug port. A first launch on a
 * loaded or throttled host regularly needs longer, and overrunning it kills the
 * worker at boot with a bare ECONNREFUSED that reads like a network fault rather
 * than a slow browser. 60s costs nothing on a fast host (the wait ends as soon
 * as the port answers) and turns that crash into a normal cold start.
 */
function localLaunchOptions() {
	const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const noSandbox = process.env.CHROME_NO_SANDBOX === '1' || runningAsRoot;

	const args = ['--disable-dev-shm-usage', '--disable-gpu'];
	if (noSandbox) args.push('--no-sandbox');

	return {
		...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
		headless: process.env.CHROME_HEADLESS !== '0',
		chromiumSandbox: !noSandbox,
		connectTimeoutMs: Number(process.env.CHROME_CONNECT_TIMEOUT_MS || 60_000),
		args,
	};
}
