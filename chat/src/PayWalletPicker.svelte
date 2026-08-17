<script>
	import { onMount, onDestroy } from 'svelte';
	import { currentUser, payAgentId, payWallet } from './stores.js';

	let open = false;
	let agents = [];          // [{ id, name, solana_address, usdc, sol, ... }]
	let agentsLoading = false;
	let agentsError = '';
	let demoWallet = { address: null, usdc: null, sol: null, configured: null };
	let demoLoading = false;
	let demoError = '';
	let demoUnconfigured = false;
	let popoverEl;
	let buttonEl;

	$: signedIn = !!$currentUser;
	$: agentsWithWallet = agents.filter((a) => !!a.solana_address);
	$: selectedAgent = agentsWithWallet.find((a) => a.id === $payAgentId) || null;

	function fmtUsdc(v) {
		if (v == null || Number.isNaN(Number(v))) return '- USDC';
		return Number(v).toFixed(3) + ' USDC';
	}
	function shortAddr(a) {
		if (!a) return '';
		return a.slice(0, 4) + '…' + a.slice(-4);
	}

	async function loadDemoWallet() {
		demoLoading = true;
		demoError = '';
		demoUnconfigured = false;
		try {
			const r = await fetch('/api/x402-pay?balance=1');
			if (!r.ok) throw new Error('HTTP ' + r.status);
			demoWallet = await r.json();
			if (demoWallet?.configured === false) {
				// A wallet that simply isn't set up is a neutral state, not an
				// error: only misconfiguration and fetch failures go red.
				if (demoWallet.code === 'wallet_unconfigured') {
					demoUnconfigured = true;
				} else {
					demoError = demoWallet.error || 'wallet misconfigured';
				}
			}
		} catch (err) {
			demoError = err.message || 'failed to load demo wallet';
		} finally {
			demoLoading = false;
		}
	}

	async function loadAgents() {
		if (!signedIn) {
			agents = [];
			return;
		}
		agentsLoading = true;
		agentsError = '';
		try {
			const r = await fetch('/api/x402-pay?agents=1', { credentials: 'include' });
			if (r.status === 401) {
				agents = [];
				agentsError = 'sign in to use your own agent wallets';
				return;
			}
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const j = await r.json();
			agents = j.agents || [];
			// If the persisted agent id no longer maps to a wallet-bearing agent
			// (deleted, wallet removed, signed in as a different user), fall
			// back to the shared demo wallet so paid calls don't 401 silently.
			const stillValid = agents.some((a) => a.id === $payAgentId && a.solana_address);
			if ($payAgentId && !stillValid) {
				$payAgentId = null;
			}
		} catch (err) {
			agentsError = err.message || 'failed to load agents';
		} finally {
			agentsLoading = false;
		}
	}

	function publishWallet() {
		if (selectedAgent) {
			payWallet.set({
				address: selectedAgent.solana_address,
				usdc: selectedAgent.usdc,
				sol: selectedAgent.sol,
				name: selectedAgent.name,
				agentId: selectedAgent.id,
			});
		} else {
			payWallet.set({
				address: demoWallet.address,
				usdc: demoWallet.usdc,
				sol: demoWallet.sol,
				name: 'three.ws demo',
				agentId: null,
			});
		}
	}

	// Re-publish whenever any of the three inputs changes. The bare reference
	// list makes Svelte track them; the guard form `if (x || y || z)` would
	// be always-truthy here because `agents` is always an array and
	// `demoWallet` always an object.
	$: { agents; demoWallet; selectedAgent; publishWallet(); }

	function selectShared() {
		$payAgentId = null;
		open = false;
		// Force refresh so the pill picks up the latest demo wallet balance.
		loadDemoWallet();
	}
	function selectAgent(a) {
		if (!a.solana_address) return; // No wallet, handled via separate flow
		$payAgentId = a.id;
		open = false;
	}

	async function refreshAll() {
		await Promise.all([loadDemoWallet(), loadAgents()]);
	}

	function onSettled() {
		// A paid tool call just settled, so refresh balances so the pill ticks down.
		refreshAll();
	}

	function onDocClick(e) {
		if (!open) return;
		if (popoverEl && popoverEl.contains(e.target)) return;
		if (buttonEl && buttonEl.contains(e.target)) return;
		open = false;
	}

	let pollHandle;
	let userUnsub;
	onMount(async () => {
		await refreshAll();
		pollHandle = setInterval(refreshAll, 30_000);
		window.addEventListener('x402-pay-settled', onSettled);
		document.addEventListener('mousedown', onDocClick);
		userUnsub = currentUser.subscribe(() => {
			// Reload agents whenever auth state changes (sign in / sign out).
			loadAgents();
		});
	});

	onDestroy(() => {
		clearInterval(pollHandle);
		window.removeEventListener('x402-pay-settled', onSettled);
		document.removeEventListener('mousedown', onDocClick);
		userUnsub?.();
	});

	$: currentLabel = (() => {
		const w = $payWallet;
		if (w?.address) {
			const usdc = fmtUsdc(w.usdc);
			const who = w.agentId ? w.name : 'demo';
			return `Pay · ${who} · ${usdc}`;
		}
		if (demoLoading || agentsLoading) return 'Pay · loading…';
		if (demoError) return 'Pay · wallet error';
		return 'Pay · not configured';
	})();
	$: dotClass = $payWallet?.address
		? 'bg-emerald-500'
		: demoError
			? 'bg-red-500'
			: 'bg-slate-300';
</script>

<div class="relative">
	<button
		bind:this={buttonEl}
		on:click={() => (open = !open)}
		class="flex h-9 items-center gap-2 rounded-full border border-rule bg-white px-3 text-[12px] font-medium text-ink shadow-sm transition-colors hover:bg-paper-deep"
		title="Wallet that pays for x402 paid-tool calls"
	>
		<span class="flex h-2 w-2 rounded-full {dotClass}"></span>
		<span class="font-mono">{currentLabel}</span>
		<span class="text-ink-soft" style="font-size:10px">▾</span>
	</button>

	{#if open}
		<div
			bind:this={popoverEl}
			class="absolute right-0 top-full z-[120] mt-2 w-[300px] rounded-xl border border-rule bg-white p-3 shadow-pop"
		>
			<div class="mb-2 text-[11px] uppercase tracking-wider text-ink-soft">x402 pay-per-call wallet</div>

			<button
				class="flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors {$payAgentId == null
					? 'border-emerald-500 bg-emerald-50'
					: 'border-rule hover:bg-paper-deep'}"
				on:click={selectShared}
			>
				<div class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-cyan-400 text-[10px] font-bold text-white">3</div>
				<div class="min-w-0 flex-1">
					<div class="text-[13px] font-medium text-ink">three.ws demo wallet</div>
					<div class="font-mono text-[11px] text-ink-soft">
						{#if demoLoading}
							loading…
						{:else if demoWallet.address}
							{shortAddr(demoWallet.address)} · {fmtUsdc(demoWallet.usdc)}
						{:else if demoError}
							<span class="text-red-600">{demoError}</span>
						{:else if demoUnconfigured && signedIn && agentsWithWallet.length > 0}
							not configured. Pick one of your agent wallets below
						{:else}
							not configured
						{/if}
					</div>
				</div>
			</button>

			<div class="mt-3 mb-1 text-[11px] uppercase tracking-wider text-ink-soft">your agents</div>

			{#if !signedIn}
				<div class="rounded-lg border border-dashed border-rule px-3 py-2 text-[12px] text-ink-soft">
					Sign in to pay from one of your agent's Solana wallets.
				</div>
			{:else if agentsLoading}
				<div class="px-3 py-2 text-[12px] text-ink-soft">loading agents…</div>
			{:else if agentsError}
				<div class="rounded-lg border border-dashed border-rule px-3 py-2 text-[12px] text-ink-soft">{agentsError}</div>
			{:else if agents.length === 0}
				<div class="rounded-lg border border-dashed border-rule px-3 py-2 text-[12px] text-ink-soft">
					No agents yet. <a class="text-indigo-600 underline" href="https://three.ws/create" target="_blank" rel="noopener">Create one →</a>
				</div>
			{:else}
				<div class="flex max-h-[220px] flex-col gap-1 overflow-y-auto pr-1">
					{#each agents as a (a.id)}
						<button
							class="flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors {$payAgentId === a.id
								? 'border-emerald-500 bg-emerald-50'
								: a.solana_address
									? 'border-rule hover:bg-paper-deep'
									: 'border-rule opacity-60'}"
							on:click={() => selectAgent(a)}
							disabled={!a.solana_address}
							title={a.solana_address ? `Pay from ${a.name}` : 'This agent has no Solana wallet yet'}
						>
							<div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-cyan-400 text-[10px] font-bold text-white">
								{a.name?.[0] || '?'}
							</div>
							<div class="min-w-0 flex-1">
								<div class="truncate text-[13px] font-medium text-ink">{a.name}</div>
								<div class="font-mono text-[11px] text-ink-soft">
									{a.solana_address ? `${shortAddr(a.solana_address)} · ${fmtUsdc(a.usdc)}` : 'no wallet'}
								</div>
							</div>
						</button>
					{/each}
				</div>
				<div class="mt-2 text-[11px] text-ink-soft">
					Need a wallet for an agent? <a class="text-indigo-600 underline" href="https://three.ws/pay" target="_blank" rel="noopener">Set one up on /pay</a>.
				</div>
			{/if}

			<div class="mt-3 flex items-center justify-between border-t border-rule pt-2 text-[11px] text-ink-soft">
				<span>$0.001 USDC per call · Solana mainnet</span>
				<a class="text-indigo-600 underline" href="https://three.ws/pay" target="_blank" rel="noopener">/pay demo</a>
			</div>
		</div>
	{/if}
</div>
