<script>
	import { createEventDispatcher } from 'svelte';
	import { localAgentId, activeAgent, agentLibraryUrl } from './stores.js';
	import { focusOnMount } from './actions.js';
	import { t } from './i18n.js';

	const dispatch = createEventDispatcher();

	let query = '';
	let myAgents = [];
	let marketAgents = [];
	let libraryAgents = [];
	let loadingMine = false;
	let loadingMarket = false;
	let loadingLibrary = false;
	let debounceTimer;

	// Marketplace filter/pagination state
	let marketSort = 'popular';
	let marketCategory = '';
	let marketCursor = null;
	let marketHasMore = false;
	let marketError = false;

	// Detail preview state
	let previewAgent = null;
	let previewLoading = false;

	// Library pagination + error state
	let libraryLimit = 60;
	let libraryError = false;

	// Normalizes a pai-chat / lobehub library agent (index entry) into the local agent shape.
	function normalizeLibraryAgent(item) {
		const m = item.meta || {};
		const avatar = m.avatar || '';
		const isUrl = typeof avatar === 'string' && /^https?:\/\//.test(avatar);
		return {
			id: `lib:${item.identifier}`,
			identifier: item.identifier,
			name: m.title || item.identifier,
			description: m.description || '',
			thumbnail_url: isUrl ? avatar : null,
			avatar_emoji: isUrl ? null : avatar,
			tags: m.tags || [],
			category: m.category || '',
			source: 'library',
		};
	}

	async function loadLibrary() {
		loadingLibrary = true;
		libraryError = false;
		try {
			const base = $agentLibraryUrl?.replace(/\/+$/, '') || '';
			if (!base) { libraryError = true; return; }
			const res = await fetch(`${base}/index.en-US.json`);
			if (res.ok) {
				const json = await res.json();
				libraryAgents = (json.agents || []).map(normalizeLibraryAgent);
			} else {
				libraryError = true;
			}
		} catch {
			libraryError = true;
		}
		loadingLibrary = false;
	}

	function inferProvider(modelId) {
		if (!modelId) return 'OpenRouter';
		if (modelId.startsWith('claude')) return 'Anthropic';
		if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) return 'OpenAI';
		return 'OpenRouter';
	}

	async function loadLibraryAgentDetail(agent) {
		const base = $agentLibraryUrl?.replace(/\/+$/, '') || '';
		const res = await fetch(`${base}/${agent.identifier}.json`);
		if (!res.ok) return agent;
		const data = await res.json();
		const cfg = data.config || {};
		const preferred_model = cfg.model
			? { id: cfg.model, name: cfg.model, provider: inferProvider(cfg.model) }
			: null;
		return {
			...agent,
			system_prompt: cfg.systemRole || '',
			greeting: cfg.openingMessage || '',
			preferred_model,
			params: cfg.params || null,
		};
	}

	async function searchMarket(q, reset = true) {
		loadingMarket = true;
		marketError = false;
		if (reset) { marketCursor = null; marketAgents = []; }
		try {
			const p = new URLSearchParams();
			if (q) p.set('q', q);
			if (marketSort) p.set('sort', marketSort);
			if (marketCategory) p.set('category', marketCategory);
			if (!reset && marketCursor) p.set('cursor', marketCursor);
			const res = await fetch(`/api/marketplace/agents?${p}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			const items = json.data?.items ?? [];
			marketAgents = reset ? items : [...marketAgents, ...items];
			marketCursor = json.data?.next_cursor ?? null;
			marketHasMore = !!marketCursor;
		} catch {
			marketError = true;
		}
		loadingMarket = false;
	}

	async function loadMine() {
		loadingMine = true;
		try {
			const res = await fetch('/api/agents', { credentials: 'include' });
			if (res.ok) {
				const json = await res.json();
				myAgents = json.agents ?? [];
			}
		} catch {}
		loadingMine = false;
	}

	$: filteredMine = query
		? myAgents.filter((a) =>
				(a.name || '').toLowerCase().includes(query.toLowerCase()) ||
				(a.description || '').toLowerCase().includes(query.toLowerCase()),
		  )
		: myAgents;

	$: filteredLibrary = (query
		? libraryAgents.filter((a) => {
				const q = query.toLowerCase();
				return (
					(a.name || '').toLowerCase().includes(q) ||
					(a.description || '').toLowerCase().includes(q) ||
					(a.tags || []).some((t) => String(t).toLowerCase().includes(q)) ||
					(a.category || '').toLowerCase().includes(q)
				);
		  })
		: libraryAgents
	).slice(0, libraryLimit);

	function onInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => searchMarket(query, true), 300);
	}

	function setMarketSort(s) { marketSort = s; searchMarket(query, true); }
	function setMarketCategory(c) { marketCategory = c === marketCategory ? '' : c; searchMarket(query, true); }
	function loadMoreMarket() { searchMarket(query, false); }
	function loadMoreLibrary() { libraryLimit += 60; }

	async function openPreview(agent) {
		previewAgent = agent;
		previewLoading = true;
		try {
			const urls = [
				`/api/agents/${agent.id}`,
				`/api/marketplace/agents/${agent.id}`,
			];
			for (const url of urls) {
				try {
					const res = await fetch(url, { credentials: 'include' });
					if (res.ok) {
						const json = await res.json();
						previewAgent = json.agent ?? json.data?.agent ?? agent;
						break;
					}
				} catch {}
			}
		} finally {
			previewLoading = false;
		}
	}

	async function pick(agent) {
		if (agent.source === 'library') {
			const detail = await loadLibraryAgentDetail(agent);
			localAgentId.set(detail.id);
			activeAgent.set(detail);
			dispatch('pick', detail);
			return;
		}
		try {
			const res = await fetch(`/api/agents/${agent.id}`, { credentials: 'include' });
			if (res.ok) {
				const json = await res.json();
				const detail = json.agent ?? json.data?.agent ?? agent;
				localAgentId.set(detail.id);
				activeAgent.set(detail);
				dispatch('pick', detail);
				return;
			}
		} catch {}
		try {
			const res = await fetch(`/api/marketplace/agents/${agent.id}`);
			if (res.ok) {
				const json = await res.json();
				const detail = json.data?.agent ?? agent;
				localAgentId.set(detail.id);
				activeAgent.set(detail);
				dispatch('pick', detail);
				return;
			}
		} catch {}
		localAgentId.set(agent.id);
		activeAgent.set(agent);
		dispatch('pick', agent);
	}

	function clear() {
		localAgentId.set('');
		activeAgent.set(null);
		dispatch('pick', null);
	}

	function initials(name) {
		return name?.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
	}

	const COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444'];
	function color(id) {
		let h = 0;
		for (let i = 0; i < (id?.length ?? 0); i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
		return COLORS[h % COLORS.length];
	}

	loadMine();
	searchMarket('');
	loadLibrary();
</script>

<div class="flex flex-col gap-3 p-1">
	<input
		type="text"
		bind:value={query}
		on:input={onInput}
		placeholder={$t('searchAgents')}
		class="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-indigo-400"
		use:focusOnMount
	/>

	<div class="flex items-center justify-between">
		{#if $localAgentId}
			<button
				class="text-left text-[12px] text-slate-400 underline hover:text-slate-600"
				on:click={clear}
			>{$t('removeAgent')}</button>
		{:else}
			<span></span>
		{/if}
		<a
			href="/dashboard"
			class="text-[12px] text-indigo-500 hover:text-indigo-700"
			target="_blank"
			rel="noopener"
		>{$t('createAgent')}</a>
	</div>

	<div class="max-h-[28rem] overflow-y-auto pr-0.5 flex flex-col gap-3">
		<!-- My Agents -->
		<div>
			<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{$t('myAgents')}</p>
			{#if loadingMine}
				<p class="text-center text-[12px] text-slate-400 py-3">{$t('loading')}</p>
			{:else if filteredMine.length === 0}
				<p class="text-[12px] text-slate-400 py-2">
					{query ? 'No matches in your agents' : 'You haven\'t created any agents yet.'}
				</p>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					{#each filteredMine as agent}
						<button
							class="flex flex-col items-center gap-1.5 rounded-xl p-2 text-center transition hover:bg-gray-50
								{$localAgentId === agent.id ? 'bg-indigo-50 ring-2 ring-indigo-300' : 'ring-1 ring-gray-100'}"
							on:click={() => pick(agent)}
							title={agent.description || agent.name}
						>
							{#if agent.thumbnail_url}
								<img
									src={agent.thumbnail_url}
									alt={agent.name}
									class="h-14 w-14 rounded-lg object-cover"
									loading="lazy"
								/>
							{:else}
								<div
									class="flex h-14 w-14 items-center justify-center rounded-lg text-[14px] font-bold text-white"
									style="background:{color(agent.id)}"
								>{initials(agent.name)}</div>
							{/if}
							<p class="w-full truncate text-[11px] font-medium text-slate-700 leading-tight">{agent.name}</p>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Marketplace -->
		<div>
			<div class="flex items-center justify-between mb-1.5">
				<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{$t('marketplace')}</p>
				<div class="flex items-center gap-1.5">
					<select
						class="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-slate-600 outline-none"
						bind:value={marketSort}
						on:change={() => searchMarket(query, true)}
					>
						<option value="popular">Popular</option>
						<option value="recent">Recent</option>
						<option value="name">A-Z</option>
					</select>
				</div>
			</div>

			{#if loadingMarket && marketAgents.length === 0}
				<p class="text-center text-[12px] text-slate-400 py-3">{$t('loading')}</p>
			{:else if marketError}
				<p class="text-[12px] text-slate-400 py-2">
					Failed to load. <button class="underline" on:click={() => searchMarket(query, true)}>retry</button>
				</p>
			{:else if marketAgents.length === 0}
				<p class="text-[12px] text-slate-400 py-2">{$t('noAgentsFound')}</p>
			{:else if previewAgent}
				<!-- Detail preview panel -->
				<div class="rounded-xl border border-gray-100 bg-gray-50 p-3">
					<button class="mb-2 text-[11px] text-slate-400 hover:text-slate-600" on:click={() => previewAgent = null}>
						← Back
					</button>
					<div class="flex items-start gap-3">
						{#if previewAgent.thumbnail_url}
							<img src={previewAgent.thumbnail_url} alt={previewAgent.name} class="h-16 w-16 rounded-xl object-cover shrink-0" />
						{:else}
							<div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl text-[18px] font-bold text-white" style="background:{color(previewAgent.id)}">{initials(previewAgent.name)}</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="text-[13px] font-semibold text-slate-800 leading-tight">{previewAgent.name}</p>
							{#if previewAgent.category}
								<p class="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{previewAgent.category}</p>
							{/if}
							<p class="mt-1 text-[12px] text-slate-600 leading-snug line-clamp-3">{previewAgent.description || ''}</p>
							{#if previewAgent.tags?.length}
								<div class="mt-1.5 flex flex-wrap gap-1">
									{#each previewAgent.tags.slice(0, 4) as tag}
										<span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{tag}</span>
									{/each}
								</div>
							{/if}
						</div>
					</div>
					{#if previewLoading}
						<p class="mt-2 text-[11px] text-slate-400 animate-pulse">Loading details…</p>
					{/if}
					<button
						class="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-indigo-700"
						on:click={() => pick(previewAgent)}
					>
						Use this agent
					</button>
				</div>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					{#each marketAgents as agent}
						<button
							class="flex flex-col items-center gap-1.5 rounded-xl p-2 text-center transition hover:bg-gray-50
								{$localAgentId === agent.id ? 'bg-indigo-50 ring-2 ring-indigo-300' : 'ring-1 ring-gray-100'}"
							on:click={() => openPreview(agent)}
							title={agent.description || agent.name}
						>
							{#if agent.thumbnail_url}
								<img src={agent.thumbnail_url} alt={agent.name} class="h-14 w-14 rounded-lg object-cover" loading="lazy" />
							{:else}
								<div class="flex h-14 w-14 items-center justify-center rounded-lg text-[14px] font-bold text-white" style="background:{color(agent.id)}">{initials(agent.name)}</div>
							{/if}
							<p class="w-full truncate text-[11px] font-medium text-slate-700 leading-tight">{agent.name}</p>
						</button>
					{/each}
				</div>
				{#if marketHasMore}
					<button
						class="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-[12px] text-slate-500 hover:bg-gray-50"
						disabled={loadingMarket}
						on:click={loadMoreMarket}
					>
						{loadingMarket ? 'Loading…' : 'Load more'}
					</button>
				{/if}
			{/if}
		</div>

		<!-- Public Library (LobeHub-compatible JSON index) -->
		<div>
			<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">{$t('publicLibrary')}</p>
			{#if loadingLibrary}
				<p class="text-center text-[12px] text-slate-400 py-3">{$t('loading')}</p>
			{:else if filteredLibrary.length === 0}
				<p class="text-[12px] text-slate-400 py-2">
					{libraryError ? 'Library unavailable' : query ? 'No matches in library' : 'No agents'}
				</p>
			{:else}
				<div class="grid grid-cols-3 gap-2">
					{#each filteredLibrary as agent}
						<button
							class="flex flex-col items-center gap-1.5 rounded-xl p-2 text-center transition hover:bg-gray-50
								{$localAgentId === agent.id ? 'bg-indigo-50 ring-2 ring-indigo-300' : 'ring-1 ring-gray-100'}"
							on:click={() => pick(agent)}
							title={agent.description || agent.name}
						>
							{#if agent.thumbnail_url}
								<img
									src={agent.thumbnail_url}
									alt={agent.name}
									class="h-14 w-14 rounded-lg object-cover"
									loading="lazy"
								/>
							{:else if agent.avatar_emoji}
								<div class="flex h-14 w-14 items-center justify-center rounded-lg bg-slate-50 text-[28px]">{agent.avatar_emoji}</div>
							{:else}
								<div
									class="flex h-14 w-14 items-center justify-center rounded-lg text-[14px] font-bold text-white"
									style="background:{color(agent.id)}"
								>{initials(agent.name)}</div>
							{/if}
							<p class="w-full truncate text-[11px] font-medium text-slate-700 leading-tight">{agent.name}</p>
						</button>
					{/each}
				</div>
				{#if !query && libraryAgents.length > filteredLibrary.length}
					<button
						class="mt-1.5 w-full rounded-lg border border-slate-200 py-1.5 text-[12px] text-slate-500 hover:bg-gray-50"
						on:click={loadMoreLibrary}
					>
						Show more ({libraryAgents.length - filteredLibrary.length} hidden)
					</button>
				{/if}
			{/if}
		</div>
	</div>
</div>
