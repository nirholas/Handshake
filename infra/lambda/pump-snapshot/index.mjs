// three.ws — Pump.fun Token Snapshot API
//
// A zero-dependency AWS Lambda (Node 22) behind a Function URL. It serves:
//   GET  /                      → live demo page (HTML)
//   GET  /api/snapshot?token=X  → real-time token snapshot (JSON)
//   GET  /healthz               → liveness probe (JSON)
//
// Every number is fetched live from a public source. No fallback arrays, no
// mocked values — if a source is unreachable the field is null so callers see
// the gap rather than fake data. Mirrors mcp-server/src/tools/pump-snapshot.js
// but reimplemented with raw fetch (incl. the Solana RPC call) so the function
// ships with no npm dependencies.
//
// Sources:
//   - Jupiter Lite price API        → price, 24h change, liquidity, decimals
//   - Dexscreener                   → 24h volume, primary DEX pair, FDV, txns
//   - pump.fun frontend-api-v3      → name, symbol, image, market cap, socials
//   - Solana RPC getTokenLargestAccounts → top-holder distribution
//   - Helius DAS getAsset (optional, if HELIUS_API_KEY set) → supply/price

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

const JSON_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-allow-headers': 'content-type',
	'cache-control': 'public, max-age=10',
};

// ── Solana base58 validation (no deps) ──────────────────────────────────────
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isValidSolanaPubkey(s) {
	return typeof s === 'string' && B58_RE.test(s);
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

async function getJupiterPrice(mint) {
	try {
		const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
		const entry = data?.[mint];
		if (!entry) return null;
		return {
			usdPrice: entry.usdPrice ?? null,
			priceChange24hPct: entry.priceChange24h ?? null,
			liquidityUsd: entry.liquidity ?? null,
			decimals: entry.decimals ?? null,
			blockId: entry.blockId ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

async function getDexscreener(mint) {
	try {
		const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
		const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
		if (pairs.length === 0) return null;
		const pair = pairs.reduce((best, p) => {
			const v = Number(p?.volume?.h24 || 0);
			return v > (best?.vol || 0) ? { pair: p, vol: v } : best;
		}, null)?.pair;
		if (!pair) return null;
		return {
			volume24hUsd: Number(pair.volume?.h24 || 0),
			priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
			priceChange24hPct: pair.priceChange?.h24 ?? null,
			liquidityUsd: pair.liquidity?.usd ?? null,
			fdvUsd: pair.fdv ?? null,
			marketCapUsd: pair.marketCap ?? null,
			pairAddress: pair.pairAddress,
			dex: pair.dexId,
			chain: pair.chainId,
			url: pair.url,
			txns24h: pair.txns?.h24 ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

async function getPumpFunMeta(mint) {
	try {
		const data = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
		if (!data || data.error) return null;
		return {
			name: data.name || null,
			symbol: data.symbol || null,
			description: data.description || null,
			imageUrl: data.image_uri || null,
			twitter: data.twitter || null,
			telegram: data.telegram || null,
			website: data.website || null,
			creator: data.creator || null,
			createdAtMs: data.created_timestamp || null,
			complete: !!data.complete,
			marketCapUsd: data.usd_market_cap ?? null,
			marketCapQuote: data.market_cap ?? null,
			totalSupply: data.total_supply_str || data.total_supply || null,
			poolAddress: data.pool_address || null,
			lastTradeTimestampMs: data.last_trade_timestamp || null,
			athMarketCapUsd: data.ath_market_cap ?? null,
			program: data.program || null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

// Solana RPC getTokenLargestAccounts via raw JSON-RPC (no @solana/web3.js).
async function getTopHolders(mint) {
	try {
		const data = await fetchJson(SOLANA_RPC_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'largest',
				method: 'getTokenLargestAccounts',
				params: [mint, { commitment: 'confirmed' }],
			}),
		});
		if (data?.error) return { error: data.error.message || 'rpc error' };
		const value = data?.result?.value || [];
		const top = value.map((acct) => ({
			address: acct.address,
			uiAmount: acct.uiAmount,
			amount: acct.amount,
			decimals: acct.decimals,
		}));
		return { topHolderCount: top.length, topHolders: top };
	} catch (err) {
		return { error: err.message };
	}
}

async function getHeliusHolderInfo(mint) {
	if (!HELIUS_API_KEY) return null;
	try {
		const data = await fetchJson(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'getAsset',
				method: 'getAsset',
				params: { id: mint, options: { showFungible: true } },
			}),
		});
		const info = data?.result?.token_info ?? null;
		if (!info) return null;
		return {
			supply: info.supply != null ? String(info.supply) : null,
			decimals: info.decimals ?? null,
			heliusPriceUsd: info.price_info?.price_per_token ?? null,
		};
	} catch (err) {
		return { error: err.message };
	}
}

async function buildSnapshot(token) {
	const [price, volume24h, meta, holders, helius] = await Promise.all([
		getJupiterPrice(token),
		getDexscreener(token),
		getPumpFunMeta(token),
		getTopHolders(token),
		getHeliusHolderInfo(token),
	]);
	return {
		token,
		fetchedAt: new Date().toISOString(),
		price,
		volume24h,
		meta,
		holders,
		helius,
		image: meta?.imageUrl || null,
		sources: {
			price: 'https://lite-api.jup.ag/price/v3',
			volume24h: 'https://api.dexscreener.com',
			meta: 'https://frontend-api-v3.pump.fun',
			holders: SOLANA_RPC_URL,
			helius: HELIUS_API_KEY ? 'https://mainnet.helius-rpc.com' : null,
		},
	};
}

function jsonResponse(statusCode, body) {
	return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// ── Lambda Function URL handler ──────────────────────────────────────────────
export const handler = async (event) => {
	const method = event?.requestContext?.http?.method || 'GET';
	const rawPath = event?.rawPath || '/';
	const path = rawPath.replace(/\/+$/, '') || '/';

	if (method === 'OPTIONS') {
		return { statusCode: 204, headers: JSON_HEADERS, body: '' };
	}

	if (path === '/healthz') {
		return jsonResponse(200, { ok: true, service: 'pump-snapshot', rpc: SOLANA_RPC_URL });
	}

	if (path === '/api/snapshot') {
		const token = event?.queryStringParameters?.token?.trim();
		if (!token) {
			return jsonResponse(400, { error: 'missing_token', message: 'Provide ?token=<mint>' });
		}
		if (!isValidSolanaPubkey(token)) {
			return jsonResponse(400, { error: 'invalid_mint', token });
		}
		const snapshot = await buildSnapshot(token);
		return jsonResponse(200, snapshot);
	}

	if (path === '/') {
		return {
			statusCode: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'public, max-age=60',
			},
			body: PAGE_HTML,
		};
	}

	return jsonResponse(404, { error: 'not_found', path });
};

// ── Live demo page ───────────────────────────────────────────────────────────
const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pump.fun Token Snapshot API — three.ws</title>
<meta name="description" content="Real-time Solana / pump.fun token snapshots: price, 24h volume, market cap, and on-chain top-holder distribution. Live API on AWS." />
<style>
  :root {
    --bg: #07080c; --panel: #0e1018; --panel-2: #141826; --line: #1f2433;
    --text: #e8ecf4; --muted: #8a93a8; --accent: #7c5cff; --accent-2: #18d6a8;
    --red: #ff5d6c; --green: #18d6a8; --radius: 14px;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: var(--sans); color: var(--text);
    background:
      radial-gradient(1200px 600px at 80% -10%, rgba(124,92,255,.18), transparent 60%),
      radial-gradient(900px 500px at 0% 10%, rgba(24,214,168,.10), transparent 55%),
      var(--bg);
    min-height: 100vh; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 56px 24px 80px; }
  header .badge {
    display: inline-flex; align-items: center; gap: 8px; font-size: 12px;
    color: var(--accent-2); border: 1px solid var(--line); border-radius: 999px;
    padding: 5px 12px; background: var(--panel); letter-spacing: .02em;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green);
    box-shadow: 0 0 0 0 rgba(24,214,168,.5); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(24,214,168,.5);} 70% { box-shadow: 0 0 0 8px rgba(24,214,168,0);} 100% { box-shadow: 0 0 0 0 rgba(24,214,168,0);} }
  h1 { font-size: clamp(28px, 5vw, 44px); line-height: 1.05; margin: 20px 0 10px; letter-spacing: -.02em; }
  h1 .grad { background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lede { color: var(--muted); font-size: 17px; max-width: 640px; line-height: 1.55; margin: 0 0 28px; }
  form { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
  input[type=text] {
    flex: 1; min-width: 240px; background: var(--panel); border: 1px solid var(--line);
    color: var(--text); border-radius: 12px; padding: 14px 16px; font-size: 15px;
    font-family: var(--mono); outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input[type=text]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,92,255,.18); }
  button {
    background: linear-gradient(90deg, var(--accent), #6b4cff); color: #fff; border: 0;
    border-radius: 12px; padding: 14px 22px; font-size: 15px; font-weight: 600; cursor: pointer;
    transition: transform .1s, filter .15s; font-family: var(--sans);
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .55; cursor: progress; }
  .examples { font-size: 13px; color: var(--muted); margin-bottom: 32px; }
  .examples a { color: var(--accent); text-decoration: none; cursor: pointer; }
  .examples a:hover { text-decoration: underline; }
  .card { background: linear-gradient(180deg, var(--panel), var(--panel-2)); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 0; overflow: hidden; }
  .card.hidden { display: none; }
  .token-head { display: flex; align-items: center; gap: 16px; padding: 22px 24px; border-bottom: 1px solid var(--line); }
  .token-head img { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: var(--panel-2); }
  .token-head .name { font-size: 20px; font-weight: 700; }
  .token-head .sym { color: var(--muted); font-family: var(--mono); font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); }
  .stat { background: var(--panel); padding: 18px 20px; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
  .stat .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .value.pos { color: var(--green); } .value.neg { color: var(--red); }
  .value.null { color: var(--muted); font-size: 15px; }
  .holders { padding: 20px 24px; }
  .holders h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 12px; }
  .holders ol { margin: 0; padding-left: 0; list-style: none; }
  .holders li { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 13px; padding: 7px 0; border-bottom: 1px dashed var(--line); }
  .holders li:last-child { border-bottom: 0; }
  .holders .addr { color: var(--muted); }
  .holders .amt { color: var(--text); font-variant-numeric: tabular-nums; }
  .skel { animation: shimmer 1.2s infinite linear; background: linear-gradient(90deg, var(--panel) 0%, var(--panel-2) 50%, var(--panel) 100%); background-size: 200% 100%; border-radius: 8px; color: transparent !important; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .error { padding: 22px 24px; color: var(--red); font-size: 15px; }
  .error .hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; line-height: 1.7; }
  footer code { font-family: var(--mono); background: var(--panel); padding: 2px 7px; border-radius: 6px; border: 1px solid var(--line); color: var(--text); }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  .api-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 18px; padding: 12px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; font-family: var(--mono); font-size: 13px; overflow-x: auto; }
  .api-line .verb { color: var(--accent-2); font-weight: 700; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge"><span class="dot"></span> Live on AWS Lambda</span>
    <h1>Pump.fun <span class="grad">Token Snapshot</span> API</h1>
    <p class="lede">Real-time market data for any Solana SPL or pump.fun token — USD price, 24h volume, market cap, and on-chain top-holder distribution. One request, every source, no mocks.</p>
  </header>

  <form id="form">
    <input id="token" type="text" placeholder="Solana mint address (base58)" autocomplete="off" spellcheck="false" />
    <button id="go" type="submit">Snapshot</button>
  </form>
  <p class="examples">Try:
    <a data-mint="HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3">PYTH</a> ·
    <a data-mint="EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm">WIF</a> ·
    <a data-mint="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263">BONK</a>
  </p>

  <div id="result" class="card hidden"></div>

  <div class="api-line">
    <span class="verb">GET</span><span id="apiExample">/api/snapshot?token=&lt;mint&gt;</span>
  </div>

  <footer>
    <p>Public JSON API. <code>GET /api/snapshot?token=&lt;mint&gt;</code> returns the full snapshot. <code>GET /healthz</code> for liveness.</p>
    <p>Data: Jupiter · Dexscreener · pump.fun · Solana RPC. Part of <a href="https://three.ws">three.ws</a> — the platform for 3D AI agents on-chain.</p>
  </footer>
</div>

<script>
const $ = (s) => document.querySelector(s);
const form = $('#form'), input = $('#token'), btn = $('#go'), result = $('#result');

function fmtUsd(n, opts = {}) {
  if (n == null || isNaN(n)) return null;
  const abs = Math.abs(n);
  const max = abs > 0 && abs < 0.01 ? 8 : (opts.compact && abs >= 1000 ? 1 : 2);
  if (opts.compact && abs >= 1000) {
    return '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  return '$' + Intl.NumberFormat('en', { maximumFractionDigits: max }).format(n);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return null;
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
function shortAddr(a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : ''; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function statCell(label, value, cls) {
  const isNull = value == null;
  return '<div class="stat"><div class="label">' + label + '</div>' +
    '<div class="value ' + (isNull ? 'null' : (cls || '')) + '">' + (isNull ? '—' : value) + '</div></div>';
}

function renderLoading() {
  result.classList.remove('hidden');
  result.innerHTML =
    '<div class="token-head"><div class="skel" style="width:56px;height:56px;border-radius:12px"></div>' +
    '<div><div class="skel" style="width:160px;height:20px;margin-bottom:8px">.</div>' +
    '<div class="skel" style="width:90px;height:13px">.</div></div></div>' +
    '<div class="grid">' + Array(4).fill('<div class="stat"><div class="skel" style="width:60px;height:11px;margin-bottom:8px">.</div><div class="skel" style="width:90px;height:20px">.</div></div>').join('') + '</div>';
}

function renderError(msg, hint) {
  result.classList.remove('hidden');
  result.innerHTML = '<div class="error">' + esc(msg) + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
}

function render(d) {
  const meta = d.meta || {}, price = d.price || {}, vol = d.volume24h || {}, holders = d.holders || {};
  const usd = price.usdPrice ?? vol.priceUsd;
  const chg = price.priceChange24hPct ?? vol.priceChange24hPct;
  const mcap = meta.marketCapUsd ?? vol.marketCapUsd ?? vol.fdvUsd;
  const liq = price.liquidityUsd ?? vol.liquidityUsd;
  const name = meta.name || (d.token.slice(0, 4) + '…' + d.token.slice(-4));
  const sym = meta.symbol ? '$' + meta.symbol : d.token.slice(0, 8);
  const img = d.image || meta.imageUrl;

  let html = '<div class="token-head">';
  html += img ? '<img src="' + esc(img) + '" alt="" onerror="this.style.visibility=\\'hidden\\'" />' : '<div style="width:56px;height:56px;border-radius:12px;background:var(--panel-2)"></div>';
  html += '<div><div class="name">' + esc(name) + '</div><div class="sym">' + esc(sym) + ' · ' + shortAddr(d.token) + '</div></div></div>';

  html += '<div class="grid">';
  html += statCell('Price', fmtUsd(usd, { compact: false }));
  html += statCell('24h Change', fmtPct(chg), chg == null ? '' : (chg >= 0 ? 'pos' : 'neg'));
  html += statCell('Market Cap', fmtUsd(mcap, { compact: true }));
  html += statCell('24h Volume', fmtUsd(vol.volume24hUsd, { compact: true }));
  html += statCell('Liquidity', fmtUsd(liq, { compact: true }));
  html += statCell('DEX', vol.dex ? esc(vol.dex) : null);
  html += '</div>';

  const list = Array.isArray(holders.topHolders) ? holders.topHolders.slice(0, 8) : [];
  if (list.length) {
    html += '<div class="holders"><h3>Top holders · on-chain (' + (holders.topHolderCount || list.length) + ')</h3><ol>';
    for (const h of list) {
      const amt = h.uiAmount != null ? Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(h.uiAmount) : '—';
      html += '<li><span class="addr">' + shortAddr(h.address) + '</span><span class="amt">' + amt + '</span></li>';
    }
    html += '</ol></div>';
  }
  result.classList.remove('hidden');
  result.innerHTML = html;
}

async function snapshot(mint) {
  const token = (mint || input.value).trim();
  if (!token) { input.focus(); return; }
  input.value = token;
  $('#apiExample').textContent = '/api/snapshot?token=' + token;
  btn.disabled = true;
  renderLoading();
  try {
    const res = await fetch('/api/snapshot?token=' + encodeURIComponent(token));
    const data = await res.json();
    if (!res.ok) { renderError(data.message || data.error || 'Request failed', data.error === 'invalid_mint' ? 'That does not look like a base58 Solana mint address.' : ''); return; }
    render(data);
  } catch (e) {
    renderError('Network error', e.message);
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); snapshot(); });
document.querySelectorAll('.examples a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); snapshot(a.dataset.mint); }));
</script>
</body>
</html>`;
