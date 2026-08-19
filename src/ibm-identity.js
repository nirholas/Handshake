// Identity Firewall — client module for /ibm/identity.
//
// Calls POST /api/agents/identity-check with the candidate name + description,
// then renders a verdict showing:
//  · overall status (clear / review / block / unavailable)
//  · identity-uniqueness gauge (from Granite embedding cosine distance)
//  · nearest existing agents by cosine similarity
//  · Granite Guardian content-screen chips (harm / social_bias / sexual_content)
//  · a designed "watsonx not configured" state when the API returns configured:false
//
// No mock data, no fake verdicts. The page HTML defines all DOM elements this
// module references by ID.

const $ = (id) => document.getElementById(id);

const nameEl  = $('name');
const descEl  = $('desc');
const runBtn  = $('run');
const runLabel = $('run-label');
const emptyEl = $('empty');
const verdictEl = $('verdict');
const countEl = $('count');

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

// ── Character counter ───────────────────────────────────────────────────────
descEl.addEventListener('input', () => {
	countEl.textContent = descEl.value.length;
});

// ── Example chips ───────────────────────────────────────────────────────────
document.getElementById('examples').addEventListener('click', (e) => {
	const chip = e.target.closest('.chip');
	if (!chip) return;
	nameEl.value = chip.dataset.name || '';
	descEl.value = chip.dataset.desc || '';
	countEl.textContent = descEl.value.length;
	run();
});

// ── Run check ───────────────────────────────────────────────────────────────
let busy = false;

async function run() {
	const name        = nameEl.value.trim();
	const description = descEl.value.trim();
	if (!name && !description) { nameEl.focus(); return; }
	if (busy) return;

	busy = true;
	runBtn.disabled = true;
	runLabel.textContent = 'Checking with Granite…';
	const spinner = document.createElement('span');
	spinner.className = 'spinner';
	runBtn.insertBefore(spinner, runBtn.firstChild);

	// Show skeleton in the verdict panel while waiting
	showSkeleton();

	try {
		const res  = await fetch('/api/agents/identity-check', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ name, description }),
		});
		const data = await res.json();
		if (!res.ok) {
			renderError(data?.error_description || data?.error || 'Check failed. Please try again.');
		} else {
			render(data);
		}
	} catch {
		renderError('Network error. Please try again.');
	} finally {
		busy = false;
		runBtn.disabled = false;
		spinner.remove();
		runLabel.textContent = 'Run identity check';
	}
}

runBtn.addEventListener('click', run);
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

// ── Skeleton state ──────────────────────────────────────────────────────────
function showSkeleton() {
	emptyEl.style.display = 'none';
	verdictEl.classList.add('show');
	verdictEl.dataset.state = 'loading';
	verdictEl.innerHTML = `
		<div class="verdict-skeleton">
			<div class="sk-row">
				<div class="sk-icon"></div>
				<div class="sk-lines"><div class="sk-line sk-line--lg"></div><div class="sk-line sk-line--sm"></div></div>
			</div>
			<div class="sk-bar"></div>
			<div class="sk-line sk-line--md"></div>
			<div class="sk-line sk-line--sm"></div>
			<div class="sk-line sk-line--md"></div>
		</div>`;

	// Inject skeleton styles once
	if (!document.getElementById('sk-styles')) {
		const s = document.createElement('style');
		s.id = 'sk-styles';
		s.textContent = `
.verdict-skeleton { display:flex; flex-direction:column; gap:12px; }
.sk-row { display:flex; align-items:center; gap:14px; }
.sk-icon { width:46px; height:46px; border-radius:13px; flex:none; background:var(--panel,rgba(255,255,255,0.06)); animation:sk-pulse 1.4s ease-in-out infinite; }
.sk-lines { flex:1; display:flex; flex-direction:column; gap:8px; }
.sk-line { height:12px; border-radius:6px; background:var(--panel,rgba(255,255,255,0.06)); animation:sk-pulse 1.4s ease-in-out infinite; }
.sk-line--lg { width:70%; }
.sk-line--md { width:55%; }
.sk-line--sm { width:40%; }
.sk-bar { height:8px; border-radius:99px; background:var(--panel,rgba(255,255,255,0.06)); animation:sk-pulse 1.4s ease-in-out infinite; }
@keyframes sk-pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
		`.trim();
		document.head.appendChild(s);
	}
}

// ── Restore verdict DOM from skeleton back to original structure ─────────────
function restoreVerdictDOM() {
	verdictEl.innerHTML = `
		<div class="status-row">
			<div class="status-icon" id="status-icon">·</div>
			<div class="status-text">
				<div class="label" id="status-label">—</div>
				<div class="meta" id="status-meta"></div>
			</div>
		</div>
		<div id="uniq-block">
			<div class="gauge"><span id="uniq-bar" style="width:0%"></span></div>
			<div class="gauge-cap"><span>Identity uniqueness</span><span id="uniq-pct">—</span></div>
		</div>
		<ul class="reasons" id="reasons"></ul>
		<div id="neighbors-block" style="display:none">
			<div class="section-title">Nearest existing agents · Granite cosine</div>
			<div id="neighbors"></div>
		</div>
		<div id="guardian-block" style="display:none">
			<div class="section-title">Granite Guardian content screen</div>
			<div class="guardian-chips" id="guardian-chips"></div>
		</div>`;
}

// ── Error state ─────────────────────────────────────────────────────────────
function renderError(msg) {
	restoreVerdictDOM();
	verdictEl.classList.add('show');
	verdictEl.dataset.state = 'unavailable';
	$('status-icon').textContent = '!';
	$('status-label').textContent = 'Could not check';
	$('status-meta').textContent = msg;
	$('uniq-block').style.display = 'none';
	$('reasons').innerHTML = '';
	$('neighbors-block').style.display = 'none';
	$('guardian-block').style.display = 'none';
}

// ── Verdict rendering ───────────────────────────────────────────────────────
const ICON  = { clear: '✓', review: '⚠', block: '✗', unavailable: '·' };
const LABEL = {
	clear:       'Distinct identity',
	review:      'Similar identity exists',
	block:       'Identity conflict',
	unavailable: 'Check unavailable',
};

function render(data) {
	restoreVerdictDOM();
	verdictEl.classList.add('show');

	const state = data.status || 'unavailable';
	verdictEl.dataset.state = state;
	$('status-icon').textContent = ICON[state] || '·';
	$('status-label').textContent = LABEL[state] || 'Unknown';

	// Unconfigured: show a clear designed state, no fake data
	if (!data.configured || state === 'unavailable') {
		$('status-meta').textContent =
			'IBM watsonx.ai is not configured on this deployment. ' +
			'Set WATSONX_API_KEY + WATSONX_PROJECT_ID to enable Granite identity checks.';
		$('uniq-block').style.display   = 'none';
		$('reasons').innerHTML           = '';
		$('neighbors-block').style.display = 'none';
		$('guardian-block').style.display  = 'none';
		return;
	}

	// Uniqueness gauge
	const pct = data.uniqueness != null ? Math.round(data.uniqueness * 100) : null;
	$('status-meta').textContent = pct != null ? `${pct}% distinct from existing agents` : '';
	if (pct != null) {
		$('uniq-block').style.display = 'block';
		$('uniq-bar').style.width     = pct + '%';
		$('uniq-pct').textContent     = pct + '%';
	} else {
		$('uniq-block').style.display = 'none';
	}

	// Reasons list
	$('reasons').innerHTML = (data.reasons || [])
		.map((r) => `<li>${esc(r)}</li>`)
		.join('');

	// Nearest agents
	const sims = (data.similar || []).filter((s) => s.score > 0);
	if (sims.length) {
		$('neighbors-block').style.display = 'block';
		$('neighbors').innerHTML = sims.slice(0, 5).map((s) => {
			const score = Math.round(s.score * 100);
			const tag   = s.owned
				? '<span class="ntag">yours</span>'
				: s.public ? '' : '<span class="ntag">private</span>';
			return `<a class="neighbor" href="/agents/${esc(s.id)}" target="_blank" rel="noopener">
				<span class="nname">${esc(s.name || 'Agent')}</span>
				<span class="nbar"><span style="width:${score}%"></span></span>
				<span class="nscore">${score}%</span>${tag}
			</a>`;
		}).join('');
	} else {
		$('neighbors-block').style.display = 'none';
	}

	// Guardian content screen
	const g = data.guardian;
	if (g) {
		$('guardian-block').style.display = 'block';
		const flagged   = new Set(g.flagged || []);
		const reasons   = g.reasons || [];
		const labelFor  = (risk) => {
			const m = reasons.find((x) => x.risk === risk);
			return m ? m.label : risk;
		};
		const risks = ['harm', 'social_bias', 'sexual_content'];
		$('guardian-chips').innerHTML = risks.map((risk) => {
			const isFlag = flagged.has(risk);
			const label  = (labelFor(risk) || risk).replace(/_/g, ' ');
			return `<span class="gchip ${isFlag ? 'flag' : ''}"><span class="gd"></span>${esc(label)}: ${isFlag ? 'flagged' : 'clear'}</span>`;
		}).join('');
	} else {
		$('guardian-block').style.display = 'none';
	}
}
