/**
 * Marketplace Analytics page — fetches and renders aggregate skill market stats.
 * Uses Canvas API to draw the volume sparkline (no external charting dependency).
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function fmtVolume(atomic, mint) {
	const n = Number(atomic) / 1_000_000;
	const symbol = mint === THREE_MINT ? '$THREE' : mint === USDC_MINT ? 'USDC' : '';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ${symbol}`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K ${symbol}`;
	return `${n.toFixed(2)} ${symbol}`;
}

function statCard(val, lbl) {
	return `<div class="stat-card"><div class="stat-val">${val}</div><div class="stat-lbl">${lbl}</div></div>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Render the trial funnel. Free trials are never counted as sales, so this is
 * the only place they are shown, and the shape of the drop-off is the point:
 * each bar is sized against the widest stage.
 */
function renderFunnel(funnel) {
	const section = document.getElementById('funnel-section');
	const list = document.getElementById('funnel-steps');
	const note = document.getElementById('funnel-note');
	if (!section || !list || !funnel) return;

	const { granted = 0, used = 0, exhausted = 0, converted = 0 } = funnel;
	if (!granted && !converted) return; // nothing to show yet; leave the section hidden

	const stages = [
		{ name: 'Trials granted', n: granted, tint: 'var(--violet)', desc: 'Buyers who started a free trial of a listed skill.' },
		{ name: 'Trials used', n: used, tint: 'var(--cyan)', desc: 'Trials where at least one run has actually been spent.' },
		{ name: 'Trials exhausted', n: exhausted, tint: 'var(--amber)', desc: 'Every free run gone. The highest-intent state in the marketplace.' },
		{ name: 'Converted to a sale', n: converted, tint: 'var(--green)', desc: 'Paid in full, settled on chain.' },
	];

	const widest = Math.max(...stages.map((s) => s.n), 1);
	list.innerHTML = stages
		.map((s) => {
			const pct = Math.max((s.n / widest) * 100, s.n > 0 ? 2 : 0);
			const rate = granted > 0 ? `${((s.n / granted) * 100).toFixed(s.n && s.n < granted / 100 ? 1 : 0)}% of granted` : '';
			return `<li class="funnel-step" style="--pct:${pct.toFixed(1)}%;--tint:${s.tint};">
				<div class="funnel-head">
					<span class="funnel-name">${esc(s.name)}</span>
					<span class="funnel-val">${s.n.toLocaleString()}${rate ? `<span class="funnel-rate">${rate}</span>` : ''}</span>
				</div>
				<div class="funnel-desc">${esc(s.desc)}</div>
			</li>`;
		})
		.join('');

	// The two shapes that mean something is wired wrong rather than demand being
	// weak. Saying so beats leaving a reader to conclude the market is dead.
	let diagnosis = '';
	if (granted > 20 && used === 0) {
		diagnosis = `All ${granted.toLocaleString()} trials still hold every run they were granted, so nothing is metering trial usage. Until runs are spent, no trial can reach the exhausted state that makes a buyer eligible to purchase.`;
	} else if (exhausted > 10 && converted === 0) {
		diagnosis = `${exhausted.toLocaleString()} trials have run out with no purchases behind them. That is a checkout problem, not a demand problem.`;
	}
	if (diagnosis) {
		note.innerHTML = `${esc(diagnosis)} <a href="/tutorials/sell-a-skill-with-a-trial">How the trial funnel is meant to work</a>`;
		note.hidden = false;
	}

	section.hidden = false;
}

function rankRow(num, name, sub, primary, secondary) {
	return `
		<div class="rank-row">
			<span class="rank-num">${num}</span>
			<div class="rank-meta">
				<div class="rank-name">${name}</div>
				${sub ? `<div class="rank-sub">${sub}</div>` : ''}
			</div>
			<div class="rank-val">
				<div class="rank-primary">${primary}</div>
				${secondary ? `<div class="rank-secondary">${secondary}</div>` : ''}
			</div>
		</div>`;
}

function drawVolumeChart(canvas, days) {
	if (!days.length) return;
	const ctx = canvas.getContext('2d');
	const dpr = window.devicePixelRatio || 1;
	const rect = canvas.getBoundingClientRect();
	canvas.width = rect.width * dpr;
	canvas.height = rect.height * dpr;
	ctx.scale(dpr, dpr);
	const W = rect.width;
	const H = rect.height;

	const pad = { top: 16, right: 12, bottom: 28, left: 44 };
	const chartW = W - pad.left - pad.right;
	const chartH = H - pad.top - pad.bottom;

	const volumes = days.map(d => Number(d.volumeAtomic));
	const maxVol = Math.max(...volumes, 1);
	const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
	const lineColor = '#4ade80';
	const textColor = isDark ? 'rgba(231,233,238,0.45)' : 'rgba(0,0,0,0.45)';
	const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';

	// Grid lines
	ctx.strokeStyle = gridColor;
	ctx.lineWidth = 1;
	for (let i = 0; i <= 4; i++) {
		const y = pad.top + (chartH / 4) * i;
		ctx.beginPath();
		ctx.moveTo(pad.left, y);
		ctx.lineTo(pad.left + chartW, y);
		ctx.stroke();
	}

	// Y-axis labels
	ctx.fillStyle = textColor;
	ctx.font = '10px Inter, system-ui, sans-serif';
	ctx.textAlign = 'right';
	for (let i = 0; i <= 4; i++) {
		const y = pad.top + (chartH / 4) * i;
		const v = (maxVol * (1 - i / 4)) / 1_000_000;
		ctx.fillText(v >= 1 ? `${v.toFixed(1)}M` : `${(v * 1000).toFixed(0)}K`, pad.left - 6, y + 4);
	}

	// X-axis labels (every ~5 days)
	ctx.textAlign = 'center';
	days.forEach((d, i) => {
		if (i % 5 !== 0 && i !== days.length - 1) return;
		const x = pad.left + (i / (days.length - 1)) * chartW;
		const label = new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		ctx.fillText(label, x, H - pad.bottom + 14);
	});

	// Volume bars
	const barW = Math.max(2, chartW / days.length - 2);
	days.forEach((d, i) => {
		const x = pad.left + (i / days.length) * chartW + (chartW / days.length - barW) / 2;
		const barH = (Number(d.volumeAtomic) / maxVol) * chartH;
		const y = pad.top + chartH - barH;
		ctx.fillStyle = lineColor;
		ctx.globalAlpha = 0.75;
		ctx.beginPath();
		ctx.roundRect(x, y, barW, barH, 2);
		ctx.fill();
	});
	ctx.globalAlpha = 1;
}

async function load() {
	const statsGrid = document.getElementById('stats-grid');
	const topSkillsList = document.getElementById('top-skills-list');
	const topAgentsList = document.getElementById('top-agents-list');
	const errorEl = document.getElementById('an-error');
	const canvas = document.getElementById('volume-chart');

	let res;
	try {
		res = await fetch('/api/marketplace/analytics');
	} catch {
		res = null;
	}
	if (!res || !res.ok) {
		errorEl.textContent = 'Failed to load analytics. Please refresh.';
		errorEl.hidden = false;
		statsGrid.innerHTML = '';
		topSkillsList.innerHTML = '';
		topAgentsList.innerHTML = '';
		return;
	}

	const { data } = await res.json();
	const { summary, topSkills, topAgents, salesVolume, trialFunnel } = data;

	// Stats. `totalSales` and `totalVolumeAtomic` count PAID purchases only;
	// free trials get their own card so they can never read as revenue.
	const totalVol = fmtVolume(summary.totalVolumeAtomic, USDC_MINT);
	statsGrid.innerHTML = [
		statCard(summary.totalSales.toLocaleString(), 'Paid skill sales'),
		statCard(totalVol, 'Total volume'),
		statCard((summary.totalTrials ?? 0).toLocaleString(), 'Free trials taken'),
		statCard(summary.uniqueBuyers.toLocaleString(), 'Paying buyers'),
		statCard(summary.uniqueSellers.toLocaleString(), 'Creators listing skills'),
	].join('');

	renderFunnel(trialFunnel);

	// Top skills
	document.getElementById('top-skills-count').textContent = topSkills.length;
	topSkillsList.innerHTML = topSkills.length
		? topSkills.map((s, i) => rankRow(
			i + 1,
			s.skill,
			s.agentName || '',
			s.totalSales > 0
				? `${s.totalSales} ${s.totalSales === 1 ? 'sale' : 'sales'}`
				: `${s.totalTrials || 0} ${s.totalTrials === 1 ? 'trial' : 'trials'}, no sales yet`,
			fmtVolume(s.totalRevenue, s.currencyMint),
		)).join('')
		: '<div style="color:var(--muted);font-size:13px;padding:16px 0;">No skills listed yet.</div>';

	// Top agents
	document.getElementById('top-agents-count').textContent = topAgents.length;
	topAgentsList.innerHTML = topAgents.length
		? topAgents.map((a, i) => rankRow(
			i + 1,
			a.agentName || 'Unknown',
			`${a.saleCount} ${a.saleCount === 1 ? 'skill sale' : 'skill sales'}`,
			fmtVolume(a.netRevenue, a.currencyMint),
			'net revenue',
		)).join('')
		: '<div style="color:var(--muted);font-size:13px;padding:16px 0;">No agents yet.</div>';

	// Volume chart
	if (salesVolume.length && canvas) {
		// Group by day (sum across currencies)
		const byDay = {};
		salesVolume.forEach(({ day, volumeAtomic }) => {
			byDay[day] = (byDay[day] || 0) + Number(volumeAtomic);
		});
		const days = Object.entries(byDay)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([day, vol]) => ({ day, volumeAtomic: vol, currencyMint: USDC_MINT }));

		// Fill in missing days with zeros for a complete 30-day view
		const filled = [];
		const start = new Date(days[0]?.day || Date.now());
		const end = new Date();
		for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
			const key = d.toISOString().slice(0, 10);
			filled.push({ day: key, volumeAtomic: byDay[key] || 0 });
		}

		// Wait for layout then draw
		requestAnimationFrame(() => drawVolumeChart(canvas, filled));
	}
}

load().catch(() => {
	const errorEl = document.getElementById('an-error');
	if (errorEl) {
		errorEl.textContent = 'Failed to load analytics. Please refresh.';
		errorEl.hidden = false;
	}
	['stats-grid', 'top-skills-list', 'top-agents-list'].forEach((id) => {
		const el = document.getElementById(id);
		if (el) el.innerHTML = '';
	});
});
