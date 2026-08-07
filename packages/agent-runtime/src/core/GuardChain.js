import { DEFI_TOOL_IDENTIFIERS, MUTATING_APIS, } from './toolRegistry.js';
import { DEFAULT_SECURITY_BLACKLIST } from './defaultSecurityBlacklist.js';
import { InterventionChecker } from './InterventionChecker.js';
// ============================================================================
// Constants
// ============================================================================
/** Display names for each layer, kept beside the ids so the UI never re-derives them. */
const LAYER_LABELS = {
    capability: 'Capability Token',
    defi_guard: 'DeFi Guard',
    intervention: 'Human Intervention',
    permission: 'Agent Permission',
    security_blacklist: 'Security Blacklist',
    spend_guard: 'Spend Envelope',
    x402: 'x402 Autonomy Budget',
};
/**
 * Relative enforcement weight of each layer, used for {@link GuardChainVerdict.coverageScore}.
 * DeFiGuard carries the most weight because it is the only layer that reasons about
 * portfolio risk, MEV exposure, and dollar caps together.
 */
const LAYER_WEIGHTS = {
    capability: 10,
    defi_guard: 30,
    intervention: 15,
    permission: 15,
    security_blacklist: 10,
    spend_guard: 15,
    x402: 5,
};
/**
 * Mutating APIs that move value *into* the wallet or are strictly neutral.
 * These are excluded from spend-envelope gating so a user reclaiming their own
 * funds never trips a cap. Mirrors the exclusions in `spendGuardPipeline`.
 */
const NON_OUTFLOW_APIS = new Set([
    'borrow',
    'borrowLisUsd',
    'cancelDCA',
    'cancelLimitOrder',
    'claimRewards',
    'redeem',
    'removeLiquidity',
    'revoke',
    'revokeAllApprovals',
    'revokeApproval',
    'unstake',
    'unstakeBnb',
    'withdraw',
    'withdrawFunds',
    'withdrawSavings',
]);
/**
 * API-name shapes that mutate on-chain state. Used only to detect tools that
 * *look* fund-moving but are absent from `MUTATING_APIS` / `DEFI_TOOL_IDENTIFIERS`
 * - i.e. registration gaps.
 */
const MUTATING_NAME_HINTS = [
    'approve',
    'borrow',
    'bridge',
    'burn',
    'buy',
    'claim',
    'deposit',
    'execute',
    'mint',
    'pay',
    'repay',
    'send',
    'sell',
    'stake',
    'supply',
    'swap',
    'transfer',
    'withdraw',
];
/** Ranking used to fold per-layer statuses into a single decision. */
const STATUS_SEVERITY = {
    approval_required: 2,
    block: 3,
    error: 3,
    pass: 0,
    skipped: 0,
    warn: 1,
};
const BLIND_SPOT_SEVERITY_ORDER = {
    critical: 0,
    info: 2,
    warning: 1,
};
// ============================================================================
// Helpers
// ============================================================================
/** True when the API name suggests an on-chain mutation, by shape rather than registry. */
function looksMutating(apiName) {
    const lower = apiName.toLowerCase();
    return MUTATING_NAME_HINTS.some((hint) => lower.includes(hint));
}
/** True when the call moves value out of the agent's wallet. */
function isOutflow(apiName) {
    return MUTATING_APIS.has(apiName) && !NON_OUTFLOW_APIS.has(apiName);
}
/** Map a DeFiGuard verdict onto a chain layer status. */
function decisionToStatus(decision) {
    if (decision === 'block')
        return 'block';
    if (decision === 'require_approval')
        return 'approval_required';
    return 'pass';
}
/** Map an intervention policy onto a chain layer status. */
function policyToStatus(policy) {
    return policy === 'never' ? 'pass' : 'approval_required';
}
// ============================================================================
// GuardChain
// ============================================================================
export class GuardChain {
    clock;
    now;
    opts;
    constructor(options = {}) {
        this.opts = options;
        this.now = options.now ?? (() => Date.now());
        this.clock = options.clock ?? (() => Date.now());
    }
    /**
     * Run every applicable layer over a single tool call.
     *
     * Layers always run to completion - the chain does not short-circuit on the
     * first block. A partial trace would defeat the purpose: the operator needs to
     * know that a call blocked by the spend envelope *also* carried critical MEV
     * exposure, and that the permission layer never ran at all.
     */
    async evaluate(request) {
        const startedAt = this.clock();
        const layers = [];
        const warnings = [];
        let modifiedArguments;
        const args = request.arguments ?? {};
        layers.push(this.runSecurityBlacklist(request, args), this.runIntervention(request, args), await this.runCapability(request, args), await this.runPermission(request, args));
        const defi = await this.runDeFiGuard(request, args);
        if (defi.warnings.length > 0)
            warnings.push(...defi.warnings);
        if (defi.modifiedArguments)
            modifiedArguments = defi.modifiedArguments;
        layers.push(defi.result, this.runSpendGuard(request), await this.runX402(request));
        const decisionLayer = this.pickDecidingLayer(layers);
        const decision = decisionLayer === undefined
            ? 'allow'
            : decisionLayer.status === 'block' || decisionLayer.status === 'error'
                ? 'block'
                : decisionLayer.status === 'approval_required'
                    ? 'require_approval'
                    : 'allow';
        const blindSpots = this.deriveBlindSpots(request, layers).sort((a, b) => BLIND_SPOT_SEVERITY_ORDER[a.severity] - BLIND_SPOT_SEVERITY_ORDER[b.severity]);
        // Warn-level layers are advisory; surface them alongside DeFiGuard's own.
        for (const layer of layers) {
            if (layer.status === 'warn')
                warnings.push(`${layer.label}: ${layer.reason}`);
        }
        return {
            blindSpots,
            blockedBy: decision === 'block' ? decisionLayer?.layer : undefined,
            code: decisionLayer?.code,
            coverageScore: this.computeCoverage(request, layers),
            decision,
            evaluatedAt: this.now(),
            layers,
            modifiedArguments,
            reason: decisionLayer === undefined || decision === 'allow'
                ? 'Cleared every applicable enforcement layer.'
                : `${decisionLayer.label}: ${decisionLayer.reason}`,
            totalElapsedMs: Math.max(0, this.clock() - startedAt),
            warnings,
        };
    }
    // ── Layer 1: security blacklist ──────────────────────────────────────────
    runSecurityBlacklist(request, args) {
        const t0 = this.clock();
        // `checkSecurityBlacklist` defaults an absent list to `[]`, while
        // `shouldIntervene` defaults it to DEFAULT_SECURITY_BLACKLIST. Mirror the
        // latter - it is what the agent loop actually applies, and defaulting to an
        // empty list here would silently under-report the blacklist layer.
        const check = InterventionChecker.checkSecurityBlacklist(request.securityBlacklist ?? DEFAULT_SECURITY_BLACKLIST, args);
        // Headless runs skip blacklisted tools rather than blocking them, so the
        // effective outcome differs from an interactive session on the same call.
        const headless = request.approvalMode === 'headless';
        return {
            code: check.blocked ? 'SECURITY_BLACKLIST' : undefined,
            detail: { approvalMode: request.approvalMode ?? 'manual', headlessSkip: headless },
            elapsedMs: this.clock() - t0,
            label: LAYER_LABELS.security_blacklist,
            layer: 'security_blacklist',
            reason: check.blocked
                ? headless
                    ? `Matched a blacklist rule (${check.reason}). In headless mode the call is skipped rather than surfaced for approval.`
                    : (check.reason ?? 'Matched a security blacklist rule.')
                : 'No blacklist rule matched these arguments.',
            status: check.blocked ? 'block' : 'pass',
        };
    }
    // ── Layer 2: human intervention ──────────────────────────────────────────
    runIntervention(request, args) {
        const t0 = this.clock();
        const mode = request.approvalMode ?? 'manual';
        const toolKey = InterventionChecker.generateToolKey(request.identifier, request.apiName, InterventionChecker.hashArguments(args));
        const policy = InterventionChecker.shouldIntervene({
            config: request.interventionConfig,
            confirmedHistory: request.confirmedHistory,
            securityBlacklist: request.securityBlacklist,
            toolArgs: args,
            toolKey,
        });
        // The global approval mode can downgrade `required`, but never `always`.
        let effective = policy;
        let reason;
        if (policy === 'always') {
            // `always` is the one policy no approval mode can downgrade.
            reason = 'Tool policy is `always` - no approval mode can bypass it.';
        }
        else {
            switch (mode) {
                case 'allow-list': {
                    const listed = (request.allowList ?? []).includes(`${request.identifier}/${request.apiName}`);
                    effective = listed ? 'never' : policy;
                    reason = listed
                        ? 'Tool is on the session allow list.'
                        : 'Tool is absent from the allow list, so the tool policy stands.';
                    break;
                }
                case 'auto-run': {
                    effective = 'never';
                    reason = 'Global auto-run mode bypasses the `required` policy.';
                    break;
                }
                case 'headless': {
                    effective = 'never';
                    reason = 'Headless mode executes without a human channel.';
                    break;
                }
                default: {
                    reason =
                        policy === 'never'
                            ? 'Tool policy permits unattended execution.'
                            : 'Tool policy requires confirmation before execution.';
                }
            }
        }
        return {
            code: effective === 'never' ? undefined : `INTERVENTION_${effective.toUpperCase()}`,
            detail: { approvalMode: mode, effectivePolicy: effective, toolKey, toolPolicy: policy },
            elapsedMs: this.clock() - t0,
            label: LAYER_LABELS.intervention,
            layer: 'intervention',
            reason,
            status: policyToStatus(effective),
        };
    }
    // ── Layer 3: capability token ────────────────────────────────────────────
    async runCapability(request, args) {
        const t0 = this.clock();
        const base = { label: LAYER_LABELS.capability, layer: 'capability' };
        if (!this.opts.checkCapability) {
            return {
                ...base,
                elapsedMs: this.clock() - t0,
                reason: 'No capability-token validator is wired into this evaluation.',
                status: 'skipped',
            };
        }
        if (request.executionPath === 'batch') {
            return {
                ...base,
                code: 'BATCH_BYPASS',
                elapsedMs: this.clock() - t0,
                reason: 'Batched dispatch bypasses this guard - the decorator only intercepts `call_tool`.',
                status: 'skipped',
            };
        }
        try {
            const result = await this.opts.checkCapability({
                agentId: request.agentId ?? 'unknown',
                args,
                toolName: request.apiName,
            });
            return {
                ...base,
                code: result.allowed ? undefined : 'CAPABILITY_DENIED',
                detail: { tokenId: result.tokenId },
                elapsedMs: this.clock() - t0,
                reason: result.reason ??
                    (result.allowed
                        ? 'A valid capability token covers this tool.'
                        : 'No valid capability token covers this tool.'),
                status: result.allowed ? 'pass' : 'block',
            };
        }
        catch (error) {
            // Fail closed: an unavailable validator must not open the money path.
            return {
                ...base,
                code: 'CAPABILITY_ERROR',
                elapsedMs: this.clock() - t0,
                reason: `Capability check failed, so the call is refused: ${error instanceof Error ? error.message : String(error)}`,
                status: 'error',
            };
        }
    }
    // ── Layer 4: agent permission ────────────────────────────────────────────
    async runPermission(request, args) {
        const t0 = this.clock();
        const base = { label: LAYER_LABELS.permission, layer: 'permission' };
        if (!this.opts.checkPermission) {
            return {
                ...base,
                elapsedMs: this.clock() - t0,
                reason: 'No permission resolver is wired into this evaluation.',
                status: 'skipped',
            };
        }
        if (request.executionPath === 'batch') {
            return {
                ...base,
                code: 'BATCH_BYPASS',
                elapsedMs: this.clock() - t0,
                reason: 'Batched dispatch bypasses this guard - the decorator only intercepts `call_tool`.',
                status: 'skipped',
            };
        }
        try {
            const result = await this.opts.checkPermission({
                agentId: request.agentId ?? 'unknown',
                args,
                toolName: request.apiName,
            });
            const level = result.level ?? (result.allowed ? 'autonomous' : 'forbidden');
            const status = result.allowed
                ? level === 'notify-and-proceed'
                    ? 'warn'
                    : 'pass'
                : level === 'approval-required'
                    ? 'approval_required'
                    : 'block';
            return {
                ...base,
                code: result.allowed ? undefined : `PERMISSION_${level.toUpperCase().replaceAll('-', '_')}`,
                detail: { level, pendingApprovalId: result.pendingApprovalId },
                elapsedMs: this.clock() - t0,
                reason: result.reason ?? `Permission level resolved to \`${level}\`.`,
                status,
            };
        }
        catch (error) {
            return {
                ...base,
                code: 'PERMISSION_ERROR',
                elapsedMs: this.clock() - t0,
                reason: `Permission check failed, so the call is refused: ${error instanceof Error ? error.message : String(error)}`,
                status: 'error',
            };
        }
    }
    // ── Layer 5: DeFi guard ──────────────────────────────────────────────────
    async runDeFiGuard(request, args) {
        const t0 = this.clock();
        const base = { label: LAYER_LABELS.defi_guard, layer: 'defi_guard' };
        if (!this.opts.defiGuard) {
            return {
                result: {
                    ...base,
                    elapsedMs: this.clock() - t0,
                    reason: 'No DeFiGuard instance is wired into this evaluation.',
                    status: 'skipped',
                },
                warnings: [],
            };
        }
        if (!this.opts.defiGuard.isDeFiTool(request.identifier)) {
            return {
                result: {
                    ...base,
                    code: 'NOT_REGISTERED',
                    detail: { identifier: request.identifier },
                    elapsedMs: this.clock() - t0,
                    reason: `\`${request.identifier}\` is not in the DeFi tool registry, so no risk or MEV analysis ran.`,
                    status: 'skipped',
                },
                warnings: [],
            };
        }
        try {
            const guardResult = await this.opts.defiGuard.analyze({
                apiName: request.apiName,
                arguments: args,
                chainId: request.chainId,
                identifier: request.identifier,
                portfolioPositions: request.portfolioPositions,
                protocol: request.protocol,
                userId: request.userId,
                userSwapCaps: request.userSwapCaps,
                userSwapVolume: request.userSwapVolume,
                userTier: request.userTier,
                valueUsd: request.valueUsd,
            });
            const { analysis } = guardResult;
            return {
                modifiedArguments: guardResult.modifiedArguments,
                result: {
                    ...base,
                    code: analysis.capCode ?? (analysis.decision === 'allow' ? undefined : 'DEFI_RISK'),
                    detail: {
                        capCode: analysis.capCode,
                        isMutating: analysis.isMutating,
                        mevAssessment: analysis.mevAssessment,
                        parameterAdjustments: analysis.parameterAdjustments,
                        protocolStatus: analysis.protocolStatus,
                        remainingDailyVolumeUsd: analysis.remainingDailyVolumeUsd,
                        riskReport: analysis.riskReport,
                    },
                    elapsedMs: this.clock() - t0,
                    reason: analysis.reason,
                    status: decisionToStatus(analysis.decision),
                },
                warnings: analysis.warnings,
            };
        }
        catch (error) {
            return {
                result: {
                    ...base,
                    code: 'DEFI_GUARD_ERROR',
                    elapsedMs: this.clock() - t0,
                    reason: `DeFi analysis failed, so the call is refused: ${error instanceof Error ? error.message : String(error)}`,
                    status: 'error',
                },
                warnings: [],
            };
        }
    }
    // ── Layer 6: spend envelope ──────────────────────────────────────────────
    runSpendGuard(request) {
        const t0 = this.clock();
        const base = { label: LAYER_LABELS.spend_guard, layer: 'spend_guard' };
        if (!this.opts.spendGuard) {
            return {
                ...base,
                elapsedMs: this.clock() - t0,
                reason: 'No spend envelope is configured for this agent.',
                status: 'skipped',
            };
        }
        if (!isOutflow(request.apiName)) {
            return {
                ...base,
                detail: { apiName: request.apiName },
                elapsedMs: this.clock() - t0,
                reason: MUTATING_APIS.has(request.apiName)
                    ? 'Inflow or neutral operation - deliberately exempt from spend caps.'
                    : 'Read-only operation - no value leaves the wallet.',
                status: 'skipped',
            };
        }
        const result = this.opts.spendGuard.check({
            agentId: request.agentId ?? 'unknown',
            balanceUsd: request.balanceUsd,
            destination: request.destination,
            token: request.token,
            userId: request.userId,
            valueUsd: request.valueUsd ?? 0,
        });
        return {
            ...base,
            code: result.code,
            detail: {
                remainingDailyUsd: result.remainingDailyUsd,
                remainingRollingUsd: result.remainingRollingUsd,
                valueUsd: request.valueUsd ?? 0,
            },
            elapsedMs: this.clock() - t0,
            reason: result.reason,
            status: result.allowed ? 'pass' : 'block',
        };
    }
    // ── Layer 7: x402 autonomy budget ────────────────────────────────────────
    async runX402(request) {
        const t0 = this.clock();
        const base = { label: LAYER_LABELS.x402, layer: 'x402' };
        if (!request.x402) {
            return {
                ...base,
                elapsedMs: this.clock() - t0,
                reason: 'Not an x402-metered request.',
                status: 'skipped',
            };
        }
        if (!this.opts.x402Hook) {
            return {
                ...base,
                elapsedMs: this.clock() - t0,
                reason: 'x402 payment context supplied but no autonomy hook is wired.',
                status: 'skipped',
            };
        }
        try {
            const result = await this.opts.x402Hook({
                agentId: request.agentId ?? 'unknown',
                amountSpentThisHourUsdc: request.x402.amountSpentThisHourUsdc,
                currentBalanceUsdc: request.x402.currentBalanceUsdc,
                requirements: request.x402.requirements,
                url: request.x402.url,
            });
            const status = result.action === 'pay' ? 'pass' : result.action === 'queue' ? 'approval_required' : 'block';
            return {
                ...base,
                code: result.action === 'pay' ? undefined : `X402_${result.action.toUpperCase()}`,
                detail: { action: result.action },
                elapsedMs: this.clock() - t0,
                reason: result.action === 'pay' ? 'Within the hourly autonomy budget.' : result.reason,
                status,
            };
        }
        catch (error) {
            return {
                ...base,
                code: 'X402_ERROR',
                elapsedMs: this.clock() - t0,
                reason: `x402 hook failed, so the payment is refused: ${error instanceof Error ? error.message : String(error)}`,
                status: 'error',
            };
        }
    }
    // ── Verdict folding ──────────────────────────────────────────────────────
    /**
     * Select the layer that determines the verdict: the highest-severity status,
     * with earlier layers winning ties so the reported reason matches the layer
     * that would actually fire first at runtime.
     */
    pickDecidingLayer(layers) {
        let best;
        for (const layer of layers) {
            if (layer.status === 'skipped' || layer.status === 'pass')
                continue;
            if (!best || STATUS_SEVERITY[layer.status] > STATUS_SEVERITY[best.status])
                best = layer;
        }
        return best;
    }
    /**
     * Coverage is measured against the layers that *should* apply to this request,
     * not against all seven. Charging a read-only call for skipping the spend
     * envelope would make the number meaningless.
     */
    computeCoverage(request, layers) {
        const applicable = new Set(['security_blacklist', 'intervention']);
        // The executor-decorator guards apply to any tool dispatched individually.
        applicable.add('capability');
        applicable.add('permission');
        if (DEFI_TOOL_IDENTIFIERS.has(request.identifier) || looksMutating(request.apiName)) {
            applicable.add('defi_guard');
        }
        if (isOutflow(request.apiName))
            applicable.add('spend_guard');
        if (request.x402)
            applicable.add('x402');
        let expected = 0;
        let evaluated = 0;
        for (const layer of layers) {
            if (!applicable.has(layer.layer))
                continue;
            expected += LAYER_WEIGHTS[layer.layer];
            if (layer.status !== 'skipped')
                evaluated += LAYER_WEIGHTS[layer.layer];
        }
        if (expected === 0)
            return 100;
        return Math.round((evaluated / expected) * 100);
    }
    // ── Blind-spot derivation ────────────────────────────────────────────────
    /**
     * Derive the enforcement gaps this request would hit. These are structural -
     * they describe checks that did not happen, which no individual guard reports
     * because from its own perspective nothing went wrong.
     */
    deriveBlindSpots(request, layers) {
        const spots = [];
        const byId = new Map(layers.map((l) => [l.layer, l]));
        const registered = DEFI_TOOL_IDENTIFIERS.has(request.identifier);
        const mutating = MUTATING_APIS.has(request.apiName);
        // 1. A registered, mutating call with no authoritative USD value: the dollar
        //    caps compare against 0 and pass, and MEV analysis never runs.
        if (registered && mutating && (request.valueUsd === undefined || request.valueUsd <= 0)) {
            spots.push({
                code: 'VALUE_UNRESOLVED',
                detail: 'No authoritative `valueUsd` was supplied, and the guard never reads a token `amount` as dollars ' +
                    '(0.5 ETH would otherwise be priced at $0.50). Every dollar-denominated check therefore compares ' +
                    'against $0 and passes: tier limits, per-user caps, the auto-execute ceiling, daily volume, and ' +
                    'MEV analysis, which needs a notional to estimate extractable value.',
                layer: 'defi_guard',
                remediation: 'Resolve the USD notional server-side - amount × spot price, or the quote’s `fromAmountUsd` - and pass it as `valueUsd`.',
                severity: 'critical',
                title: 'Dollar caps evaluated against $0',
            });
        }
        // 2. An on-chain mutation on a tool the guard does not know about.
        if (!registered && (mutating || looksMutating(request.apiName))) {
            spots.push({
                code: 'TOOL_UNREGISTERED',
                detail: `\`${request.apiName}\` mutates on-chain state, but \`${request.identifier}\` is absent from ` +
                    'the DeFi tool registry. `isDeFiTool()` returns false, so DeFiGuard returns early and the entire ' +
                    'risk, MEV, cap, and protocol-audit surface is skipped for this call.',
                layer: 'defi_guard',
                remediation: `Add \`${request.identifier}\` to DEFI_TOOL_IDENTIFIERS via registerFundMovingTool() in toolRegistry.ts.`,
                severity: 'critical',
                title: 'Fund-moving tool not registered with DeFiGuard',
            });
        }
        // 3. Batched dispatch bypasses the executor decorators entirely.
        if (request.executionPath === 'batch') {
            spots.push({
                code: 'BATCH_BYPASS',
                detail: 'Both guards are executor decorators that intercept only `call_tool`. A tool dispatched through ' +
                    '`call_tools_batch` reaches its handler without any capability-token or permission check - and the ' +
                    'batch executor applies no concurrency cap, so every tool in the batch runs at once.',
                layer: 'permission',
                remediation: 'Route fund-moving tools through single dispatch, or wrap the `call_tools_batch` executor with the same guards.',
                severity: 'critical',
                title: 'Capability and permission guards bypassed by batching',
            });
        }
        // 4. Value leaves the wallet with no envelope to bound it.
        if (isOutflow(request.apiName) && byId.get('spend_guard')?.status === 'skipped') {
            spots.push({
                code: 'SPEND_UNSCOPED',
                detail: `\`${request.apiName}\` moves value out of the agent wallet, but no spend envelope is configured. ` +
                    'Per-transaction, rolling-window, and daily caps, the reserve floor, and the token/destination ' +
                    'firewall are all unenforced, and the custody-breach latch can never trip.',
                layer: 'spend_guard',
                remediation: 'Attach a SpendGuard with per-tx, rolling, and daily caps for this agent.',
                severity: 'critical',
                title: 'Outflow with no spend envelope',
            });
        }
        // 5. Protocol audit status defaults to unaudited when the registry is empty.
        const defiDetail = byId.get('defi_guard')?.detail;
        if (registered && request.protocol && defiDetail?.protocolStatus === 'unaudited') {
            spots.push({
                code: 'PROTOCOL_UNVERIFIED',
                detail: `\`${request.protocol}\` is not present in the protocol registry, so it is treated as unaudited. ` +
                    'With an empty registry every protocol reads the same way, which makes the audit signal carry no information.',
                layer: 'defi_guard',
                remediation: 'Populate `protocolRegistry` in the guard config so audited protocols are distinguishable from unknown ones.',
                severity: 'warning',
                title: 'Protocol audit status unverifiable',
            });
        }
        // 6/7. Guards that were never wired into this evaluation at all.
        if (byId.get('capability')?.status === 'skipped' && !this.opts.checkCapability) {
            spots.push({
                code: 'CAPABILITY_UNWIRED',
                detail: 'No capability-token validator was supplied, so scope-limited delegation is not enforced on this path.',
                layer: 'capability',
                remediation: 'Inject `checkCapability` backed by the capabilityToken records.',
                severity: 'warning',
                title: 'Capability guard not wired',
            });
        }
        if (byId.get('permission')?.status === 'skipped' && !this.opts.checkPermission) {
            spots.push({
                code: 'PERMISSION_UNWIRED',
                detail: 'No permission resolver was supplied, so the agent’s permission level is not consulted on this path.',
                layer: 'permission',
                remediation: 'Inject `checkPermission` backed by the agentPermission records.',
                severity: 'warning',
                title: 'Permission guard not wired',
            });
        }
        // 8. Read-only DeFi calls are unanalyzed by default.
        if (registered && !mutating) {
            spots.push({
                code: 'READONLY_UNANALYZED',
                detail: `\`${request.apiName}\` is not a mutating API, and \`analyzeReadOnly\` defaults to false, so the ` +
                    'guard returns immediately. This is intentional and cheap, but it means read paths carry no risk telemetry.',
                layer: 'defi_guard',
                remediation: 'Set `analyzeReadOnly: true` if read-path risk telemetry is wanted.',
                severity: 'info',
                title: 'Read-only call not analyzed',
            });
        }
        return spots;
    }
}
/**
 * Compare a set of live tool identifiers against the DeFi enforcement registry.
 *
 * Pass the identifiers actually installed in a deployment to find fund-moving
 * tools that no guard would ever see. With no argument it reports the registry
 * itself.
 */
export function analyzeGuardCoverage(installedIdentifiers) {
    const mutatingApis = [...MUTATING_APIS].sort();
    const registryIds = [...DEFI_TOOL_IDENTIFIERS].sort();
    const supplied = installedIdentifiers ? [...new Set(installedIdentifiers)].sort() : registryIds;
    const registered = [];
    const unregistered = [];
    for (const identifier of supplied) {
        const entry = {
            apis: [],
            identifier,
            registered: DEFI_TOOL_IDENTIFIERS.has(identifier),
        };
        if (entry.registered)
            registered.push(entry);
        else
            unregistered.push(entry);
    }
    return {
        coveragePercent: supplied.length === 0 ? 100 : Math.round((registered.length / supplied.length) * 100),
        mutatingApis,
        registered,
        unregistered,
    };
}
/** Human-readable label for a layer id, for callers rendering a trace. */
export function guardLayerLabel(layer) {
    return LAYER_LABELS[layer];
}
/** Relative enforcement weight of a layer, exposed for callers scoring coverage. */
export function guardLayerWeight(layer) {
    return LAYER_WEIGHTS[layer];
}
/** The layers `GuardChain` evaluates, in order. */
export const GUARD_LAYER_ORDER = [
    'security_blacklist',
    'intervention',
    'capability',
    'permission',
    'defi_guard',
    'spend_guard',
    'x402',
];
