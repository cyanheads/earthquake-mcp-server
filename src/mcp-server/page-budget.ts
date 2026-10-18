/**
 * @fileoverview Complete serialized-result sizing for bounded event pages.
 * @module mcp-server/page-budget
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** Successful caller result budget, excluding the caller-controlled JSON-RPC ID. */
export const RESULT_BUDGET = 24_000;
let modernMetadata: object = { resultType: 'complete' };

/** Use the same resolved identity the SDK stamps on modern responses. Set during setup. */
export function setPageIdentity(identity: { name: string; version: string; title: string }) {
  modernMetadata = {
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': identity },
  };
}

/** Match scalar trailers and conservatively allow both separators for every field. */
export function toolEnvelope(
  domain: object,
  content: unknown[],
  metadata: Record<string, unknown>,
  render: Record<string, { render?: (value: never) => string }> = {},
) {
  const fields = Object.entries(metadata).map(([key, value]) =>
    render[key]?.render
      ? render[key].render(value as never)
      : key === 'notice'
        ? `> ${String(value)}`
        : `**${key}:** ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
  );
  return {
    structuredContent: { ...domain, ...metadata },
    content: fields.length
      ? [...content, { type: 'text', text: `\n\n${fields.join('\n\n')}` }]
      : content,
  };
}

/** Choose a prefix by measuring the complete rendered envelope on every candidate. */
export function boundedPage<T extends { id: string }>(
  events: readonly T[],
  limit: number,
  envelope: (count: number) => object,
): number {
  const fits = (count: number) =>
    Buffer.byteLength(JSON.stringify({ ...envelope(count), ...modernMetadata }), 'utf8') <=
    RESULT_BUDGET;
  const max = Math.min(limit, events.length);
  if (fits(max)) return max;
  if (max === 0 || !fits(1)) {
    const eventId = events[0]?.id.slice(0, 128);
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      `An event${eventId ? ` (${eventId})` : ''} or its page metadata exceeds the response budget.`,
      {
        reason: 'result_too_large',
        retryable: false,
        recovery: {
          hint: 'Use a narrower feed or query, or read the event directly from the source.',
        },
      },
    );
  }
  let low = 1;
  let high = max - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}
