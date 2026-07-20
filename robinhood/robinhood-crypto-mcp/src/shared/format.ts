/** Shared tool-result helpers. */

import { RobinhoodApiError } from './client.js';
import { GuardViolationError } from './guards.js';

export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Serialize a successful tool result. */
export function toolResult(payload: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Serialize a failure so the model can act on it.
 *
 * Guard violations and API errors carry remediation text already; anything
 * else is surfaced verbatim rather than flattened to "an error occurred".
 */
export function toolError(error: unknown): ToolResponse {
  const message =
    error instanceof RobinhoodApiError || error instanceof GuardViolationError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
