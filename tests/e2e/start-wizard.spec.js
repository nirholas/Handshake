/**
 * /start onboarding wizard: end-to-end smoke.
 *
 * Drives the shipped wizard (pages/start.html + src/start.js) through the
 * no-avatar path and asserts the contract the deploy step has with the API:
 *   • POST /api/agents carries the name and the resolved skill list
 *   • PUT  /api/agents/:id/embed-policy applies the chosen brain model
 *   • POST /api/widgets is created for that agent, and the snippet handed out
 *     points at the real loader (/embed.js with data-widget)
 *   • a failed create shows a retry that finishes the publish
 *   • a signed-out visitor gets a sign-in panel, never a failing request
 *   • off-screen steps are inert and the footer's Continue is not covered by
 *     the shared helper-widget corner stack
 *   • an avatar coming back from a creation page is attached without double
 *     decoding its name
 *
 * Auth, CSRF, and the three mutation endpoints are fulfilled at the Playwright
 * route layer so the run is deterministic and never writes to the database;
 * everything between the click and the assertion is the product code.
 */

import { test, expect } from '@playwright/test';

const FIXTURE_USER = { id: 'usr_e2e_start', handle: 'e2e-start', display_name: 'E2E Start', plan: 'free' };
const AGENT_ID = '3d3f9c1e-6c3b-4d2e-9a3a-1b2c3d4e5f60';
const WIDGET_ID = 'wdgt_e2e_start';

function jsonRoute(status, body) {
	return (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installFixtures(page, { signedIn = true, failFirstCreate = false } = {}) {
	const calls = { agents: [], policies: [], widgets: [] };
	await page.route('**/api/auth/me**', jsonRoute(200, { user: signedIn ? FIXTURE_USER : null }));
	await page.route('**/api/csrf-token**', jsonRoute(200, {
		token: 'csrf-e2e', expires_in: 600, data: { token: 'csrf-e2e', expires_in: 600 },
	}));
	await page.route('**/api/agents', (route, req) => {
		if (req.method() !== 'POST') return route.fallback();
		calls.agents.push(req.postDataJSON());
		if (failFirstCreate && calls.agents.length === 1) return route.abort('failed');
		return route.fulfill({
			status: 201, contentType: 'application/json',
			body: JSON.stringify({ agent: { id: AGENT_ID, name: calls.agents.at(-1).name } }),
		});
	});
	await page.route(`**/api/agents/${AGENT_ID}/embed-policy`, (route, req) => {
		calls.policies.push(req.postDataJSON());
		return route.fulfill({
			status: 200, contentType: 'application/json',
			body: JSON.stringify({ policy: { brain: req.postDataJSON().brain } }),
		});
	});
	await page.route('**/api/widgets', (route, req) => {
		if (req.method() !== 'POST') return route.fallback();
		calls.widgets.push(req.postDataJSON());
		return route.fulfill({
			status: 201, contentType: 'application/json',
			body: JSON.stringify({ widget: { id: WIDGET_ID } }),
		});
	});
	return calls;
}

/** Start from scratch, skip the avatar, name the agent, pick a model, reach step 4. */
async function reachDeploy(page, { model = 'llama-3.3-70b-versatile' } = {}) {
	await page.goto('/start');
	await page.locator('#btn-blank-start').click();
	await expect(page.locator('#step-1')).toHaveClass(/active/);
	await page.locator('#btn-skip-step').click({ timeout: 5_000 });
	await expect(page.locator('#step-2')).toHaveClass(/active/);
	await page.locator('#agent-name').fill('E2E Wizard Agent');
	await page.locator(`[data-model="${model}"]`).click();
	await page.locator('#btn-next').click({ timeout: 5_000 });
	await expect(page.locator('#step-3')).toHaveClass(/active/);
	await page.locator('#btn-next').click({ timeout: 5_000 });
	await expect(page.locator('#step-4')).toHaveClass(/active/);
}

test.describe('/start wizard', () => {
	test.beforeEach(async ({ page }) => {
		page.on('pageerror', (err) => {
			// Vite's dev-only HMR socket noise is not a product error.
			if (/WebSocket closed without opened/i.test(err.message)) return;
			throw new Error(`Uncaught page error: ${err.message}`);
		});
	});

	test('publishes the agent, applies the chosen brain, and hands out the real embed snippet', async ({ page }) => {
		test.setTimeout(90_000);
		const calls = await installFixtures(page);
		await reachDeploy(page);

		await expect(page.locator('#deploy-success')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('#deploy-live-url')).toContainText(`/agents/${AGENT_ID}`);
		await expect(page.locator('#deploy-live-link')).toHaveAttribute('href', new RegExp(`/agents/${AGENT_ID}$`));
		const snippet = await page.locator('#embed-code').textContent();
		expect(snippet).toContain('/embed.js');
		expect(snippet).toContain(`data-widget="${WIDGET_ID}"`);
		await expect(page.locator('#deploy-brain')).toContainText('Llama 3.3 70B');

		expect(calls.agents).toHaveLength(1);
		expect(calls.agents[0].name).toBe('E2E Wizard Agent');
		expect(calls.agents[0].skills).toEqual(expect.arrayContaining(['greet', 'remember', 'think']));
		expect(calls.policies).toEqual([{ brain: { model: 'llama-3.3-70b-versatile' } }]);
		expect(calls.widgets).toHaveLength(1);
		expect(calls.widgets[0]).toMatchObject({ type: 'talking-agent', config: { agent_id: AGENT_ID }, is_public: true });

		// One heading in the accessibility tree at a time.
		await expect(page.locator('h1:visible')).toHaveCount(1);

		await page.locator('#btn-next').click({ timeout: 5_000 });
		await expect(page.locator('#step-5')).toHaveClass(/active/);
		await expect(page.locator('#btn-next')).toHaveText('Go to dashboard');
	});

	test('a failed create shows a retry that finishes the publish', async ({ page }) => {
		test.setTimeout(90_000);
		const calls = await installFixtures(page, { failFirstCreate: true });
		await reachDeploy(page);

		const retry = page.locator('#deploy-status .wz-deploy-retry');
		await expect(retry).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('#step4-headline')).toHaveText('Publishing hit a snag');
		await expect(page.locator('#deploy-label')).not.toHaveText('');
		await expect(page.locator('#btn-next')).toBeHidden();

		await retry.click();
		await expect(page.locator('#deploy-success')).toBeVisible({ timeout: 15_000 });
		expect(calls.agents).toHaveLength(2);
		expect(calls.widgets).toHaveLength(1);
	});

	test('a signed-out visitor is offered sign-in at the deploy step, not a failing request', async ({ page }) => {
		test.setTimeout(90_000);
		const calls = await installFixtures(page, { signedIn: false });
		await reachDeploy(page);

		const panel = page.locator('#deploy-signin');
		await expect(panel).toBeVisible();
		await expect(page.locator('#step4-headline')).toHaveText('Publish your agent');
		await expect(page.locator('#deploy-signin-login')).toHaveAttribute('href', '/login?next=%2Fstart');
		await expect(page.locator('#deploy-signin-register')).toHaveAttribute('href', '/register?next=%2Fstart');
		await expect(page.locator('#deploy-status')).toBeHidden();
		await expect(page.locator('#btn-next')).toBeHidden();
		expect(calls.agents).toHaveLength(0);

		// The saved session survives a reload and lands straight back on the panel.
		await page.reload();
		await expect(page.locator('#step-4')).toHaveClass(/active/);
		await expect(panel).toBeVisible();
	});

	test('off-screen steps are inert and Continue is not covered by helper widgets', async ({ page }) => {
		test.setTimeout(90_000);
		await installFixtures(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/start');
		await page.locator('#btn-blank-start').click();
		await page.locator('#btn-skip-step').click({ timeout: 5_000 });
		await expect(page.locator('#step-2')).toHaveClass(/active/);

		await expect(page.locator('.wz-step[inert]')).toHaveCount(4);
		await expect(page.locator('.wz-step.active[inert]')).toHaveCount(0);
		await expect(page.locator('h1:visible')).toHaveCount(1);
		// Playwright's actionability check fails when another element would
		// receive the click; before the sticky footer the corner stack sat here.
		await page.locator('#btn-next').click({ trial: true, timeout: 5_000 });

		for (const width of [320, 768, 1440]) {
			await page.setViewportSize({ width, height: 800 });
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
			expect(overflow, `horizontal overflow at ${width}px`).toBe(0);
		}
	});

	test('an avatar returning from a creation page is attached, name intact', async ({ page }) => {
		test.setTimeout(90_000);
		await installFixtures(page);
		await page.goto('/start?avatarId=ava-e2e-one&avatarName=Luna%20100%25&avatarThumb=%2Ffavicon-32x32.png&from=selfie');
		await expect(page.locator('#step-2')).toHaveClass(/active/);
		await expect(page).toHaveURL(/\/start$/);
		await page.locator('#btn-back').click({ timeout: 5_000 });
		await expect(page.locator('#step-1')).toHaveClass(/active/);
		await expect(page.locator('#ap-name')).toHaveText('Luna 100%');
		await expect(page.locator('#avatar-method-grid')).toBeHidden();
	});
});
