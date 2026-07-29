<script lang="ts">
	import type { Tokens } from 'marked';
	import type { MarkdownOptions, Renderers } from '$src/svelte-marked';
	import { parseXML } from '$src/widgets.js';
	import ArtifactButton from '$src/ArtifactButton.svelte';

	export let token: Tokens.HTML;
	export const options: MarkdownOptions = undefined;
	export const renderers: Renderers = undefined;
	export let message;

	$: xml = parseXML(token.text);
</script>

{#if xml.element === 'artifact' && message?.role === 'assistant'}
	<ArtifactButton {xml} />
{:else}
	<span class="{token.block ? 'block' : 'inline'} whitespace-pre-wrap [overflow-wrap:anywhere]"
		>{token.text}</span
	>
{/if}
