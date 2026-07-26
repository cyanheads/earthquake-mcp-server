/**
 * @fileoverview Tool definition for counting earthquakes matching filters without fetching full records.
 * @module mcp-server/tools/definitions/earthquake-count.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { upstreamRejection } from '@/mcp-server/tools/fdsn-error.js';
import { buildQueryParams, ignoredUsgsFilters } from '@/mcp-server/tools/query-params.js';
import { getEmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeCount = tool('earthquake_count', {
  title: 'Count Earthquakes',
  description:
    'Count earthquakes matching filters without fetching full records. ' +
    'Use for statistical queries ("how many M5+ earthquakes in 2025?") or to gauge result size ' +
    'before calling earthquake_search. ' +
    'Omitting start_time counts only the last 30 days, so pass an explicit range for any ' +
    'period-specific question; queryEcho reports the window and filters the count actually covers. ' +
    'When exceeds_limit is true, the count exceeds 20,000 and a full search would be truncated — ' +
    'narrow filters before fetching. ' +
    'USGS returns the max_allowed cap (20,000); EMSC count endpoint does not return this field ' +
    '(max_allowed will be null). ' +
    'Both catalogs include non-tectonic records, so a radius over a mining region counts quarry ' +
    'blasts alongside earthquakes — pass event_type="earthquake" on USGS to exclude them. ' +
    'USGS-specific filters (alert_level, event_type, min_felt, min_significance) are not sent when ' +
    'source=emsc — the response names them in ignoredFilters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    start_time: z
      .string()
      .optional()
      .describe(
        'Start of time range as ISO 8601 (e.g. "2026-01-01" or "2026-05-23T00:00:00"). ' +
          'Defaults to 30 days before end_time (or before the current time) if omitted — ' +
          'applied server-side so USGS and EMSC honor the same window.',
      ),
    end_time: z
      .string()
      .optional()
      .describe('End of time range as ISO 8601. Defaults to current time if omitted.'),
    min_magnitude: z
      .number()
      .min(-1)
      .max(10)
      .optional()
      .describe(
        'Minimum magnitude (Richter or equivalent). ' +
          'M2.5+ is felt by some people; M5+ can cause damage; M7+ is major.',
      ),
    max_magnitude: z.number().min(-1).max(10).optional().describe('Maximum magnitude.'),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Latitude for radius search. Requires longitude and radius_km.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Longitude for radius search. Requires latitude and radius_km.'),
    radius_km: z
      .number()
      .min(0)
      .max(20002)
      .optional()
      .describe(
        'Search radius in kilometers from the lat/lon point. ' +
          'Converted to degrees for EMSC (1° ≈ 111.2 km).',
      ),
    min_depth_km: z
      .number()
      .optional()
      .describe(
        'Minimum depth in kilometers. ' +
          'Shallow quakes (0–70 km) typically cause more surface damage than deep quakes (>300 km).',
      ),
    max_depth_km: z.number().optional().describe('Maximum depth in kilometers.'),
    alert_level: z
      .enum(['green', 'yellow', 'orange', 'red'])
      .optional()
      .describe(
        'Minimum PAGER alert level. PAGER estimates economic loss and casualties. ' +
          '"green" = minimal impact; "red" = extreme. Only available from USGS.',
      ),
    min_felt: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Minimum number of DYFI (Did You Feel It?) reports. ' +
          'Use to count events with confirmed public impact. Only available from USGS.',
      ),
    min_significance: z
      .number()
      .int()
      .optional()
      .describe(
        'Minimum USGS significance score (0–2000+). ' +
          'Combines magnitude, felt reports, and PAGER estimates. ' +
          'Significant events typically score 600+. Only available from USGS.',
      ),
    event_type: z
      .string()
      .optional()
      .describe(
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
        'Maximum events the API would return for a full fetch. 20000 for USGS. ' +
          'Null for EMSC — the EMSC count endpoint does not return this field.',
      ),
    source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
    exceeds_limit: z
      .boolean()
      .describe(
        'True when count exceeds 20000 — a full earthquake_search would be truncated. ' +
          'For EMSC, evaluated against the known 20000 limit since max_allowed is not returned. ' +
          'Narrow filters to retrieve all matching events.',
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
      reason: 'invalid_radius',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitude or longitude provided without radius_km, or vice versa.',
      recovery: 'Provide latitude, longitude, and radius_km together for a location-based count.',
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
        throw ctx.fail('source_unavailable', err.message, {
          ...ctx.recoveryFor('source_unavailable'),
        });
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

    // Echo the effective upstream parameters — USGS-only filters are excluded for
    // EMSC because buildFdsnQuery does not send them.
    const isUsgs = input.source !== 'emsc';
    ctx.enrich({
      queryEcho: {
        ...(params.startTime != null ? { start_time: params.startTime } : {}),
        ...(params.endTime != null ? { end_time: params.endTime } : {}),
        ...(params.minMagnitude != null ? { min_magnitude: params.minMagnitude } : {}),
        ...(params.maxMagnitude != null ? { max_magnitude: params.maxMagnitude } : {}),
        ...(params.latitude != null ? { latitude: params.latitude } : {}),
        ...(params.longitude != null ? { longitude: params.longitude } : {}),
        ...(params.radiusKm != null ? { radius_km: params.radiusKm } : {}),
        ...(params.minDepthKm != null ? { min_depth_km: params.minDepthKm } : {}),
        ...(params.maxDepthKm != null ? { max_depth_km: params.maxDepthKm } : {}),
        ...(isUsgs && params.alertLevel != null ? { alert_level: params.alertLevel } : {}),
        ...(isUsgs && params.minFelt != null ? { min_felt: params.minFelt } : {}),
        ...(isUsgs && params.minSignificance != null
          ? { min_significance: params.minSignificance }
          : {}),
        ...(isUsgs && params.eventType != null ? { event_type: params.eventType } : {}),
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
      `**Exceeds limit:** ${result.exceeds_limit ? '⚠️ Yes — full search would be truncated. Narrow filters.' : 'No'}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
