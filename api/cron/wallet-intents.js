// GET /api/cron/wallet-intents — the Wallet Intents scheduler.
//
// Runs every 10 minutes. Evaluates every enabled scheduled / balance-floor /
// launch-matching intent across all agents and executes the due ones through the
// SAME owner-authorized, spend-policy-gated, audited signing paths the rest of
// the wallet uses. Each execution is idempotent (one fire per period / per breach
// per day / per matched mint) and clamped to both the intent's own caps and the
// agent's spend policy. Tip/income/stream intents fire inline from their event
// hooks (the tip-recording path), not here.
//
// Nothing here exposes a key: the engine decrypts only at signing, audit-logs
// every recovery, and writes a custody event stamped with the intent_id.

import { json, method, wrapCron } from '../_lib/http.js';
import { runIntentSweep } from '../_lib/wallet-intents.js';
import { requireCron } from '../_lib/cron-auth.js';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const startedAt = Date.now();
	const now = new Date();
	// Mainnet is the live money network; the engine no-ops launch buys on devnet.
	const summary = await runIntentSweep({ network: 'mainnet', now });
	const ms = Date.now() - startedAt;
	console.info(`[wallet-intents] sweep done in ${ms}ms`, summary);
	return json(res, 200, { data: { ...summary, took_ms: ms } });
});
