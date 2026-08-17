<script>
	// The wallet identity of the agent you're chatting with. Tip it for a good
	// answer, copy its address, or open its full wallet on three.ws. Thin Svelte
	// wrapper over the shared portable wallet (one module, mounted everywhere the
	// avatar appears) so the chat never forks the wallet logic. Reads only public
	// data from the CORS:* wallet-embed endpoint; it is the visitor view by
	// construction (no owner controls in chat).
	import { onMount, onDestroy } from 'svelte';
	import { mountPortableWallet } from '$shared/portable-wallet.js';

	export let agentId = '';
	/** 'chip' toggles a popover; 'card' renders the wallet open inline. */
	export let variant = 'chip';

	let host;
	let mount = null;
	let mountedId = null;

	function remount(id) {
		if (mount) {
			try { mount.destroy(); } catch { /* already gone */ }
			mount = null;
		}
		mountedId = null;
		if (!host || !id) return;
		mount = mountPortableWallet(host, {
			agentId: id,
			variant,
			tip: true,
			qr: true,
			share: true,
			theme: 'light',
		});
		mountedId = id;
	}

	onMount(() => remount(agentId));
	onDestroy(() => { try { mount?.destroy(); } catch { /* gone */ } });

	// Re-mount when the active agent changes.
	$: if (host && agentId !== mountedId) remount(agentId);
</script>

<span class="agent-wallet" bind:this={host}></span>

<style>
	.agent-wallet {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
	}
</style>
