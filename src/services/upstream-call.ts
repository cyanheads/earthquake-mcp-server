/**
 * @fileoverview Call plumbing shared by the USGS and EMSC services — the per-call
 * deadline, the HTML-body guard, the labelled request context, and the cancellation test.
 * @module services/upstream-call
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';

/**
 * Total budget for one tool call's upstream work — every request, retry, and backoff
 * it chains — so the server answers before an MCP SDK client's 60-second timeout.
 */
export const CALL_DEADLINE_MS = 50_000;

/** A CDN or rate-limit page served in place of the requested document. */
export const HTML_BODY = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/**
 * Build an operation-labelled child of the handler context for withRetry/fetchWithTimeout.
 * `Context extends RequestContext`, so passing `ctx` as the parent inherits every
 * correlation field. The label is what the child adds: `ctx.operation` names the calling
 * tool, while `fetchWithTimeout` reports `context.operation` on a timeout — so the error
 * names the upstream call that hung, not whichever tool reached it.
 */
export function makeReqCtx(operation: string, ctx: Context) {
  return requestContextService.createRequestContext({ operation, parentContext: ctx });
}

/** A caller cancellation, which must propagate rather than degrade a result. */
export function isCancellation(err: unknown, ctx: Context): boolean {
  return (
    ctx.signal?.aborted === true ||
    (err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled)
  );
}
