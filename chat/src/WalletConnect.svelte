<script>
  import { currentUser, loadCurrentUser, walletProvider } from './stores.js';
  import { signInWithEVM, signInWithSolana, signOut } from './walletAuth.js';

  let loading = null; // 'evm' | 'sol' | null
  let error = '';

  async function connectEVM() {
    error = '';
    loading = 'evm';
    try {
      const { wallet } = await signInWithEVM();
      walletProvider.set(wallet);
      await loadCurrentUser();
    } catch (e) {
      error = e.message || 'EVM sign-in failed.';
    } finally {
      loading = null;
    }
  }

  async function connectSolana() {
    error = '';
    loading = 'sol';
    try {
      const { wallet } = await signInWithSolana();
      walletProvider.set(wallet);
      await loadCurrentUser();
    } catch (e) {
      error = e.message || 'Solana sign-in failed.';
    } finally {
      loading = null;
    }
  }

  async function handleSignOut() {
    await signOut();
    walletProvider.set(null);
    currentUser.set(null);
  }

  function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }
</script>

{#if $currentUser}
  <!-- signed-in chip -->
  <span class="flex items-center gap-2 text-sm text-ink">
    <span class="font-medium" title={$currentUser.wallet_address}>
      {$currentUser.wallet_address ? shortAddr($currentUser.wallet_address) : ($currentUser.display_name || 'Account')}
    </span>
    <span class="opacity-30">·</span>
    <button
      class="text-sm text-ink-soft underline hover:text-ink"
      on:click={handleSignOut}
    >Sign out</button>
  </span>
{:else}
  <div class="flex flex-col items-end gap-1">
    <div class="flex items-center gap-2">
      <!-- EVM button -->
      <button
        disabled={loading !== null}
        on:click={connectEVM}
        class="h-9 rounded-full bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-[#333] disabled:opacity-50"
      >
        {loading === 'evm' ? 'Connecting…' : 'Connect EVM'}
      </button>
      <!-- Solana button -->
      <button
        disabled={loading !== null}
        on:click={connectSolana}
        class="h-9 rounded-full border border-rule bg-white px-4 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-50"
      >
        {loading === 'sol' ? 'Connecting…' : 'Connect Solana'}
      </button>
    </div>
    {#if error}
      <p class="text-xs text-red-500">{error}</p>
    {/if}
  </div>
{/if}
