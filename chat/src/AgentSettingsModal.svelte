<script>
	import { activeAgent, params, toolSchema } from './stores.js';
	import Modal from './Modal.svelte';

	export let open = false;
	export let onSave = null;

	let draft = {};
	$: if (open && $activeAgent) {
		draft = {
			system_prompt: $activeAgent.system_prompt || '',
			greeting: $activeAgent.greeting || '',
			preferred_model: $activeAgent.preferred_model || null,
			temperature: $activeAgent.temperature ?? $params.temperature,
			maxTokens: $activeAgent.maxTokens ?? $params.maxTokens,
			tools: [...($activeAgent.tools || [])],
		};
	}

	$: allTools = ($toolSchema || []).flatMap((g) =>
		(g.schema || []).map((t) => ({ name: t.function.name, groupName: g.name }))
	);

	function toggleTool(name) {
		if (draft.tools.includes(name)) {
			draft.tools = draft.tools.filter((t) => t !== name);
		} else {
			draft.tools = [...draft.tools, name];
		}
	}

	async function save() {
		const updated = { ...$activeAgent, ...draft };
		activeAgent.set(updated);
		onSave?.(updated);
		if (updated.id && !updated.id.startsWith('lib:')) {
			try {
				await fetch(`/api/agents/${updated.id}`, {
					method: 'PATCH',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						system_prompt: updated.system_prompt,
						greeting: updated.greeting,
					}),
				});
			} catch {}
		}
		open = false;
	}
</script>

<Modal bind:open>
	<div class="flex flex-col gap-4 p-4 w-[480px] max-w-full">
		<h2 class="text-[15px] font-semibold text-slate-800">Agent Settings: {$activeAgent?.name}</h2>

		<label class="flex flex-col gap-1.5 text-[12px] font-medium text-slate-600">
			System Prompt
			<textarea
				bind:value={draft.system_prompt}
				rows="5"
				class="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 resize-y outline-none focus:border-indigo-400"
				placeholder="You are a helpful assistant..."
			/>
		</label>

		<label class="flex flex-col gap-1.5 text-[12px] font-medium text-slate-600">
			Opening Message
			<textarea
				bind:value={draft.greeting}
				rows="2"
				class="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 resize-y outline-none focus:border-indigo-400"
				placeholder="Hello! How can I help you today?"
			/>
		</label>

		<label class="flex flex-col gap-1.5 text-[12px] font-medium text-slate-600">
			Temperature
			<div class="flex items-center gap-2">
				<input
					type="range"
					min="0"
					max="2"
					step="0.1"
					bind:value={draft.temperature}
					class="flex-1 accent-indigo-500"
				/>
				<span class="text-[12px] text-slate-500 w-8 text-right">{draft.temperature}</span>
			</div>
		</label>

		<label class="flex flex-col gap-1.5 text-[12px] font-medium text-slate-600">
			Max Tokens (0 = unlimited)
			<input
				type="number"
				min="0"
				bind:value={draft.maxTokens}
				class="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-indigo-400 w-32"
			/>
		</label>

		{#if allTools.length > 0}
			<div class="flex flex-col gap-1.5">
				<p class="text-[12px] font-medium text-slate-600">Enabled Tools</p>
				<div class="flex flex-wrap gap-2">
					{#each allTools as tool}
						<label
							class="flex items-center gap-1.5 text-[12px] text-slate-700 cursor-pointer select-none"
						>
							<input
								type="checkbox"
								checked={draft.tools.includes(tool.name)}
								on:change={() => toggleTool(tool.name)}
								class="accent-indigo-500"
							/>
							{tool.name}
						</label>
					{/each}
				</div>
			</div>
		{/if}

		<div class="flex justify-end gap-2 pt-2">
			<button
				on:click={() => (open = false)}
				class="rounded-lg border border-slate-200 px-4 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
			>
				Cancel
			</button>
			<button
				on:click={save}
				class="rounded-lg bg-indigo-500 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-600"
			>
				Save
			</button>
		</div>
	</div>
</Modal>
