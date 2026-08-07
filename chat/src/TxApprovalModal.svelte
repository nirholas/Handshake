<script>
	import { fade, scale } from 'svelte/transition';
	import { cubicIn } from 'svelte/easing';
	import Button from './Button.svelte';

	export let details;   // { network, from, to, amount, token, memo?, estimatedFee? }
	export let guard = null; // GuardChain verdict from /api/agent/guard, when preflighted
	export let onApprove; // () => void
	export let onReject;  // () => void

	let pending = false;

	// A `block` verdict never reaches this modal (the tool body is refused
	// before the wallet prompt). The intervention layer always reads
	// approval_required here because this modal IS the intervention, so the
	// chip keys off every OTHER layer: "cleared" means nothing beyond the
	// approval you are already giving was flagged.
	$: guardFlags = (guard?.layers || []).filter(
		(l) => l.layer !== 'intervention' && ['warn', 'approval_required', 'block', 'error'].includes(l.status),
	);
	$: guardTone = guard && guardFlags.length === 0 ? 'ok' : 'review';
	$: guardCriticalSpots = (guard?.blindSpots || []).filter((s) => s.severity === 'critical');

	function truncate(addr) {
		if (!addr || addr.length <= 12) return addr;
		return addr.slice(0, 6) + '…' + addr.slice(-4);
	}

	function approve() {
		pending = true;
		onApprove();
	}

	function reject() {
		pending = true;
		onReject();
	}

	$: rows = [
		{ label: 'Network', value: details.network },
		{ label: 'From', value: truncate(details.from) },
		{ label: 'To', value: truncate(details.to) },
		{ label: 'Amount', value: `${details.amount} ${details.token}` },
		...(details.memo ? [{ label: 'Memo', value: details.memo }] : []),
		...(details.estimatedFee ? [{ label: 'Estimated Fee', value: details.estimatedFee }] : []),
	];
</script>

<div
	transition:fade={{ duration: 200, easing: cubicIn }}
	aria-hidden="true"
	class="fixed inset-0 z-[200] bg-black/60"
/>

<div
	role="dialog"
	aria-modal="true"
	aria-label="Approve Transaction"
	transition:scale={{ opacity: 0, start: 0.97, duration: 150, easing: cubicIn }}
	class="fixed left-1/2 top-1/2 z-[201] w-[95%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
>
	<h2 class="mb-1 text-lg font-semibold text-white">Approve Transaction</h2>
	<span class="mb-5 inline-block rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-medium text-slate-300">
		{details.network}
	</span>

	<table class="mb-6 w-full text-sm">
		<tbody>
			{#each rows as row}
				<tr class="border-b border-slate-800 last:border-0">
					<td class="py-2.5 pr-4 font-medium text-slate-400">{row.label}</td>
					<td class="py-2.5 text-right font-mono text-slate-200 break-all">{row.value}</td>
				</tr>
			{/each}
		</tbody>
	</table>

	{#if guard}
		<div class="mb-6 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs">
			<div class="mb-1.5 flex items-center gap-2">
				<span class="font-medium text-slate-300">Platform guard</span>
				{#if guardTone === 'ok'}
					<span class="rounded-full bg-emerald-900/70 px-2 py-0.5 font-medium text-emerald-300">cleared</span>
				{:else}
					<span class="rounded-full bg-amber-900/70 px-2 py-0.5 font-medium text-amber-300">review advised</span>
				{/if}
				<span class="ml-auto text-slate-500">{guard.coverageScore}% coverage</span>
			</div>
			{#each guardFlags as flag}
				<p class="mb-1 text-amber-200/90">{flag.label}: {flag.reason}</p>
			{/each}
			{#each guard.warnings || [] as warning}
				<p class="mb-1 text-amber-200/90">{warning}</p>
			{/each}
			{#each guardCriticalSpots as spot}
				<p class="text-slate-400">Unchecked: {spot.title}</p>
			{/each}
		</div>
	{/if}

	<div class="flex gap-3">
		<Button
			variant="outline"
			class="flex-1 !justify-center !border-slate-600 !bg-transparent !text-slate-300 hover:!border-slate-400 disabled:opacity-50"
			disabled={pending}
			on:click={reject}
		>
			Reject
		</Button>
		<Button
			variant="dark"
			class="flex-1 !justify-center !bg-indigo-600 hover:!bg-indigo-500 disabled:opacity-50"
			disabled={pending}
			on:click={approve}
		>
			Approve
		</Button>
	</div>
</div>
