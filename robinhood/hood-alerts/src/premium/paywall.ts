import { createPublicClient, createWalletClient, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { robinhood } from 'viem/chains'
import type { HoodBroadcaster, HoodConfirmer } from 'hood402'
import { PaywallEngine } from 'hood402/server'
import type { Config } from '../config.js'
import type { EntitlementRepo } from '../db/entitlements.js'
import type { Platform } from '../db/subscribers.js'

/** Outcome of a premium activation attempt. */
export type ActivationResult =
  | { status: 402; body: unknown }
  | { status: 200; body: unknown; settlementHeader: string }
  | { status: 503; body: unknown }

/**
 * The premium purchase flow on the hood402 rail (x402 `exact`/EIP-3009 USDG
 * on Robinhood Chain): a 402 challenge, verification, ON-CHAIN settlement,
 * and only then the entitlement flip. The entitlement never activates before
 * the USDG transfer settles, so a signature alone buys nothing.
 *
 * Settlement modes (from config):
 * - facilitator: HOOD402_FACILITATOR_URL delegates verify+settle (no gas key here)
 * - self-settle: HOOD402_SETTLER_KEY broadcasts `transferWithAuthorization` itself
 */
export class PremiumPaywall {
  private readonly engine: PaywallEngine | null

  constructor(
    private readonly config: Config,
    private readonly entitlements: EntitlementRepo,
  ) {
    this.engine = this.buildEngine()
  }

  /** True when this instance can actually sell premium. */
  get enabled(): boolean {
    return this.engine !== null
  }

  private buildEngine(): PaywallEngine | null {
    const { payTo, facilitatorUrl, settlerKey, premiumPriceUsdg, premiumDays } = this.config
    if (!payTo) return null
    const base = {
      price: premiumPriceUsdg,
      payTo,
      network: 'robinhood',
      description: `hood-alerts premium: ${premiumDays} days of unlimited real-time alerts`,
    }
    if (facilitatorUrl) return new PaywallEngine({ ...base, facilitator: facilitatorUrl })
    if (settlerKey) {
      const account = privateKeyToAccount(settlerKey)
      const transport = http(this.config.rpcUrl)
      const reader = createPublicClient({ chain: robinhood, transport })
      const wallet = createWalletClient({ chain: robinhood, transport, account })
      // hood402 is a local file: link with its own pinned viem; the client
      // identities differ only at compile time (patch-level viem skew), so the
      // structurally-correct clients are bridged to hood402's expected types.
      return new PaywallEngine({
        ...base,
        wallet: wallet as unknown as HoodBroadcaster,
        account: account.address as Address,
        reader: reader as unknown as HoodConfirmer,
      })
    }
    return null
  }

  /**
   * Handle one activation request. `paymentHeader` is the raw `X-PAYMENT`
   * value (undefined on the first, unpaid request, which earns the 402
   * challenge with full payment instructions).
   */
  async activate(
    platform: Platform,
    chatId: string,
    paymentHeader: string | undefined,
    resourceUrl: string,
  ): Promise<ActivationResult> {
    if (!this.engine) {
      return {
        status: 503,
        body: {
          error: 'premium purchases are not configured on this instance',
          fix: 'set HOOD402_PAY_TO plus HOOD402_FACILITATOR_URL or HOOD402_SETTLER_KEY',
          docs: 'https://nirholas.github.io/hood-alerts/self-host.html',
        },
      }
    }
    const auth = await this.engine.authorize(paymentHeader, resourceUrl)
    if (!auth.ok) return { status: 402, body: auth.body }

    const settlement = await this.engine.settle(auth.payload, auth.requirements)
    if (!settlement.success) {
      return {
        status: 402,
        body: {
          x402Version: 1,
          accepts: [auth.requirements],
          error: settlement.errorReason ?? 'settlement failed',
        },
      }
    }

    const entitlement = this.entitlements.activate(platform, chatId, this.config.premiumDays * 86_400, {
      ...(settlement.transaction ? { tx: settlement.transaction } : {}),
      ...(settlement.payer ? { payer: settlement.payer } : {}),
    })
    return {
      status: 200,
      settlementHeader: this.engine.settlementHeader(settlement),
      body: {
        activated: true,
        platform,
        chat: chatId,
        tier: 'premium',
        expiresAt: new Date(entitlement.expiresAt * 1000).toISOString(),
        transaction: settlement.transaction ?? null,
      },
    }
  }
}
