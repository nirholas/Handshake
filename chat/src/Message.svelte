<script context="module">
	// Remembered position (in scroll-content space, so it's scroll-independent) of
	// the avatar slot the agent last stood in. When a new assistant message mounts
	// its own <agent-3d>, we use this to walk the avatar down from where it was to
	// the new slot instead of having it pop into place. Module-scoped so it
	// survives the per-message remount of the avatar.
	let prevAgentSlotY = null;
	const WALK_IN_MS = 820;
</script>

<script>
	import { createEventDispatcher, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { v4 as uuidv4 } from 'uuid';
	import Button from './Button.svelte';
	import {
		feCheck,
		feCheckCircle,
		feChevronDown,
		feChevronLeft,
		feChevronRight,
		feCopy,
		feCpu,
		feEdit2,
		feTerminal,
		feMoreHorizontal,
		feStar,
		feRefreshCw,
		feUser,
		feX,
		feChevronUp,
	} from './feather';
	import Icon from './Icon.svelte';
	import MessageContent from './MessageContent.svelte';
	import { formatModelName, hasCompanyLogo } from './providers.js';
	import { config, talkingHeadAvatarUrl, localAgentId, brandConfig } from './stores.js';
	import { detectEmotion } from './sentiment.js';
	import Toolcall from './Toolcall.svelte';
	import ToolcallButton from './ToolcallButton.svelte';
	import ModelViewer3D from './ModelViewer3D.svelte';

	const dispatch = createEventDispatcher();

	let agentEl;
	let agentSlotEl;
	let agentWalkedIn = false;
	let lastReactedToUserId = null;

	// Position of the avatar slot within the scroll container's content, immune to
	// scrolling so the walk distance between two messages stays correct.
	function slotContentY(slot) {
		const scroller = slot.closest('.scrollable');
		if (!scroller) return null;
		return slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
	}

	// Walk the avatar down from the previous message's slot into this one. The slot
	// stays hidden until the agent's GLB is ready, then it appears at the old
	// position and glides to its resting spot while the walk clip plays — so the
	// agent looks like it strolled to the new message rather than teleporting.
	function walkAgentIntoPlace(slot, el) {
		if (!slot || !el) return;
		const y = slotContentY(slot);
		if (y == null) { slot.style.opacity = '1'; return; }
		const from = prevAgentSlotY;
		prevAgentSlotY = y;

		const dy = from == null ? 0 : from - y;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!dy || reduced) {
			slot.style.opacity = '1';
			return;
		}

		try { el.play?.('walk', { loop: true }); } catch {}
		slot.style.transition = 'none';
		slot.style.transform = `translateY(${dy}px)`;
		slot.style.zIndex = '40';
		slot.style.opacity = '1';
		void slot.offsetHeight; // flush the starting position before animating
		slot.style.transition = `transform ${WALK_IN_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
		slot.style.transform = 'translateY(0)';

		const done = (ev) => {
			if (ev && ev.propertyName !== 'transform') return;
			slot.removeEventListener('transitionend', done);
			slot.style.transition = '';
			slot.style.transform = '';
			slot.style.zIndex = '';
			if (!generating) { try { el.play?.('idle', { loop: true }); } catch {} }
		};
		slot.addEventListener('transitionend', done);
		setTimeout(() => done(), WALK_IN_MS + 120); // safety net if transitionend is missed
	}

	$: if (agentEl && agentSlotEl && !agentWalkedIn) {
		agentWalkedIn = true;
		const slot = agentSlotEl;
		const run = () => walkAgentIntoPlace(slot, agentEl);
		if (agentEl._mounted) run();
		else agentEl.addEventListener('agent:ready', run, { once: true });
		// Never leave the slot stuck invisible if the avatar fails to load.
		setTimeout(() => { if (slot && slot.style.opacity === '0') slot.style.opacity = '1'; }, 6000);
	}

	function faceCamera(el) {
		const apply = () => {
			const content = el?._viewer?.content;
			if (!content) return;
			content.rotation.y = Math.PI;
			el._viewer.invalidate?.();
		};
		if (el?._viewer?.content) apply();
		else el?.addEventListener('agent:ready', apply, { once: true });
	}

	function reactToUserSentiment(el, userMessage) {
		if (!el || !userMessage?.id || !userMessage.content) return;
		if (lastReactedToUserId === userMessage.id) return;
		const sentiment = detectEmotion(userMessage.content);
		if (!sentiment) {
			lastReactedToUserId = userMessage.id;
			return;
		}
		const fire = () => {
			try { el.expressEmotion?.(sentiment.emotion, sentiment.weight); } catch {}
			try { el._scene?.playAnimationByHint?.(sentiment.emotion); } catch {}
		};
		if (el._mounted) fire();
		else el.addEventListener('agent:ready', fire, { once: true });
		lastReactedToUserId = userMessage.id;
	}

	$: if (agentEl) faceCamera(agentEl);
	$: if (agentEl && convo?.messages?.length) {
		const last = convo.messages[i];
		const isLatest = last?.role === 'assistant'
			&& i === convo.messages.findLastIndex((m) => m.role === 'assistant');
		if (isLatest) {
			const prior = [...convo.messages.slice(0, i)].reverse().find((m) => m.role === 'user');
			if (prior) reactToUserSentiment(agentEl, prior);
		}
	}

	function msgTransition(node, { style }) {
		if (style === 'snap') return { duration: 0 };
		if (style === 'elegant') return fly(node, { y: 6, duration: 180, easing: cubicOut });
		return fly(node, { y: 14, duration: 380, easing: cubicOut });
	}


	export let message;
	export let i;
	export let convo;
	export let generating;
	export let collapsedRanges;

	export let saveMessage;
	export let deleteMessage;
	export let saveVersion;
	export let saveConversation;
	export let shiftVersion;
	export let insertSystemPrompt;
	export let submitCompletion;
	export let isChoosing;
	export let choiceHandler;
	export let question;
	export let choices;

	export let chose;
	export let activeToolcall;
	export let textareaEls;

	// Tool responses carrying a 3D model envelope, rendered inline in the thread
	// (in addition to the clickable pill that opens the full tool view).
	function model3dResponses(msg) {
		if (!msg.toolcalls?.length) return [];
		const out = [];
		for (const toolcall of msg.toolcalls) {
			const resp = convo.messages.find((m) => m.toolcallId === toolcall.id);
			const c = resp?.content;
			if (c?.contentType === 'application/model-3d' && c.content) out.push({ toolcall, resp });
		}
		return out;
	}

	// Once a pending generation resolves, persist the GLB URL into the stored
	// tool message so reloading the conversation renders the model directly
	// instead of re-polling the job.
	function persistResolvedModel(resp, glbUrl) {
		resp.content.content.glb = glbUrl;
		resp.content.content.job = null;
		saveMessage(resp);
	}

	const GLB_URL_RE = /https?:\/\/[^\s"'<>()[\]]+\.glb(?:\?[^\s"'<>()[\]]*)?/gi;

	// GLB links written straight into a message get an inline viewer too, unless
	// the same model already renders from a tool card in this conversation.
	function messageGlbUrls(msg) {
		if (msg.role !== 'assistant' && msg.role !== 'user') return [];
		if (typeof msg.content !== 'string' || !msg.content.toLowerCase().includes('.glb')) return [];
		const found = [...new Set(msg.content.match(GLB_URL_RE) || [])];
		if (!found.length) return [];
		const rendered = new Set();
		for (const m of convo.messages) {
			const c = m.role === 'tool' ? m.content : null;
			if (c?.contentType === 'application/model-3d' && c.content?.glb) rendered.add(c.content.glb);
		}
		return found.filter((u) => !rendered.has(u)).slice(0, 2);
	}

	function initials(name) {
		return name?.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
	}

	const COLORS = ['#818CF8','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444'];
	function color(id) {
		let h = 0;
		for (let i = 0; i < (id?.length ?? 0); i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
		return COLORS[h % COLORS.length];
	}

	function submitEdit(i) {
		// Update the ID of the edited message:
		if (convo.messages[i].submitted || convo.messages[i].generated) {
			let vid = null;
			const msgBeforeEdit = { ...convo.messages[i] };
			msgBeforeEdit.editing = false;
			msgBeforeEdit.pendingContent = '';
			if (!msgBeforeEdit.vid) {
				vid = uuidv4();
				msgBeforeEdit.vid = vid;
			}
			saveMessage(msgBeforeEdit);

			saveVersion(msgBeforeEdit, i);

			convo.messages[i].id = uuidv4();
			if (!convo.messages[i].vid) {
				convo.messages[i].vid = vid;
			}
			convo.messages[i].editing = false;
			convo.messages[i].content = convo.messages[i].pendingContent;
			convo.messages[i].pendingContent = '';
			saveMessage(convo.messages[i]);
		}

		convo.messages = convo.messages.slice(0, i + 1);
		saveConversation(convo);

		submitCompletion();
	}

	// Sequences of tool calls which are not interrupted by messages also containing text content will be displayed on the same line.
	function collapsedToolcalls(collapsedRange, collapsedMessages, ci, message) {
		if (ci < collapsedMessages.length - 1) {
			// Don't show duplicated toolcalls if these toolcalls will
			// be collapsed into a single line in a later message.
			const nextMessage = collapsedMessages[ci + 1];
			if (nextMessage.role === 'assistant' && nextMessage.toolcalls && !nextMessage.content) {
				return [];
			}
		}

		const i = convo.messages.findIndex((m) => m.id === message.id);

		// Starting from the message `i`, and going backwards, collect all `.toolcalls` until
		// we are interrupted by a message that contains `.content`, or we reach `collapsedRange.starti`
		const toolcalls = [];
		for (let j = i; j >= collapsedRange.starti; j--) {
			const msgIter = convo.messages[j];
			if (msgIter.role === 'assistant' && msgIter.toolcalls) {
				toolcalls.push(msgIter.toolcalls);
			}
			if (msgIter.role === 'assistant' && msgIter.content) {
				break;
			}
		}
		return toolcalls.reverse().flat();
	}

	let contentHeight;
	let copied = false;
	async function copyContent() {
		await navigator.clipboard.writeText(message.content || '');
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

{#if (['user', 'assistant'].includes(message.role) || (message.role === 'system' && (!message.customInstructions || (message.customInstructions && message.showCustomInstructions)))) && ($config.explicitToolView || !collapsedRanges.some((r) => i >= r.starti && i < r.endi))}
	{@const effectiveAgentId = $localAgentId || $brandConfig?.agent_id || ''}
	{@const hasLogo = message.role === 'assistant'}
	{@const isLatestAssistant = message.role === 'assistant' && i === convo.messages.findLastIndex((m) => m.role === 'assistant')}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
	<li
		data-role={message.role}
		in:msgTransition={{ style: $config.messageAnimation ?? 'smooth' }}
		class="group relative flex {message.role === 'user' ? 'justify-end' : 'justify-start'} pt-4 pb-10"
		style="z-index: {convo.messages.length - i};"
		on:touchstart={(event) => {
			// Make click trigger hover on mobile:
			event.target.dispatchEvent(new MouseEvent('mouseenter'));
		}}
	>
		{#if i === 0 && message.role !== 'system'}
			<Button
				variant="outline"
				class="absolute left-1/2 top-0 z-[98] -translate-x-1/2 border-dashed text-xs opacity-0 transition-[border-color,opacity] group-hover:opacity-100"
				on:click={insertSystemPrompt}
			>
				<Icon icon={feTerminal} class="mr-2 h-3 w-3 text-slate-600" />
				Add system prompt
			</Button>
		{:else if i === 1 && convo.messages[i - 1].role === 'system' && convo.messages[i - 1].customInstructions && !convo.messages[i - 1].showCustomInstructions}
			<Button
				variant="outline"
				class="absolute left-1/2 top-0 z-[98] -translate-x-1/2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
				on:click={() => {
					convo.messages[i - 1].showCustomInstructions = true;
					saveMessage(convo.messages[i - 1]);
				}}
			>
				<Icon icon={feEdit2} class="mr-2 h-3 w-3 text-slate-600" />
				Custom instructions
			</Button>
		{/if}
		<div
			class="{message.role === 'user'
				? 'bg-paper-deep text-ink rounded-2xl px-4 py-3 max-w-[78%] relative'
				: hasLogo && isLatestAssistant
					? 'relative flex w-full gap-x-3.5 items-center'
					: 'relative flex w-full gap-x-3.5 items-end'}"
		>
			{#if message.role !== 'user'}
			<div class="relative shrink-0 flex flex-col items-center">
			{#if message.role === 'assistant' && hasLogo && isLatestAssistant}
				<!-- Thought bubble while thinking -->
				{#if message.thinking && message.thoughts}
					<div class="avatar-bubble avatar-bubble--thinking mb-2">
						<div class="line-clamp-4 italic text-slate-500">{message.thoughts}</div>
						<span class="avatar-bubble-tail"></span>
					</div>
				<!-- Chat bubble while streaming response -->
				{:else if generating && message.content}
					<div class="avatar-bubble mb-2">
						<div class="line-clamp-4">{message.content}</div>
						<span class="avatar-bubble-tail"></span>
					</div>
				{/if}
			{/if}
			<button
				disabled={message.role === 'system' || (message.role === 'assistant' && hasLogo && isLatestAssistant)}
				on:click={() => {
					if (message.role === 'assistant' && hasLogo && isLatestAssistant) return;
					if (message.role === 'user') {
						message.role = 'assistant';
					} else {
						message.role = 'user';
					}
				}}
				class="shrink-0 rounded-md md:rounded-[6px] {message.role === 'assistant' && hasLogo && isLatestAssistant
					? 'flex w-[132px] h-[224px]'
					: 'flex h-8 w-8 md:h-9 md:w-9'}"
			>
				{#if message.role === 'assistant' && hasLogo && isLatestAssistant}
					<!-- The figure is framed with ~30% headroom; render the canvas taller than
					     its window and pull it up so the empty headroom is cropped, keeping the
					     figure large without the avatar floating in dead space. -->
					<span bind:this={agentSlotEl} class="w-full h-full overflow-hidden inline-block shrink-0 rounded-[inherit] will-change-transform" style="opacity:0;">
						<!-- svelte-ignore custom-element-no-implicit-ns -->
						<agent-3d
							bind:this={agentEl}
							{...($talkingHeadAvatarUrl
								? { src: $talkingHeadAvatarUrl }
								: message.agent?.id
									? { 'agent-id': message.agent.id }
									: { src: '/avatars/cz.glb' })}
							mode="inline"
							width="132"
							height="280"
							background="transparent"
							kiosk
							name-plate="off"
							style="width:132px;height:280px;display:block;margin-top:-46px;"
						></agent-3d>
					</span>
				{:else}
					{#if message.role === 'assistant'}
						{#if message.agent?.thumbnail_url}
							<img src={message.agent.thumbnail_url} alt={message.agent.name} class="w-full h-full object-cover rounded-md md:rounded-[6px]" />
						{:else if message.agent}
							<div class="flex h-full w-full items-center justify-center rounded-md md:rounded-[6px] text-xs font-bold text-white" style="background:{color(message.agent.id)}">
								{initials(message.agent.name)}
							</div>
						{:else}
							<span class="m-auto">
								<Icon icon={feCpu} class="h-4 w-4 text-slate-800" />
							</span>
						{/if}
					{:else if message.role === 'system'}
						<span class="m-auto">
							<Icon icon={feTerminal} class="h-4 w-4 text-slate-800" />
						</span>
					{:else}
						<span class="m-auto">
							<Icon icon={feUser} class="h-4 w-4 text-slate-800" />
						</span>
					{/if}
				{/if}
			</button>
			</div>
			{/if}

			<!-- svelte-ignore a11y-no-static-element-interactions -->
			{#if message.editing}
				<textarea
					bind:this={textareaEls[i]}
					class="w-full resize-none border-none bg-transparent p-0 leading-[28px] text-slate-800 outline-none focus:ring-0"
					rows={1}
					bind:value={message.pendingContent}
					on:keydown={(event) => {
						if (
							event.key === 'Enter' &&
							!event.shiftKey &&
							message.role === 'user' &&
							message.submitted &&
							message.pendingContent &&
							message.content !== message.pendingContent
						) {
							event.preventDefault();
							submitEdit(i);
							event.target.blur();
						}
					}}
					on:input={(event) => {
						// Resize textarea as content grows:
						event.target.style.height = 'auto';
						event.target.style.height = event.target.scrollHeight + 'px';
					}}
				/>
			{:else}
				<div class="flex w-full flex-col gap-6">
					{#if !$config.explicitToolView}
						{@const collapsedRange = collapsedRanges.find((r) => i === r.endi)}
						{#if collapsedRange}
							{@const collapsedMessages = convo.messages
								.slice(collapsedRange.starti, collapsedRange.endi)
								.filter((m) => m.role === 'assistant')}
							{#if collapsedMessages.length > 0}
								{#each collapsedMessages as message, ci}
									{@const toolcallsOnLine = collapsedToolcalls(
										collapsedRange,
										collapsedMessages,
										ci,
										message
									)}

									<MessageContent {message} />

									{#if toolcallsOnLine?.length > 0}
										<div class="-mb-1 flex flex-wrap gap-3 [&:first-child]:mt-1">
											{#each toolcallsOnLine as toolcall, ti}
												{@const toolresponse = convo.messages.find(
													(msg) => msg.toolcallId === toolcall.id
												)}
												<ToolcallButton
													{toolcall}
													{toolresponse}
													active={toolcall.id === activeToolcall?.id}
													on:click={() => {
														activeToolcall = toolcall;
													}}
												/>
											{/each}
										</div>
										{#each model3dResponses(message).filter((p) => toolcallsOnLine.includes(p.toolcall)) as pair (pair.toolcall.id)}
											<ModelViewer3D
												content={pair.resp.content.content}
												on:resolved={(e) => persistResolvedModel(pair.resp, e.detail.glb_url)}
											/>
										{/each}
									{/if}
								{/each}
							{/if}
						{/if}
					{/if}

					{#if message.websearch || message.reasoning}
						<div class="-mb-3 flex flex-col gap-2">
							{#if message.websearch}
								<div
									class="{generating
										? 'animate-pulse'
										: ''} flex items-center gap-x-1.5 self-start rounded-full bg-paper-deep px-3.5 py-2 text-left text-xs text-ink-faint transition-colors hover:bg-paper-deep"
								>
									{generating ? 'Searching' : 'Searched'} the web
								</div>
							{/if}
							{#if message.reasoning}
								<button
									class="{message.thinking
										? 'animate-pulse'
										: ''} flex items-center gap-x-1.5 self-start rounded-full bg-paper-deep px-3.5 py-2 text-left text-xs text-ink-faint transition-colors hover:bg-paper-deep"
									on:click={() => {
										message.thoughtsExpanded = !message.thoughtsExpanded;
										saveMessage(message);
									}}
								>
									{message.thinking ? 'Thinking' : 'Thought'} for {message.thinkingTime < 1
										? 'a bit'
										: ((s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s} seconds`))(
												Math.ceil(message.thinkingTime)
											)}
									{#if message.thoughts}
										<Icon
											icon={feChevronDown}
											class="{message.thoughtsExpanded
												? 'rotate-180'
												: ''} h-4 w-4 text-ink-faint transition-transform"
										/>
									{/if}
								</button>
								{#if message.thoughtsExpanded && message.thoughts}
									<div
										class="{contentHeight > 400
											? 'relative'
											: ''} mb-3 mt-2 border-l border-gray-200 pl-6"
									>
										<MessageContent
											message={{ content: message.thoughts }}
											bind:contentHeight
										/>
										{#if contentHeight > 400}
											<button
												class="sticky z-10 bottom-2 left-1/2 flex translate-x-[calc(-50%+40px)] items-center gap-x-1.5 self-start rounded-full bg-paper-deep px-3.5 py-2 text-left text-xs text-ink-faint transition-colors hover:bg-paper-deep"
												on:click={() => {
													message.thoughtsExpanded = !message.thoughtsExpanded;
													saveMessage(message);
												}}
											>
												<Icon icon={feChevronUp} class="h-4 w-4 transition-transform" /> Collapse thoughts
											</button>
										{/if}
									</div>
								{/if}
							{/if}
						</div>
					{/if}

					{#if generating && message.role === 'assistant' && i === convo.messages.length - 1 && message.content === '' && !message.toolcalls}
						<div class="mt-2 h-3 w-3 shrink-0 animate-bounce rounded-full bg-slate-600" />
					{/if}

					<MessageContent {message} />

					{#each messageGlbUrls(message) as glbSrc (glbSrc)}
						<ModelViewer3D content={{ glb: glbSrc }} height={300} />
					{/each}

					{#if !$config.explicitToolView && message.toolcalls?.length > 0}
						<div class="-mb-1 flex flex-wrap gap-3 [&:first-child]:mt-1">
							{#each message.toolcalls as toolcall, ti}
								{@const toolresponse = convo.messages.find((msg) => msg.toolcallId === toolcall.id)}
								<ToolcallButton
									{toolcall}
									{toolresponse}
									active={toolcall.id === activeToolcall?.id}
									on:click={() => {
										activeToolcall = toolcall;
									}}
								/>
							{/each}
						</div>
						{#each model3dResponses(message) as pair (pair.toolcall.id)}
							<ModelViewer3D
								content={pair.resp.content.content}
								on:resolved={(e) => persistResolvedModel(pair.resp, e.detail.glb_url)}
							/>
						{/each}
					{/if}

					<!-- OAI toolcalls will always be at the end -->
					{#if message.toolcalls && $config.explicitToolView}
						{#each message.toolcalls as toolcall, ti}
							{@const toolresponse = convo.messages.find((msg) => msg.toolcallId === toolcall.id)}
							<Toolcall
								{toolcall}
								{toolresponse}
								bind:chose
								{isChoosing}
								{choiceHandler}
								{question}
								{choices}
								class="mb-1"
								on:click={() => {
									convo.messages[i].toolcalls[ti].expanded =
										!convo.messages[i].toolcalls[ti].expanded;
									saveMessage(convo.messages[i]);
								}}
							/>
						{/each}
					{/if}
				</div>
			{/if}

			{#if message.editing}
				<div class="absolute -bottom-8 right-1 flex gap-x-1 md:right-0">
					{#if convo.messages.filter((msg) => msg.role !== 'system' && !msg.submitted).length >= 2 && i === convo.messages.length - 1 && message.role !== 'assistant'}
						<button
							class="flex items-center gap-x-1 rounded-full bg-green-100 px-3 py-2"
							on:click={() => {
								submitCompletion();
							}}
						>
							<Icon icon={feCheckCircle} class="h-3.5 w-3.5 text-slate-600" />
							<span class="text-xs text-slate-600"> Submit all </span>
						</button>
					{/if}
					{#if message.role !== 'assistant' && message.pendingContent && message.pendingContent !== message.content}
						<button
							class="flex items-center gap-x-1 rounded-full bg-green-50 px-3 py-2 hover:bg-green-100"
							on:click={(event) => {
								if (message.role === 'system') {
									// If system message, accept the edit instead of submitting at point:
									convo.messages[i].content = message.pendingContent;
									convo.messages[i].pendingContent = '';
									convo.messages[i].editing = false;
									saveMessage(convo.messages[i]);
									return;
								}
								submitEdit(i);
								event.target.blur();
							}}
						>
							<Icon icon={feCheck} class="h-3.5 w-3.5 text-slate-600" />
							<span class="text-xs text-slate-600">
								{#if message.role === 'system'}
									Set system prompt
								{:else}
									Submit
								{/if}
							</span>
						</button>
					{/if}
					{#if message.role === 'assistant' && message.pendingContent && message.pendingContent !== message.content && message.content !== '...' && i === convo.messages.length - 1}
						<button
							class="flex items-center gap-x-1.5 rounded-full bg-green-50 px-3 py-2 hover:bg-green-100"
							on:click={async () => {
								convo.messages[i].unclosed = true;
								saveMessage(convo.messages[i]);
								submitCompletion(false);
							}}
						>
							<Icon icon={feMoreHorizontal} class="h-3.5 w-3.5 text-slate-600" />
							<span class="text-xs text-slate-600">Pre-filled response</span>
						</button>
					{/if}
					<button
						class="flex items-center gap-x-1 rounded-full bg-gray-50 px-3 py-2 hover:bg-gray-100"
						on:click={() => {
							convo.messages[i].editing = false;
							convo.messages[i].pendingContent = '';
							saveMessage(convo.messages[i]);
						}}
					>
						<Icon icon={feX} class="h-3.5 w-3.5 text-slate-600" />
						<span class="text-xs text-slate-600">Cancel</span>
					</button>
				</div>
			{/if}
			{#if !message.editing}
				<div
					class="absolute bottom-[-32px] md:bottom-[-28px] {message.role === 'user' ? 'left-0' : 'left-11 md:left-14'} flex items-center gap-x-4"
				>
					{#if message.role === 'user' && convo.versions?.[message.vid]}
						{@const versions = convo.versions[message.vid]}
						{@const versionIndex = versions.findIndex((v) => v === null)}
						<div class="flex items-center md:gap-x-1 opacity-50 group-hover:opacity-100 transition-opacity">
							<button
								class="group flex h-6 w-6 shrink-0 rounded-full md:h-3 md:w-3"
								disabled={versionIndex === 0}
								on:click={() => {
									shiftVersion(-1, message, i);
								}}
							>
								<Icon
									icon={feChevronLeft}
									class="m-auto h-3.5 w-3.5 text-slate-800 group-disabled:text-slate-500 md:h-3 md:w-3"
								/>
							</button>
							<span class="text-xs tabular-nums font-medium">
								{versionIndex + 1} / {versions.length}
							</span>
							<button
								class="group flex h-6 w-6 shrink-0 rounded-full md:h-3 md:w-3"
								disabled={versionIndex === versions.length - 1}
								on:click={() => {
									shiftVersion(1, message, i);
								}}
							>
								<Icon
									icon={feChevronRight}
									class="m-auto h-3.5 w-3.5 text-slate-800 group-disabled:text-slate-500 md:h-3 md:w-3"
								/>
							</button>
						</div>
					{:else if message.role === 'assistant' && i > 0}
						{@const prevMsg = convo.messages[i - 1]}
						{#if prevMsg?.vid && convo.versions?.[prevMsg.vid]}
							{@const versions = convo.versions[prevMsg.vid]}
							{@const versionIndex = versions.findIndex((v) => v === null)}
							{#if versions.length > 1}
								<div class="flex items-center gap-x-1 text-slate-400 opacity-50 group-hover:opacity-100 transition-opacity">
									<button
										class="group flex h-6 w-6 shrink-0 rounded-full"
										disabled={versionIndex === 0}
										on:click={() => shiftVersion(-1, prevMsg, i - 1)}
									>
										<Icon icon={feChevronLeft} class="m-auto h-3 w-3 group-disabled:opacity-30" />
									</button>
									<span class="text-[11px] tabular-nums font-medium">{versionIndex + 1}/{versions.length}</span>
									<button
										class="group flex h-6 w-6 shrink-0 rounded-full"
										disabled={versionIndex === versions.length - 1}
										on:click={() => shiftVersion(1, prevMsg, i - 1)}
									>
										<Icon icon={feChevronRight} class="m-auto h-3 w-3 group-disabled:opacity-30" />
									</button>
								</div>
							{/if}
						{/if}
					{/if}

					{#if message.role === 'assistant' && (convo.models.length > 1 || (i > 2 && convo.messages[i - 2].role === 'assistant' && message.model && convo.messages[i - 2].model && convo.messages[i - 2].model.id !== message.model.id) || (message.role === 'assistant' && (i === 1 || i === 2) && message.model && convo.models[0]?.id !== message.model.id))}
						<p class="text-[10px]">{formatModelName(message.model)}</p>
					{/if}
				</div>

				<div
					class="{!generating
						? 'group-hover:opacity-100'
						: ''} absolute bottom-[-32px] right-1 flex gap-x-2 opacity-0 transition-opacity md:gap-x-0.5"
				>
					{#if message.role !== 'system'}
						<button
							class="group/actions flex h-7 w-7 shrink-0 rounded-lg hover:bg-gray-100"
							on:click={copyContent}
							title="Copy"
						>
							{#if copied}
								<Icon icon={feCheck} strokeWidth={3} class="m-auto h-[12px] w-[12px] text-green-500" />
							{:else}
								<Icon icon={feCopy} strokeWidth={3} class="m-auto h-[12px] w-[12px] text-slate-600 group-hover/actions:text-slate-800" />
							{/if}
						</button>
					{/if}
					<button
						class="group/actions flex h-7 w-7 shrink-0 rounded-lg hover:bg-gray-100"
						on:click={async () => {
							convo.messages[i].editing = true;
							convo.messages[i].pendingContent = convo.messages[i].content;
							await tick();
							textareaEls[i].style.height = 'auto';
							textareaEls[i].style.height = textareaEls[i].scrollHeight + 'px';
							textareaEls[i].focus();
							saveMessage(convo.messages[i]);
						}}
					>
						<Icon
							icon={feEdit2}
							strokeWidth={3}
							class="m-auto h-[11px] w-[11px] text-slate-600 group-hover/actions:text-slate-800"
						/>
					</button>
					{#if message.role !== 'system'}
						<button
							class="group/actions flex h-7 w-7 shrink-0 rounded-lg hover:bg-gray-100"
							on:click={() => {
								activeToolcall = null;

								if (message.role === 'user') {
									if (!message.vid) {
										message.vid = uuidv4();
										saveMessage(message);
									}
									saveVersion(message, i);

									// If user message, remove all messages after this one, then regenerate:
									convo.messages = convo.messages.slice(0, i + 1);
									submitCompletion();
								} else {
									// History is split on the user message, so get the message before this (which will be the user's):
									const previousUserMessage = convo.messages[i - 1];
									if (!previousUserMessage.vid) {
										previousUserMessage.vid = uuidv4();
										saveMessage(previousUserMessage);
									}
									saveVersion(previousUserMessage, i - 1);

									// If assistant message, remove all messages after this one, including this one, then regenerate:
									convo.messages = convo.messages.slice(0, i);
									submitCompletion();
								}
								saveConversation(convo);
							}}
						>
							<Icon
								icon={feRefreshCw}
								strokeWidth={3}
								class="m-auto h-[12px] w-[12px] text-slate-600 group-hover/actions:text-slate-800"
							/>
						</button>
					{/if}
					<button
						class="group/actions flex h-7 w-7 shrink-0 rounded-lg hover:bg-gray-100"
						on:click={() => {
							// Remove this message from the conversation:
							convo.messages = convo.messages.slice(0, i).concat(convo.messages.slice(i + 1));
							deleteMessage(message);
							saveConversation(convo);
							dispatch('rerender');
						}}
					>
						<Icon
							icon={feX}
							strokeWidth={3}
							class="m-auto h-[14px] w-[14px] text-slate-600 group-hover/actions:text-slate-800"
						/>
					</button>
				</div>
			{/if}
		</div>
		<button
			on:click={async () => {
				// Insert a blank message inbetween the next message and the next next message:
				let role;
				if (message.role === 'assistant' || message.role === 'system') {
					role = 'user';
				} else {
					role = 'assistant';
				}
				const msg = {
					id: uuidv4(),
					role,
					content: '',
					editing: true,
				};
				convo.messages.splice(i + 1, 0, msg);
				convo.messages = convo.messages;
				await tick();
				textareaEls[i + 1].focus();

				saveMessage(msg);
				saveConversation(convo);
			}}
			class="{!generating
				? 'group-hover:opacity-100'
				: ''} z-1 absolute bottom-0 left-1/2 flex h-6 w-6 -translate-x-1/2 translate-y-1/2 items-center justify-center rounded-md border border-slate-200 bg-white opacity-0 transition-opacity hover:bg-gray-200"
		>
			<Icon icon={feStar} class="m-auto h-3 w-3 text-slate-600" />
		</button>
	</li>
{/if}

<style>
	.avatar-bubble {
		position: relative;
		width: 180px;
		padding: 8px 12px 10px;
		border-radius: 14px;
		background: #141414;
		border: 1px solid #2A2A2A;
		box-shadow: 0 4px 16px rgba(0,0,0,0.07);
		font-size: 12px;
		line-height: 1.45;
		color: #ECEAE3;
		animation: bubble-pop 200ms ease-out;
	}
	.avatar-bubble--thinking {
		background: #1C1C1C;
		color: #9A988F;
	}
	.avatar-bubble-tail {
		position: absolute;
		bottom: -6px;
		left: 50%;
		transform: translateX(-50%) rotate(45deg);
		width: 10px;
		height: 10px;
		background: #141414;
		border-right: 1px solid #2A2A2A;
		border-bottom: 1px solid #2A2A2A;
	}
	.avatar-bubble--thinking .avatar-bubble-tail {
		background: #1C1C1C;
	}
	@keyframes bubble-pop {
		from { opacity: 0; transform: translateY(4px) scale(0.97); }
		to   { opacity: 1; transform: translateY(0) scale(1); }
	}
</style>
