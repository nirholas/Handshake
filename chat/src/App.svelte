<script>
	import { v4 as uuidv4 } from 'uuid';
	import { onMount, tick } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { complete, generateImage } from './convo.js';
	import KnobsSidebar from './KnobsSidebar.svelte';
	import Button from './Button.svelte';
	import { marked } from 'marked';
	import markedKatex from './marked-katex-extension';

	import { persisted } from './localstorage.js';
	import { getRelativeDate } from './date.js';
	import { compressAndEncode, decodeAndDecompress } from './share.js';
	import {
		formatModelName,
		providers,
		fetchModels,
		hasCompanyLogo,
		priorityOrder,
		formatMultipleModelNames,
		BUILTIN_MODELS,
	} from './providers.js';
	import ModelSelector from './ModelSelector.svelte';
	import CompanyLogo from './CompanyLogo.svelte';
	import { controller, remoteServer, config, params, toolSchema, syncServer, brandConfig, ttsEnabled, localAgentId, activeAgent, talkingHeadEnabled, talkingHeadAvatarUrl, route, mode, websiteCategory, loadCurrentUser, currentUser, notify, localProvidersEnabled, generating as generatingStore } from './stores.js';
	import { t } from './i18n.js';
	import Notifications from './Notifications.svelte';
	import AuthPage from './three-ui/pages/AuthPage.svelte';
	import Pricing from './three-ui/pages/Pricing.svelte';
	import MarketingPage from './three-ui/pages/MarketingPage.svelte';
	import ResourcePage from './three-ui/pages/ResourcePage.svelte';
	import FeaturePage from './three-ui/pages/FeaturePage.svelte';
	import EventsPage from './three-ui/pages/EventsPage.svelte';
	import SettingsModal from './SettingsModal.svelte';
	import ToolcallButton from './ToolcallButton.svelte';
	import MessageContent from './MessageContent.svelte';
	import Toolcall from './Toolcall.svelte';
	import Modal from './Modal.svelte';
	import Composer from './three-ui/Composer.svelte';
	import Icon from './Icon.svelte';
	import {
		feArrowUp,
		feCheck,
		feCheckCircle,
		feChevronDown,
		feChevronLeft,
		feChevronRight,
		feCpu,
		feDownload,
		feEdit2,
		feGrid,
		feMenu,
		feTerminal,
		feMoreHorizontal,
		fePaperclip,
		feStar,
		feRefreshCw,
		feSettings,
		feShare,
		feSidebar,
		feSpeaker,
		feSquare,
		feTrash,
		feUser,
		feUsers,
		feX,
	} from './feather.js';
	import { defaultToolSchema, agentToolSchema, pumpToolSchema, agentPaymentsToolSchema, pumpTradingToolSchema, curatedToolPacks } from './tools.js';
	import { signMessageSolana, signMessageEVM } from './walletAuth.js';
	import { debounce, readFileAsDataURL } from './util.js';
	import { flash, focusOnMount } from './actions';
	import Message from './Message.svelte';
	import { deleteSingleItem, initEncryption, sendSingleItem, syncPull, syncPush } from './sync.js';
	import AgentPicker from './AgentPicker.svelte';
	import AgentSettingsModal from './AgentSettingsModal.svelte';
	import TalkingHead from './TalkingHead.svelte';
	import EmptyState from './three-ui/EmptyState.svelte';
	import SuggestionChips from './three-ui/SuggestionChips.svelte';
	import TopNav from './three-ui/TopNav.svelte';
	import WebsiteFlow from './three-ui/flows/WebsiteFlow.svelte';
	import DesktopFlow from './three-ui/flows/DesktopFlow.svelte';
	import RevenueDashboard from './three-ui/pages/RevenueDashboard.svelte';
	import SkillsMarketplaceModal from './SkillsMarketplaceModal.svelte';

	marked.use(
		markedKatex({
			throwOnError: false,
		})
	);

	const convoId = persisted('convoId');
	let convos = {};

	// Initialize history and convo with a blank slate while we wait for IndexedDB to start
	const defaultConvo = {
		id: uuidv4(),
		time: Date.now(),
		models: [BUILTIN_MODELS[0]],
		messages: [],
		versions: {},
		tools: [],
		agentId: null,
	};
	let convo = defaultConvo;

	let db;
	const request = indexedDB.open('threews-chat', 3);
	request.onupgradeneeded = (event) => {
		const db = event.target.result;
		if (!db.objectStoreNames.contains('messages')) {
			db.createObjectStore('messages', { keyPath: 'id' });
		}
		if (!db.objectStoreNames.contains('conversations')) {
			db.createObjectStore('conversations', { keyPath: 'id' });
		}
		if (!db.objectStoreNames.contains('knowledge')) {
			const ks = db.createObjectStore('knowledge', { keyPath: 'id' });
			ks.createIndex('agentId', 'agentId', { unique: false });
			ks.createIndex('filename', 'filename', { unique: false });
		}
	};
	request.onsuccess = async (event) => {
		db = event.target.result;
		await fetchAllConversations();

		const restored = await restoreConversation();

		// Search bang support
		const queryParams = new URLSearchParams(window.location.search);
		if (queryParams.has('search')) {
			const search = queryParams.get('search');
			const model = queryParams.get('model');
			convo.models = [{ id: model, name: model, provider: 'OpenRouter' }];
			convo.websearch = true;
			const msg = {
				id: uuidv4(),
				role: 'user',
				content: search,
				submitted: true,
			};
			convo.messages = [msg];
			saveMessage(msg);
			saveConversation(convo);
			submitCompletion();
		} else {
			if (!restored) {
				if (!$convoId || !convos[$convoId]) {
					newConversation();
				} else {
					convo = convos[$convoId];
				}
				if (!convo.tools) {
					convo.tools = [];
					saveConversation(convo);
				}
			}
		}
	};
	request.onerror = (event) => {
		console.error(event.target.error);
	};

	const saveMessage = debounce((msg, opts = { syncToServer: true }) => {
		const transaction = db.transaction(['messages'], 'readwrite');
		const store = transaction.objectStore('messages');

		store.put(msg);

		if (opts.syncToServer && $syncServer.token && $syncServer.password) {
			sendSingleItem($syncServer.address, $syncServer.token, {
				conversation: null,
				message: msg,
				apiKeys: null,
			}).catch(() => {});
		}

		transaction.onerror = () => {
			console.error('Message save failed', transaction.error);
			notify('Failed to save — your changes may be lost. Check browser storage settings.');
		};
	}, 500);

	function convertMessageFromIdToObject(message, conversations) {
		for (let convo of conversations) {
			const index = convo.messages.indexOf(message.id);
			if (index !== -1) {
				// Replace the message ID with the actual message object
				convo.messages[index] = message;
			}
			// Handle versions
			for (let versionKey in convo.versions) {
				for (let messages of convo.versions[versionKey]) {
					if (!messages) {
						continue;
					}
					const i = messages.indexOf(message.id);
					if (i !== -1) {
						// Replace the message ID with the actual message object
						messages[i] = message;
					}
				}
			}
		}
	}

	async function fetchAllConversations() {
		const transaction = db.transaction(['conversations', 'messages'], 'readonly');
		const conversationsStore = transaction.objectStore('conversations');
		const messagesStore = transaction.objectStore('messages');

		const fetchConversations = new Promise((resolve, reject) => {
			const conversationsRequest = conversationsStore.getAll();
			conversationsRequest.onsuccess = (event) => {
				const conversations = event.target.result;
				conversations.forEach((conversation) => {
					// Migrate `convo.model` to `convo.models`:
					if (conversation.model) {
						conversation.models = [conversation.model];
						delete conversation.model;
						saveConversation(conversation);
					}
				});
				resolve(conversations);
			};
			conversationsRequest.onerror = (event) => {
				reject(event.target.error);
			};
		});

		const fetchMessages = new Promise((resolve, reject) => {
			const messagesRequest = messagesStore.getAll();
			messagesRequest.onsuccess = (event) => {
				const messages = event.target.result;
				resolve(messages);
			};
			messagesRequest.onerror = (event) => {
				reject(event.target.error);
			};
		});

		try {
			// First, we fetch all entities, convert them into the proper format, so we can display them
			// ASAP on-screen.
			const [conversations, messages] = await Promise.all([fetchConversations, fetchMessages]);

			const conversationsConverted = structuredClone(conversations);
			messages.forEach((message) => {
				convertMessageFromIdToObject(message, conversationsConverted);
			});
			const convosMap = {};
			for (const convo of conversationsConverted) {
				convosMap[convo.id] = convo;
			}
			convos = convosMap;

			// Sync:
			if ($syncServer.token && $syncServer.password) {
				syncPullPush(conversations, messages, convosMap).catch((e) => {
					console.warn('[sync] pull/push failed:', e?.message || e);
				}); // async
			}
		} catch (error) {
			console.error('Error fetching history:', error);
		}
	}

	async function syncPullPush(conversations, messages, convosMap) {
		await initEncryption($syncServer.password);

		// Conversations returned by this need to be converted again.
		const { newConversations, deletedConversations, newMessages, deletedMessages } = await syncPull(
			{
				conversationIds: conversations.map((c) => c.id),
				messageIds: messages.map((m) => m.id),
				saveConversation,
				deleteConversation,
				saveMessage,
				deleteMessage,
			}
		);
		const completeConversations = conversations.concat(newConversations);
		const completeMessages = messages.concat(newMessages);

		const newConversationsConverted = structuredClone(newConversations);
		messages.forEach((message) => {
			convertMessageFromIdToObject(message, newConversationsConverted);
		});
		newMessages.forEach((message) => {
			convertMessageFromIdToObject(message, newConversationsConverted);
		});

		for (const convo of newConversationsConverted) {
			convosMap[convo.id] = convo;
		}
		for (const convo of deletedConversations) {
			delete convosMap[convo.id];
		}
		for (const deletedMsg of deletedMessages) {
			for (const convoId of Object.keys(convosMap)) {
				const idx = convosMap[convoId].messages.findIndex((m) => m.id === deletedMsg.id);
				if (idx !== -1) {
					convosMap[convoId].messages.splice(idx, 1);
					break;
				}
			}
		}
		convos = convosMap;

		await syncPush({
			conversations: completeConversations.filter((c) => c.messages.length > 0),
			messages: completeMessages,
		});
	}

	const saveConversation = debounce((convo, opts = { convert: true, syncToServer: true }) => {
		const transaction = db.transaction(['conversations'], 'readwrite');
		const store = transaction.objectStore('conversations');

		// Check if we need to convert the messages to ids
		// This may be called during sync, for which the data is ids already
		const messages = opts.convert ? convo.messages.map((msg) => msg.id) : convo.messages;
		const versions = opts.convert
			? Object.fromEntries(
					Object.entries(convo.versions).map(([key, value]) => [
						key,
						value.map((messages) => {
							if (!messages) {
								return null;
							}
							return messages.map((msg) => {
								return msg.id;
							});
						}),
					])
				)
			: convo.versions;

		const convoConvertedOrNot = {
			...convo,
			messages,
			versions,
		};

		store.put(convoConvertedOrNot);

		if (
			opts.syncToServer &&
			$syncServer.token &&
			$syncServer.password &&
			convo.messages.length > 0
		) {
			sendSingleItem($syncServer.address, $syncServer.token, {
				conversation: convoConvertedOrNot,
				message: null,
				apiKeys: null,
			}).catch(() => {});
		}

		transaction.onerror = () => {
			console.error('Conversation save failed', transaction.error);
			notify('Failed to save — your changes may be lost. Check browser storage settings.');
		};
	}, 500);

	function deleteConversation(convo, opts = { syncToServer: true }) {
		const transaction = db.transaction(['conversations'], 'readwrite');
		const store = transaction.objectStore('conversations');

		store.delete(convo.id);

		if (
			opts.syncToServer &&
			$syncServer.token &&
			$syncServer.password &&
			convo.messages.length > 0
		) {
			deleteSingleItem($syncServer.address, $syncServer.token, {
				conversationId: convo.id,
				messageId: null,
			}).catch(() => {});
		}

		transaction.onerror = () => {
			console.error('Conversation delete failed', transaction.error);
			notify('Failed to delete conversation. Check browser storage settings.');
		};
	}

	function deleteMessage(message, opts = { syncToServer: true }) {
		const transaction = db.transaction(['messages'], 'readwrite');
		const store = transaction.objectStore('messages');

		store.delete(message.id);

		if (opts.syncToServer && $syncServer.token && $syncServer.password) {
			deleteSingleItem($syncServer.address, $syncServer.token, {
				conversationId: null,
				messageId: message.id,
			}).catch(() => {});
		}

		transaction.onerror = () => {
			console.error('Message delete failed', transaction.error);
			notify('Failed to delete message. Check browser storage settings.');
		};
	}

	let historyBuckets = [];
	$: {
		historyBuckets = [];
		for (const entry of Object.values(convos).sort((a, b) => b.time - a.time)) {
			if (entry.shared || isNaN(new Date(entry.time).getTime())) {
				continue;
			}

			const bucketKey = getRelativeDate(entry.time);

			const existingBucket = historyBuckets.find((bucket) => bucket.relativeDate === bucketKey);
			if (!existingBucket) {
				historyBuckets.push({ relativeDate: bucketKey, convos: [entry] });
			} else {
				existingBucket.convos.push(entry);
			}
		}
		historyBuckets.sort((a, b) => b.convos[0].time - a.convos[0].time);
	}

	let searchQuery = '';
	$: filteredConvos = searchQuery.trim()
		? Object.values(convos).filter(
				(c) =>
					!c.shared &&
					(c.messages.some(
						(m) =>
							typeof m.content === 'string' &&
							m.content.toLowerCase().includes(searchQuery.toLowerCase())
					) ||
						(c.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
						(c.messages.find((m) => m.role === 'user')?.content || '')
							.toLowerCase()
							.includes(searchQuery.toLowerCase()))
			)
		: null;

	let generating = false;
	$: $generatingStore = generating;
	let editingTitleId = null;

	let historyOpen = false;
	let knobsOpen = false;

	let activeToolcall = null;

	let scrollableEl = null;
	let previousScrollTop = 0;
	let autoscrollCanceled;
	let scrollAnimFrame = null;
	function scrollToBottom() {
		if (!scrollableEl) return;
		const step = () => {
			scrollAnimFrame = null;
			if (!scrollableEl) return;
			const target = scrollableEl.scrollHeight - scrollableEl.clientHeight;
			const current = scrollableEl.scrollTop;
			const delta = target - current;
			if (delta <= 0.5) {
				scrollableEl.scrollTop = target;
				return;
			}
			// Gentle easing: move ~8% of the remaining distance per frame,
			// capped so we never jump more than 6px in a single frame.
			const next = current + Math.min(Math.max(delta * 0.08, 0.5), 6);
			scrollableEl.scrollTop = next;
			scrollAnimFrame = requestAnimationFrame(step);
		};
		if (scrollAnimFrame == null) {
			scrollAnimFrame = requestAnimationFrame(step);
		}
	}
	let textareaEls = [];
	let inputTextareaEl;

	let handleFileDrop;

	let innerWidth = window.innerWidth;

	$: splitView = innerWidth > 1215 && activeToolcall && !$config.explicitToolView;

	let settingsModalOpen = false;
	let toolcallModalOpen = false;

	let thinkingStartTime = null;
	let thinkingInterval = null;

	let tree;

	function handleAbort() {
		if (!generating) {
			return;
		}
		$controller.abort();
		generating = false;
		speakLastMessage();
		// Stop thinking
		const i = convo.messages.length - 1;
		if (convo.messages[i].reasoning) {
			convo.messages[i].thinking = false;
			stopThinkingTimer(i);
		}
		talkingHead?.think(false);
	}

	async function submitCompletion(insertUnclosed = true) {
		window.speechSynthesis?.cancel();
		if (!convo.models?.[0]?.provider) {
			const msg = {
				id: uuidv4(),
				role: 'assistant',
				error: 'No model selected. Please select a model to begin.',
				content: '',
			};
			saveMessage(msg);
			convo.messages.push(msg);
			convo.messages = convo.messages;
			saveConversation(convo);
			return;
		}

		if (generating) {
			$controller.abort();
		}

		generating = true;

		if (insertUnclosed) {
			const msg = {
				id: uuidv4(),
				role: 'assistant',
				content: '',
				unclosed: true,
				generated: true,
				websearch: convo.websearch && convo.models[0]?.provider === 'OpenRouter',
				model: convo.models[0],
				agent: $activeAgent,
			};
			convo.messages.push(msg);
			convo.messages = convo.messages;

			if (
				convo.models[0].kind === 'reasoner' &&
				(convo.models[0].reasoningEffortControls === 'range'
					? $params.reasoningEffort['range'] > 0
					: true)
			) {
				convo.messages[convo.messages.length - 1].reasoning = true;
				convo.messages[convo.messages.length - 1].thinking = true;
				convo.messages[convo.messages.length - 1].thoughts = '';
				convo.messages[convo.messages.length - 1].thoughtsExpanded = true;
				startThinkingTimer(convo.messages.length - 1);
			}

			saveMessage(msg);
			saveConversation(convo);
		}

		for (let i = 0; i < convo.messages.length; i++) {
			let modified = false;
			if (convo.messages[i].editing) {
				convo.messages[i].content = convo.messages[i].pendingContent;
				convo.messages[i].editing = false;
				modified = true;
			}
			if (convo.messages[i].pendingContent !== '') {
				convo.messages[i].pendingContent = '';
				modified = true;
			}
			if (!convo.messages[i].submitted) {
				convo.messages[i].submitted = true;
			}

			if (modified) {
				saveMessage(convo.messages[i]);
			}
		}
		await tick();
		scrollToBottom();

		const i = convo.messages.length - 1;

		if (convo.models[0].modality === 'text->image') {
			await generateImage(convo, {
				oncomplete: (resp) => {
					convo.messages[i].generatedImageUrl = resp.data[0].url;
					generating = false;
					saveMessage(convo.messages[i]);
				},
			});
			return;
		}

		let unexpandedThinkingOnce = false;

		const onupdate = async (chunk) => {
			if (chunk.error) {
				convo.messages[i].error = chunk.error.message || chunk.error;
				saveMessage(convo.messages[i]);
				handleAbort();
				return;
			}

			if (chunk.choices.length === 0) {
				handleAbort();
				return;
			}

			const choice = chunk.choices[0];

			if (convo.messages[i].model.id === 'o1') {
				convo.messages[i].content = choice.message.content;
				pulseTokens();
				// Once content starts coming in, we can stop thinking
				if (convo.messages[i].reasoning && !unexpandedThinkingOnce) {
					unexpandedThinkingOnce = true;
					convo.messages[i].thinking = false;
					stopThinkingTimer(i);
				}
				saveMessage(convo.messages[i]);
				return;
			}

			if (choice.delta.content) {
				convo.messages[i].content += choice.delta.content;
				pulseTokens();
				if (agentEl && agentEl._streamToBubble) agentEl._streamToBubble(choice.delta.content);
				if (agentEl && agentEl._onStreamChunk) agentEl._onStreamChunk();
				// Once content starts coming in, we can stop thinking
				if (convo.messages[i].reasoning && !unexpandedThinkingOnce) {
					unexpandedThinkingOnce = true;
					convo.messages[i].thinking = false;
					convo.messages[i].thoughtsExpanded = false;
					stopThinkingTimer(i);
				}
				saveMessage(convo.messages[i]);
			}

			// Begin thinking
			if (choice.delta.reasoning && !convo.messages[i].reasoning) {
				convo.messages[i].reasoning = true;
				convo.messages[i].thoughts = '';
				convo.messages[i].thoughtsExpanded = true;
				if (!convo.messages[i].thinking && !unexpandedThinkingOnce) {
					unexpandedThinkingOnce = true;
					convo.messages[i].thinking = true;
					startThinkingTimer(i);
				}
				saveMessage(convo.messages[i]);
			}

			// Stream thoughts
			if (convo.messages[i].reasoning && choice.delta.reasoning) {
				convo.messages[i].thoughts += choice.delta.reasoning;
				pulseTokens();
				if (agentEl && agentEl._onStreamChunk) agentEl._onStreamChunk();
				saveMessage(convo.messages[i]);
			}

			if (choice.delta.tool_calls) {
				if (!convo.messages[i].toolcalls) {
					convo.messages[i].toolcalls = [];
					saveMessage(convo.messages[i]);
				}

				for (const tool_call of choice.delta.tool_calls) {
					let index = tool_call.index;
					// Watch out! Anthropic tool call indices are 1-based, not 0-based, when message.content is involved.
					// NOTE: No longer the case for OpenRouter, they've changed this.
					if (convo.models[0].provider === 'Anthropic' && convo.messages[i].content) {
						index--;
						// With thinking, we need to subtract one more:
						if (convo.messages[i].reasoning) {
							index--;
						}
					}

					if (!convo.messages[i].toolcalls[index]) {
						convo.messages[i].toolcalls[index] = {
							id: tool_call.id,
							name: tool_call.function.name,
							arguments: '',
							expanded: true,
						};
						if (innerWidth > 1215) {
							activeToolcall = convo.messages[i].toolcalls[index];
						}
					}
					if (tool_call.function.arguments) {
						convo.messages[i].toolcalls[index].arguments += tool_call.function.arguments;
						if (innerWidth > 1215) {
							activeToolcall = convo.messages[i].toolcalls[index];
						}
					}
					saveMessage(convo.messages[i]);
				}
			}

			// Scroll to bottom if we're at or near the bottom of the conversation:
			if (!autoscrollCanceled) {
				scrollToBottom();
			}

			// Check for stoppage:
			// External tool calls:
			if (
				chunk.choices &&
				(chunk.choices[0].finish_reason === 'stop' ||
					chunk.choices[0].finish_reason === 'end_turn' ||
					chunk.choices[0].finish_reason === 'tool_calls')
			) {
				generating = false;

				if (convo.messages[i].reasoning) {
					convo.messages[i].thinking = false;
					stopThinkingTimer(i);
				}

				// Toolcall arguments are now finalized, we can parse them:
				if (convo.messages[i].toolcalls) {
					let toolPromises = [];

					for (let ti = 0; ti < convo.messages[i].toolcalls.length; ti++) {
						const toolcall = convo.messages[i].toolcalls[ti];

						try {
							toolcall.arguments = JSON.parse(toolcall.arguments);
						} catch (err) {
							convo.messages[i].error =
								'Failed to parse tool call arguments: ' + err + toolcall.arguments;
							saveMessage(convo.messages[i]);
							return;
						}

						// Do we have a client-side tool for this? Search all groups.
						let clientGroup = null, clientToolIndex = -1;
						for (const g of $toolSchema) {
							const idx = g.schema?.findIndex(t => t.clientDefinition && t.clientDefinition.name === toolcall.name) ?? -1;
							if (idx !== -1) { clientGroup = g; clientToolIndex = idx; break; }
						}
						if (clientGroup && clientToolIndex !== -1 && convo.tools.includes(toolcall.name)) {
							const clientTool = clientGroup.schema[clientToolIndex];
							const AsyncFunction = async function () {}.constructor;
							// @ts-ignore
							const clientFn = new AsyncFunction(
								'args',
								'choose',
								clientTool.clientDefinition.body
							);
							const promise = clientFn(toolcall.arguments, choose);
							toolPromises.push(promise);
						} else {
							// Otherwise, call server-side tool
							const promise = (async () => {
								try {
									const resp = await fetch(`${$remoteServer.address}/tool`, {
										method: 'POST',
										headers: {
											Authorization: `Basic ${$remoteServer.password}`,
										},
										body: JSON.stringify({
											id: toolcall.id,
											chat_id: convo.id,
											name: toolcall.name,
											arguments: toolcall.arguments,
										}),
									});
									convo.messages[i].toolcalls[ti].finished = true;
									saveMessage(convo.messages[i]);
									if (!resp.ok) {
										throw new Error(`Tool server returned ${resp.status}`);
									}
									return JSON.parse(await resp.text());
								} catch (err) {
									convo.messages[i].toolcalls[ti].finished = true;
									saveMessage(convo.messages[i]);
									return { error: err.message || 'Tool invocation failed' };
								}
							})();

							toolPromises.push(promise);
						}
					}

					const toolResponses = await Promise.all(toolPromises);

					for (let ti = 0; ti < toolResponses.length; ti++) {
						const msg = {
							id: uuidv4(),
							role: 'tool',
							toolcallId: convo.messages[i].toolcalls[ti].id,
							name: convo.messages[i].toolcalls[ti].name,
							content: toolResponses[ti],
						};
						convo.messages.push(msg);
						convo.messages = convo.messages;
						saveMessage(msg);
						saveConversation(convo);
					}

					submitCompletion();
				} else {
					generateTitle();
				}

				return;
			}
		};

		const onabort = (err) => {
			if (err && typeof err === 'object') {
				if (err.code === 'payment_required') {
					const url = err.upgradeUrl || '/pricing';
					convo.messages[i].error = `Out of credits. [Upgrade your plan](${url}) to keep chatting.`;
				} else if (err.code === 'rate_limited') {
					const hint = err.retryAfter ? ` Try again in ${err.retryAfter}s.` : ' Please wait a moment and try again.';
					convo.messages[i].error = `The built-in model is rate-limited.${hint}`;
				} else if (err.code === 'tools_unsupported') {
					const tools = err.toolNames?.length ? err.toolNames.join(', ') : 'the enabled tools';
					convo.messages[i].error = `**${err.modelId}** doesn't support tool use. Disable ${tools} in the Tools panel, or switch to a tool-capable model like \`anthropic/claude-sonnet-4.5\` or \`openai/gpt-5-mini\`.`;
				} else {
					convo.messages[i].error = err.message || String(err);
				}
				saveMessage(convo.messages[i]);
			} else if (typeof err === 'string') {
				convo.messages[i].error = err;
				saveMessage(convo.messages[i]);
			}
			handleAbort();
		};

		// RAG retrieval
		if ($activeAgent?.id && db) {
			try {
				const lastUserMsg = [...convo.messages].reverse().find((m) => m.role === 'user');
				if (lastUserMsg?.content) {
					const { retrieveTopK } = await import('./knowledge.js');
					const chunks = await retrieveTopK(db, $activeAgent.id, lastUserMsg.content, 3);
					if (chunks.length > 0) {
						convo.retrievalContext = chunks.map((c) => c.text).join('\n\n');
					}
				}
			} catch {}
		}

		complete(convo, onupdate, onabort);
		delete convo.retrievalContext;
	}

	function startThinkingTimer(messageIndex) {
		thinkingStartTime = Date.now();
		updateThinkingTime(messageIndex);
		thinkingInterval = setInterval(() => updateThinkingTime(messageIndex), 500);
	}

	function stopThinkingTimer(messageIndex) {
		if (thinkingInterval) {
			clearInterval(thinkingInterval);
			thinkingInterval = null;
		}
		// updateThinkingTime(messageIndex);
	}

	function updateThinkingTime(messageIndex) {
		const thinkingTime = (Date.now() - thinkingStartTime) / 1000; // Convert to seconds
		convo.messages[messageIndex].thinkingTime = thinkingTime;
		saveMessage(convo.messages[messageIndex]);
	}

	async function insertSystemPrompt() {
		const msg = { id: uuidv4(), role: 'system', content: '', editing: true };
		convo.messages.unshift(msg);
		convo.messages = convo.messages;
		await tick();
		textareaEls[0].focus();

		saveMessage(msg);
		saveConversation(convo);
	}

	function cleanShareLink() {
		const params = new URLSearchParams(window.location.search);
		if (params.has('s') || params.has('sl')) {
			window.history.pushState('', document.title, window.location.pathname);
		}
	}

	function newConversation() {
		cleanShareLink();
		activeToolcall = null;

		// if (convo.messages.length === 0) {
		// 	historyOpen = false;
		// 	inputTextareaEl.focus();
		// 	return;
		// }

		const existingNewConvo = Object.values(convos).find((convo) => convo.messages.length === 0);
		if (existingNewConvo) {
			const oldModels = convo.models;
			$convoId = existingNewConvo.id;
			convo = convos[$convoId];
			convo.models = oldModels;

			historyOpen = false;
			inputTextareaEl.focus();
			return;
		}

		// If the x402 pay-per-call pack is installed, pre-enable its tools on
		// new conversations so the model can immediately call paid MCP tools
		// without the user having to dig through the Tools dropdown first.
		const x402PackMeta = curatedToolPacks.find((p) => p.id === 'x402-pay');
		const x402PackInstalled = x402PackMeta
			? $toolSchema.find((g) => g.name === x402PackMeta.name)
			: null;
		const defaultTools = x402PackInstalled
			? x402PackInstalled.schema.map((t) => t.function?.name).filter(Boolean)
			: [];

		const convoData = {
			id: uuidv4(),
			time: Date.now(),
			models:
				convo.models.length > 0
					? [...convo.models]
					: [models.find((m) => m.id === 'anthropic/claude-3.5-sonnet')],
			messages: [],
			versions: {},
			tools: defaultTools,
			agentId: null,
		};
		if ($activeAgent?.preferred_model) {
			convoData.models = [$activeAgent.preferred_model];
		}
		$convoId = convoData.id;
		convos[convoData.id] = convoData;
		convo = convoData;

		saveConversation(convo);
		if ($activeAgent) applyAgentToConvo($activeAgent);

		historyOpen = false;
		if (innerWidth > 880) {
			inputTextareaEl.focus();
		}
	}

	function switchToAgentConversation(agentId) {
		if (!db) return;
		if (!agentId) {
			const noAgent = Object.values(convos)
				.filter(c => !c.agentId)
				.sort((a, b) => b.time - a.time)[0];
			if (noAgent) {
				$convoId = noAgent.id;
				convo = noAgent;
			} else {
				newConversation();
			}
			return;
		}
		const existing = Object.values(convos)
			.filter(c => c.agentId === agentId)
			.sort((a, b) => b.time - a.time)[0];
		if (existing) {
			$convoId = existing.id;
			convo = existing;
			return;
		}
		const convoData = {
			id: uuidv4(),
			time: Date.now(),
			models: convo.models.length > 0 ? [...convo.models] : [BUILTIN_MODELS[0]],
			messages: [],
			versions: {},
			tools: [],
			agentId,
		};
		if ($activeAgent?.preferred_model) {
			convoData.models = [$activeAgent.preferred_model];
		}
		$convoId = convoData.id;
		convos[convoData.id] = convoData;
		convo = convoData;
		saveConversation(convo);
	}

	function applyAgentToConvo(agent) {
		if (!db) return;
		if (agent.system_prompt && convo.messages.length === 0) {
			const sysMsg = { id: uuidv4(), role: 'system', content: agent.system_prompt };
			convo.messages = [sysMsg];
			saveMessage(sysMsg);
		}
		const nonSystem = convo.messages.filter(m => m.role !== 'system');
		if (nonSystem.length === 0) {
			const greeting = agent.greeting || `Hi, I'm ${agent.name || 'here'}. How can I help you today?`;
			const greetMsg = { id: uuidv4(), role: 'assistant', content: greeting, generated: true, agent };
			convo.messages = [...convo.messages, greetMsg];
			saveMessage(greetMsg);
		}
		saveConversation(convo);
	}

	function onAgentSettingsSave(updatedAgent) {
		if (!convo) return;
		const sysIdx = convo.messages.findIndex((m) => m.role === 'system');
		if (sysIdx !== -1 && updatedAgent.system_prompt) {
			convo.messages[sysIdx].content = updatedAgent.system_prompt;
			saveMessage(convo.messages[sysIdx]);
			saveConversation(convo);
		} else if (sysIdx === -1 && updatedAgent.system_prompt) {
			const sysMsg = { id: uuidv4(), role: 'system', content: updatedAgent.system_prompt };
			convo.messages = [sysMsg, ...convo.messages];
			saveMessage(sysMsg);
			saveConversation(convo);
		}
	}

	function clearAgentFromConvo() {
		convo.messages = convo.messages.filter(m => m.role !== 'system' && !m.generated);
		saveConversation(convo);
	}

	$: if ($activeAgent !== undefined) {
		const agentId = $activeAgent?.id ?? null;
		switchToAgentConversation(agentId);
		if ($activeAgent) applyAgentToConvo($activeAgent);
	}

	// Split history at this point:
	function saveVersion(message, i) {
		if (!convo.versions) {
			convo.versions = {};
		}
		if (!convo.versions[message.vid]) {
			convo.versions[message.vid] = [null];
		}
		const nullIdx = convo.versions[message.vid].findIndex((v) => v === null);
		convo.versions[message.vid][nullIdx] = [
			structuredClone(message),
			...structuredClone(convo.messages.slice(i + 1)).map((m) => {
				return {
					...m,
					editing: false,
					pendingContent: '',
				};
			}),
		];
		convo.versions[message.vid].push(null);
		saveConversation(convo);
	}

	function shiftVersion(dir, message, i) {
		const activeVersionIndex = convo.versions[message.vid].findIndex((v) => v === null);
		const newVersionIndex = activeVersionIndex + dir;

		convo.versions[message.vid][activeVersionIndex] = convo.messages.slice(i);

		const newMessages = convo.versions[message.vid][newVersionIndex];

		convo.messages = convo.messages.slice(0, i).concat(newMessages);

		convo.versions[message.vid][newVersionIndex] = null;

		saveConversation(convo);
	}

	function closeSidebars(event) {
		if (
			historyOpen &&
			!event.target.closest('[data-sidebar="history"]') &&
			!event.target.closest('[data-trigger="history"]')
		) {
			historyOpen = false;
		}
		if (
			knobsOpen &&
			!event.target.closest('[data-trigger="knobs"]') &&
			!event.target.closest('[data-sidebar="knobs"]')
		) {
			knobsOpen = false;
		}
	}

	async function shareConversation(event) {
		event.currentTarget.dispatchEvent(new CustomEvent('flashSuccess'));

		const sharePromise = (async () => {
			const encoded = await compressAndEncode({
				models: convo.models,
				messages: convo.messages,
			});
			const longShare = `${window.location.protocol}//${window.location.host}/?s=${encoded}`;
			if (longShare.length <= 200) return longShare;
			try {
				const data = new FormData();
				data.append('pwd', 'muie_webshiti');
				data.append('f:1', new Blob([encoded], { type: 'text/plain' }), 'content.txt');
				const response = await fetch(`https://sync.three.ws`, {
					method: 'POST',
					body: data,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const shortenedLink = await response.text();
				return `${window.location.protocol}//${window.location.host}/?sl=${shortenedLink.split('/').reverse()[1]}`;
			} catch (e) {
				console.warn('[share] link shortener unreachable, falling back to long URL:', e?.message || e);
				return longShare;
			}
		})();

		try {
			const clipboardItem = new ClipboardItem({
				'text/plain': sharePromise,
			});
			await navigator.clipboard.write([clipboardItem]);
		} catch (err) {
			await navigator.clipboard.writeText(await sharePromise);
		}
	}

	let exportOpen = false;

	function downloadFile(content, filename, type) {
		const blob = new Blob([content], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	function exportConvoAsMarkdown() {
		exportOpen = false;
		const lines = [];
		for (const msg of convo.messages) {
			if (msg.role === 'system') continue;
			if (!msg.content && !msg.toolcalls?.length) continue;
			const role = msg.role === 'user' ? '**You**' : '**Assistant**';
			let body = msg.content || '';
			if (msg.toolcalls?.length) {
				const names = msg.toolcalls.map((tc) => tc.name || 'tool').join(', ');
				body += (body ? '\n\n' : '') + `*[used tool: ${names}]*`;
			}
			lines.push(`${role}\n\n${body}\n\n---\n`);
		}
		downloadFile(lines.join('\n'), `conversation-${convo.id.slice(0, 8)}.md`, 'text/markdown');
	}

	function exportConvoAsJSON() {
		exportOpen = false;
		const data = {
			id: convo.id,
			time: convo.time,
			models: convo.models,
			messages: convo.messages
				.filter((m) => m.role !== 'system')
				.map((m) => ({
					role: m.role,
					content: m.content,
					model: m.model,
					time: m.time,
				})),
		};
		downloadFile(JSON.stringify(data, null, 2), `conversation-${convo.id.slice(0, 8)}.json`, 'application/json');
	}

	async function restoreConversation(skipGateCheck = false) {
		const params = new URLSearchParams(window.location.search);
		const gate = params.get('gate');

		let share;
		if (params.has('s')) {
			share = params.get('s');
		} else if (params.has('sl')) {
			try {
				const response = await fetch(`https://sync.three.ws/p/${params.get('sl')}/`);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				share = await response.text();
			} catch (e) {
				console.warn('[share] could not resolve shortened link:', e?.message || e);
				return false;
			}
		}
		if (!share) {
			return false;
		}

		// Token-gate: show wallet verify UI before loading the scene
		if (gate && !skipGateCheck) {
			activeGate = { id: gate, s: params.get('s'), sl: params.get('sl') };
			gateState = 'pending';
			return false;
		}

		try {
			let decoded = await decodeAndDecompress(share);
			if (Array.isArray(decoded)) {
				decoded = { name: 'Shared conversation', messages: decoded };
			}
			// Handle legacy format
			if (decoded.model) {
				decoded.models = [decoded.model];
				delete decoded.model;
			}
			let id = uuidv4();
			const existingShared = Object.values(convos).find((convo) => convo.shared);
			if (existingShared) {
				id = existingShared.id;
			}
			const convoData = {
				id,
				time: Date.now(),
				shared: true,
				models: decoded.models || [],
				messages: decoded.messages,
				versions: {},
				tools: [],
			};
			$convoId = convoData.id;
			convos[convoData.id] = convoData;
			convo = convoData;
			return true;
		} catch (err) {
			console.error('Error decoding shared conversation:', err);
		}
	}

	let models = [...BUILTIN_MODELS];

	let loading = false;

	function initializePWAStyles() {
		if (
			innerWidth < 640 &&
			(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone)
		) {
			document.body.classList.add('standalone');
		}
	}

	let installToastMsg = '';

	// Token-gate enforcement state
	let gateState = null; // null | 'pending' | 'checking' | 'denied'
	let gateError = '';
	let activeGate = null; // { id, s, sl }

	async function verifyGate(walletType) {
		gateState = 'checking';
		gateError = '';
		try {
			// Connect wallet to get address
			let address, signature;
			if (walletType === 'solana') {
				if (!window.solana) throw new Error('No Solana wallet found. Install Phantom or a compatible wallet.');
				await window.solana.connect();
				address = window.solana.publicKey.toString();
			} else {
				if (!window.ethereum) throw new Error('No EVM wallet found. Install MetaMask or a compatible wallet.');
				const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
				address = accounts[0];
			}

			// Phase 1: get nonce message
			const p1 = await fetch('/api/scene/gate-check', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ gateId: activeGate.id, walletAddress: address }),
			});
			if (!p1.ok) throw new Error('Gate check failed: ' + p1.status + ' ' + await p1.text());
			const { message } = await p1.json();

			// Sign message
			if (walletType === 'solana') {
				({ address, signature } = await signMessageSolana(message));
			} else {
				({ address, signature } = await signMessageEVM(message));
			}

			// Phase 2: verify
			const p2 = await fetch('/api/scene/gate-check', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ gateId: activeGate.id, walletAddress: address, signature, message }),
			});
			if (!p2.ok) {
				const body = await p2.json().catch(() => ({}));
				throw new Error(body.error_description || 'Verification failed');
			}
			const { allowed, reason } = await p2.json();

			if (allowed) {
				gateState = null;
				activeGate = null;
				await restoreConversation(true);
			} else {
				gateState = 'denied';
				gateError = reason || 'Access denied.';
			}
		} catch (e) {
			gateState = 'denied';
			gateError = e.message || 'Wallet verification failed.';
		}
	}

	let choiceHandler;
	async function makeChoice() {
		return new Promise((resolve) => {
			choiceHandler = (choice) => {
				resolve(choice);
			};
		});
	}

	let isChoosing = false;
	let question = '';
	let choices = [];
	let chose = null; // index
	export async function choose(newQuestion, newChoices) {
		chose = null;
		question = newQuestion;
		choices = newChoices;
		isChoosing = true;

		if (innerWidth < 1215) {
			toolcallModalOpen = true;
			const lastToolMessage = convo.messages[convo.messages.length - 1];
			const lastToolcall = lastToolMessage.toolcalls[lastToolMessage.toolcalls.length - 1];
			activeToolcall = lastToolcall;
		}

		const choseValue = await makeChoice();
		chose = choices.findIndex((c) => c === choseValue);
		isChoosing = false;

		if (innerWidth < 1215) {
			toolcallModalOpen = false;
			activeToolcall = null;
		}

		return choseValue;
	}

	$: window.convo = convo;
	$: window.saveConversation = saveConversation;

	$: {
		document.title = $brandConfig.name;
		document.documentElement.style.setProperty('--accent', $brandConfig.accent_color);
	}

	function syncRouteFromHash() {
		const hash = window.location.hash.slice(1) || 'chat';
		route.set(hash);
	}

	onMount(async () => {
		syncRouteFromHash();
		window.addEventListener('hashchange', syncRouteFromHash);

		// Populate auth state from session cookie
		await loadCurrentUser();

		// Default to the user's own agent when none is selected
		if ($currentUser && !$localAgentId && !$brandConfig.agent_id) {
			try {
				const agentRes = await fetch('/api/agents/me', { credentials: 'include' });
				if (agentRes.ok) {
					const { agent: agentData } = await agentRes.json();
					if (agentData?.id) localAgentId.set(agentData.id);
				}
			} catch {}
		}

		// Fetch global brand config from server
		try {
			const res = await fetch('/api/chat/config');
			if (res.ok) {
				const { data } = await res.json();
				if (data) brandConfig.set(data);
			}
		} catch {}

		// Clear old deprecated local storage data:
		localStorage.removeItem('tools');
		localStorage.removeItem('toolSchema');
		localStorage.removeItem('history');
		localStorage.removeItem('remoteServerAddress');

		// Populate params with default values, in case of old data:
		if ($params.messagesContextLimit == null) {
			$params.messagesContextLimit = 0;
		}
		if ($params.reasoningEffort == null) {
			$params.reasoningEffort = {
				'low-medium-high': 'high',
				range: 64000,
			};
		}

		// Init client tools with default values
		if ($toolSchema.length === 0 && !window.localStorage.getItem('initializedClientTools')) {
			$toolSchema = [...defaultToolSchema, pumpToolSchema, agentPaymentsToolSchema, pumpTradingToolSchema];
			window.localStorage.setItem('initializedClientTools', 'true');
		} else {
			// Add pump tool group for existing users who already initialized
			if (!$toolSchema.some(g => g.name === 'Pump.fun & Crypto')) {
				$toolSchema = [...$toolSchema, pumpToolSchema];
			}
			if (!$toolSchema.some(g => g.name === 'Agent Payments')) {
				$toolSchema = [...$toolSchema, agentPaymentsToolSchema];
			}
			if (!$toolSchema.some(g => g.name === 'Pump.fun Trading')) {
				$toolSchema = [...$toolSchema, pumpTradingToolSchema];
			}
			// Add any missing client tools to the client-side group
			const clientGroup = $toolSchema.find((g) => g.name === 'Client-side');
			const defaultClientGroup = defaultToolSchema.find((g) => g.name === 'Client-side');
			if (clientGroup && defaultClientGroup) {
				for (const tool of defaultClientGroup.schema) {
					const existingTool = clientGroup.schema.find(
						(t) => t?.clientDefinition?.id === tool.clientDefinition.id
					);
					if (!existingTool) {
						clientGroup.schema.push(tool);
					}
					// Or if we already have it, but any field differs
					else {
						if (JSON.stringify(existingTool) !== JSON.stringify(tool)) {
							Object.assign(existingTool, tool);
						}
					}
				}
			}
		}

		const urlParams = new URLSearchParams(window.location.search);
		const installId = urlParams.get('install');
		if (installId) {
			const pack = curatedToolPacks.find(p => p.id === installId);
			if (pack) {
				const alreadyInstalled = $toolSchema.some(g => g.name === pack.name);
				if (!alreadyInstalled) {
					$toolSchema = [...$toolSchema, { name: pack.name, schema: pack.schema }];
					installToastMsg = `Tool pack '${pack.name}' installed.`;
					setTimeout(() => { installToastMsg = ''; }, 3000);
				}
			}
			const url = new URL(window.location.href);
			url.searchParams.delete('install');
			window.history.replaceState({}, '', url.toString());
		}

		// One-time bootstrap of the x402 pay-per-call pack so every chat user
		// can immediately exercise paid MCP tools. Honors removal: once a user
		// uninstalls the pack from Tool Packs, the bootstrap flag prevents us
		// from forcing it back in. Also enables the pack's tools on the active
		// conversation if it's still empty, so the LLM sees them on the first
		// turn without requiring the user to dig through the Tools dropdown.
		try {
			if (!localStorage.getItem('x402PayPackBootstrapped')) {
				const x402Pack = curatedToolPacks.find((p) => p.id === 'x402-pay');
				if (x402Pack && !$toolSchema.some((g) => g.name === x402Pack.name)) {
					$toolSchema = [...$toolSchema, { name: x402Pack.name, schema: x402Pack.schema }];
				}
				if (x402Pack && convo && (convo.messages?.length ?? 0) === 0) {
					const names = x402Pack.schema.map((t) => t.function?.name).filter(Boolean);
					convo.tools = Array.from(new Set([...(convo.tools || []), ...names]));
					saveConversation(convo);
				}
				localStorage.setItem('x402PayPackBootstrapped', '1');
			}
		} catch (err) {
			// Best-effort bootstrap — e.g. Safari private mode blocks
			// localStorage. Don't break the rest of onMount over it.
			console.warn('[x402-pay] bootstrap failed:', err);
		}

		// When the user installs a Local skill from the Skills modal, auto-enable
		// the new tools in the current conversation so the LLM can call them on
		// the next turn — same UX as the x402-pay bootstrap above, but
		// triggered on-demand instead of once at startup. We only enable for
		// the active convo; other convos pick up the new tools through the
		// usual Tools dropdown.
		window.addEventListener('local-skill-installed', (e) => {
			try {
				const skill = e.detail?.skill;
				if (!skill || !convo) return;
				if (skill.kind === 'tool' && Array.isArray(skill.schema_json)) {
					const names = skill.schema_json
						.map((t) => t.function?.name || t.clientDefinition?.name)
						.filter(Boolean);
					if (names.length === 0) return;
					convo.tools = Array.from(new Set([...(convo.tools || []), ...names]));
					saveConversation(convo);
				}
			} catch (err) {
				console.warn('[local-skill] enable failed:', err);
			}
		});
		window.addEventListener('local-skill-uninstalled', (e) => {
			try {
				const skill = e.detail?.skill;
				if (!skill || !convo) return;
				if (skill.kind === 'tool' && Array.isArray(skill.schema_json)) {
					const names = new Set(
						skill.schema_json
							.map((t) => t.function?.name || t.clientDefinition?.name)
							.filter(Boolean),
					);
					convo.tools = (convo.tools || []).filter((n) => !names.has(n));
					saveConversation(convo);
				}
			} catch (err) {
				console.warn('[local-skill] disable failed:', err);
			}
		});

		initializePWAStyles();

		// Only probe the local tool server if the user has opted in or clearly
		// configured it (non-empty password, or non-default address). Otherwise
		// the probe to localhost:8081 fails noisily for users who haven't
		// started the helper.
		const remoteServerConfigured =
			$remoteServer.password !== '' ||
			$remoteServer.address !== '';
		if ($localProvidersEnabled || remoteServerConfigured) {
			try {
				tree = await (
					await fetch(`${$remoteServer.address}/list_directory`, {
						method: 'GET',
						headers: {
							Authorization: `Basic ${$remoteServer.password}`,
						},
					})
				).json();
			} catch (error) {
				console.debug(
					`[tool server] not detected at ${$remoteServer.address} — start it if you want local tools.`
				);
			}
		}

		loading = true;

		// Fetch all free models from the server (no user API key needed) alongside user's provider models
		const [serverFreeModels, userModels] = await Promise.all([
			fetch('/api/chat/models')
				.then((r) => r.json())
				.then(({ data }) =>
					(data ?? []).map((m) => ({
						id: m.id,
						name: m.name,
						provider: 'Built-in',
						modality: 'text->text',
					}))
				)
				.catch(() => []),
			fetchModels({
				onFinally: () => {
					loading = false;
				},
			}),
		]);

		// Merge: server free models first (deduplicated), then user's API-key models
		const seenIds = new Set(serverFreeModels.map((m) => m.id));
		models = [...serverFreeModels, ...userModels.filter((m) => !seenIds.has(m.id))];

		// Auto-select default built-in model if no model chosen yet, or if the saved model no longer exists
		const savedModelStillValid = convo.models?.[0]?.id && models.some((m) => m.id === convo.models[0].id);
		if (!savedModelStillValid) {
			const defaultId = $brandConfig.default_model;
			const defaultModel = models.find((m) => m.id === defaultId) ?? BUILTIN_MODELS[0];
			if (defaultModel) convo = { ...convo, models: [defaultModel] };
		}
	});

	// For displaying compact tools, we need to collapse sequences of Assistant and Tool messages into a single message
	// inside which we'll display all the tool calls.
	// Returns a list of ranges of messages containing the start and end indices of messages that should be collapsed.
	let collapsedRanges = [];
	$: if (!$config.explicitToolView) {
		collapsedRanges = [];
		let range = { starti: null, endi: null };
		for (let i = convo.messages.length - 1; i >= 0; i--) {
			if (
				convo.messages[i].role === 'tool' ||
				(convo.messages[i].role === 'assistant' &&
					convo.messages[i].toolcalls &&
					i !== convo.messages.length - 1)
			) {
				if (range.endi === null) {
					range.endi = i + 1;
				}
			} else {
				if (range.endi !== null) {
					range.starti = i + 1;
					collapsedRanges.push(range);
					collapsedRanges = collapsedRanges;
					range = { starti: null, endi: null };
				}
			}
		}
	}

	let savedTime = 0;
	let video;

	// Floating 3D agent
	let agentEl;
	let talkingHead;
	let talkingHeadReady = false;
	let pendingSpeak = null;
	let agentReady = false;
	let agentPendingSpeak = null;
	let agentVisible = true;
	let agentScriptLoaded = false;
	let prevThoughtBubbleActive = false;
	let thinkingTransitioning = false;
	let agentPickerOpen = false;
	let showAgentSettings = false;

	// Walk while tokens are actively arriving. `generating` flips false the
	// instant the network stream ends, but we want the avatar to keep walking
	// until rendering settles — 600ms tail bridges micro-pauses between tokens
	// and the gap between last token and DOM paint.
	let tokensFlowing = false;
	let _tokensFlowingTimer = null;
	function pulseTokens() {
		tokensFlowing = true;
		if (_tokensFlowingTimer) clearTimeout(_tokensFlowingTimer);
		_tokensFlowingTimer = setTimeout(() => { tokensFlowing = false; }, 600);
	}

	// Live thought bubble above the avatar — streams the active reasoning,
	// then collapses to a "Thought for Xs" summary while the response streams.
	let thoughtBubbleEl;
	$: thinkingMessage = (() => {
		const msgs = convo?.messages;
		if (!msgs?.length || !generating) return null;
		const last = msgs[msgs.length - 1];
		if (!last || last.role !== 'assistant' || !last.reasoning) return null;
		return last;
	})();
	$: thoughtBubbleActive = !!thinkingMessage?.thinking;
	$: thoughtBubbleText = thinkingMessage?.thoughts || '';
	$: thoughtBubbleSeconds = thinkingMessage?.thinkingTime
		? thinkingMessage.thinkingTime < 1 ? '<1' : Math.ceil(thinkingMessage.thinkingTime)
		: 0;
	$: if (thoughtBubbleEl && thoughtBubbleActive && thoughtBubbleText) {
		// Auto-scroll to bottom as tokens stream in
		queueMicrotask(() => {
			if (thoughtBubbleEl) thoughtBubbleEl.scrollTop = thoughtBubbleEl.scrollHeight;
		});
	}

	// Drag state for the floating agent widget
	/** @type {{ x: number | null, y: number | null }} */
	let dragPos = { x: null, y: null };
	let dragging = false;
	let dragOffset = { x: 0, y: 0 };
	let dragStart = { x: 0, y: 0 };
	let dragMoved = false;
	/** @type {'dying' | 'falling' | null} */
	let avatarExitAnim = null;

	/** @param {MouseEvent} e */
	function onAvatarDragStart(e) {
		if (e.button !== 0) return;
		if (/** @type {HTMLElement} */ (e.target).closest('button, input, a, select')) return;
		if (avatarExitAnim) return;
		e.preventDefault();
		const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		dragStart = { x: e.clientX, y: e.clientY };
		dragMoved = false;
		dragging = true;
		window.addEventListener('mousemove', onAvatarDragMove);
		window.addEventListener('mouseup', onAvatarDragEnd);
	}

	/** @param {MouseEvent} e */
	function onAvatarDragMove(e) {
		if (!dragging) return;
		if (!dragMoved && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 5) {
			dragMoved = true;
		}
		if (!dragMoved) return;
		const aw = agentEl?.offsetWidth || 420;
		const ah = agentEl?.offsetHeight || 700;
		const x = Math.max(0, Math.min(window.innerWidth - aw, e.clientX - dragOffset.x));
		const y = Math.max(0, Math.min(window.innerHeight - ah, e.clientY - dragOffset.y));
		dragPos = { x, y };
	}

	function onAvatarDragEnd() {
		const wasClick = dragging && !dragMoved;
		dragging = false;
		window.removeEventListener('mousemove', onAvatarDragMove);
		window.removeEventListener('mouseup', onAvatarDragEnd);
		if (wasClick) killAvatar();
	}

	function killAvatar() {
		if (!agentVisible || avatarExitAnim) return;
		avatarExitAnim = 'dying';
		try { agentEl?.play?.('dying', { loop: false }); } catch {}
		setTimeout(() => {
			agentVisible = false;
			avatarExitAnim = null;
		}, 1200);
	}

	function reviveAvatar() {
		if (agentVisible) return;
		avatarExitAnim = 'falling';
		agentVisible = true;
		const playFalling = () => { try { agentEl?.play?.('falling', { loop: false }); } catch {} };
		let attempts = 0;
		const tryPlay = () => {
			if (agentEl && agentReady) { playFalling(); return; }
			if (agentEl) { agentEl.addEventListener('agent:ready', playFalling, { once: true }); return; }
			if (attempts++ < 40) setTimeout(tryPlay, 50);
		};
		tryPlay();
		setTimeout(() => { avatarExitAnim = null; }, 1200);
	}

	$: effectiveAgentId = $localAgentId || $brandConfig.agent_id || '';

	$: if (effectiveAgentId && !agentScriptLoaded) {
		agentScriptLoaded = true;
		const s = document.createElement('script');
		s.type = 'module';
		s.src = '/agent-3d/latest/agent-3d.js';
		document.head.appendChild(s);
	}

	// Expose to client tools
	$: if (agentEl) window.__threewsAgent = agentEl;

	$: if (agentEl && !agentReady) {
		agentEl.addEventListener('agent:ready', () => {
			agentReady = true;
			// Re-frame once the canvas has its final on-screen size — the
			// internal framing happens at load time, before our ResizeObserver
			// has reacted to the host's actual width/height. Without this, the
			// avatar's feet can clip on first render at large element sizes.
			try {
				requestAnimationFrame(() => {
					try { agentEl._viewer?.resize?.(); } catch {}
					try { agentEl._viewer?.frameContent?.(); } catch {}
				});
			} catch {}
			if (!avatarExitAnim) {
				// STEP 1: force walk so we can verify the clip plays at all.
				playClipWithFallback(agentEl, 'walk', ['walking', 'Walk', 'Walking', 'run', 'Run', 'idle']);
			}
			if (agentPendingSpeak) {
				agentEl.speak(agentPendingSpeak);
				agentPendingSpeak = null;
			}
		}, { once: true });
	}

	function playClipWithFallback(el, primary, fallbacks = []) {
		if (!el) return;
		const tryNext = (names) => {
			if (!names.length) return;
			const [name, ...rest] = names;
			Promise.resolve(el.play(name, { loop: true }))
				.catch(() => tryNext(rest));
		};
		tryNext([primary, ...fallbacks]);
	}

	// STEP 1 watchdog. playClipByName fires-and-forgets, the agent-3d itself
	// kicks idle right after scene init, the embedded GLB may have its own
	// 'idle' on a separate mixer, and any of half a dozen handlers can call
	// _stopWalkAnimation. Poll and brute-force walk until it sticks.
	let walkWatchdogTimer = null;
	let _walkDiagLogged = false;
	function ensureWalkPlaying() {
		if (!agentEl) { return; }
		if (!agentReady) { return; }
		if (avatarExitAnim) return;

		// Blocker #1: explicit attribute disable
		if (agentEl.getAttribute('avatar-walk') === 'off') {
			agentEl.removeAttribute('avatar-walk');
		}
		// Blocker #2: prefers-reduced-motion (browsers with this on never start walk)
		// We can't change the OS pref, but we sidestep agent-3d's _onStreamChunk
		// path entirely by calling play() directly. So — no early return here.

		// Blocker #3: agent-3d's internal _isWalking flag stuck true ⇒ _onStreamChunk
		// no-ops. Reset it so any future stream chunks can re-trigger walk too.
		try { agentEl._isWalking = false; } catch {}
		clearTimeout(agentEl._walkStopDebounce);

		const viewer = agentEl._scene?.viewer;
		const am = viewer?.animationManager;
		// Blocker #4: stale failure marker on the manager
		if (am?._failed?.has?.('walk')) am._failed.delete('walk');

		// Blocker #5: dual-mixer fight. The viewer has a mixer for embedded GLB
		// clips; the AnimationManager has its own mixer for external clips. Both
		// bind to the same model and both run every frame, so an embedded "idle"
		// keeps stomping bones even when we play external "walk". Stop the
		// embedded mixer so only the manager animates.
		try { viewer?.mixer?.stopAllAction?.(); } catch {}

		const candidates = ['walk', 'walking', 'Walk', 'Walking', 'run', 'Run'];
		const alreadyWalking = am && candidates.includes(am.currentName);

		// Blocker #6: viewer.state.actionStates['idle'] = true keeps _animating on
		// for the embedded mixer and re-arms idle every render. Clear it.
		try {
			const actionStates = viewer?.state?.actionStates;
			if (actionStates) for (const k of Object.keys(actionStates)) actionStates[k] = false;
		} catch {}

		if (!_walkDiagLogged) {
			_walkDiagLogged = true;
			const embedded = (viewer?.clips || []).map(c => c.name);
			const externalDefs = (am?._animationDefs || []).map(d => d.name);
			const externalLoaded = am?.clips ? Array.from(am.clips.keys()) : [];
			console.log('[avatar walk diag]', {
				agentReady, isWalking: agentEl._isWalking,
				avatarWalkAttr: agentEl.getAttribute('avatar-walk'),
				prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
				embeddedClips: embedded, externalDefs, externalLoaded,
				currentClip: am?.currentName, alreadyWalking,
			});
		}

		if (alreadyWalking) return;

		(async () => {
			try { await am?.ensureLoaded?.('walk'); } catch {}
			if (am && am.currentName === 'walk') am.currentName = null; // bypass crossfade short-circuit
			playClipWithFallback(agentEl, 'walk', ['walking', 'Walk', 'Walking', 'run', 'Run']);
		})();
	}

	// STEP 1: force the walking animation always so we can confirm it plays.
	// (Idle / think switching deliberately disabled while we verify the walk clip.)
	$: if (agentEl && agentReady && !avatarExitAnim && !thinkingTransitioning) {
		ensureWalkPlaying();
		clearInterval(walkWatchdogTimer);
		walkWatchdogTimer = setInterval(ensureWalkPlaying, 500);
	}

	// When thinking ends, play a one-shot falling animation before resuming the loop.
	$: {
		const wasActive = prevThoughtBubbleActive;
		prevThoughtBubbleActive = thoughtBubbleActive;
		if (wasActive && !thoughtBubbleActive && agentEl && agentReady && !avatarExitAnim) {
			thinkingTransitioning = true;
			try { agentEl.play('falling', { loop: false }); } catch {}
			setTimeout(() => {
				thinkingTransitioning = false;
				if (agentEl && agentReady && !avatarExitAnim) {
					agentEl.play((generating || tokensFlowing) ? 'walk' : 'idle', { loop: true }).catch(() => {});
				}
			}, 1200);
		}
	}

	$: if (effectiveAgentId) {
		agentReady = false;
		agentPendingSpeak = null;
	}

	// Inject 3D agent tools into schema when an agent is active
	$: if (effectiveAgentId) {
		const hasGroup = $toolSchema.some(g => g.name === '3D Agent');
		if (!hasGroup) $toolSchema = [...$toolSchema, agentToolSchema];
	}

	function detectEmotion(text) {
		const t = text.toLowerCase();
		const scores = { concern: 0, celebration: 0, curiosity: 0, empathy: 0, patience: 0 };

		if (/\b(error|failed|can't|cannot|unable to|unfortunately|issue|problem|broken|doesn't work)\b/.test(t)) scores.concern += 2;
		if (/\b(sorry|apologize|my mistake|incorrect)\b/.test(t)) scores.concern += 1;

		if (/\b(great|excellent|perfect|congrats|congratulations|amazing|wonderful|fantastic|awesome|well done)\b/.test(t)) scores.celebration += 2;
		if (/\b(success|worked|solved|fixed|done|completed)\b/.test(t)) scores.celebration += 1;

		if (/\b(interesting|fascinating|curious|wonder|surprising|actually|notably|worth knowing)\b/.test(t)) scores.curiosity += 2;
		if (/\?/.test(text)) scores.curiosity += 1;

		if (/\b(understand|i see|that makes sense|must be|difficult|hard|tough|challenging|frustrating)\b/.test(t)) scores.empathy += 2;
		if (/\b(feel|sounds like|i hear you)\b/.test(t)) scores.empathy += 1;

		if (/\b(let me|one moment|working on|processing|calculating|give me a|just a)\b/.test(t)) scores.patience += 2;

		if (/\bcan't wait\b/.test(t)) scores.concern -= 2;
		if (/\bno problem\b/.test(t)) scores.concern -= 2;

		const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
		return top[1] >= 2 ? top[0] : null;
	}

	$: if ($mode !== 'website') websiteCategory.set(null);

	function speakLastMessage() {
		const last = [...convo.messages].reverse().find((m) => m.role === 'assistant' && m.content);
		if (!last?.content) return;

		if (agentEl && effectiveAgentId) {
			if (agentReady) {
				agentEl.speak(last.content);
				const emotion = detectEmotion(last.content);
				if (emotion) setTimeout(() => agentEl?.expressEmotion(emotion), 600);
			} else {
				agentPendingSpeak = last.content;
			}
		} else if ($talkingHeadEnabled && agentVisible) {
			if (talkingHeadReady) {
				const mood = detectEmotion(last.content);
				if (mood) talkingHead.setMood(mood);
				talkingHead.speak({ text: last.content, mood: mood || 'neutral' });
			} else {
				pendingSpeak = last.content;
			}
		}

		if ($ttsEnabled && window.speechSynthesis && !$talkingHeadEnabled) {
			window.speechSynthesis.cancel();
			const utt = new SpeechSynthesisUtterance(last.content);
			window.speechSynthesis.speak(utt);
		}
	}

	$: if ($talkingHeadAvatarUrl) {
		talkingHeadReady = false;
		pendingSpeak = null;
	}

	function onTalkingHeadReady() {
		talkingHeadReady = true;
		if (pendingSpeak) {
			talkingHead.speak({ text: pendingSpeak });
			pendingSpeak = null;
		}
	}

	async function generateTitle() {
		if (convo.title) return;
		const msgs = convo.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
		if (msgs.length < 2) return;

		const model = convo.models[0];
		if (!model?.id) return;
		const provider = providers.find((p) => p.name === model.provider);
		if (!provider) return;

		const context = msgs
			.slice(0, 4)
			.map((m) => `${m.role}: ${(typeof m.content === 'string' ? m.content : '').slice(0, 300)}`)
			.join('\n');

		try {
			const response = await fetch(`${provider.url}${provider.completionUrl}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(model.provider === 'Anthropic'
						? { 'x-api-key': provider.apiKeyFn(), 'anthropic-version': '2023-06-01' }
						: { Authorization: `Bearer ${provider.apiKeyFn()}` }),
				},
				body: JSON.stringify({
					model: model.id,
					stream: false,
					max_tokens: 20,
					messages: [
						{
							role: 'user',
							content: `Summarize this conversation in 4-6 words as a title. No quotes, no punctuation.\n\n${context}`,
						},
					],
				}),
			});
			if (!response.ok) return;
			const data = await response.json();
			const title =
				data?.choices?.[0]?.message?.content?.trim() || data?.content?.[0]?.text?.trim();
			if (title) {
				convo.title = title;
				saveConversation(convo);
				convos = { ...convos, [convo.id]: convo };
			}
		} catch {
			// Non-critical, fail silently
		}
	}

	let showSkillsMarketplace = false;

	function removeSkill(name) {
		toolSchema.update(groups => groups.filter(g => g.name !== name));
	}
</script>

<svelte:window
	bind:innerWidth
	on:touchstart={closeSidebars}
	on:click={closeSidebars}
	on:keydown={(event) => {
		if (
			event.key === 'Escape' &&
			generating &&
			convo.messages.filter((msg) => msg.generated).length > 0
		) {
			handleAbort();
		}
		if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			const branchedMessages = convo.messages
				.map((m, idx) => ({ m, idx }))
				.filter(({ m }) => m.vid && convo.versions?.[m.vid]?.length > 1);
			if (branchedMessages.length === 0) return;
			const { m, idx } = branchedMessages[branchedMessages.length - 1];
			const dir = event.key === 'ArrowLeft' ? -1 : 1;
			shiftVersion(dir, m, idx);
			event.preventDefault();
		}
	}}
/>

{#if generating && new URLSearchParams(window.location.search).get('vibe') === 'true'}
	<video
		transition:fade={{ duration: 1000 }}
		src="{import.meta.env.BASE_URL}peace.mp4"
		class="fixed left-0 top-0 z-[1000] h-screen w-screen object-cover"
		autoplay
		loop
		bind:this={video}
		on:timeupdate={() => {
			savedTime = video.currentTime;
		}}
		on:loadeddata={() => {
			if (savedTime > 0) {
				video.currentTime = savedTime;
			}
		}}
	/>
{/if}

{#if $route === 'pricing'}
  <div class="min-h-dvh bg-paper">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <Pricing />
  </div>
{:else if $route === 'signin' || $route === 'signup'}
  <div class="min-h-dvh bg-paper">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <AuthPage kind={$route} />
  </div>
{:else if $route.startsWith('solutions/') || $route.startsWith('business/')}
  <div class="min-h-dvh bg-paper">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <MarketingPage slug={$route} />
  </div>
{:else if $route.startsWith('events/')}
  <div class="min-h-dvh bg-paper overflow-y-auto">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <EventsPage slug={$route} />
  </div>
{:else if $route.startsWith('resources/')}
  <div class="min-h-dvh bg-paper">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <ResourcePage slug={$route.slice('resources/'.length)} />
  </div>
{:else if $route === 'dashboard/revenue'}
  <div class="min-h-dvh bg-[#F5F4EF]">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <RevenueDashboard />
  </div>
{:else if $route.startsWith('features/')}
  <div class="min-h-dvh bg-paper overflow-y-auto">
    <div class="sticky top-0 z-[110]"><TopNav /></div>
    <FeaturePage slug={$route.slice('features/'.length)} />
  </div>
{:else}
<main class="flex h-dvh w-screen flex-col">
	<div class="sticky top-0 z-[110]">
		<TopNav />
	</div>
	<div class="flex h-12 items-center gap-1 px-2 py-1 md:hidden">
		<button
			on:click={newConversation}
			class="flex rounded-full p-2 transition-colors hover:bg-gray-100"
		>
			<Icon icon={feStar} strokeWidth={3} class="ml-auto h-4 w-4 text-slate-700" />
		</button>
		<button
			data-trigger="history"
			class="flex rounded-full p-2 transition-colors hover:bg-gray-100"
			on:click={() => (historyOpen = !historyOpen)}
		>
			<Icon icon={feMenu} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
		</button>

		<ModelSelector
			{convo}
			{models}
			on:change={({ detail }) => {
				convo.models = [detail];
				saveConversation(convo);
			}}
			on:changeMulti={({ detail }) => {
				if (convo.models.find((m) => m.id === detail.id)) {
					convo.models = convo.models.filter((m) => m.id !== detail.id);
				} else {
					convo.models = [...(convo.models || []), detail];
				}
				saveConversation(convo);
			}}
			class="!absolute left-1/2 z-[99] -translate-x-1/2"
		/>

		<button
			class="ml-auto flex rounded-full p-2 transition-colors hover:bg-gray-100"
			use:flash
			on:click={shareConversation}
		>
			<Icon icon={feShare} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
		</button>
		<div class="relative">
			<button
				class="flex rounded-full p-2 transition-colors hover:bg-gray-100 disabled:opacity-40"
				on:click={() => (exportOpen = !exportOpen)}
				disabled={convo.messages.length === 0}
				title="Export conversation"
			>
				<Icon icon={feDownload} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
			</button>
			{#if exportOpen}
				<button
					class="fixed inset-0 z-20 cursor-default"
					aria-hidden="true"
					tabindex="-1"
					on:click={() => (exportOpen = false)}
				/>
				<div class="absolute right-0 top-full mt-1 z-30 w-48 rounded-xl border border-[#E5E3DC] bg-white p-1 shadow-pop">
					<button
						class="flex h-9 w-full items-center rounded-lg px-3 text-sm font-medium text-[#1A1A1A] hover:bg-[#F5F4EF]"
						on:click={exportConvoAsMarkdown}
					>Export as Markdown</button>
					<button
						class="flex h-9 w-full items-center rounded-lg px-3 text-sm font-medium text-[#1A1A1A] hover:bg-[#F5F4EF]"
						on:click={exportConvoAsJSON}
					>Export as JSON</button>
				</div>
			{/if}
		</div>
		<button
			data-trigger="knobs"
			class="flex rounded-full p-2 transition-colors hover:bg-gray-100"
			on:click={() => (knobsOpen = !knobsOpen)}
		>
			<Icon icon={feSidebar} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
		</button>
	</div>
	<div class="relative flex h-full flex-1 overflow-hidden">
		{#if convo.messages.length > 0}
		<aside
			data-sidebar="history"
			class="{historyOpen
				? ''
				: '-translate-x-full'} fixed top-0 z-[100] flex h-full w-[260px] flex-col border-r border-rule bg-paper pl-3 pt-4 transition-transform duration-500 ease-in-out md:static md:translate-x-0"
		>
			<div class="mb-1 pr-3">
				<button
					on:click={newConversation}
					class="three.ws-btn-primary flex w-full items-center justify-start gap-2 rounded-full px-4 py-2.5"
				>
					<span class="text-base font-medium leading-none">+</span>
					{$t('newChat')}
				</button>
			</div>
			<input
				type="search"
				placeholder="Search conversations..."
				bind:value={searchQuery}
				class="mx-2 my-2 w-[calc(100%-16px)] rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
			/>
			<ol
				class="flex list-none flex-col overflow-y-auto pb-3 pr-3 pt-1 scrollbar-invisible scrollbar-slim hover:scrollbar-white"
			>
				{#if filteredConvos}
					{#if filteredConvos.length === 0}
						<li class="px-3 py-4 text-center text-sm text-slate-400">No conversations found</li>
					{:else}
						{#each filteredConvos.sort((a, b) => b.time - a.time) as historyConvo (historyConvo.id)}
							{@const matchingMsg = historyConvo.messages.find(
								(m) =>
									typeof m.content === 'string' &&
									m.content.toLowerCase().includes(searchQuery.toLowerCase())
							)}
							<li class="group relative">
								<button
									on:click={() => {
										handleAbort();
										historyOpen = false;
										activeToolcall = null;
										searchQuery = '';
										$convoId = historyConvo.id;
										convo = convos[$convoId];
										cleanShareLink();
										tick().then(() => { scrollToBottom(); });
									}}
									class="{$convoId === historyConvo.id
										? 'bg-paper-deep'
										: ''} flex w-full flex-col rounded-md px-3 py-1.5 text-left text-sm text-ink hover:bg-paper-deep"
								>
									<span class="line-clamp-1">
										{#if historyConvo.agentId}
											<span class="text-[10px] text-indigo-400 mr-1">[agent]</span>
										{/if}
										{historyConvo.title || (historyConvo.messages.length === 0
											? 'New conversation'
											: historyConvo.messages
													.find((m) => m.role === 'user')
													?.content?.split(' ')
													.slice(0, 5)
													.join(' ') || 'New conversation')}
									</span>
									{#if matchingMsg}
										<p class="truncate text-xs text-slate-400">
											...{matchingMsg.content.slice(
												Math.max(0, matchingMsg.content.toLowerCase().indexOf(searchQuery.toLowerCase()) - 20),
												matchingMsg.content.toLowerCase().indexOf(searchQuery.toLowerCase()) + 60
											)}...
										</p>
									{/if}
								</button>
								<button
									on:click={() => {
										if ($convoId === historyConvo.id) {
											const newId = Object.values(convos).find(
												(e) => e.id !== historyConvo.id && !e.shared
											)?.id;
											if (!newId) {
												newConversation();
											} else {
												$convoId = newId;
											}
										}
										delete convos[historyConvo.id];
										convos = convos;
										deleteConversation(historyConvo);
									}}
									class="z-1 absolute right-0 top-0 flex h-full w-12 rounded-br-md rounded-tr-md bg-gradient-to-l {$convoId ===
									historyConvo.id
										? 'from-paper-deep'
										: 'from-paper group-hover:from-paper-deep'} from-65% to-transparent pr-3 transition-opacity sm:from-paper-deep sm:opacity-0 sm:group-hover:opacity-100"
								>
									<Icon icon={feTrash} class="m-auto mr-0 h-3 w-3 shrink-0 text-ink-soft" />
								</button>
							</li>
						{/each}
					{/if}
				{:else}
					{#each historyBuckets as { relativeDate, convos: historyConvos } (relativeDate)}
						<li class="mb-1 ml-3 text-[11px] font-medium text-ink-soft [&:not(:first-child)]:mt-5">
							{relativeDate}
						</li>
						{#each historyConvos as historyConvo (historyConvo.id)}
							<li class="group relative">
								{#if editingTitleId === historyConvo.id}
									<div class="{$convoId === historyConvo.id ? 'bg-paper-deep' : ''} flex h-9 w-full items-center rounded-md px-3">
										<input
											class="w-full bg-transparent text-sm text-ink outline-none"
											bind:value={historyConvo.title}
											on:blur={() => { saveConversation(historyConvo); convos = { ...convos }; editingTitleId = null; }}
											on:keydown={(e) => e.key === 'Enter' && e.target.blur()}
											use:focusOnMount
										/>
									</div>
								{:else}
									<button
										on:click={() => {
											handleAbort();

											historyOpen = false;
											activeToolcall = null;

											$convoId = historyConvo.id;
											convo = convos[$convoId];

											cleanShareLink();

											tick().then(() => {
												scrollToBottom();
											});
										}}
										class="{$convoId === historyConvo.id
											? 'bg-paper-deep'
											: ''} flex h-9 w-full items-center rounded-md px-3 text-left text-sm text-ink hover:bg-paper-deep"
									>
										<span
											class="line-clamp-1"
											on:dblclick|stopPropagation={() => { editingTitleId = historyConvo.id; }}
										>
											{historyConvo.title || (historyConvo.messages.length === 0
												? 'New conversation'
												: historyConvo.messages
														.find((m) => m.role === 'user')
														?.content?.split(' ')
														.slice(0, 5)
														.join(' ') || 'New conversation')}
										</span>
									</button>
								{/if}
								<button
									on:click={() => {
										if ($convoId === historyConvo.id) {
											const newId = Object.values(convos).find(
												(e) => e.id !== historyConvo.id && !e.shared
											)?.id;
											if (!newId) {
												newConversation();
											} else {
												$convoId = newId;
											}
										}
										delete convos[historyConvo.id];
										convos = convos;
										deleteConversation(historyConvo);
									}}
									class="z-1 absolute right-0 top-0 flex h-full w-12 rounded-br-md rounded-tr-md bg-gradient-to-l {$convoId ===
									historyConvo.id
										? 'from-paper-deep'
										: 'from-paper group-hover:from-paper-deep'} from-65% to-transparent pr-3 transition-opacity sm:from-paper-deep sm:opacity-0 sm:group-hover:opacity-100"
								>
									<Icon icon={feTrash} class="m-auto mr-0 h-3 w-3 shrink-0 text-ink-soft" />
								</button>
							</li>
						{/each}
					{/each}
				{/if}
			</ol>

			<div class="settings-trigger-container -ml-3 mt-auto flex pb-3">
				<button
					data-trigger="settings"
					class="mx-3 flex flex-1 items-center gap-x-4 rounded-lg border border-rule px-4 py-3 text-left text-sm font-medium hover:bg-paper-deep"
					on:click={() => {
						historyOpen = false;
					}}
				>
					{$t('settings')}
					<Icon icon={feSettings} class="ml-auto h-4 w-4 text-ink-soft" />
				</button>
			</div>
		</aside>
		{/if}
		<div class="flex flex-1 flex-col">
			<div class="relative hidden items-center px-2 py-2 md:flex">
				<ModelSelector
					{convo}
					{models}
					on:change={({ detail }) => {
						convo.models = [detail];
						saveConversation(convo);
					}}
					on:changeMulti={({ detail }) => {
						if (convo.models.find((m) => m.id === detail.id)) {
							convo.models = convo.models.filter((m) => m.id !== detail.id);
						} else {
							convo.models = [...(convo.models || []), detail];
						}
						saveConversation(convo);
					}}
					class="!absolute left-1/2 z-[99] -translate-x-1/2"
				/>

				<button
					class="ml-auto flex rounded-full p-3 transition-colors hover:bg-gray-100"
					use:flash
					on:click={shareConversation}
				>
					<Icon icon={feShare} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
				</button>
				<div class="relative">
					<button
						class="flex rounded-full p-3 transition-colors hover:bg-gray-100 disabled:opacity-40"
						on:click={() => (exportOpen = !exportOpen)}
						disabled={convo.messages.length === 0}
						title="Export conversation"
					>
						<Icon icon={feDownload} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
					</button>
					{#if exportOpen}
						<button
							class="fixed inset-0 z-20 cursor-default"
							aria-hidden="true"
							tabindex="-1"
							on:click={() => (exportOpen = false)}
						/>
						<div class="absolute right-0 top-full mt-1 z-30 w-48 rounded-xl border border-[#E5E3DC] bg-white p-1 shadow-pop">
							<button
								class="flex h-9 w-full items-center rounded-lg px-3 text-sm font-medium text-[#1A1A1A] hover:bg-[#F5F4EF]"
								on:click={exportConvoAsMarkdown}
							>Export as Markdown</button>
							<button
								class="flex h-9 w-full items-center rounded-lg px-3 text-sm font-medium text-[#1A1A1A] hover:bg-[#F5F4EF]"
								on:click={exportConvoAsJSON}
							>Export as JSON</button>
						</div>
					{/if}
				</div>
				<button
					class="relative flex items-center gap-1 rounded-full p-3 transition-colors hover:bg-gray-100"
					on:click={() => (showSkillsMarketplace = true)}
					title="Skills Marketplace"
				>
					<Icon icon={feGrid} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
					<span class="hidden sm:inline text-[12px] text-slate-700">Skills</span>
					{#if $toolSchema.length > 0}
						<span class="ml-1 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[10px] text-white">{$toolSchema.length}</span>
					{/if}
				</button>
				<button
					data-trigger="knobs"
					class="flex rounded-full p-3 transition-colors hover:bg-gray-100"
					on:click={() => (knobsOpen = !knobsOpen)}
				>
					<Icon icon={feSidebar} strokeWidth={3} class="m-auto h-4 w-4 text-slate-700" />
				</button>
			</div>

			{#if convo.messages.length === 0}
				<div class="flex h-full w-full overflow-y-auto">
					<EmptyState>
						<svelte:fragment slot="composer">
							<Composer
								bind:generating
								bind:convo
								{saveMessage}
								{saveConversation}
								{submitCompletion}
								{scrollToBottom}
								{handleAbort}
								{tree}
								bind:inputTextareaEl
								bind:handleFileDrop
								placeholder={$mode === 'website' ? 'Describe the website you want to build' : $t('typeMessage')}
								mode={$mode}
								modes={[{ id: 'website', label: 'Website' }]}
								onModeClear={() => mode.set(null)}
							/>
						</svelte:fragment>
						<svelte:fragment slot="chips">
							{#if $mode === 'website'}
								<WebsiteFlow />
							{:else if $mode === 'desktop'}
								<DesktopFlow />
							{:else}
								<SuggestionChips />
							{/if}
						</svelte:fragment>
					</EmptyState>
				</div>
			{:else}
				<div class="flex h-full w-full">
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div
						class="{splitView
							? 'w-[50%]'
							: 'w-full'} relative max-h-[calc(100vh-49px)] transition-[width] duration-500 ease-in-out"
						on:dragover={(event) => {
							event.preventDefault();
						}}
						on:drop={handleFileDrop}
					>
						<div
							bind:this={scrollableEl}
							class="{splitView
								? 'scrollbar-none'
								: 'scrollbar-ultraslim'} scrollable flex h-full w-full flex-col overflow-y-auto pb-[128px]"
							on:scroll={() => {
								const { scrollTop, scrollHeight, clientHeight } = scrollableEl;
								if (scrollTop < previousScrollTop) {
									autoscrollCanceled = true;
								} else if (scrollHeight - scrollTop - clientHeight <= 5) {
									autoscrollCanceled = false;
								}
								previousScrollTop = scrollTop;
							}}
						>
							<ul
							class="max-w-[760px] mx-auto w-full px-6 !list-none flex flex-col relative {splitView ? 'rounded-br-lg border-r' : ''}"
						>
								{#each convo.messages as message, i (message.id)}
									<Message
										{message}
										{i}
										{convo}
										{generating}
										{collapsedRanges}
										{saveMessage}
										{deleteMessage}
										{saveVersion}
										{saveConversation}
										{shiftVersion}
										{insertSystemPrompt}
										{submitCompletion}
										{isChoosing}
										{choiceHandler}
										{question}
										{choices}
										bind:chose
										bind:activeToolcall
										bind:textareaEls
										on:rerender={() => {
											convo.messages = convo.messages;
										}}
									/>
								{/each}


							</ul>
						</div>

						<div class="pointer-events-none absolute bottom-[72px] inset-x-0 h-8 z-[98] bg-gradient-to-t from-paper to-transparent" />
						{#if $toolSchema.length > 0 || (effectiveAgentId || $talkingHeadEnabled)}
							<div class="flex flex-wrap gap-1.5 px-4 pt-2 pb-0">
								{#each $toolSchema as group}
									<span class="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-medium text-indigo-700">
										{group.name}
										<button
											class="ml-0.5 rounded-full p-0.5 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600"
											on:click={() => removeSkill(group.name)}
											aria-label="Remove {group.name}"
										>
											<Icon icon={feX} class="h-2.5 w-2.5" />
										</button>
									</span>
								{/each}
								<button
									class="text-[11px] text-slate-400 hover:text-slate-600"
									on:click={() => (showSkillsMarketplace = true)}
								>
									+ Add skill
								</button>
								{#if effectiveAgentId || $talkingHeadEnabled}
									<button
										class="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
										on:click={agentVisible ? killAvatar : reviveAvatar}
										title={agentVisible ? 'Hide avatar' : 'Show avatar'}
									>
										{agentVisible ? 'Hide avatar' : 'Show avatar'}
									</button>
								{/if}
							</div>
						{/if}
						<Composer
							bind:generating
							bind:convo
							{saveMessage}
							{saveConversation}
							{submitCompletion}
							{scrollToBottom}
							{handleAbort}
							{tree}
							bind:inputTextareaEl
							bind:handleFileDrop
						/>
					</div>

					{#if splitView}
						{@const toolresponse = convo.messages.find((msg) => msg.toolcallId === activeToolcall.id)}
						<div in:fade={{ duration: 500 }} class="w-[50%] p-3.5">
							<Toolcall
								toolcall={activeToolcall}
								{toolresponse}
								collapsable={false}
								closeButton
								bind:chose
								{isChoosing}
								{choiceHandler}
								{question}
								{choices}
								class="!rounded-xl"
								on:close={() => {
									activeToolcall = null;
								}}
							/>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<KnobsSidebar {knobsOpen} {db} />
	</div>
</main>
{/if}

<SettingsModal
	open={settingsModalOpen}
	trigger="settings"
	on:fetchModels={async () => {
		const fetched = await fetchModels({ onFinally: () => {} });
		models = [...BUILTIN_MODELS, ...fetched];
	}}
	on:disableTool={({ detail: name }) => {
		convo.tools = convo.tools.filter((n) => n !== name);
		saveConversation(convo);
	}}
/>

<SkillsMarketplaceModal bind:open={showSkillsMarketplace} />

<AgentSettingsModal bind:open={showAgentSettings} onSave={onAgentSettingsSave} />

{#if innerWidth <= 1215 && !$config.explicitToolView}
	<Modal
		bind:open={toolcallModalOpen}
		trigger="toolcall"
		class="!p-0"
		buttonClass="hidden"
		on:close={() => {
			activeToolcall = null;
		}}
	>
		<Toolcall
			toolcall={activeToolcall}
			toolresponse={convo.messages.find((msg) => msg.toolcallId === activeToolcall.id)}
			collapsable={false}
			closeButton
			bind:chose
			{isChoosing}
			{choiceHandler}
			{question}
			{choices}
			class="!rounded-xl"
			on:close={() => {
				toolcallModalOpen = false;
				activeToolcall = null;
			}}
		/>
	</Modal>
{/if}

<Notifications />

{#if installToastMsg}
	<div transition:fade={{ duration: 200 }} class="fixed bottom-16 left-1/2 z-[200] -translate-x-1/2 rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800 shadow-md">
		{installToastMsg}
	</div>
{/if}

{#if gateState}
	<div transition:fade={{ duration: 150 }} class="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
		<div class="mx-4 w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl">
			<div class="mb-2 text-2xl font-bold text-slate-900">🔒 Token-Gated Scene</div>
			<p class="mb-6 text-sm text-slate-600">This 3D scene requires wallet ownership verification to access. Connect your wallet and prove you hold the required token.</p>

			{#if gateState === 'pending'}
				<div class="flex flex-col gap-3">
					<button
						class="flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-purple-700 active:scale-95"
						on:click={() => verifyGate('solana')}
					>
						<svg class="h-5 w-5" viewBox="0 0 128 128" fill="none"><circle cx="64" cy="64" r="64" fill="#9945FF"/><path d="M86 44H42l14 14h44L86 44zm0 26H42l14 14h44L86 70zM42 84h44l-14 14H28L42 84z" fill="white"/></svg>
						Verify with Solana Wallet
					</button>
					<button
						class="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 active:scale-95"
						on:click={() => verifyGate('evm')}
					>
						<svg class="h-5 w-5" viewBox="0 0 128 128" fill="none"><circle cx="64" cy="64" r="64" fill="#627EEA"/><path d="M64 20v33l28 12.5L64 20z" fill="white" fill-opacity=".6"/><path d="M64 20L36 65.5l28-12.5V20z" fill="white"/><path d="M64 88v20l28-38.5L64 88z" fill="white" fill-opacity=".6"/><path d="M64 108V88L36 69.5 64 108z" fill="white"/><path d="M64 82.5l28-16.9-28-12.6v29.5z" fill="white" fill-opacity=".2"/><path d="M36 65.5l28 16.9V53l-28 12.5z" fill="white" fill-opacity=".6"/></svg>
						Verify with EVM Wallet
					</button>
				</div>
			{:else if gateState === 'checking'}
				<div class="flex flex-col items-center gap-3 py-4">
					<div class="h-8 w-8 animate-spin rounded-full border-4 border-purple-200 border-t-purple-600"></div>
					<p class="text-sm text-slate-500">Connecting wallet and verifying…</p>
				</div>
			{:else if gateState === 'denied'}
				<div class="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">
					<strong>Access denied:</strong> {gateError}
				</div>
				<div class="flex flex-col gap-2">
					<button
						class="rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
						on:click={() => { gateState = 'pending'; gateError = ''; }}
					>Try a different wallet</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	:global(.standalone .input-floating) {
		bottom: 32px;
	}
	:global(.standalone .scrollable) {
		padding-bottom: 100px;
	}
	:global(.standalone .settings-trigger-container) {
		padding-bottom: 2.5rem;
	}

	:global(.markdown.prose :where(p):not(:where([class~='not-prose'], [class~='not-prose'] *))) {
		margin-top: 0.75rem;
		margin-bottom: 0.75rem;
	}

	:global(
		.markdown.prose
			:where(.prose > :first-child):not(:where([class~='not-prose'], [class~='not-prose'] *))
	) {
		margin-top: 0;
	}

	:global(
		.markdown.prose
			:where(.prose > :last-child):not(:where([class~='not-prose'], [class~='not-prose'] *))
	) {
		margin-bottom: 0;
	}

	:global(.markdown.prose :where(a):not(:where([class~='not-prose'], [class~='not-prose'] *))) {
		color: #1A1A1A;
	}

	:global(.markdown.prose :where(pre):not(:where([class~='not-prose'], [class~='not-prose'] *))) {
		background-color: #EBE8E0;
		border-color: #E5E3DC;
	}

	.avatar-floater {
		transition: transform 1100ms cubic-bezier(0.55, 0, 0.7, 0.2), opacity 1100ms ease-in;
		transform-origin: bottom center;
	}
	.avatar-walking {
		animation: avatar-walk-bob 720ms ease-in-out infinite;
		transform-origin: bottom center;
	}
	@keyframes avatar-walk-bob {
		0%   { transform: translateY(0)    rotate(-1.2deg); }
		25%  { transform: translateY(-6px) rotate(0deg); }
		50%  { transform: translateY(0)    rotate(1.2deg); }
		75%  { transform: translateY(-6px) rotate(0deg); }
		100% { transform: translateY(0)    rotate(-1.2deg); }
	}
	@media (prefers-reduced-motion: reduce) {
		.avatar-walking { animation: none; }
	}
	.avatar-dying {
		transform: translateY(120vh) rotate(35deg);
		opacity: 0;
		pointer-events: none;
	}
	.avatar-falling {
		animation: avatar-fall-in 900ms cubic-bezier(0.2, 0.8, 0.3, 1) both;
	}
	@keyframes avatar-fall-in {
		0%   { transform: translateY(-120vh) rotate(-25deg); opacity: 0; }
		70%  { transform: translateY(8px) rotate(2deg); opacity: 1; }
		100% { transform: translateY(0) rotate(0); opacity: 1; }
	}

	.thought-bubble {
		position: relative;
		width: 280px;
		max-width: calc(100vw - 48px);
		margin-bottom: 14px;
		padding: 10px 14px 12px;
		border-radius: 18px;
		background: #ffffff;
		border: 1px solid #E5E3DC;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
		font-family: 'Inter', system-ui, sans-serif;
		animation: thought-bubble-pop 220ms ease-out;
		pointer-events: auto;
	}

	@keyframes thought-bubble-pop {
		from { opacity: 0; transform: translateY(6px) scale(0.96); }
		to   { opacity: 1; transform: translateY(0)   scale(1); }
	}

	.thought-bubble-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
		font-size: 11px;
		font-weight: 600;
		color: #9C9A93;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.thought-bubble-collapsed {
		padding-bottom: 10px;
	}
	.thought-bubble-collapsed .thought-bubble-header {
		margin-bottom: 0;
	}

	.thought-bubble-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #6366F1;
		animation: thought-bubble-pulse 1.2s ease-in-out infinite;
	}
	.thought-bubble-dot.idle {
		background: #C7C4BB;
		animation: none;
	}

	@keyframes thought-bubble-pulse {
		0%, 100% { opacity: 0.4; transform: scale(0.85); }
		50%      { opacity: 1;   transform: scale(1.1); }
	}

	.thought-bubble-body {
		max-height: 140px;
		overflow-y: auto;
		font-size: 12px;
		line-height: 1.5;
		color: #4B4A45;
		white-space: pre-wrap;
		word-break: break-word;
		scrollbar-width: thin;
		scrollbar-color: #D4D2CA transparent;
		mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
		-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%);
	}

	.thought-bubble-body::-webkit-scrollbar { width: 4px; }
	.thought-bubble-body::-webkit-scrollbar-thumb { background: #D4D2CA; border-radius: 2px; }

	.thought-bubble-placeholder {
		color: #9C9A93;
		font-style: italic;
	}

	.thought-bubble-tail {
		position: absolute;
		right: 28px;
		border-radius: 50%;
		background: #ffffff;
		border: 1px solid #E5E3DC;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
	}
	.thought-bubble-tail-1 {
		bottom: -8px;
		width: 12px;
		height: 12px;
	}
	.thought-bubble-tail-2 {
		bottom: -18px;
		right: 22px;
		width: 7px;
		height: 7px;
	}
	:global(body.user-is-touching) .group:focus-within .group-focus-within\:visible {
		visibility: visible;
		opacity: 1;
	}
	:global(.h-footer-horizon) {
		background: #F5F4EF !important;
		color: #1A1A1A !important;
		border-top: 1px solid #E5E3DC !important;
	}
	:global(.h-footer-horizon .h-footer-glow-line, .h-footer-horizon .h-footer-floor, .h-footer-horizon .h-footer-haze, .h-footer-horizon .h-footer-watermark) {
		display: none;
	}
	:global(.h-footer-links a) {
		color: rgba(0,0,0,0.65) !important;
	}
	:global(.h-footer-links a:hover) {
		color: #000 !important;
		text-shadow: none !important;
	}
	:global(.h-footer-link-heading) {
		color: rgba(0,0,0,0.45) !important;
	}
	:global(.h-footer-brand) {
		color: #000 !important;
	}
	:global(.h-footer-brand .wordmark-dot) {
		background: #000 !important;
		box-shadow: none !important;
	}
	:global(.h-footer-tagline) {
		color: rgba(0,0,0,0.55) !important;
	}
	:global(.h-footer-legal) {
		color: rgba(0,0,0,0.52) !important;
	}
	:global(.h-footer-legal-links a) {
		color: rgba(0,0,0,0.65) !important;
	}
	:global(.h-footer-social) {
		color: rgba(0,0,0,0.65) !important;
		background: rgba(0,0,0,0.03) !important;
		border-color: rgba(0,0,0,0.06) !important;
	}
	:global(.h-footer-social:hover) {
		color: #000 !important;
		background: rgba(0,0,0,0.08) !important;
		border-color: rgba(0,0,0,0.18) !important;
	}
	:global(.h-footer-bottom) {
		border-top: 1px solid rgba(0,0,0,0.06) !important;
	}
	:global(.h-footer-inner) {
		margin-bottom: 2rem;
	}
</style>

<footer class="h-footer-horizon" style="margin-top: auto;">
    <div class="h-footer-inner">
        <div class="h-footer-brand-col">
            <div class="h-footer-brand">
                <img class="wordmark-logo" src="/three.svg" alt="" aria-hidden="true" />
                <span class="wordmark-dot" aria-hidden="true"></span>
                <span>three.ws</span>
            </div>
            <p class="h-footer-tagline">Give your AI a body.</p>
            <div class="h-footer-socials">
                <a
                    class="h-footer-social"
                    href="https://x.com/trythreews"
                    target="_blank"
                    rel="noopener"
                    aria-label="three.ws on X"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            fill="currentColor"
                            d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                        />
                    </svg>
                </a>
                <a
                    class="h-footer-social"
                    href="https://github.com/nirholas/three.ws"
                    target="_blank"
                    rel="noopener"
                    aria-label="three.ws on GitHub"
                >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path
                            fill="currentColor"
                            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                        />
                    </svg>
                </a>
            </div>
        </div>
        <nav class="h-footer-links" aria-label="Footer">
            <div class="h-footer-link-col">
                <h4 class="h-footer-link-heading">Product</h4>
                <a href="/create">Create</a>
                <a href="/studio">Studio</a>
                <a href="/widgets">Widgets</a>
                <a href="/discover">Discover</a>
            </div>
            <div class="h-footer-link-col">
                <h4 class="h-footer-link-heading">Developers</h4>
                <a href="/docs">Docs</a>
                <a
                    href="https://github.com/nirholas/three.ws"
                    target="_blank"
                    rel="noopener"
                    >GitHub</a
                >
                <a
                    href="https://eips.ethereum.org/EIPS/eip-8004"
                    target="_blank"
                    rel="noopener"
                    >ERC-8004</a
                >
            </div>
            <div class="h-footer-link-col">
                <h4 class="h-footer-link-heading">Resources</h4>
                <a href="/features">Features</a>
                <a href="/dashboard">Dashboard</a>
            </div>
        </nav>
    </div>
    <div class="h-footer-bottom">
        <p class="h-footer-legal">© 2026 three.ws — All rights reserved.</p>
        <div class="h-footer-legal-links">
            <a href="/legal/privacy">Privacy Policy</a>
            <a href="/legal/tos">Terms of Use</a>
        </div>
    </div>
</footer>
