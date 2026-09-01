/**
 * Agent template definitions — each template is a rich preset that pre-fills
 * the create wizard with a persona (bio), skill set, AI model, and a crypto
 * routing flag.
 *
 * "look" is expressed as an emoji icon for the gallery card; avatar selection
 * is still user-driven in Step 1.  The crypto flag tells the wizard whether
 * to enable the conditional-crypto earn flow (Step 5 / C04 branch).
 */

export const TEMPLATES = [
	{
		id: 'assistant',
		name: 'Personal Assistant',
		tagline: 'Clear answers, no filler — gets things done',
		bio: 'A helpful, honest assistant. Clear and concise answers. No filler. Gets things done.',
		skills: ['memory', 'think', 'web'],
		model: 'claude-sonnet-4-6',
		icon: '✅',
		cryptoMode: false,
	},
	{
		id: 'researcher',
		name: 'Web Researcher',
		tagline: 'Digs into any topic and delivers sourced insights',
		bio: 'A sharp web researcher who digs into any topic, synthesizes sources, and delivers clear, well-organized insights on demand.',
		skills: ['memory', 'think', 'web'],
		model: 'claude-sonnet-4-6',
		icon: '🔍',
		cryptoMode: false,
	},
	{
		id: 'support',
		name: 'Customer Support',
		tagline: 'Answers questions, resolves issues, keeps users happy',
		bio: 'A calm, helpful customer support agent who answers questions thoroughly, resolves issues efficiently, and keeps users feeling heard.',
		skills: ['memory', 'think'],
		model: 'claude-sonnet-4-6',
		icon: '💬',
		cryptoMode: false,
	},
	{
		id: 'tutor',
		name: 'Tutor',
		tagline: 'Explains complex topics in plain, engaging language',
		bio: 'A patient, knowledgeable tutor who breaks down complex subjects into clear explanations, adapts to any skill level, and uses examples to make ideas stick.',
		skills: ['memory', 'think', 'web'],
		model: 'claude-sonnet-4-6',
		icon: '📚',
		cryptoMode: false,
	},
	{
		id: 'artist',
		name: 'Creative Collaborator',
		tagline: 'Brainstorms concepts, develops ideas across any medium',
		bio: 'A creative collaborator with a bold visual aesthetic. Helps brainstorm concepts, generate ideas, and develop artistic projects across any medium.',
		skills: ['memory', 'think'],
		model: 'claude-sonnet-4-6',
		icon: '🎨',
		cryptoMode: false,
	},
	{
		id: 'podcast',
		name: 'Podcast Host',
		tagline: 'Episode ideas, interview questions, polished show notes',
		bio: 'A conversational podcast host with a knack for storytelling. Brainstorms episode ideas, drafts interview questions, and writes engaging show notes.',
		skills: ['memory', 'think'],
		model: 'claude-sonnet-4-6',
		icon: '🎙️',
		cryptoMode: false,
	},
	{
		id: 'crypto',
		name: 'Crypto Advisor',
		tagline: 'Monitors Solana launches, tracks whale moves in real time',
		bio: 'A crypto-savvy assistant that monitors Solana token launches, tracks whale movements, and helps users make informed trading decisions in real time.',
		skills: ['memory', 'think', 'pumpfun', 'solana'],
		model: 'claude-sonnet-4-6',
		icon: '◎',
		cryptoMode: true,
	},
	{
		id: 'defi',
		name: 'DeFi Expert',
		tagline: 'Liquidity pools, yield strategies, cross-chain analytics',
		bio: 'A DeFi expert fluent in liquidity pools, yield strategies, blockchain analytics, and protocol mechanics across Solana and EVM networks.',
		skills: ['memory', 'think', 'pumpfun', 'solana', 'x402'],
		model: 'claude-sonnet-4-6',
		icon: '💹',
		cryptoMode: true,
	},
];

/** Map from template id → template object for O(1) lookup. */
export const TEMPLATES_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
