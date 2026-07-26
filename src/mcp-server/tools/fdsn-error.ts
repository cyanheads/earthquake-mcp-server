/**
 * @fileoverview Pulls the actionable sentence out of an FDSN service's 4xx error body.
 * `fetchWithTimeout` captures the upstream body into `error.data.body` but leaves the
 * thrown message at a bare status code, so a content[]-only client sees "Status: 400"
 * and nothing to act on. Shared by earthquake_search and earthquake_count, which catch
 * the same upstream error shape.
 * @module mcp-server/tools/fdsn-error
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

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
 * Extract the reason lines from an FDSN error body, dropping the status stamp, the
 * generic HTTP reason phrase, and the trailing boilerplate. USGS puts the useful
 * sentence on the line after `Error 400: Bad Request`; EMSC puts it on the stamp line
 * itself — both shapes reduce to the same result. Returns undefined when nothing
 * beyond boilerplate survives.
 */
export function extractFdsnReason(body: string): string | undefined {
  if (HTML_BODY.test(body)) return;

  const segments: string[] = [];
  for (const raw of body.split('\n')) {
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
 * Recognize an upstream 4xx — the source rejected the caller's parameters — and read
 * the reason out of the captured body. Returns undefined for every other failure
 * (5xx, network, timeout, or a 4xx whose body says nothing) so the caller rethrows
 * unchanged.
 */
export function upstreamRejection(err: unknown): { status: number; reason: string } | undefined {
  if (!(err instanceof McpError)) return;

  const status = err.data?.status;
  const body = err.data?.body;
  if (typeof status !== 'number' || status < 400 || status >= 500) return;
  if (typeof body !== 'string') return;

  const reason = extractFdsnReason(body);
  return reason ? { status, reason } : undefined;
}
