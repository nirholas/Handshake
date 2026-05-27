/**
 * Renders the identity modal HTML+CSS in isolation and screenshots it at
 * desktop and mobile viewports. Avoids the full app bootstrap (WebGL, IDB,
 * Solana SDK) that can't run in headless Chrome.
 */
import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:5555';

function extractIdentityCSS() {
	const html = readFileSync('/workspaces/three.ws/pages/create-review.html', 'utf-8');
	const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
	return styleMatch?.[1] || '';
}

function buildTestPage(css) {
	const sampleAddr = 'DuH8HS9Vxh4Y1vHeoXAwV3qiRmM57tYyJAwrTieY8Gww';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${css}
/* Override any hidden states for the test */
body { background: var(--bg); color: var(--text); margin: 0; }
.fm-backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0,0,0,0.7); }
.fm-dialog { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 28px 24px 22px; max-width: 480px; width: 100%; max-height: 90vh; overflow-y: auto; }
.fm-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
.fm-icon { font-size: 28px; line-height: 1; flex-shrink: 0; }
.fm-head-text { flex: 1; min-width: 0; }
.fm-head h3 { margin: 0; font-size: 19px; font-weight: 600; }
.fm-head p { margin: 4px 0 0; font-size: 13px; color: var(--muted); line-height: 1.45; }
.fm-close { position: absolute; top: 16px; right: 16px; background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; padding: 4px 8px; }
.fm-body { display: flex; flex-direction: column; gap: 14px; }
.fm-bullets { margin: 0; padding: 0 0 0 18px; font-size: 13.5px; color: var(--muted); line-height: 1.5; }
.fm-bullets li { margin-bottom: 4px; }
.fm-bullets li::marker { color: var(--accent); }
.fm-actions { margin-top: 16px; display: flex; gap: 10px; }
.fm-cta { display: inline-flex; align-items: center; justify-content: center; padding: 10px 22px; border-radius: 9px; border: 1px solid var(--border); background: rgba(255,255,255,0.06); color: var(--text); font-size: 14px; font-weight: 500; cursor: pointer; }
@media (max-width: 560px) {
	.fm-backdrop { padding: 0; align-items: flex-end; }
	.fm-dialog { max-width: 100%; max-height: 88vh; border-radius: 18px 18px 0 0; padding: 22px 20px 26px; }
	.fm-head h3 { font-size: 17px; }
	.fm-head p { font-size: 12.5px; }
}
</style>
</head>
<body>
<div class="fm-backdrop" role="dialog" aria-modal="true">
	<div class="fm-dialog" tabindex="-1" style="position: relative;">
		<div class="fm-head">
			<div class="fm-icon" aria-hidden="true">🪪</div>
			<div class="fm-head-text">
				<h3>On-Chain Identity</h3>
				<p>Your agent becomes a Metaplex Core asset on Solana the moment you save — transferable, composable, browsable in any wallet.</p>
			</div>
			<button class="fm-close" type="button" aria-label="Close">✕</button>
		</div>
		<div class="fm-body">
			<ul class="fm-bullets">
				<li>Owned by your wallet, not by three.ws — transfer or sell at any time.</li>
				<li>Metadata (avatar URL, persona, voice) is mutable by you, signed on-chain.</li>
				<li>Discoverable in the agent registry by capability, price, and reputation.</li>
			</ul>
			<div class="fm-id-card" data-state="ready">
				<div class="fm-id-card-top">
					<div class="fm-id-avatar fm-id-avatar--fallback">L</div>
					<div class="fm-id-card-top-right">
						<div class="fm-id-head">
							<span class="fm-id-chain">Solana mainnet</span>
							<span class="fm-id-pill">preview</span>
						</div>
						<div class="fm-id-meta">
							<div><span class="muted">Name</span><strong>Luna</strong></div>
							<div><span class="muted">Asset standard</span><strong>Metaplex Core</strong></div>
						</div>
					</div>
				</div>
				<a class="fm-id-addr-link" href="https://solscan.io/account/${sampleAddr}" target="_blank" rel="noopener noreferrer" title="Open in Solscan (sample address)">
					<span class="fm-id-addr">${sampleAddr}</span>
					<span class="fm-id-explorer-hint">View on Solscan</span>
				</a>
				<p class="fm-id-sample-note">Sample keypair — your real address is created on save</p>
			</div>
		</div>
		<div class="fm-actions">
			<button class="fm-cta" type="button">Got it</button>
		</div>
	</div>
</div>
</body>
</html>`;
}

async function run() {
	const css = extractIdentityCSS();
	const html = buildTestPage(css);

	const browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	});

	try {
		const page = await browser.newPage();

		// ── Desktop ──
		await page.setViewport({ width: 1280, height: 900 });
		await page.setContent(html, { waitUntil: 'networkidle0' });
		await new Promise(r => setTimeout(r, 500));
		await page.screenshot({ path: '/tmp/identity-desktop.png', fullPage: false });
		console.log('Desktop screenshot saved: /tmp/identity-desktop.png');

		// ── Mobile ──
		await page.setViewport({ width: 390, height: 844 });
		await page.setContent(html, { waitUntil: 'networkidle0' });
		await new Promise(r => setTimeout(r, 500));
		await page.screenshot({ path: '/tmp/identity-mobile.png', fullPage: false });
		console.log('Mobile screenshot saved: /tmp/identity-mobile.png');

		// ── Loading state ──
		const loadingHtml = html
			.replace('data-state="ready"', 'data-state="loading"')
			.replace('>preview<', '>generating…<')
			.replace(`>${sampleAddr}<`, '>—<');
		await page.setViewport({ width: 1280, height: 900 });
		await page.setContent(loadingHtml, { waitUntil: 'networkidle0' });
		await new Promise(r => setTimeout(r, 500));
		await page.screenshot({ path: '/tmp/identity-loading.png', fullPage: false });
		console.log('Loading state screenshot saved: /tmp/identity-loading.png');

		console.log('Done — all screenshots captured.');
	} finally {
		await browser.close();
	}
}

const sampleAddr = 'DuH8HS9Vxh4Y1vHeoXAwV3qiRmM57tYyJAwrTieY8Gww';
run().catch((err) => {
	console.error(err);
	process.exit(1);
});
