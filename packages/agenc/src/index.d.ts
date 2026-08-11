// Type definitions for @three-ws/agenc

export declare class ThreeWsError extends Error {
	name: string;
	code: string;
	status: number | null;
	detail?: string;
	retryAfter?: number;
	body: unknown;
}

export declare class PaymentRequiredError extends ThreeWsError {
	accepts: unknown | null;
}

/** Ergonomic alias for ThreeWsError, matching the README's error reference. */
export declare const AgenCError: typeof ThreeWsError;

export declare const DEFAULT_BASE_URL: string;

export type Cluster = 'mainnet' | 'devnet';

/** Lifecycle state of a task, decoded from the on-chain enum by the bridge. */
export type TaskState = 'Open' | 'Claimed' | 'Completed' | 'Cancelled' | 'Disputed' | 'Expired';

/** Registry status of an agent, decoded from the on-chain enum by the bridge. */
export type AgentStatus = 'Inactive' | 'Active' | 'Busy' | 'Suspended';

export interface AgencClientOptions {
	/** API origin. Defaults to https://three.ws (or THREE_WS_BASE_URL). */
	baseUrl?: string;
	/** fetch implementation (default globalThis.fetch). */
	fetch?: typeof fetch;
	/** Bearer token attached as Authorization (reads are public; rarely needed). */
	apiKey?: string;
	/** Default headers on every request. */
	headers?: Record<string, string>;
}

export interface CommonOptions {
	/** Target cluster. Default 'mainnet'. */
	cluster?: Cluster;
	/** Abort an in-flight read. */
	signal?: AbortSignal;
}

export interface ListTasksOptions extends CommonOptions {}

export interface GetTaskOptions extends CommonOptions {
	/** Include the event timeline (?lifecycle=1). Default false. */
	lifecycle?: boolean;
}

export interface GetAgentOptions extends CommonOptions {}

export interface TaskSummary {
	/** 32-byte task id, hex. */
	taskId: string | null;
	/** Derived task account address (base58). */
	taskPda: string | null;
	/** Lifecycle state label. */
	state: TaskState | string | null;
	/** Raw enum ordinal when numeric. */
	stateRaw: number | null;
	/** Escrowed reward (atomic units, stringified). */
	rewardAmount: string | null;
	/** SPL mint of the reward; null for native SOL. */
	rewardMint: string | null;
	/** Unix deadline (stringified). */
	deadline: string | null;
	currentWorkers: number | null;
	maxWorkers: number | null;
	/** Completion timestamp, if any. */
	completedAt: string | null;
	/** true when the task carries a constraint hash (ZK lane). */
	private: boolean;
}

export interface TaskList {
	cluster: string | null;
	programId: string | null;
	creator: string | null;
	count: number;
	tasks: TaskSummary[];
	fetchedAt: string | null;
	raw: unknown;
}

export interface LifecycleEvent {
	eventName: string | null;
	timestamp: string | number | null;
	txSignature: string | null;
	actor: string | null;
}

export interface TaskLifecycle {
	currentState: TaskState | string | null;
	createdAt: string | number | null;
	currentWorkers: number | null;
	maxWorkers: number | null;
	timeline: LifecycleEvent[];
}

export interface TaskRecord extends TaskSummary {
	/** Creator wallet (base58). */
	creator: string | null;
	/** Constraint hash (hex) for private/ZK tasks; null otherwise. */
	constraintHash: string | null;
}

export interface TaskDetail {
	cluster: string | null;
	programId: string | null;
	taskPda: string | null;
	task: TaskRecord;
	/** Present (non-null) only when `{ lifecycle: true }` was requested. */
	lifecycle: TaskLifecycle | null;
	fetchedAt: string | null;
	raw: unknown;
}

export interface AgentRecord {
	/** 32-byte agent id, hex. */
	agentId: string | null;
	/** Controlling wallet (base58). */
	authority: string | null;
	/** Freeform u64 capability bitmap (stringified). */
	capabilities: string | null;
	status: AgentStatus | string | null;
	statusRaw: number | null;
	endpoint: string | null;
	metadataUri: string | null;
	/** Staked lamports (stringified). */
	stakeAmount: string | null;
	activeTasks: number | null;
	reputation: number | null;
	registeredAt: string | number | null;
}

export interface AgentDetail {
	cluster: string | null;
	programId: string | null;
	agentPda: string | null;
	agent: AgentRecord;
	fetchedAt: string | null;
	raw: unknown;
}

/** Resolve a task by PDA string, explicit PDA, or a (creator, taskId) pair. */
export type TaskSelector = string | { taskPda?: string } | { creator: string; taskId: string };

/** Resolve an agent by PDA string, or by PDA / id label object, or a bare id label. */
export type AgentSelector = string | { agentPda?: string; agentId?: string };

export interface AgencClient {
	listTasks(creator: string, opts?: ListTasksOptions): Promise<TaskList>;
	getTask(idOrPda: TaskSelector, opts?: GetTaskOptions): Promise<TaskDetail>;
	getAgent(idOrPda: AgentSelector, opts?: GetAgentOptions): Promise<AgentDetail>;
}

export declare function createAgenc(options?: AgencClientOptions): AgencClient;
export declare function listTasks(creator: string, opts?: ListTasksOptions): Promise<TaskList>;
export declare function getTask(idOrPda: TaskSelector, opts?: GetTaskOptions): Promise<TaskDetail>;
export declare function getAgent(idOrPda: AgentSelector, opts?: GetAgentOptions): Promise<AgentDetail>;
