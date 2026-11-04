/**
 * @fileoverview Call plumbing shared by the USGS and EMSC services — the per-call
 * deadline, the HTML-body guard, reading and parsing a 2xx body, the retry predicate,
 * the labelled request context, and the cancellation test.
 * @module services/upstream-call
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, requestContextService } from '@cyanheads/mcp-ts-core/utils';

/**
 * Total budget for one tool call's upstream work — every request, retry, and backoff
 * it chains — so the server answers before an MCP SDK client's 60-second timeout.
 */
export const CALL_DEADLINE_MS = 50_000;

/** A CDN or rate-limit page served in place of the requested document. */
export const HTML_BODY = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/** The upstream a call reads, named in the fixed messages of the errors it raises. */
type UpstreamSource = 'USGS' | 'EMSC';

/** `data.reason` of {@link malformedResponse}, which {@link isTransientUpstream} reads. */
const MALFORMED_RESPONSE = 'malformed_response';

/**
 * A 2xx response that is not the document the call asked for: a body that does not parse,
 * parses to another shape, or holds a record missing a field the source always publishes.
 * `ServiceUnavailable`, so every tool maps it onto its `*_unavailable` reason, with a fixed
 * message that never quotes parser or engine text; the parser's error stays in the log.
 */
export function malformedResponse(source: UpstreamSource, cause?: unknown): McpError {
  return serviceUnavailable(
    `${source} returned a response in an unexpected format.`,
    { reason: MALFORMED_RESPONSE },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * `withRetry`'s predicate for the upstream calls: the framework default, minus a malformed
 * body. A body delivered whole that does not parse is what the origin or its cache served,
 * so an immediate repeat returns the same bytes and only spends the call's deadline; a later
 * call may succeed. The error carries no `retryable: false`, which the tools read as "this
 * source does not implement the operation".
 */
export function isTransientUpstream(error: unknown): boolean {
  return (
    !(error instanceof McpError && error.data?.reason === MALFORMED_RESPONSE) &&
    defaultIsTransient(error)
  );
}

/**
 * Read a 2xx response body. `fetchWithTimeout` keeps its deadline on the body and classifies
 * a read cut short by the attempt timeout or the caller's signal, but rejects with any other
 * read failure as the runtime raised it (cyanheads/mcp-ts-core#819): a connection dropped
 * mid-body. That becomes a retryable `ServiceUnavailable` with a fixed message, as a network
 * failure before the headers does, so no runtime text reaches the caller.
 */
export async function readResponseText(
  response: Response,
  source: UpstreamSource,
): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw serviceUnavailable(
      `${source} closed the connection before the response was complete.`,
      undefined,
      { cause: err },
    );
  }
}

/**
 * Parse a 2xx JSON body and check the top-level shape the caller reads next. A body that
 * does not parse, or parses to anything `hasShape` rejects, fails as {@link malformedResponse}.
 */
export function parseJsonBody<T>(
  text: string,
  source: UpstreamSource,
  hasShape: (value: unknown) => value is T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw malformedResponse(source, err);
  }
  if (!hasShape(value)) throw malformedResponse(source);
  return value;
}

/** A JSON object — not `null`, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a GeoJSON record has the members both catalogs' normalizers read: a `properties`
 * object and a point geometry of numeric longitude and latitude, with a numeric depth or null.
 * The services narrow it to their own feature type.
 */
export function isPointFeature(value: unknown): boolean {
  if (!isJsonObject(value) || !isJsonObject(value.properties) || !isJsonObject(value.geometry)) {
    return false;
  }
  const { type, coordinates } = value.geometry;
  return (
    type === 'Point' &&
    Array.isArray(coordinates) &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number' &&
    (typeof coordinates[2] === 'number' || coordinates[2] === null)
  );
}

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
