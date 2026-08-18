/**
 * @fileoverview Pulls the actionable sentence out of an FDSN service's 4xx error body.
 * `fetchWithTimeout` captures the upstream body into `error.data.body` but leaves the
 * thrown message at a bare status code, so a content[]-only client sees "Status: 400"
 * and nothing to act on. Shared by earthquake_search and earthquake_count, which catch
 * the same upstream error shape.
 * @module mcp-server/tools/fdsn-error
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Boilerplate both FDSN implementations append after the reason — a usage URL, the
 * echoed request (which carries an internal upstream hostname), a submission timestamp,
 * and service versions. None of it helps the caller, so extraction stops here.
 */
const TRAILER_START = /^(usage details|request:|request submitted:|service version|fdsnws-event:)/i;

/** The `Error 400: ` stamp both services prefix onto the first line. */
const STATUS_STAMP = /^error\s+\d{3}:\s*/i;

/** Generic HTTP reason phrase USGS repeats after the stamp — no diagnostic value. */
const STATUS_PHRASE_ONLY =
  /^(bad request|unauthorized|forbidden|not found|unprocessable entity|internal server error)$/i;

/** Upper bound on the extracted reason — fits the full USGS sentence, stops short of a body dump. */
const MAX_REASON_CHARS = 300;

/** An HTML error page carries no reason line worth extracting. */
const HTML_BODY = /^\s*<(!doctype\s|html[\s>])/i;

/**
 * `fetchWithTimeout` captures an over-budget error body as head + this marker + tail,
 * glued together without a newline. Everything from the marker onward is a
 * non-contiguous jump into the trailing boilerplate — including the echoed request and
 * its internal upstream hostname.
 */
const ELISION_MARKER = /…\[\d+ bytes? elided\]…/;

/**
 * Reduce a captured body to the lines that are whole. An elided body keeps only what
 * precedes the marker, minus the partial line the cut landed in — a fragment like
 * "Usage det" no longer reads as a trailer, so it would otherwise survive as reason
 * text. A body captured intact is returned unchanged.
 */
function completeLines(body: string): string {
  const marker = ELISION_MARKER.exec(body);
  if (marker === null) return body;
  return body.slice(0, body.lastIndexOf('\n', marker.index) + 1);
}

/**
 * Extract the reason lines from an FDSN error body, dropping the status stamp, the
 * generic HTTP reason phrase, and the trailing boilerplate. USGS puts the useful
 * sentence on the line after `Error 400: Bad Request`; EMSC puts it on the stamp line
 * itself — both shapes reduce to the same result. Returns undefined when nothing
 * beyond boilerplate survives.
 */
export function extractFdsnReason(body: string): string | undefined {
  if (HTML_BODY.test(body)) return;

  const segments: string[] = [];
  for (const raw of completeLines(body).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (TRAILER_START.test(line)) break;
    const stripped = line.replace(STATUS_STAMP, '');
    if (stripped === '' || STATUS_PHRASE_ONLY.test(stripped)) continue;
    segments.push(stripped);
  }

  if (segments.length === 0) return;

  const reason = segments.join(' ');
  return reason.length > MAX_REASON_CHARS
    ? `${reason.slice(0, MAX_REASON_CHARS).trimEnd()}…`
    : reason;
}

/**
 * An upstream rejection of the caller's parameters. `reason` is absent when the body
 * carried nothing beyond boilerplate — the rejection is still real and still the
 * caller's parameters, so it must not be reported as if the service explained itself.
 */
export interface UpstreamRejection {
  reason?: string;
  status: number;
}

/**
 * Codes the framework assigns to the 4xx statuses that mean "the request itself was
 * malformed": 400, 422, and the miscellaneous 4xx range. Deliberately narrower than
 * the whole 400–499 band — 404 classifies as NotFound and, on the FDSN query path,
 * means the configured base URL does not point at an FDSN service, which is an
 * operator problem rather than a bad caller parameter. 401/403/409/429 are likewise
 * their own failure classes and bubble unrelabeled.
 */
const REJECTION_CODES = new Set<number>([
  JsonRpcErrorCode.InvalidParams,
  JsonRpcErrorCode.InvalidRequest,
  JsonRpcErrorCode.ValidationError,
]);

/**
 * Recognize an upstream rejection of the caller's parameters and read the reason out
 * of the captured body. Returns undefined for every other failure (5xx, network,
 * timeout, auth, rate limit, a 404 from a misconfigured base URL) so the caller
 * rethrows those unchanged.
 */
export function upstreamRejection(err: unknown): UpstreamRejection | undefined {
  if (!(err instanceof McpError)) return;
  if (!REJECTION_CODES.has(err.code)) return;

  const status = err.data?.status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return;

  const body = err.data?.body;
  const reason = typeof body === 'string' ? extractFdsnReason(body) : undefined;
  return reason != null ? { status, reason } : { status };
}
