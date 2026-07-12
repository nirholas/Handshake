/** Base class for every error hood-launcher throws. */
export class HoodLauncherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A concept/config failed the abuse denylist or LLM safety screen. */
export class ConceptRejectedError extends HoodLauncherError {
  constructor(
    readonly reason: string,
    readonly field: 'name' | 'symbol' | 'description' | 'concept',
  ) {
    super(`Concept rejected (${field}): ${reason}`)
  }
}

/** A ticker is already in use on-chain / in the registry. */
export class TickerTakenError extends HoodLauncherError {
  constructor(
    readonly symbol: string,
    readonly where: string,
  ) {
    super(`Ticker "${symbol}" is already taken (${where})`)
  }
}

/** A daily/seed cap would be exceeded by this launch. */
export class CapExceededError extends HoodLauncherError {
  constructor(
    readonly cap: string,
    readonly detail: string,
  ) {
    super(`Cap "${cap}" exceeded: ${detail}`)
  }
}

/** The kill switch is engaged; no launches may proceed. */
export class KilledError extends HoodLauncherError {
  constructor(readonly source: string) {
    super(`Kill switch engaged (${source}) — refusing to launch`)
  }
}

/** A launch was requested but no signer/account is configured. */
export class NoSignerError extends HoodLauncherError {
  constructor(op: string) {
    super(`${op} requires a signer — set ROBINHOOD_CHAIN_PRIVATE_KEY or pass an account`)
  }
}

/** The selected rail cannot run on the selected network. */
export class RailUnavailableError extends HoodLauncherError {
  constructor(rail: string, network: string, detail: string) {
    super(`Rail "${rail}" is unavailable on ${network}: ${detail}`)
  }
}

/** The operator has not affirmed launch responsibility (required for live launches). */
export class ResponsibilityNotAffirmedError extends HoodLauncherError {
  constructor() {
    super(
      'Live launch refused: set config.acknowledgeLaunchResponsibility = true (or ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1) ' +
        'to affirm you accept full responsibility for the assets you create.',
    )
  }
}

/** An on-chain launch transaction reverted or produced no token. */
export class LaunchFailedError extends HoodLauncherError {
  constructor(
    message: string,
    readonly transactionHash?: `0x${string}`,
  ) {
    super(message)
  }
}
