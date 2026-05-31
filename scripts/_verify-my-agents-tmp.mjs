import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const now = Date.now();
const agents = [
  { id:'11111111-1111-1111-1111-111111111111', name:'Ansem', description:'A sharp trading agent that lives on Base.', avatar_model_url:'/avatars/default.glb', avatar_thumbnail_url:null, chain_id:8453, is_registered:true, is_published:true, chat_count:1240, skills:['a','b','c'], created_at:new Date(now-3*86400000).toISOString() },
  { id:'22222222-2222-2222-2222-222222222222', name:'Default Starter Agent', description:null, avatar_model_url:'/avatars/default.glb', avatar_thumbnail_url:null, chain_id:null, is_registered:false, is_published:false, chat_count:0, skills:[], created_at:new Date(now-30*86400000).toISOString() },
  { id:'33333333-3333-3333-3333-333333333333', name:'Concierge', description:'Helps users navigate the platform with style and grace.', avatar_model_url:'/avatars/default.glb', avatar_thumbnail_url:null, chain_id:null, is_registered:false, is_published:true, chat_count:58, skills:['help'], created_at:new Date(now-86400000).toISOString() },
];

await page.route('**/api/auth/me', r => r.fulfill({ json:{ user:{ id:'u1', email:'x@y.com' } } }));
await page.route('**/api/agents/me', r => r.fulfill({ json:{ agent: agents[0] } }));
await page.route('**/api/agents', r => r.fulfill({ json:{ agents } }));
await page.route('**/api/erc8004/hydrate', r => r.fulfill({ json:{ agents: [
  { chainId:84532, agentId:'42', name:'On-chain Scout', description:'Discovered in your linked wallet.', image:null, glbUrl:'/avatars/default.glb' },
] } }));

await page.goto('http://localhost:3000/my-agents/', { waitUntil:'networkidle' });
await page.waitForTimeout(2000);

const cards = await page.locator('.my-agents-card').count();
const stats = await page.locator('.my-agents-stat__value').allTextContents();
const toolbarVisible = await page.locator('#my-agents-toolbar').isVisible();
const newTile = await page.locator('.my-agents-card--new').count();
const importBtn = await page.locator('button:has-text("Import to library")').count();
console.log('CARDS:', cards);
console.log('STATS:', stats.join(' | '));
console.log('TOOLBAR visible:', toolbarVisible);
console.log('NEW tile:', newTile, '| IMPORT btn:', importBtn);
await page.screenshot({ path:'/tmp/my-agents-populated.png', fullPage:true });

// Test search
await page.fill('#my-agents-search-input', 'concierge');
await page.waitForTimeout(300);
const afterSearch = await page.locator('.my-agents-card:not(.my-agents-card--new)').count();
console.log('after search "concierge":', afterSearch, 'cards');

// Test sort by chats
await page.fill('#my-agents-search-input', '');
await page.waitForTimeout(300);
await page.selectOption('#my-agents-sort-select', 'chats');
await page.waitForTimeout(300);
const firstName = await page.locator('.my-agents-card__name').first().textContent();
console.log('sort by chats, first card:', firstName);

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
