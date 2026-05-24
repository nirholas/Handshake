async function main() {
	const loadingEl = document.getElementById('loading');
	const dashboardEl = document.getElementById('dashboard-content');
	const agentId = new URL(location.href).searchParams.get('agent');

	if (!agentId) {
		loadingEl.textContent = 'Error: No agent ID specified in URL.';
		return;
	}

	try {
		const resp = await fetch(`/api/pump/dashboard?agent_id=${agentId}`, { credentials: 'include' });
		if (!resp.ok) {
			const err = await resp.json();
			throw new Error(err.error_description || 'Failed to load dashboard data.');
		}
		const data = await resp.json();

		document.getElementById('price-usd').textContent = `$${data.price?.value.toFixed(6) || 'N/A'}`;
		document.getElementById('market-cap').textContent = `$${(data.price?.marketCap || 'N/A')}`;

		const historyEl = document.getElementById('trade-history');
		historyEl.innerHTML = data.history.map(tx => `
			<div class="trade-item">
				<span class="${tx.side.toLowerCase()}">${tx.side}</span>
				<span>${tx.amount.toFixed(2)}</span>
				<span>$${(tx.priceUsd * tx.amount).toFixed(2)}</span>
				<a href="https://solscan.io/tx/${tx.txHash}" target="_blank" rel="noopener">View</a>
			</div>
		`).join('');
		
		loadingEl.hidden = true;
		dashboardEl.hidden = false;

	} catch (e) {
		loadingEl.textContent = `Error: ${e.message}`;
	}
}

main();
