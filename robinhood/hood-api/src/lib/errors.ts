/**
 * Structured API errors. Every error response is
 * `{ error, hint, docs }` — never a bare 500 string.
 */

export interface ApiErrorBody {
  /** Stable machine-readable code, e.g. `unknown_symbol`. */
  error: string
  /** Human-actionable hint: what went wrong and how to fix it. */
  hint: string
  /** Link into the docs for this class of error. */
  docs: string
}

const DOCS_BASE = 'https://nirholas.github.io/hood-api'

/** Every HTTP status an ApiError can carry — a closed literal union so route handlers typecheck against `default`. */
export type ApiErrorStatus = 400 | 401 | 404 | 451 | 500 | 502 | 503

export class ApiError extends Error {
  readonly status: ApiErrorStatus
  readonly code: string
  readonly hint: string
  readonly docsPath: string

  constructor(status: ApiErrorStatus, code: string, hint: string, docsPath = '/#errors') {
    super(`${code}: ${hint}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.hint = hint
    this.docsPath = docsPath
  }

  toBody(): ApiErrorBody {
    return { error: this.code, hint: this.hint, docs: `${DOCS_BASE}${this.docsPath}` }
  }

  static badRequest(hint: string, code = 'bad_request') {
    return new ApiError(400, code, hint, '/#errors')
  }
  static notFound(hint: string, code = 'not_found') {
    return new ApiError(404, code, hint, '/#errors')
  }
  static unknownSymbol(symbol: string) {
    return new ApiError(
      404,
      'unknown_symbol',
      `"${symbol}" is not a canonical Robinhood Chain Stock Token. List them at /v1/stocks.`,
      '/#stocks',
    )
  }
  static upstream(hint: string, code = 'upstream_unavailable') {
    return new ApiError(502, code, hint, '/#errors')
  }
  static paymentsDisabled() {
    return new ApiError(
      503,
      'payments_not_configured',
      'This endpoint requires x402 payment but the server has no X402_PAY_TO configured. Run the free endpoints, or deploy with payments enabled.',
      '/#x402',
    )
  }
  static sessionInvalid(hint: string) {
    return new ApiError(401, 'session_invalid', hint, '/#firehose')
  }
}

/**
 * Shared `defaultHook` for `OpenAPIHono` instances: turns a failed zod request
 * validation (bad param/query) into the same `{ error, hint, docs }` shape as
 * every other error path, instead of zod-openapi's raw `ZodError` JSON.
 */
export function apiValidationHook(
  result: { success: true } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } },
  c: { json: (body: ApiErrorBody, status: 400) => Response },
) {
  if (result.success) return
  const first = result.error.issues[0]
  const field = first?.path.join('.') || 'request'
  const err = ApiError.badRequest(`Invalid ${field}: ${first?.message ?? 'validation failed'}`, 'invalid_request')
  return c.json(err.toBody(), 400)
}

/** Convert any thrown value into an ApiError, mapping known SDK error names. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  const name = (err as { name?: string })?.name ?? ''
  const message = (err as { message?: string })?.message ?? String(err)
  switch (name) {
    case 'UnknownSymbolError':
      return ApiError.notFound(message, 'unknown_symbol')
    case 'FeedNotFoundError':
      return ApiError.notFound(message, 'no_feed')
    case 'StaleFeedError':
      return ApiError.upstream(message, 'stale_feed')
    case 'InvalidFeedAnswerError':
      return ApiError.upstream(message, 'invalid_feed_answer')
    case 'NoRouteError':
      return ApiError.notFound(message, 'no_dex_route')
    case 'StockTokenEligibilityError':
      return new ApiError(451, 'stock_token_eligibility', message, '/#legal')
    default:
      return ApiError.upstream(
        `Upstream read failed: ${message}`,
        'upstream_unavailable',
      )
  }
}
