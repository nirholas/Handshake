<script>
	import { createEventDispatcher } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import JsonView from './svelte-json-view/JsonView.svelte';
	import Icon from './Icon.svelte';
	import Choice from './Choice.svelte';
	import { feCheck, feChevronDown, feLoader, feX } from './feather.js';

	const dispatch = createEventDispatcher();

	export let toolcall;
	export let toolresponse;
	export let collapsable = true;
	export let closeButton = false;

	export let isChoosing = false;
	export let choiceHandler;
	export let question = '';
	export let choices = [];
	export let chose = null;

	let className = '';
	export { className as class };

	$: finished = toolcall.finished || toolresponse;

	let displayType = null;
	let displayTypeDisabled = false;
	let displayedContent = null;
	$: if (toolresponse && toolresponse.content && toolresponse.content.contentType) {
		displayType = null;
		displayedContent = null;
		// When a special contentType is returned, if a `content` field is not present,
		// we automatically fill it with the value of whatever argument (single) was passed into the tool call.
		// This is done in order to save tokens, because it prevents us having to re-send the content again to the model.
		if (!toolresponse.content.content && Object.keys(toolcall.arguments).length === 1) {
			displayedContent = toolcall.arguments[Object.keys(toolcall.arguments)[0]];
		} else {
			displayedContent = toolresponse.content.content;
		}
		if (displayedContent) {
			const contentType = toolresponse.content.contentType;
			// Get display type for this type of content:
			if (contentType.startsWith('image/')) {
				displayType = 'image';
			} else if (contentType === 'text/html') {
				displayType = 'webpage';
			} else if (contentType === 'text/markdown') {
				displayType = 'markdown';
			} else if (contentType === 'application/tx-result') {
				displayType = 'tx_result';
			}
			// ...
		}
	}
	$: if (isChoosing) {
		displayType = 'choice';
	}
</script>

<div class="{className} flex h-full w-full flex-col bg-white">
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<svelte:element
		this={collapsable ? 'button' : 'div'}
		class="{!collapsable || toolcall.expanded ? '' : 'rounded-b-lg'} {collapsable
			? 'transition-colors hover:bg-gray-50'
			: ''} flex items-center gap-4 rounded-t-lg border border-slate-200 px-5 py-3 text-sm text-slate-700 sm:gap-3"
		on:click
	>
		{#if finished}
			<span in:fade={{ duration: 300 }}>
				<Icon icon={feCheck} class="h-5 w-5 text-slate-700" />
			</span>
		{:else}
			<span in:fade={{ duration: 300 }}>
				<span class="animate-pulse">
					<svg
						class="mb-0.5 h-[18px] w-[18px] animate-spin text-slate-700"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 512 512"
						><!--!Font Awesome Free 6.6.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2024 Fonticons, Inc.--><path
							fill="currentColor"
							d="M288 39.1v16.7c0 10.8 7.3 20.2 17.7 23.1C383.2 100.4 440 171.5 440 256c0 101.7-82.3 184-184 184-101.7 0-184-82.3-184-184 0-84.5 56.8-155.6 134.3-177.2C216.7 75.9 224 66.5 224 55.7V39.1c0-15.7-14.8-27.2-30-23.2C86.6 43.5 7.4 141.2 8 257.3c.7 137.1 111.5 247 248.5 246.7C393.3 503.7 504 392.8 504 256c0-115.6-79.1-212.8-186.2-240.2C302.7 11.9 288 23.5 288 39.1z"
						/></svg
					>
				</span>
			</span>
		{/if}
		<code class="font-semibold tracking-tight">{toolcall.name}</code>
		<div class="-my-1.5 -mr-2 ml-auto flex items-center gap-2">
			{#if displayType !== null}
				<button
					on:click={(event) => {
						event.stopPropagation();
						displayTypeDisabled = !displayTypeDisabled;
					}}
					class="flex whitespace-nowrap rounded-full border border-slate-200 px-3 py-1 text-[10px] font-medium transition-colors hover:bg-gray-100 md:text-xs"
				>
					{#if displayTypeDisabled}
						View component
					{:else}
						View code
					{/if}
				</button>
			{/if}
			{#if collapsable}
				<Icon
					icon={feChevronDown}
					class="{toolcall.expanded
						? 'rotate-180'
						: ''} h-4 w-4 text-slate-700 transition-transform"
				/>
			{:else if closeButton}
				<button
					on:click={() => {
						dispatch('close');
					}}
					class="flex rounded-full p-3 transition-colors hover:bg-gray-100"
				>
					<Icon icon={feX} class="ml-auto h-4 w-4 text-slate-700" />
				</button>
			{/if}
		</div>
	</svelte:element>
	{#if !collapsable || toolcall.expanded}
		<div
			transition:slide={{ duration: 300 }}
			class="h-full max-h-[80vh] overflow-y-auto scrollbar-ultraslim"
		>
			{#if displayType === null || displayTypeDisabled}
				<div
					class="{toolresponse
						? 'border-b-0'
						: 'rounded-b-lg'} flex flex-col whitespace-pre-wrap border border-t-0 border-slate-200 bg-white px-4 py-3 font-mono text-sm text-slate-800 [overflow-wrap:anywhere]"
				>
					{#if typeof toolcall.arguments === 'object'}
						{#if Object.keys(toolcall.arguments).length === 1}
							{toolcall.arguments[Object.keys(toolcall.arguments)[0]]}
						{:else}
							<JsonView json={toolcall.arguments} />
						{/if}
					{:else if toolcall.arguments}
						{toolcall.arguments}
					{:else}
						<div class="h-3 w-3 shrink-0 animate-bounce rounded-full bg-slate-600" />
					{/if}
				</div>
				{#if toolresponse}
					<div class="h-px w-full border-t border-dashed border-slate-300" />
					<div class="flex flex-col rounded-b-lg border border-t-0 border-slate-200">
						<span class="px-4 pt-3 text-sm font-medium tracking-[0.01em] text-slate-700"
							>Result:</span
						>
						<div
							class="flex flex-col whitespace-pre-wrap rounded-[inherit] bg-white px-4 py-3 font-mono text-sm text-slate-800 [overflow-wrap:anywhere]"
						>
							{#if !toolresponse.content}
								<span class="italic">blank</span>
							{:else if typeof toolresponse.content === 'object'}
								<JsonView json={toolresponse.content} />
							{:else}
								{toolresponse.content}
							{/if}
						</div>
					</div>
				{/if}
			{:else if toolresponse && displayType === 'image'}
				<div class="flex flex-col rounded-b-lg border border-t-0 border-slate-200">
					<img src={displayedContent} alt="" class="w-full object-contain object-[0]" />
				</div>
			{:else if toolresponse && displayType === 'webpage'}
				<div class="flex h-full flex-col rounded-b-lg border border-t-0 border-slate-200">
					<iframe
						title="Webpage"
						srcdoc={displayedContent}
						class="h-full min-h-[50vh] w-full"
						frameborder="0"
						allowfullscreen
					/>
				</div>
			{:else if displayType === 'choice'}
				<div class="flex flex-col rounded-b-lg border border-t-0 border-slate-200 px-6 py-5">
					<Choice bind:chose {choiceHandler} {question} {choices} />
				</div>
			{:else if toolresponse && displayType === 'tx_result'}
				<div class="flex flex-col gap-3 rounded-b-lg border border-t-0 border-slate-200 px-5 py-4">
					<!-- Status badge + amount -->
					<div class="flex flex-wrap items-center gap-2">
						{#if displayedContent.status === 'success'}
							<span class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Confirmed</span>
						{:else if displayedContent.status === 'pending'}
							<span class="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">Pending</span>
						{:else}
							<span class="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">Failed</span>
						{/if}
						<span class="text-sm font-medium text-slate-700">{displayedContent.amount} {displayedContent.token}</span>
						<span class="text-xs text-slate-400">on {displayedContent.network}</span>
					</div>

					<!-- Addresses -->
					<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs text-slate-600">
						<span class="font-sans text-slate-400">From</span>
						<span class="break-all">{displayedContent.from?.slice(0, 6)}…{displayedContent.from?.slice(-4)}</span>
						<span class="font-sans text-slate-400">To</span>
						<span class="break-all">{displayedContent.to?.slice(0, 6)}…{displayedContent.to?.slice(-4)}</span>
					</div>

					<!-- Tx hash + explorer link -->
					<div class="flex items-center gap-2 font-mono text-xs text-slate-500">
						<span class="break-all">{displayedContent.txHash?.slice(0, 12)}…{displayedContent.txHash?.slice(-6)}</span>
						{#if displayedContent.explorerUrl}
							<a
								href={displayedContent.explorerUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="ml-auto whitespace-nowrap rounded border border-slate-200 px-2 py-0.5 font-sans text-[10px] text-slate-600 transition-colors hover:bg-slate-50"
							>
								View on Explorer ↗
							</a>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
