<script lang="ts">
	import { flash } from '../../../../actions.js';
	import { feChevronDown, feChevronUp, feCopy } from '../../../../feather.js';
	import Icon from '../../../../Icon.svelte';
	import type { MarkdownOptions, Renderers } from '../../markedConfiguration';
	import type { Tokens } from 'marked';

	export let token: Tokens.Code;
	export const options: MarkdownOptions = undefined;
	export const renderers: Renderers = undefined;
	// Passed to every renderer by the marked harness; this one renders the same
	// header for assistant and user code blocks, so it goes unread.
	export const message = undefined;

	let attrs: Record<string, any> = {};

	function parseAttributes(langString) {
		const regex = /(\w+)=["'](.+?)["']/g;
		const attrs = {};
		let match;
		while ((match = regex.exec(langString)) !== null) {
			attrs[match[1]] = match[2];
		}
		return attrs;
	}

	$: if (token.lang) {
		attrs = parseAttributes(token.lang);
	}

	let clientHeight;
	let showingAll = false;
</script>

<div class="relative" bind:clientHeight>
	{#if clientHeight > 400}
		<button
			class="absolute bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-x-1.5 self-start rounded-full bg-gray-200 px-3.5 py-2 text-left text-xs transition-colors hover:bg-gray-300"
			on:click={() => (showingAll = !showingAll)}
		>
			<Icon icon={showingAll ? feChevronUp : feChevronDown} class="h-4 w-4 transition-transform" />
			{showingAll ? 'Show less' : 'Show all'}
		</button>
	{/if}
	<div
		class="flex items-center gap-4 rounded-t-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 sm:gap-3"
	>
		{#if attrs.filepath || token.lang}
			<span class="font-mono text-xs font-semibold text-black">
				{attrs.filepath || token.lang}
			</span>
		{/if}
		<div class="ml-auto flex gap-2">
			<button
				class="flex items-center gap-x-1.5 self-start rounded-full bg-gray-200 px-3.5 py-2 text-left text-xs transition-colors hover:bg-gray-300"
				use:flash
				on:click={(event) => {
					event.currentTarget.dispatchEvent(new CustomEvent('flashSuccess'));
					navigator.clipboard.writeText(token.text);
				}}
			>
				<Icon icon={feCopy} class="h-3 w-3" />
				Copy
			</button>
		</div>
	</div>
	<pre
		class={clientHeight > 400 && !showingAll
			? 'max-h-[400px] overflow-y-auto scrollbar-ultraslim'
			: ''}><code class={`lang-${token.lang}`}>{token.text}</code></pre>
</div>
