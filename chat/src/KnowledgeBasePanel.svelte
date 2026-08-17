<script>
	import { activeAgent, openaiAPIKey, notify } from './stores.js';
	import { ingestFile, getChunksForAgent, deleteChunksForFile } from './knowledge.js';

	export let db;

	let files = [];
	let uploading = false;
	let uploadProgress = { stage: '', done: 0, total: 0 };
	let fileInput;

	async function loadFiles() {
		if (!db || !$activeAgent) return;
		const chunks = await getChunksForAgent(db, $activeAgent.id);
		const byFile = {};
		for (const c of chunks) {
			byFile[c.filename] = (byFile[c.filename] || 0) + 1;
		}
		files = Object.entries(byFile).map(([filename, chunkCount]) => ({ filename, chunkCount }));
	}

	async function handleUpload(event) {
		const file = event.target.files?.[0];
		if (!file || !$activeAgent) return;
		if (!$openaiAPIKey) {
			notify('Add an OpenAI API key in Settings to use the knowledge base.', 'error');
			fileInput.value = '';
			return;
		}
		uploading = true;
		try {
			await ingestFile(db, $activeAgent.id, file, (stage, done, total) => {
				uploadProgress = { stage, done, total };
			});
			notify(`${file.name} ingested (${uploadProgress.total} chunks)`, 'success');
			await loadFiles();
		} catch (e) {
			notify(e.message, 'error');
		} finally {
			uploading = false;
			fileInput.value = '';
		}
	}

	async function removeFile(filename) {
		if (!db || !$activeAgent) return;
		await deleteChunksForFile(db, $activeAgent.id, filename);
		await loadFiles();
	}

	$: if (db && $activeAgent) loadFiles();
</script>

<div class="flex flex-col gap-3">
	<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Knowledge Base</p>

	{#if files.length === 0}
		<p class="text-[12px] text-slate-400">No files uploaded yet.</p>
	{:else}
		<ul class="flex flex-col gap-1.5">
			{#each files as f}
				<li class="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
					<div>
						<p class="text-[13px] text-slate-700">{f.filename}</p>
						<p class="text-[11px] text-slate-400">{f.chunkCount} chunks</p>
					</div>
					<button
						class="text-[12px] text-red-400 hover:text-red-600"
						on:click={() => removeFile(f.filename)}
					>Remove</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if uploading}
		<div class="text-[12px] text-slate-500">
			{uploadProgress.stage === 'done'
				? 'Saved!'
				: `${uploadProgress.stage}: ${uploadProgress.done}/${uploadProgress.total} chunks…`}
		</div>
	{:else}
		<label class="cursor-pointer rounded-lg border border-dashed border-slate-300 px-4 py-3 text-center text-[12px] text-slate-500 hover:border-indigo-400 hover:text-indigo-500 transition">
			Upload .txt or .md file
			<input
				bind:this={fileInput}
				type="file"
				accept=".txt,.md"
				class="hidden"
				on:change={handleUpload}
			/>
		</label>
	{/if}
</div>
