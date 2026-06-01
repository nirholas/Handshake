// Browser verification for Task 13 — the client slash-command autocomplete.
//
// The server command router (parse/validate/dispatch, /help, /who, rate-limit,
// unknown-command errors) is covered by a separate logic check; this harness
// drives the real /game page in a browser to exercise the NEW client UI:
// the autocomplete dropdown, keyboard navigation, Tab/Enter completion, and
// mouse selection — against the real DOM, CSS, and event wiring.
//
// It reaches the live IsoGame instance (window.__ISO__), puts it in the 'world'
// phase, and feeds it the command manifest exactly as the server sends it on
// join (commandManifest()). No multiplayer server required.
//
//   npm run dev          # http://localhost:3000
//   node scripts/verify-chat-commands.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://localhost:3000/game.html';
// Mirrors multiplayer/src/rooms/commands.js commandManifest() — the shape the
// server pushes over the 'commands' message on join.
const MANIFEST = [
	{ name: 'help', args: '', aliases: ['commands', 'h', '?'], desc: 'List the commands you can use' },
	{ name: 'who', args: '', aliases: ['players', 'online'], desc: 'List the players in your realm' },
	{ name: 'pickup', args: '', aliases: ['take'], desc: 'Pick up your firepit or shack you are standing beside' },
	{ name: 'lock', args: '', aliases: [], desc: 'Lock the structure beside you against stray clicks' },
	{ name: 'unlock', args: '', aliases: [], desc: 'Unlock the structure beside you' },
	{ name: 'dismount', args: '', aliases: ['unmount'], desc: 'Climb down from your mount' },
];

const ok = [];
const fail = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());
const consoleErrors = [];
// Filter environmental noise: colyseus/vite-HMR sockets fail without a running
// server, and auth/API endpoints require credentials not present in this test env.
const ENV_NOISE = /WebSocket|game-net|ERR_CONNECTION|vite|websocket|401|403|api\//i;
page.on('console', (m) => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => { if (!ENV_NOISE.test(e.message)) consoleErrors.push('pageerror: ' + e.message); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ISO__ && typeof window.__ISO__._onCommands === 'function', { timeout: 15000 });

// Put the game in-world and hand it the manifest exactly as the server would.
await page.evaluate((manifest) => {
	const g = window.__ISO__;
	g.phase = 'world';
	g._setHudPhase('world'); // hides the start overlay, reveals the chat panel
	g._onCommands(manifest);
}, MANIFEST);
check(true, 'reached in-world IsoGame and loaded command manifest');

const input = page.locator('#kg-chat-input');
await input.click();

// '/' → full registry, in registry order.
await input.type('/');
await page.waitForSelector('#kg-chat-hint:not([hidden])', { timeout: 3000 });
const all = await page.$$eval('#kg-chat-hint .kg-chat-hint-cmd', (els) => els.map((e) => e.textContent.trim()));
check(all.length === 6, `'/' lists all 6 commands (got ${all.length}: ${all.join(', ')})`);
check(all[0] === '/help' && all.includes('/dismount'), 'list is registry-ordered and complete');
const descs = await page.$$eval('#kg-chat-hint .kg-chat-hint-desc', (els) => els.map((e) => e.textContent.trim()));
check(descs.every((d) => d.length > 0), 'every suggestion shows a description');

// Alias match: 'unm' → /dismount (alias 'unmount').
await input.fill('/unm');
await page.waitForTimeout(80);
const alias = await page.$$eval('#kg-chat-hint .kg-chat-hint-cmd', (els) => els.map((e) => e.textContent.trim()));
check(alias.length === 1 && alias[0] === '/dismount', `alias 'unm' resolves to /dismount (got ${alias.join(', ')})`);

// Prefix narrowing: '/l' → /lock only.
await input.fill('/l');
await page.waitForTimeout(80);
const pre = await page.$$eval('#kg-chat-hint .kg-chat-hint-cmd', (els) => els.map((e) => e.textContent.trim()));
check(pre.length === 1 && pre[0] === '/lock', `'/l' narrows to /lock (got ${pre.join(', ')})`);

// Keyboard nav: ArrowDown highlights the first row.
await input.fill('/');
await page.waitForTimeout(60);
await input.press('ArrowDown');
const active1 = await page.$eval('#kg-chat-hint .kg-chat-hint-item--active .kg-chat-hint-cmd', (e) => e.textContent.trim()).catch(() => null);
check(active1 === '/help', `ArrowDown highlights first command (got ${active1})`);
await input.press('ArrowUp'); // wrap to last
const active2 = await page.$eval('#kg-chat-hint .kg-chat-hint-item--active .kg-chat-hint-cmd', (e) => e.textContent.trim()).catch(() => null);
check(active2 === '/dismount', `ArrowUp from first wraps to last (got ${active2})`);
const aria = await input.getAttribute('aria-activedescendant');
check(aria === 'kg-chat-hint-5', `aria-activedescendant tracks selection (got ${aria})`);

// Tab completes the highlighted command into the field and (no args) hides the hint.
await input.press('Tab');
check((await input.inputValue()) === '/dismount', `Tab completes highlighted command (got "${await input.inputValue()}")`);
check(await page.locator('#kg-chat-hint').isHidden(), 'hint hides after completing a no-arg command');

// Typing a space (args) hides the hint; clearing back to a bare name reopens it.
await input.fill('/who ');
await page.waitForTimeout(60);
check(await page.locator('#kg-chat-hint').isHidden(), 'hint hides once a space (args) is typed');

// Escape dismisses an open hint without closing the chat.
await input.fill('/p');
await page.waitForTimeout(60);
check(await page.locator('#kg-chat-hint').isVisible(), "'/p' reopens the hint");
await input.press('Escape');
check(await page.locator('#kg-chat-hint').isHidden(), 'Escape dismisses the hint');
check(await page.locator('#kg-chat-input').isVisible(), 'chat input still present after Escape');

// Mouse pick fills the input (it then sends via the net path).
await input.fill('/pi');
await page.waitForTimeout(60);
await page.locator('#kg-chat-hint .kg-chat-hint-item').first().click();
await page.waitForTimeout(60);
// After a pick the field is cleared by _sendChat; assert the hint closed cleanly.
check(await page.locator('#kg-chat-hint').isHidden(), 'mouse pick completes + closes the hint');

// Chat history: send a message, then use ↑ to recall it.
// Seed the history directly via the game instance (net is offline so chat() is a no-op).
await page.evaluate(() => {
	const g = window.__ISO__;
	g._chatHistory = ['hello realm', '/who']; // reset to a known state
	g._chatHistoryCursor = -1;
	g._chatHistoryDraft = '';
});
await input.fill('');
await input.press('ArrowUp'); // → most recent: /who
await page.waitForTimeout(60);
check((await input.inputValue()) === '/who', `ArrowUp recalls most recent message (got "${await input.inputValue()}")`);
await input.press('ArrowUp'); // → older: hello realm
await page.waitForTimeout(60);
check((await input.inputValue()) === 'hello realm', `ArrowUp again recalls older message (got "${await input.inputValue()}")`);
await input.press('ArrowUp'); // at oldest → stays
await page.waitForTimeout(60);
check((await input.inputValue()) === 'hello realm', `ArrowUp at oldest clamps (got "${await input.inputValue()}")`);
await input.press('ArrowDown'); // → /who
await page.waitForTimeout(60);
check((await input.inputValue()) === '/who', `ArrowDown moves to newer (got "${await input.inputValue()}")`);
await input.press('ArrowDown'); // → back to draft (empty)
await page.waitForTimeout(60);
check((await input.inputValue()) === '', `ArrowDown to draft restores empty field (got "${await input.inputValue()}")`);

// Editing while in history recall resets cursor so next ↑ starts fresh from most recent.
await input.press('ArrowUp'); // enter history
await input.type('x'); // edit → cursor resets
await page.waitForTimeout(60);
await input.fill(''); await input.press('ArrowUp'); // fresh recall from most recent
await page.waitForTimeout(60);
check((await input.inputValue()) === '/who', `editing breaks recall; fresh ArrowUp starts from most recent (got "${await input.inputValue()}")`);

// /help reply has kg-chat-line--help CSS class applied.
// /who reply has kg-chat-line--who CSS class applied.
// Drive a local sysLine to confirm (it goes through _appendChatLine).
await page.evaluate(() => { window.__ISO__._sysLine('Commands\n  /help', 'help'); });
await page.waitForTimeout(60);
const hasHelpClass = await page.$eval('.kg-chat-line--help', () => true).catch(() => false);
check(hasHelpClass, '/help system line gets kg-chat-line--help class');
await page.evaluate(() => { window.__ISO__._sysLine('1 player in Mainland\n  • Verifier (you)', 'who'); });
await page.waitForTimeout(60);
const hasWhoClass = await page.$eval('.kg-chat-line--who', () => true).catch(() => false);
check(hasWhoClass, '/who system line gets kg-chat-line--who class');

check(consoleErrors.length === 0, `no unexpected console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 3).join(' | ')}`);

await browser.close();

console.log('\n=== client autocomplete ===');
ok.forEach((m) => console.log('  PASS ' + m));
if (fail.length) {
	console.log('\n=== FAILURES ===');
	fail.forEach((m) => console.log('  FAIL ' + m));
	process.exit(1);
}
console.log(`\nAll ${ok.length} checks passed.`);
