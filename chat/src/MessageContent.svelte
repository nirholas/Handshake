<script>
	import Markdown from './svelte-marked/markdown/Markdown.svelte';

	export let message;

	export let contentHeight = undefined;
</script>

{#if message.error}
	<!-- An error is a state of its own, not a quieter reply: give it a border, a
	     warning tint and a role so it is legible at a glance and announced. -->
	<div
		role="alert"
		class="markdown flex w-full max-w-none items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-left text-sm text-ink-soft prose-a:underline"
	>
		<svg
			viewBox="0 0 24 24"
			class="mt-[3px] h-4 w-4 shrink-0 text-amber-400"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M12 9v4" />
			<path
				d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
			/>
			<path d="M12 17h.01" />
		</svg>
		<span class="min-w-0"><Markdown source={message.error} /></span>
	</div>
{:else if message.content}
	<div
		bind:clientHeight={contentHeight}
		class="markdown prose prose-slate prose-invert flex w-full max-w-none flex-col break-words prose-h1:font-semibold prose-h2:font-semibold prose-h3:font-semibold prose-h4:font-semibold prose-h1:!my-2 prose-h1:text-[22px] prose-h2:!my-1.5 prose-h2:text-xl prose-h3:!my-1.5 prose-h3:text-lg prose-p:whitespace-pre-wrap prose-p:text-slate-800 prose-a:[overflow-wrap:anywhere] prose-code:[overflow-wrap:anywhere] prose-pre:mb-4 prose-pre:mt-0 prose-pre:whitespace-pre-wrap prose-pre:rounded-lg prose-pre:rounded-t-none prose-pre:border-t-0 prose-pre:border prose-pre:border-slate-200 prose-pre:bg-white prose-pre:text-slate-800 prose-pre:[overflow-wrap:anywhere] prose-ul:my-0 prose-img:mb-2"
	>
		{#if message.contentParts}
			{#each message.contentParts as part}
				<img
					src={part.image_url.url}
					alt=""
					class="max-h-[400px] w-min rounded-lg object-contain object-[0]"
				/>
			{/each}
		{/if}
		<Markdown source={message.content} {message} />
	</div>
{:else if message.generatedImageUrl}
	<img
		src={message.generatedImageUrl}
		alt=""
		class="max-h-[400px] w-min rounded-lg object-contain object-[0]"
	/>
{/if}
