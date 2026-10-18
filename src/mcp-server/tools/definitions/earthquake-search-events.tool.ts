/**
 * @fileoverview Tool definition for searching earthquakes via USGS or EMSC FDSN query API.
 * @module mcp-server/tools/definitions/earthquake-search-events.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { boundedPage, toolEnvelope } from '@/mcp-server/page-budget.js';
import { upstreamRejection } from '@/mcp-server/tools/fdsn-error.js';
import {
  buildQueryParams,
  earthquakeFilterFields,
  filterQueryEcho,
  ignoredUsgsFilters,
} from '@/mcp-server/tools/query-params.js';
import {
  type EarthquakeEventOutput,
  EarthquakeEventSchema,
  formatEvent,
} from '@/mcp-server/tools/schemas.js';
import { getEmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

function formatSearch(result: { source: string; count: number; events: EarthquakeEventOutput[] }) {
  const lines = [`**Source:** ${result.source.toUpperCase()} | **Count:** ${result.count}`, ''];
  if (result.count === 0) lines.push('_No events matched the query._');
  else for (const event of result.events) lines.push(...formatEvent(event), '');
  return [{ type: 'text' as const, text: lines.join('\n') }];
}

const searchTrailer = {
  countUnavailable: {
    render: () =>
      '**Total match count unavailable:** the follow-up count query failed, so the total number of matches is unknown for this call. The returned events are unaffected.',
  },
  queryEcho: {
    render: (q: object | undefined) =>
      `**Query echo:** ${Object.entries(q ?? {})
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' · ')}`,
  },
  ignoredFilters: {
    render: (f: string[] | undefined) =>
      `**Ignored filters (not supported by EMSC, not sent upstream):** ${(f ?? []).join(', ')} — these results are NOT constrained by the listed filters. Re-run with source=usgs to apply them.`,
  },
};

export const earthquakeSearchEvents = tool('earthquake_search_events', {
  title: 'Search Earthquakes',
  description:
    'Search earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports. ' +
    'Supports USGS (global, richer metadata: PAGER, DYFI, ShakeMap) and EMSC, an independent global ' +
    'catalog operated by the European-Mediterranean Seismological Centre. ' +
    'For location-based queries, provide latitude, longitude, and radius_km together. ' +
    'A rectangular study area is expressed with min_latitude, max_latitude, min_longitude, and ' +
    'max_longitude — each independently optional, so a single edge is a valid constraint. Combining ' +
    'the box with the lat/lon/radius circle intersects the two, returning only events inside both. ' +
    'Both catalogs include non-tectonic records (quarry blasts, explosions) — every event carries ' +
    'its event_type, and event_type="earthquake" filters the rest out on USGS. ' +
    'USGS-specific filters (alert_level, event_type, min_felt, min_significance) are not sent when ' +
    'source=emsc — the response names them in ignoredFilters. ' +
    'Use earthquake_count_events first to gauge result size before requesting large result sets. ' +
    'A call accepts limit up to 20,000 but fetches at most 100 candidates and returns a 24,000-byte page; retrieve remaining results by paging with ' +
    'offset, which is passed straight through to the upstream FDSN API. When a result is capped, ' +
    'nextOffset carries the offset for the following page and totalCount the full match count — ' +
    'or countUnavailable reports that the count lookup failed and the total is unknown.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...earthquakeFilterFields,
    radius_km: earthquakeFilterFields.radius_km.describe(
      'Search radius in kilometers from the lat/lon point. ' +
        '100 km covers a metro region; 500 km covers a large country. ' +
        'Max 20001.6, the ceiling USGS enforces. ' +
        'Converted to degrees for EMSC (1° ≈ 111.2 km).',
    ),
    source: z
      .enum(['usgs', 'emsc'])
      .default('usgs')
      .describe(
        'Data source. Both catalogs are global. ' +
          '"usgs" covers global events with PAGER, DYFI, and ShakeMap metadata. ' +
          '"emsc" is an independent global catalog operated by the European-Mediterranean ' +
          'Seismological Centre — use it to cross-check any event, anywhere, against a separate ' +
          'network. It publishes no PAGER, DYFI, or ShakeMap metadata and no per-event detail ' +
          'endpoint; its station coverage is densest around Europe and the Mediterranean.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20000)
      .optional()
      .describe(
        'Maximum events to return per call. Default 100. ' +
          'Accepts up to 20000; fetches at most 100 candidates and returns a byte-bounded page. ' +
          'Combine with offset to retrieve match sets larger than one call can return.',
      ),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Index of the first event to return, counting from 1 — offset=1 is the first match ' +
          '(both upstream APIs reject 0). Omit for the first page, then pass the nextOffset ' +
          'value from a capped result to fetch the next one. Ordering is set by order_by, so ' +
          'keep order_by, limit, and every filter identical across pages.',
      ),
    order_by: z
      .enum(['time', 'time-asc', 'magnitude', 'magnitude-asc'])
      .default('time')
      .describe('Sort order. "time" returns newest first; "magnitude" returns largest first.'),
  }),

  output: z.object({
    count: z.number().describe('Number of events returned.'),
    source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
    events: z
      .array(EarthquakeEventSchema.describe('A single earthquake event.'))
      .describe('Matching earthquake events.'),
  }),

  // Agent-facing context on the success path — total match count, truncation flag,
  // query echo, and recovery guidance for empty or capped result sets. Populated via
  // ctx.enrich(...) so it reaches both structuredContent and content[] automatically.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total events matching the query before the limit was applied. ' +
          'Fetched via a follow-up count query when results are truncated at the limit. Absent ' +
          'when results were not capped, and when that follow-up query failed — countUnavailable ' +
          'separates the two.',
      ),
    countUnavailable: z
      .boolean()
      .optional()
      .describe(
        'True when the follow-up total-count query failed, so the total is unknown for this ' +
          'call rather than never requested. The returned events are complete and unaffected; ' +
          'only totalCount is missing. Retry earthquake_count_events with the same filters to recover ' +
          'the total. Absent whenever the count succeeded or was never needed.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when results were capped by the requested limit, candidate limit, or response byte budget. ' +
          'totalCount carries the full match count when available, and nextOffset the input ' +
          'for the following page. With countUnavailable set the total is unknown, so this ' +
          'flag means the page was filled, not that more events are confirmed to remain.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as the offset input to retrieve the next page, with every other input ' +
          'unchanged. Present when more events remain or may remain with an unknown total; absent means this was the last page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when results are empty or capped — how to broaden filters or get the full count. ' +
          'Absent when the result set is non-empty and within the limit.',
      ),
    ignoredFilters: z
      .array(z.string().describe('Name of an input filter that was not applied.'))
      .optional()
      .describe(
        'USGS-only filters supplied in the input but not sent upstream because source=emsc ' +
          'does not support them. The result set is NOT constrained by these — re-run with ' +
          'source=usgs to apply them. Absent when every supplied filter was applied.',
      ),
    queryEcho: z
      .object({
        start_time: z
          .string()
          .optional()
          .describe(
            'Effective query start time sent upstream — server-resolved to a 30-day window when omitted from input.',
          ),
        end_time: z
          .string()
          .optional()
          .describe(
            'Effective query end time. Absent when omitted from input — the upstream defaults to the current time.',
          ),
        min_magnitude: z.number().optional().describe('Minimum magnitude filter sent upstream.'),
        max_magnitude: z.number().optional().describe('Maximum magnitude filter sent upstream.'),
        latitude: z.number().optional().describe('Radius-search latitude sent upstream.'),
        longitude: z.number().optional().describe('Radius-search longitude sent upstream.'),
        radius_km: z
          .number()
          .optional()
          .describe('Search radius in km sent upstream (converted to degrees for EMSC).'),
        min_latitude: z
          .number()
          .optional()
          .describe('Southern bounding-box edge sent upstream, in degrees.'),
        max_latitude: z
          .number()
          .optional()
          .describe('Northern bounding-box edge sent upstream, in degrees.'),
        min_longitude: z
          .number()
          .optional()
          .describe('Western bounding-box edge sent upstream, in degrees.'),
        max_longitude: z
          .number()
          .optional()
          .describe('Eastern bounding-box edge sent upstream, in degrees.'),
        min_depth_km: z.number().optional().describe('Minimum depth filter sent upstream.'),
        max_depth_km: z.number().optional().describe('Maximum depth filter sent upstream.'),
        alert_level: z
          .string()
          .optional()
          .describe('PAGER alert filter sent upstream. Absent for EMSC — not supported there.'),
        min_felt: z
          .number()
          .optional()
          .describe(
            'DYFI felt-report filter sent upstream. Absent for EMSC — not supported there.',
          ),
        min_significance: z
          .number()
          .optional()
          .describe('Significance filter sent upstream. Absent for EMSC — not supported there.'),
        event_type: z
          .string()
          .optional()
          .describe('Event-type filter sent upstream. Absent for EMSC — not supported there.'),
        source: z.enum(['usgs', 'emsc']).describe('Data source queried.'),
        limit: z.number().describe('Effective result limit sent upstream.'),
        offset: z
          .number()
          .optional()
          .describe('1-based paging offset sent upstream. Absent when the first page was fetched.'),
        order_by: z.string().describe('Sort order sent upstream.'),
      })
      .optional()
      .describe(
        'Echo of the effective parameters sent to the upstream API, including server-resolved defaults. ' +
          'Use to diagnose unexpected or empty results — a filter absent here was not sent upstream.',
      ),
  },

  enrichmentTrailer: searchTrailer,

  errors: [
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One event or page metadata cannot fit the response budget.',
      recovery: 'Narrow the query or read the event directly upstream.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_radius',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitude or longitude provided without radius_km, or vice versa.',
      recovery: 'Provide latitude, longitude, and radius_km together for a location-based search.',
    },
    {
      reason: 'invalid_bounding_box',
      code: JsonRpcErrorCode.ValidationError,
      when: 'min_latitude exceeds max_latitude, or min_longitude exceeds max_longitude.',
      recovery:
        'Swap the inverted pair so the minimum is not above the maximum. An equal pair is a ' +
        'valid degenerate box. To cross the antimeridian, keep min_longitude below ' +
        'max_longitude and extend max_longitude past 180 (or min_longitude below -180).',
    },
    {
      reason: 'source_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Selected source API returns a 5xx or is unreachable.',
      retryable: true,
      recovery: 'Try the other source (usgs or emsc) or retry after a short delay.',
    },
    {
      reason: 'source_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Selected source API did not answer before the request deadline.',
      retryable: true,
      recovery:
        'Narrow the time range, raise min_magnitude, or lower limit so the upstream query ' +
        'returns faster, then retry. Use earthquake_count_events first to size the match set.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The source API rejected the query parameters and explained why in its response body.',
      recovery:
        'Read the upstream reason in the error message — it names the offending parameter and ' +
        'the accepted format. Correct that parameter and call again.',
    },
    {
      reason: 'upstream_rejected_no_reason',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The source API rejected the query but its response body carried no usable explanation.',
      recovery:
        'The service named no offending parameter. Re-check the parameters you supplied — ' +
        'time range format, magnitude bounds, and the lat/lon/radius trio are the usual causes — ' +
        'or retry with the other source to see whether it accepts the same query.',
    },
  ],

  async handler(input, ctx) {
    // Validate radius params — all three must be provided together
    const latProvided = input.latitude != null;
    const lonProvided = input.longitude != null;
    const radiusProvided = input.radius_km != null;

    if (
      (latProvided || lonProvided || radiusProvided) &&
      !(latProvided && lonProvided && radiusProvided)
    ) {
      throw ctx.fail(
        'invalid_radius',
        'Radius search requires latitude, longitude, and radius_km — provide all three together.',
        { ...ctx.recoveryFor('invalid_radius') },
      );
    }

    // Only a strictly inverted pair is wrong. An equal pair is a degenerate box both
    // providers answer with real events, so rejecting it would invent a restriction
    // neither upstream imposes.
    if (
      input.min_latitude != null &&
      input.max_latitude != null &&
      input.min_latitude > input.max_latitude
    ) {
      throw ctx.fail(
        'invalid_bounding_box',
        `min_latitude (${input.min_latitude}) is above max_latitude (${input.max_latitude}).`,
        { ...ctx.recoveryFor('invalid_bounding_box') },
      );
    }
    if (
      input.min_longitude != null &&
      input.max_longitude != null &&
      input.min_longitude > input.max_longitude
    ) {
      throw ctx.fail(
        'invalid_bounding_box',
        `min_longitude (${input.min_longitude}) is above max_longitude (${input.max_longitude}).`,
        { ...ctx.recoveryFor('invalid_bounding_box') },
      );
    }

    const config = getServerConfig();
    const limit = Math.min(input.limit ?? config.defaultLimit, 100);

    ctx.log.info('Searching earthquakes', {
      source: input.source,
      limit,
      offset: input.offset,
      start_time: input.start_time,
      min_magnitude: input.min_magnitude,
    });

    // Shared builder applies the documented 30-day start-time default server-side
    const params: EarthquakeQueryParams = {
      ...buildQueryParams(input),
      limit,
      ...(input.offset != null ? { offset: input.offset } : {}),
      orderBy: input.order_by,
    };

    let result: Awaited<ReturnType<UsgsService['searchEvents']>>;
    try {
      result =
        input.source === 'emsc'
          ? await getEmscService().searchEvents(params, ctx)
          : await getUsgsService().searchEvents(params, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail(
          'source_unavailable',
          err.message,
          {
            ...ctx.recoveryFor('source_unavailable'),
            ...(err.data?.retryable === false
              ? {
                  retryable: false,
                  recovery: {
                    hint: 'Do not retry this source: it does not implement the operation. Change source to the other catalog (usgs or emsc).',
                  },
                }
              : {}),
          },
          { cause: err },
        );
      }
      // A timeout classifies as Timeout, not ServiceUnavailable — it needs its own
      // branch or it bypasses the contract and reaches the caller with no recovery hint.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Timeout) {
        throw ctx.fail('source_timeout', err.message, {
          ...ctx.recoveryFor('source_timeout'),
        });
      }
      // A 4xx means the upstream rejected the parameters, and its body usually says
      // which one. The framework leaves that body out of the message, so fold it in
      // here — otherwise content[]-only clients see a bare status code. A body with no
      // usable reason still gets a contract reason of its own, so the raw upstream text
      // (which echoes an internal hostname) never substitutes for an explanation.
      const rejection = upstreamRejection(err);
      if (rejection) {
        const source = input.source.toUpperCase();
        if (rejection.reason != null) {
          throw ctx.fail(
            'upstream_rejected',
            `${source} rejected the query: ${rejection.reason}`,
            { ...ctx.recoveryFor('upstream_rejected'), status: rejection.status },
            { cause: err },
          );
        }
        throw ctx.fail(
          'upstream_rejected_no_reason',
          `${source} rejected the query (HTTP ${rejection.status}) — the service gave no reason.`,
          { ...ctx.recoveryFor('upstream_rejected_no_reason'), status: rejection.status },
          { cause: err },
        );
      }
      throw err;
    }

    ctx.log.info('Search completed', { source: input.source, count: result.count });

    const queryEcho = {
      ...filterQueryEcho(params, input.source),
      source: input.source,
      limit,
      ...(input.offset != null ? { offset: input.offset } : {}),
      order_by: input.order_by,
    };

    // An absence from queryEcho is too quiet a signal that a supplied filter never
    // constrained the results — name the dropped filters outright.
    const ignoredFilters = ignoredUsgsFilters(input, input.source);

    // Offsets are 1-based upstream, so the events consumed through this page are
    // (offset - 1) + count and the next page starts at offset + count. A full page
    // that exactly exhausts a known total is the last page, not a truncated one.
    const offset = input.offset ?? 1;
    const events = result.events.slice(0, limit);
    const domain = (count: number) => ({
      count,
      source: input.source,
      events: events.slice(0, count),
    });
    const metadata = (count: number) => {
      const nextOffset = offset + count;
      const truncated =
        count < result.events.length ||
        (result.count >= limit &&
          count > 0 &&
          (result.totalCount == null || nextOffset - 1 < result.totalCount));
      let notice: string | undefined;
      if (count === 0)
        notice =
          offset > 1
            ? `No events at offset ${offset} — the previous page was the last one. Lower offset or broaden the filters.`
            : 'No events matched the query. Try broadening the time range, lowering min_magnitude, or expanding the radius.';
      else if (truncated)
        notice =
          (result.totalCount != null
            ? `Showing events ${offset}–${nextOffset - 1} of ${result.totalCount} matches. `
            : result.countUnavailable
              ? 'Results capped; the follow-up count query failed, so the total is unknown. '
              : `Results capped at the limit (${limit}) or response budget. Use earthquake_count_events to get the full count. `) +
          `Call again with offset=${nextOffset} and the same filters, source, limit and order_by for the next page.`;
      return {
        queryEcho,
        ...(ignoredFilters.length ? { ignoredFilters } : {}),
        ...(result.totalCount != null ? { totalCount: result.totalCount } : {}),
        ...(result.countUnavailable ? { countUnavailable: true } : {}),
        ...(truncated ? { truncated: true, nextOffset } : {}),
        ...(notice != null ? { notice } : {}),
      };
    };
    const count = boundedPage(events, limit, (n) =>
      toolEnvelope(domain(n), formatSearch(domain(n)), metadata(n), searchTrailer),
    );
    const { notice, ...meta } = metadata(count);
    ctx.enrich(meta);
    if (notice != null) ctx.enrich.notice(notice);
    return domain(count);
  },

  format: formatSearch,
});
