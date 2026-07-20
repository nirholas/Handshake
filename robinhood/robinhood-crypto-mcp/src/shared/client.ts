/**
 * HTTP client for the Robinhood Crypto Trading API.
 *
 * Responsibilities: sign every request, respect the documented rate limit,
 * translate error envelopes into actionable messages, and follow cursors.
 *
 * Responses are returned as-is. Robinhood's published schemas and the two
 * community clients disagree on several field names, so this client does not
 * remap fields — a wrong mapping silently corrupts data, while a pass-through
 * stays correct even when the upstream shape changes.
 */

import { buildAuthHeaders } from './signer.js';
import { redact, RATE_LIMIT_BURST, RATE_LIMIT_PER_MINUTE, type Credentials } from './config.js';

export class RobinhoodApiError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;
  readonly details: Array<{ detail?: string; attr?: string | null }>;

  constructor(
    message: string,
    status: number,
    errorType?: string,
    details: Array<{ detail?: string; attr?: string | null }> = [],
  ) {
    super(message);
    this.name = 'RobinhoodApiError';
    this.status = status;
    this.errorType = errorType;
    this.details = details;
  }
}

/**
 * Token bucket matching Robinhood's documented 100 req/min with 300 burst.
 * Robinhood states limits are per-endpoint and vary, so this is a floor that
 * keeps a well-behaved client under the global ceiling, not an exact mirror.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Resolve once a token is available. */
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await sleep(Math.min(Math.max(waitMs, 10), 5_000));
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  /** Query parameters. Array values repeat the key, which is what Robinhood expects. */
  query?: Record<string, string | string[] | number | undefined>;
  /** JSON body for writes. Serialized once, then both signed and sent. */
  body?: unknown;
  /** Retries for transient failures (429 / 5xx). */
  maxRetries?: number;
}

export class RobinhoodCryptoClient {
  private readonly bucket = new TokenBucket(RATE_LIMIT_BURST, RATE_LIMIT_PER_MINUTE / 60_000);

  constructor(private readonly credentials: Credentials) {}

  get apiVersion(): string {
    return this.credentials.apiVersion;
  }

  async get<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  async post<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const pathWithQuery = path + buildQueryString(options.query);

    // Serialize exactly once: the signature covers these precise bytes.
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const maxRetries = options.maxRetries ?? 2;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.bucket.take();

      // Re-sign per attempt: signatures expire 30s after their timestamp.
      const headers = buildAuthHeaders({
        apiKey: this.credentials.apiKey,
        privateKey: this.credentials.privateKey,
        path: pathWithQuery,
        method,
        body,
      });

      let response: Response;
      try {
        response = await fetch(`${this.credentials.baseUrl}${pathWithQuery}`, {
          method,
          headers: {
            ...headers,
            'Content-Type': 'application/json; charset=utf-8',
            Accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(
          `Request to ${method} ${pathWithQuery} failed: ${redact(String(error), this.credentials)}`,
        );
      }

      if (response.ok) {
        const text = await response.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Robinhood returned a non-JSON body for ${method} ${pathWithQuery}.`);
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoffMs(attempt),
        );
        continue;
      }

      throw await this.toApiError(response, method, pathWithQuery);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Walk a cursor-paginated collection and return every result.
   *
   * @param maxPages - Safety bound so a runaway cursor cannot spin forever.
   */
  async getAllPages<T = unknown>(
    path: string,
    options: RequestOptions = {},
    maxPages = 20,
  ): Promise<{ results: T[]; truncated: boolean }> {
    const results: T[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const query = { ...options.query, ...(cursor ? { cursor } : {}) };
      const body = await this.get<{ results?: T[]; next?: string | null }>(path, {
        ...options,
        query,
      });

      if (Array.isArray(body?.results)) results.push(...body.results);
      else if (body !== undefined && !Array.isArray(body?.results)) {
        // A non-paginated endpoint: return the single payload verbatim.
        return { results: [body as T], truncated: false };
      }

      const next = body?.next;
      if (!next) return { results, truncated: false };

      const nextCursor = extractCursor(next);
      if (!nextCursor || nextCursor === cursor) return { results, truncated: false };
      cursor = nextCursor;
    }

    return { results, truncated: true };
  }

  private async toApiError(
    response: Response,
    method: string,
    path: string,
  ): Promise<RobinhoodApiError> {
    const text = await response.text().catch(() => '');
    let errorType: string | undefined;
    let details: Array<{ detail?: string; attr?: string | null }> = [];

    try {
      const parsed = JSON.parse(text) as {
        type?: string;
        errors?: Array<{ detail?: string; attr?: string | null }>;
      };
      errorType = parsed.type;
      if (Array.isArray(parsed.errors)) details = parsed.errors;
    } catch {
      // Non-JSON error body: fall through to the status-based message.
    }

    const detailText = details
      .map((entry) => (entry.attr ? `${entry.attr}: ${entry.detail}` : entry.detail))
      .filter(Boolean)
      .join('; ');

    const message = [
      `Robinhood API ${response.status} on ${method} ${path}`,
      detailText || redact(text.slice(0, 400), this.credentials) || response.statusText,
      guidanceFor(response.status),
    ]
      .filter(Boolean)
      .join(' — ');

    return new RobinhoodApiError(
      redact(message, this.credentials),
      response.status,
      errorType,
      details,
    );
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000);
}

/**
 * Actionable guidance for the statuses that actually trip people up, rather
 * than a bare status code.
 */
function guidanceFor(status: number): string {
  switch (status) {
    case 401:
      return 'Check ROBINHOOD_CRYPTO_API_KEY and that the private key matches the public key registered with Robinhood. Also verify your system clock: signatures expire 30 seconds after their timestamp.';
    case 403:
      return 'The API credential lacks the required permission. Re-check the scopes selected when the key was created (read vs. order placement), and any IP allowlist on the key.';
    case 404:
      return 'Check the path, including its trailing slash — Robinhood requires it.';
    case 429:
      return 'Rate limited (documented: 100 requests/minute, 300 burst).';
    default:
      return status >= 500 ? 'Robinhood-side error; retry shortly.' : '';
  }
}

function buildQueryString(
  query: Record<string, string | string[] | number | undefined> | undefined,
): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // Repeat the key for array values (?symbol=A&symbol=B) per the API docs.
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Robinhood returns `next` as an absolute URL; we need just the cursor. */
function extractCursor(nextUrl: string): string | undefined {
  try {
    return new URL(nextUrl).searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}
