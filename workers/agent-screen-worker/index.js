import { Stagehand } from '@browserbasehq/stagehand';
import { loadConfig } from './config.js';
import { pushFrame } from './capture.js';
import { runTask } from './task-runner.js';

const cfg = loadConfig();

// Bind push() with the shared config so callers don't repeat it
function push({ agentId, page, activity, type }) {
	return pushFrame({
		agentId,
		page,
		activity,
		type,
		pushUrl: cfg.PUSH_URL,
		agentJwt: cfg.AGENT_JWT,
		screenshotIntervalMs: cfg.SCREENSHOT_INTERVAL_MS,
	});
}

async function main() {
	console.log(`[agent-screen-worker] starting, agent ${cfg.AGENT_ID}`);

	const env = cfg.BROWSERBASE_API_KEY ? 'BROWSERBASE' : 'LOCAL';
	console.log(`[agent-screen-worker] browser env: ${env}`);

	const stagehand = new Stagehand({
		env,
		apiKey: cfg.BROWSERBASE_API_KEY || undefined,
		projectId: cfg.BROWSERBASE_PROJECT_ID || undefined,
		// LLM that drives act()/extract(). The key is passed explicitly so the
		// worker never depends on process-wide env resolution inside Stagehand;
		// without one, the bare model name still lets Stagehand boot for the
		// navigate-and-screenshot path.
		model: cfg.ANTHROPIC_API_KEY
			? { modelName: cfg.MODEL_NAME, apiKey: cfg.ANTHROPIC_API_KEY }
			: cfg.MODEL_NAME,
		...(env === 'LOCAL' ? { localBrowserLaunchOptions: cfg.LOCAL_LAUNCH_OPTIONS } : {}),
		verbose: 1,
	});

	console.log(`[agent-screen-worker] act/extract model: ${cfg.MODEL_NAME}`);

	await stagehand.init();
	// Stagehand v3 has no `.page` accessor: pages hang off the CDP-backed context.
	// init() opens one tab, so activePage() normally hits; newPage() covers a
	// context that came up empty.
	const page = stagehand.context.activePage() || (await stagehand.context.newPage());

	// Signal the stream is alive immediately
	await push({ agentId: cfg.AGENT_ID, page, activity: 'Agent starting up', type: 'activity' });

	// Graceful shutdown
	const shutdown = async (signal) => {
		console.log(`[agent-screen-worker] ${signal}, shutting down`);
		await push({ agentId: cfg.AGENT_ID, page, activity: 'Agent shutting down', type: 'activity' }).catch(() => {});
		await stagehand.close().catch(() => {});
		process.exit(0);
	};
	process.once('SIGINT', () => shutdown('SIGINT'));
	process.once('SIGTERM', () => shutdown('SIGTERM'));

	// Stagehand v3: act/extract live on the Stagehand instance and take the page
	// as an option, so the runner needs both handles.
	await runTask({ stagehand, page, cfg, push });
}

main().catch((err) => {
	console.error('[agent-screen-worker] fatal:', err);
	process.exit(1);
});
