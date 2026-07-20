import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseEther, type Address } from 'viem'
import { LlmStrategist } from '../../src/strategies/llm-strategist.js'
import { parseVerdict, judgeLaunch } from '../../src/framework/llm.js'
import type { Market } from '../../src/framework/market.js'
import type { StrategyTickContext } from '../../src/framework/strategy.js'
import { FakeMarket } from './helpers/fake-market.js'

const TOKEN_A = '0x2222222222222222222222222222222222222b' as Address
const CREATOR = '0x3333333333333333333333333333333333333c' as Address
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

function ctxFor(market: FakeMarket, now: number): StrategyTickContext {
  return {
    market: market as unknown as Market,
    positions: [],
    now,
    quoteToken: WETH,
    quoteSymbol: 'WETH',
    quoteDecimals: 18,
    log: () => {},
  }
}

function seeded(strategist: LlmStrategist, launch: { token: Address; creator: Address; launchpad: 'noxa' | 'odyssey'; pool: Address | null }) {
  ;(strategist as unknown as { queue: { launch: typeof launch; seenAt: number }[] }).queue.push({
    launch: { ...launch, blockNumber: 1n, transactionHash: '0xdead' as `0x${string}` },
    seenAt: Date.now(),
  })
}

describe('parseVerdict', () => {
  it('parses a clean JSON object', () => {
    const v = parseVerdict('{"buy": true, "confidence": 0.8, "thesis": "clean retention, low deployer share"}')
    expect(v).toEqual({ buy: true, confidence: 0.8, thesis: 'clean retention, low deployer share' })
  })

  it('extracts JSON embedded in surrounding prose', () => {
    const v = parseVerdict('Sure, here is my verdict:\n{"buy": false, "confidence": 0.3, "thesis": "thin liquidity"}\nHope that helps!')
    expect(v.buy).toBe(false)
    expect(v.confidence).toBe(0.3)
  })

  it('clamps out-of-range confidence into [0, 1]', () => {
    expect(parseVerdict('{"buy": true, "confidence": 1.4, "thesis": "x"}').confidence).toBe(1)
    expect(parseVerdict('{"buy": true, "confidence": -0.2, "thesis": "x"}').confidence).toBe(0)
  })

  it('throws on missing JSON entirely', () => {
    expect(() => parseVerdict('no json here')).toThrow(/no JSON object/)
  })

  it('throws when "buy" is not a boolean', () => {
    expect(() => parseVerdict('{"buy": "yes", "confidence": 0.5, "thesis": "x"}')).toThrow(/missing boolean "buy"/)
  })

  it('throws when "thesis" is missing or empty', () => {
    expect(() => parseVerdict('{"buy": true, "confidence": 0.5, "thesis": ""}')).toThrow(/non-empty "thesis"/)
  })
})

describe('judgeLaunch — provider dispatch', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('calls the Anthropic Messages API and parses its response shape', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages')
      return new Response(JSON.stringify({ content: [{ text: '{"buy": true, "confidence": 0.9, "thesis": "great"}' }] }), { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const verdict = await judgeLaunch({ provider: 'anthropic', apiKey: 'test-key' }, 'brief')
    expect(verdict.buy).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('calls the OpenAI-compatible chat-completions shape for openai/groq/openrouter', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"buy": false, "confidence": 0.2, "thesis": "skip"}' } }] }), { status: 200 })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const verdict = await judgeLaunch({ provider: 'groq', apiKey: 'test-key' }, 'brief')
    expect(verdict.buy).toBe(false)
  })

  it('throws a descriptive error on a non-2xx response', async () => {
    global.fetch = vi.fn(async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch
    await expect(judgeLaunch({ provider: 'openai', apiKey: 'test-key' }, 'brief')).rejects.toThrow(/HOOD_LLM_MODEL/)
  })
})

describe('LlmStrategist.tick', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = global.fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  function verdictResponse(buy: boolean, confidence: number, thesis = 'because') {
    return new Response(JSON.stringify({ content: [{ text: JSON.stringify({ buy, confidence, thesis }) }] }), { status: 200 })
  }

  it('turns a high-confidence buy verdict into a buy Intent', async () => {
    fetchMock.mockResolvedValueOnce(verdictResponse(true, 0.9, 'clean signals'))
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' }, minConfidence: 0.6, entryWeth: 0.01 })
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n)
    market.multicallResults = [parseEther('1000'), parseEther('10')]
    seeded(strategist, { token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })

    const decision = await strategist.tick(ctxFor(market, Date.now()))
    expect(decision.intents).toHaveLength(1)
    expect(decision.intents[0]?.side).toBe('buy')
    expect(decision.intents[0]?.reason).toMatch(/clean signals/)
  })

  it('does not trade a buy verdict below minConfidence', async () => {
    fetchMock.mockResolvedValueOnce(verdictResponse(true, 0.4, 'marginal'))
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' }, minConfidence: 0.6 })
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n)
    market.multicallResults = [parseEther('1000'), parseEther('10')]
    seeded(strategist, { token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })

    const decision = await strategist.tick(ctxFor(market, Date.now()))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/confidence=0.40/)
  })

  it('does not trade a buy:false verdict regardless of confidence', async () => {
    fetchMock.mockResolvedValueOnce(verdictResponse(false, 0.95, 'looks like a rug'))
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' }, minConfidence: 0.6 })
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n)
    market.multicallResults = [parseEther('1000'), parseEther('10')]
    seeded(strategist, { token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })

    const decision = await strategist.tick(ctxFor(market, Date.now()))
    expect(decision.intents).toHaveLength(0)
  })

  it('alerts (never throws) when the LLM call fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' } })
    const market = new FakeMarket()
    const amountIn = parseEther('0.01')
    market.buyRoutes.set(TOKEN_A.toLowerCase(), parseEther('1000'))
    market.sellRoutes.set(TOKEN_A.toLowerCase(), (amountIn * 98n) / 100n)
    market.multicallResults = [parseEther('1000'), parseEther('10')]
    seeded(strategist, { token: TOKEN_A, creator: CREATOR, launchpad: 'noxa', pool: TOKEN_A })

    const decision = await strategist.tick(ctxFor(market, Date.now()))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/LLM judge failed/)
  })

  it('skips a launch with no liquid Uniswap route without calling the LLM', async () => {
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' } })
    const market = new FakeMarket()
    seeded(strategist, { token: TOKEN_A, creator: CREATOR, launchpad: 'odyssey', pool: null })

    const decision = await strategist.tick(ctxFor(market, Date.now()))
    expect(decision.intents).toHaveLength(0)
    expect(decision.alerts[0]?.message).toMatch(/no liquid Uniswap route/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports its edge hypothesis and failure modes (documentation contract)', () => {
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'k' } })
    expect(strategist.meta.edge.length).toBeGreaterThan(20)
    expect(strategist.meta.failureModes.length).toBeGreaterThanOrEqual(3)
  })

  it('never leaks the API key through meta()', () => {
    const strategist = new LlmStrategist({ llm: { provider: 'anthropic', apiKey: 'super-secret-key' } })
    expect(JSON.stringify(strategist.meta)).not.toMatch(/super-secret-key/)
  })
})
