<script>
  import { route, loadCurrentUser } from '../../stores.js';
  import { signInWithEVM, signInWithSolana } from '../../walletAuth.js';
  import { signInWithPassword, registerWithPassword } from '../../passwordAuth.js';

  export let kind = 'signin'; // 'signin' | 'signup'

  let email = '';
  let password = '';
  let name = '';
  let tosAccepted = false;
  let loading = null; // 'evm' | 'sol' | 'password' | null
  let error = '';

  async function connectEVM() {
    error = '';
    loading = 'evm';
    try {
      await signInWithEVM();
      await loadCurrentUser();
      route.set('chat');
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
      await signInWithSolana();
      await loadCurrentUser();
      route.set('chat');
    } catch (e) {
      error = e.message || 'Solana sign-in failed.';
    } finally {
      loading = null;
    }
  }

  async function submit() {
    error = '';
    loading = 'password';
    try {
      if (kind === 'signup') {
        await registerWithPassword({ email, password, displayName: name, tosAccepted });
      } else {
        await signInWithPassword({ email, password });
      }
      await loadCurrentUser();
      password = '';
      route.set('chat');
    } catch (e) {
      error = e.message || 'Sign-in failed.';
    } finally {
      loading = null;
    }
  }
</script>

<section class="pt-24 pb-16 px-6">
  <div class="bg-white border border-rule rounded-2xl p-8 w-full max-w-[420px] mx-auto">
    <h1 class="font-serif text-3xl font-semibold text-center">
      {kind === 'signin' ? 'Welcome back' : 'Create your account'}
    </h1>
    <p class="text-ink-soft text-sm text-center mt-2">
      {kind === 'signin'
        ? 'Sign in to continue to three.ws'
        : 'Free to start. No credit card required.'}
    </p>

    <div class="mt-6 space-y-3">
      <button
        disabled={loading !== null}
        on:click={connectEVM}
        class="bg-black text-white rounded-xl h-11 w-full flex items-center justify-center gap-2 hover:bg-[#333] text-sm font-medium disabled:opacity-50 transition-colors"
      >
        {loading === 'evm' ? 'Connecting…' : 'Connect EVM Wallet'}
      </button>
      <button
        disabled={loading !== null}
        on:click={connectSolana}
        class="bg-white border border-rule text-ink rounded-xl h-11 w-full flex items-center justify-center gap-2 hover:bg-paper text-sm font-medium disabled:opacity-50 transition-colors"
      >
        {loading === 'sol' ? 'Connecting…' : 'Connect Solana Wallet'}
      </button>
    </div>

    <div class="flex items-center gap-3 text-xs text-ink-faint my-4">
      <span class="flex-1 h-px bg-rule" />or<span class="flex-1 h-px bg-rule" />
    </div>

    <form class="space-y-3" on:submit|preventDefault={submit}>
      {#if kind === 'signup'}
        <label class="block">
          <span class="text-xs font-medium text-ink-soft mb-1.5 block">Name</span>
          <input class="w-full h-11 px-4 rounded-xl border border-rule bg-white focus:outline-none focus:border-ink"
                 type="text" bind:value={name} required>
        </label>
      {/if}
      <label class="block">
        <span class="text-xs font-medium text-ink-soft mb-1.5 block">Email</span>
        <input class="w-full h-11 px-4 rounded-xl border border-rule bg-white focus:outline-none focus:border-ink"
               type="email" bind:value={email} required autocomplete="email">
      </label>
      <label class="block">
        <span class="text-xs font-medium text-ink-soft mb-1.5 block">Password</span>
        <input class="w-full h-11 px-4 rounded-xl border border-rule bg-white focus:outline-none focus:border-ink"
               type="password" bind:value={password} required minlength="8"
               autocomplete={kind === 'signup' ? 'new-password' : 'current-password'}>
      </label>
      {#if kind === 'signup'}
        <!-- Clickwrap. The server refuses account creation without it, so the
             submit button stays disabled until it is checked. -->
        <label class="flex items-start gap-2 text-xs text-ink-soft">
          <input type="checkbox" bind:checked={tosAccepted} required class="mt-0.5 accent-black">
          <span>
            I agree to the
            <a href="/legal/tos" class="text-ink underline">Terms of Service</a>
            and
            <a href="/legal/privacy" class="text-ink underline">Privacy Policy</a>.
          </span>
        </label>
      {/if}
      <button type="submit"
              disabled={loading !== null || (kind === 'signup' && !tosAccepted)}
              class="w-full h-11 rounded-full bg-black text-white text-sm font-medium hover:bg-ink disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
        {#if loading === 'password'}
          {kind === 'signin' ? 'Signing in…' : 'Creating account…'}
        {:else}
          {kind === 'signin' ? 'Sign in' : 'Create account'}
        {/if}
      </button>
    </form>

    {#if error}
      <p role="alert" class="text-xs text-red-500 text-center mt-3">{error}</p>
    {/if}
  </div>

  <p class="text-center text-sm text-ink-soft mt-6">
    {#if kind === 'signin'}
      Don't have an account?
      <button class="text-ink underline" on:click={() => route.set('signup')}>Sign up</button>
    {:else}
      Already have an account?
      <button class="text-ink underline" on:click={() => route.set('signin')}>Sign in</button>
    {/if}
  </p>
</section>
