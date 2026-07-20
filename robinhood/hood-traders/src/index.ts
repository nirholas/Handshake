// Framework
export { Agent } from './framework/agent.js'
export type { AgentOptions } from './framework/agent.js'
export { Fleet } from './framework/fleet.js'
export type { AgentSpec, FleetSummary } from './framework/fleet.js'
export { loadFleetConfig, loadLlmConfig, loadLlmMinConfidence } from './framework/config.js'
export type { FleetConfig } from './framework/config.js'
export { Journal } from './framework/journal.js'
export { KillSwitch } from './framework/kill.js'
export { Market } from './framework/market.js'
export type { SpotPrice } from './framework/market.js'
export { RiskEngine, utcDayStart } from './framework/risk.js'
export type { RiskContext, RiskVerdict } from './framework/risk.js'
export type {
  Strategy,
  StrategyMeta,
  StrategyStartContext,
  StrategyTickContext,
  QuoteKind,
} from './framework/strategy.js'
export type {
  Alert,
  AgentStatus,
  Decision,
  DecisionRecord,
  EquityPoint,
  Intent,
  Mode,
  Position,
  RefusalReason,
  RiskLimits,
  TradeRecord,
} from './framework/types.js'

// Strategies
export { LaunchSniper } from './strategies/launch-sniper.js'
export type { LaunchSniperParams } from './strategies/launch-sniper.js'
export { Momentum } from './strategies/momentum.js'
export type { MomentumParams } from './strategies/momentum.js'
export { PremiumWatch } from './strategies/premium-watch.js'
export type { PremiumWatchParams } from './strategies/premium-watch.js'
export { LlmStrategist } from './strategies/llm-strategist.js'
export type { LlmStrategistParams } from './strategies/llm-strategist.js'

// LLM client (bring your own key — Claude, OpenAI, Groq, or OpenRouter)
export { judgeLaunch, parseVerdict } from './framework/llm.js'
export type { LlmProvider, LlmClientConfig, LlmVerdict } from './framework/llm.js'

// Dashboard server
export { createDashboardServer } from './server/dashboard.js'
