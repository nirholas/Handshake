<script>
	import { route } from '../stores.js';
	import Icon from '../Icon.svelte';
	import { feMenu, feX, feArrowLeft, feExternalLink } from '../feather.js';
	import WalletConnect from '../WalletConnect.svelte';
	import NotificationBell from '../NotificationBell.svelte';
	import PayWalletPicker from '../PayWalletPicker.svelte';

	let mobileOpen = false;

	// Main-site destinations. These live at the site root (three.ws/…),
	// outside the chat SPA, so they are real anchors rather than route changes.
	const siteLinks = [
		{ href: '/marketplace', label: 'Marketplace' },
		{ href: '/pay', label: 'Pay' },
		{ href: '/features', label: 'Features' },
		{ href: '/docs', label: 'Docs' }
	];

	function goChatHome() {
		route.set('chat');
		mobileOpen = false;
	}
</script>

<header class="sticky top-0 z-40 border-b border-rule bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
	<div class="mx-auto flex h-14 max-w-[1240px] items-center justify-between px-4 sm:px-6">

		<!-- LEFT: brand breadcrumb — three.ws (home) / Chat -->
		<div class="flex min-w-0 items-center gap-1.5">
			<a
				href="/"
				class="group flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-ink transition-colors hover:bg-paper-deep"
				title="Back to three.ws"
				aria-label="Back to three.ws home"
			>
				<img src="{import.meta.env.BASE_URL}three.svg" alt="" aria-hidden="true" class="h-5 w-5" />
				<span class="font-serif text-[22px] font-semibold lowercase leading-none tracking-tight">three.ws</span>
			</a>
			<span class="select-none text-base font-light text-ink-soft/60" aria-hidden="true">/</span>
			<button
				on:click={goChatHome}
				class="rounded-full px-2 py-1 text-sm font-medium text-ink transition-colors hover:bg-paper-deep"
				aria-current={$route === 'chat' ? 'page' : undefined}
			>
				Chat
			</button>
		</div>

		<!-- CENTER: main-site navigation (desktop) -->
		<nav class="absolute left-1/2 hidden -translate-x-1/2 items-center gap-0.5 lg:flex" aria-label="three.ws">
			{#each siteLinks as link}
				<a
					href={link.href}
					class="rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink"
				>
					{link.label}
				</a>
			{/each}
		</nav>

		<!-- RIGHT: auth buttons + hamburger -->
		<div class="flex items-center gap-2">
			<div class="hidden items-center gap-2 md:flex">
				<NotificationBell />
				<PayWalletPicker />
				<WalletConnect />
			</div>
			<button
				class="rounded-full p-2 text-ink transition-colors hover:bg-paper-deep md:hidden"
				aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
				aria-expanded={mobileOpen}
				on:click={() => (mobileOpen = !mobileOpen)}
			>
				<Icon icon={mobileOpen ? feX : feMenu} class="h-5 w-5" />
			</button>
		</div>
	</div>

	<!-- Mobile sheet -->
	{#if mobileOpen}
		<div class="border-t border-rule bg-paper md:hidden">
			<div class="flex flex-col gap-1 px-4 py-3">
				<button
					on:click={goChatHome}
					class="flex h-11 items-center rounded-xl px-3 text-sm font-medium text-ink transition-colors hover:bg-paper-deep"
					aria-current={$route === 'chat' ? 'page' : undefined}
				>
					Chat
				</button>
				{#each siteLinks as link}
					<a
						href={link.href}
						class="flex h-11 items-center justify-between rounded-xl px-3 text-sm font-medium text-ink transition-colors hover:bg-paper-deep"
					>
						{link.label}
						<Icon icon={feExternalLink} class="h-4 w-4 text-ink-soft" />
					</a>
				{/each}

				<a
					href="/"
					class="mt-1 flex h-11 items-center gap-2 rounded-xl border border-rule px-3 text-sm font-medium text-ink transition-colors hover:bg-paper-deep"
				>
					<Icon icon={feArrowLeft} class="h-4 w-4" />
					Back to three.ws
				</a>

				<div class="mt-2 flex flex-col gap-3 border-t border-rule pt-3">
					<PayWalletPicker />
					<WalletConnect />
				</div>
			</div>
		</div>
	{/if}
</header>

<style>
	:global(.three-ui-card) {
		background: #f5f4ef;
		border: 1px solid #e5e3dc;
		border-radius: 12px;
	}
</style>
