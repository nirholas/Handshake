<script>
	import { route } from '../stores.js';
	import Icon from '../Icon.svelte';
	import { feMenu, feX, feArrowLeft, feExternalLink } from '../feather.js';
	import WalletConnect from '../WalletConnect.svelte';
	import NotificationBell from '../NotificationBell.svelte';
	import PayWalletPicker from '../PayWalletPicker.svelte';

	// Main-site destinations. These live at the site root (three.ws/…),
	// outside the chat SPA, so they are real anchors rather than route changes.
	// Sourced from the shared nav data so chat and the main-site header can
	// never disagree on labels or hrefs.
	import { CHAT_SITE_LINKS as siteLinks } from '../../../public/nav-data.js';

	let mobileOpen = false;

	function goChatHome() {
		route.set('chat');
		mobileOpen = false;
	}
</script>

<header class="sticky top-0 z-40 border-b border-rule bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
	<div class="mx-auto flex h-14 max-w-[1240px] items-center justify-between px-4 sm:px-6">

		<!-- LEFT: brand breadcrumb: three.ws (home) / Chat -->
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

		<!-- CENTER: main-site navigation (desktop).
		     In flow, not absolutely centered: a centered overlay sat on top of the
		     right-hand cluster at every width, so the Pay pill covered Features and
		     Docs and neither was clickable. Shown from xl, where the three clusters
		     fit side by side; below that the links live in the sheet behind the
		     hamburger. -->
		<nav
			class="hidden min-w-0 flex-1 items-center justify-center gap-0.5 xl:flex"
			aria-label="three.ws"
		>
			{#each siteLinks as link}
				<a
					href={link.href}
					class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink {link.highlight
						? 'border border-rule'
						: ''}"
				>
					{#if link.highlight}<span class="iris-dot" aria-hidden="true"></span>{/if}
					{link.label}
				</a>
			{/each}
		</nav>

		<!-- RIGHT: auth buttons + hamburger. The hamburger stays until xl, because
		     that is where the site links join the bar; without it, every width
		     between md and xl had no way to reach them at all. -->
		<div class="flex shrink-0 items-center gap-2">
			<div class="hidden items-center gap-2 md:flex">
				<NotificationBell />
				<PayWalletPicker />
				<WalletConnect />
			</div>
			<button
				class="rounded-full p-2 text-ink transition-colors hover:bg-paper-deep xl:hidden"
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
		<div class="border-t border-rule bg-paper xl:hidden">
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
						<span class="flex items-center gap-2">
							{#if link.highlight}<span class="iris-dot" aria-hidden="true"></span>{/if}
							{link.label}
						</span>
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

				<!-- Only when the header cluster is hidden, so the wallet controls are
				     never offered twice on the same screen. -->
				<div class="mt-2 flex flex-col gap-3 border-t border-rule pt-3 md:hidden">
					<PayWalletPicker />
					<WalletConnect />
				</div>
			</div>
		</div>
	{/if}
</header>

<style>
	:global(.three-ui-card) {
		background: #0A0A0A;
		border: 1px solid #2A2A2A;
		border-radius: 12px;
	}

	/* Iris live dot: same signature as the main-site nav's Text → 3D pill. */
	.iris-dot {
		width: 6px;
		height: 6px;
		flex: 0 0 auto;
		border-radius: 50%;
		background: conic-gradient(from 210deg, #ffb454, #ff6ad5, #8b5cf6, #4fc3ff, #ffb454);
	}
	@media (prefers-reduced-motion: no-preference) {
		.iris-dot {
			animation: iris-pulse 2.4s ease-in-out infinite;
		}
		@keyframes iris-pulse {
			0%,
			100% {
				box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.45);
			}
			50% {
				box-shadow: 0 0 0 4px rgba(139, 92, 246, 0);
			}
		}
	}
</style>
