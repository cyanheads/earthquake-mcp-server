/**
 * @fileoverview Tool definition for counting earthquakes matching filters without fetching full records.
 * @module mcp-server/tools/definitions/earthquake-count-events.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { upstreamRejection } from '@/mcp-server/tools/fdsn-error.js';
import {
  buildQueryParams,
  earthquakeFilterFields,
  filterQueryEcho,
  ignoredUsgsFilters,
  invertedRange,
} from '@/mcp-server/tools/query-params.js';
import { getEmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeCountEvents = tool('earthquake_count_events', {
  title: 'Count Earthquakes',
  description:
    'Count matches without event records, or size an earthquake_search_events query. Omitting start_time uses 30 days; pass explicit bounds for historical periods. queryEcho reports applied filters/window; ignoredFilters names unsupported EMSC inputs. Circle and independently optional box edges intersect. Both catalogs include non-tectonic events; event_type="earthquake" excludes them on USGS. exceeds_limit marks the 20,000-event single-request threshold, not a retrieval ceiling: search supports offset paging beyond it. max_allowed is 20,000 for USGS, null for EMSC.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    ...earthquakeFilterFields,
    min_felt: earthquakeFilterFields.min_felt.describe(
      'Minimum number of DYFI (Did You Feel It?) reports. ' +
        'Use to count events with confirmed public impact. Only available from USGS.',
    ),
    event_type: earthquakeFilterFields.event_type.describe(
      'Filter by upstream event classification, e.g. "earthquake" to exclude quarry blasts and ' +
        'explosions from the count, or "quarry blast" to count only those. Matched verbatim ' +
        'against the USGS catalog, which accepts any string and returns a count of zero for an ' +
        'unrecognized one. Only available from USGS.',
    ),
    source: z
      .enum(['usgs', 'emsc'])
      .default('usgs')
      .describe(
        'Data source. Both catalogs are global. ' +
          '"usgs" covers global events with PAGER, DYFI, and ShakeMap metadata. ' +
          '"emsc" is an independent global catalog operated by the European-Mediterranean ' +
          'Seismological Centre — use it to cross-check a count from a separate network. ' +
          'It has no PAGER, DYFI, or ShakeMap metadata; its station coverage is densest around ' +
          'Europe and the Mediterranean, so counts of small events differ most by region.',
      ),
  }),

  output: z.object({
    count: z.number().describe('Number of events matching the query.'),
    max_allowed: z
      .number()
      .nullable()
      .describe(
        'Upstream single-request threshold: 20000 for USGS; null because EMSC count omits it. Offset paging can retrieve larger sets.',
      ),
    source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
    exceeds_limit: z
      .boolean()
      .describe(
        'Count exceeds the single-request threshold (20000 for EMSC despite null max_allowed). Use search offset paging or narrower filters.',
      ),
  }),

  // A count is a single number with no context of its own — the window and filters
  // it covers have to travel with it, including the server-resolved 30-day default.
  // Populated via ctx.enrich(...) so it reaches structuredContent and content[].
  enrichment: {
    queryEcho: z
      .object({
        start_time: z
          .string()
          .optional()
          .describe('Applied start time; defaults to 30 days before end/now.'),
        end_time: z
          .string()
          .optional()
          .describe('Applied end time; absent means upstream current-time default.'),
        min_magnitude: z.number().optional().describe('Applied minimum magnitude.'),
        max_magnitude: z.number().optional().describe('Applied maximum magnitude.'),
        latitude: z.number().optional().describe('Circle latitude, degrees.'),
        longitude: z.number().optional().describe('Circle longitude, degrees.'),
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
        min_depth_km: z.number().optional().describe('Applied minimum depth, km.'),
        max_depth_km: z.number().optional().describe('Applied maximum depth, km.'),
        alert_level: z
          .string()
          .optional()
          .describe('Applied minimum PAGER alert; absent for EMSC.'),
        min_felt: z
          .number()
          .optional()
          .describe('Applied minimum DYFI response count; absent for EMSC.'),
        min_significance: z
          .number()
          .optional()
          .describe('Applied minimum significance; absent for EMSC.'),
        event_type: z.string().optional().describe('Applied event type; absent for EMSC.'),
        magnitude_type: z.string().optional().describe('Applied magnitude type.'),
        product_type: z.string().optional().describe('Applied required product; USGS only.'),
        review_status: z
          .enum(['automatic', 'reviewed'])
          .optional()
          .describe('Applied review status; USGS only.'),
        source: z.enum(['usgs', 'emsc']).describe('Data source queried.'),
      })
      .optional()
      .describe(
        'Echo of the effective parameters the count covers, including server-resolved defaults. ' +
          'Read start_time and end_time to know which window the count spans — a filter absent ' +
          'here was not sent upstream.',
      ),
    ignoredFilters: z
      .array(z.string().describe('Name of an input filter that was not applied.'))
      .optional()
      .describe(
        'USGS-only filters supplied in the input but not sent upstream because source=emsc ' +
          'does not support them. The count is NOT constrained by these — re-run with ' +
          'source=usgs to apply them. Absent when every supplied filter was applied.',
      ),
  },

  enrichmentTrailer: {
    queryEcho: {
      render: (q) =>
        `**Query echo:** ${Object.entries(q ?? {})
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' · ')}`,
    },
    ignoredFilters: {
      render: (f) =>
        `**Ignored filters (not supported by EMSC, not sent upstream):** ${(f ?? []).join(', ')} — ` +
        'this count is NOT constrained by the listed filters. Re-run with source=usgs to apply them.',
    },
  },

  errors: [
    {
      reason: 'invalid_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Minimum magnitude or depth exceeds its maximum, or start_time is after end_time.',
      recovery: 'Swap or correct the named bounds; equal bounds and single bounds are accepted.',
    },
    {
      reason: 'invalid_radius',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitude or longitude provided without radius_km, or vice versa.',
      recovery: 'Provide latitude, longitude, and radius_km together for a location-based count.',
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
        'Narrow the time range or raise min_magnitude so the upstream count scans a smaller ' +
        'window, then retry. Counts over multi-year spans are the usual cause.',
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
    const rangeError = invertedRange(input);
    if (rangeError)
      throw ctx.fail('invalid_range', rangeError, { ...ctx.recoveryFor('invalid_range') });
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

    ctx.log.info('Counting earthquakes', {
      source: input.source,
      start_time: input.start_time,
      min_magnitude: input.min_magnitude,
    });

    // Shared builder applies the documented 30-day start-time default server-side
    const params: EarthquakeQueryParams = buildQueryParams(input);

    let result: Awaited<ReturnType<UsgsService['countEvents']>>;
    try {
      result =
        input.source === 'emsc'
          ? await getEmscService().countEvents(params, ctx)
          : await getUsgsService().countEvents(params, ctx);
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

    ctx.log.info('Count completed', {
      source: input.source,
      count: result.count,
      exceeds_limit: result.exceedsLimit,
    });

    // Echo the effective upstream parameters — the shared echo drops the USGS-only
    // filters for EMSC, which buildFdsnQuery does not send.
    ctx.enrich({
      queryEcho: {
        ...filterQueryEcho(params, input.source),
        source: input.source,
      },
    });

    // An absence from queryEcho is too quiet a signal that a supplied filter never
    // constrained the count — name the dropped filters outright.
    const ignoredFilters = ignoredUsgsFilters(input, input.source);
    if (ignoredFilters.length > 0) ctx.enrich({ ignoredFilters });

    return {
      count: result.count,
      max_allowed: result.maxAllowed,
      source: input.source,
      exceeds_limit: result.exceedsLimit,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Source:** ${result.source.toUpperCase()}`,
      `**Count:** ${result.count}`,
      `**Max allowed:** ${result.max_allowed ?? 'Not reported by EMSC'}`,
      `**Exceeds limit:** ${result.exceeds_limit ? 'Yes — above the single-request threshold. Use search offset paging or narrower filters.' : 'No'}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
