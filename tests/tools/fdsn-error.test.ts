/**
 * @fileoverview Tests for the FDSN 4xx reason extractor. Bodies are verbatim captures
 * from live USGS and EMSC responses — the two services word their 400s differently, and
 * both wrap the useful sentence in boilerplate that must not reach the caller.
 * @module tests/tools/fdsn-error.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { extractFdsnReason, upstreamRejection } from '@/mcp-server/tools/fdsn-error.js';

/** USGS: generic reason phrase on the stamp line, the useful sentence on the next one. */
const USGS_BAD_STARTTIME = `Error 400: Bad Request

Bad starttime value "not-a-date". Valid values are ISO-8601 timestamps.

Usage details are available from https://earthquake.usgs.gov/fdsnws/event/1

Request:
/fdsnws/event/1/query?format=geojson&amp;starttime=not-a-date&amp;limit=5

Request Submitted:
2026-07-26T10:06:54+00:00

Service version:
2.7.0
`;

/** EMSC: the useful sentence rides on the stamp line itself. */
const EMSC_BAD_STARTTIME = `Error 400: Request was not properly specified: start or starttime used a bad format

Request:
http://ws2/query?format=json&start=not-a-date&limit=5

Request Submitted:
2026-07-26T10:06:55.501

Service version: v 2.2
fdsnws-event: v 1.2.1
`;

/** EMSC also answers a type mismatch with a serialized validation record. */
const EMSC_BAD_MAGNITUDE = `Error 400: [{'type': 'float_parsing', 'loc': ('query', 'minmagnitude'), 'msg': 'Input should be a valid number, unable to parse string as a number', 'input': 'abc'}]

Request:
http://ws2/query?format=json&minmagnitude=abc&limit=2

Request Submitted:
2026-07-26T10:07:17.887

Service version: v 2.2
fdsnws-event: v 1.2.1
`;

describe('extractFdsnReason', () => {
  it('pulls the USGS sentence out from under the generic status phrase', () => {
    expect(extractFdsnReason(USGS_BAD_STARTTIME)).toBe(
      'Bad starttime value "not-a-date". Valid values are ISO-8601 timestamps.',
    );
  });

  it('drops the USGS boilerplate trailer', () => {
    const reason = extractFdsnReason(USGS_BAD_STARTTIME) ?? '';
    expect(reason).not.toContain('Usage details');
    expect(reason).not.toContain('Request Submitted');
    expect(reason).not.toContain('Service version');
    expect(reason).not.toContain('2.7.0');
  });

  it('reads the EMSC reason off the stamp line', () => {
    expect(extractFdsnReason(EMSC_BAD_STARTTIME)).toBe(
      'Request was not properly specified: start or starttime used a bad format',
    );
  });

  it('drops the EMSC echoed request, which carries an internal upstream hostname', () => {
    const reason = extractFdsnReason(EMSC_BAD_STARTTIME) ?? '';
    expect(reason).not.toContain('ws2');
    expect(reason).not.toContain('fdsnws-event');
  });

  it('keeps the parameter name from an EMSC validation record', () => {
    const reason = extractFdsnReason(EMSC_BAD_MAGNITUDE) ?? '';
    expect(reason).toContain('minmagnitude');
    expect(reason).toContain('valid number');
    expect(reason).not.toContain('Request Submitted');
  });

  it('bounds an overlong reason and marks the cut', () => {
    const reason = extractFdsnReason(`Error 400: ${'x'.repeat(500)}\n\nRequest:\nfoo`) ?? '';
    expect(reason.length).toBeLessThanOrEqual(301);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('returns undefined for an HTML error page', () => {
    expect(
      extractFdsnReason('<!DOCTYPE html>\n<html><body>502 Bad Gateway</body></html>'),
    ).toBeUndefined();
  });

  it('returns undefined when nothing but boilerplate survives', () => {
    expect(extractFdsnReason('Error 400: Bad Request\n\nRequest:\n/query?x=1\n')).toBeUndefined();
    expect(extractFdsnReason('')).toBeUndefined();
  });
});

describe('upstreamRejection', () => {
  const upstream = (status: number, body: unknown) =>
    new McpError(JsonRpcErrorCode.InvalidParams, `Fetch failed. Status: ${status}`, {
      status,
      statusText: 'Bad Request',
      body,
      errorSource: 'FetchHttpError',
    });

  it('recognizes a 4xx carrying a reason', () => {
    expect(upstreamRejection(upstream(400, USGS_BAD_STARTTIME))).toEqual({
      status: 400,
      reason: 'Bad starttime value "not-a-date". Valid values are ISO-8601 timestamps.',
    });
  });

  it('ignores a 5xx — that failure class is source_unavailable, not a bad parameter', () => {
    expect(upstreamRejection(upstream(503, 'Error 503: upstream down'))).toBeUndefined();
  });

  it('ignores a 4xx whose body says nothing actionable', () => {
    expect(
      upstreamRejection(upstream(400, 'Error 400: Bad Request\n\nRequest:\n/query')),
    ).toBeUndefined();
    expect(upstreamRejection(upstream(400, undefined))).toBeUndefined();
  });

  it('ignores errors that are not McpError', () => {
    expect(upstreamRejection(new Error('boom'))).toBeUndefined();
    expect(upstreamRejection(undefined)).toBeUndefined();
  });
});
