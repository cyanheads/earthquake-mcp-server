/**
 * @fileoverview Tool definition for searching earthquakes via USGS or EMSC FDSN query API.
 * @module mcp-server/tools/definitions/earthquake-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { buildQueryParams } from '@/mcp-server/tools/query-params.js';
import { EarthquakeEventSchema, formatEvent } from '@/mcp-server/tools/schemas.js';
import { getEmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import { getUsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeSearch = tool('earthquake_search', {
  title: 'Search Earthquakes',
  description:
    'Search earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports. ' +
    'Supports USGS (global, richer metadata: PAGER, DYFI, ShakeMap) and EMSC (European-Mediterranean, independent catalog). ' +
    'For location-based queries, provide latitude, longitude, and radius_km together. ' +
    'USGS-specific filters (alert_level, min_felt, min_significance) are ignored when source=emsc. ' +
    'Use earthquake_count first to gauge result size before requesting large result sets. ' +
    'Results are capped at 20,000 events per query.',
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
          '100 km covers a metro region; 500 km covers a large country. ' +
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
          'Use to find events with confirmed public impact. Only available from USGS.',
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
    source: z
      .enum(['usgs', 'emsc'])
      .default('usgs')
      .describe(
        'Data source. ' +
          '"usgs" covers global events with PAGER, DYFI, and ShakeMap metadata. ' +
          '"emsc" covers the European-Mediterranean region with an independent catalog — ' +
          'useful for cross-verification or European-focused queries.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20000)
      .optional()
      .describe(
        'Maximum events to return. Default 100. ' +
          'Large limits (>1000) may result in slow responses. Max 20000.',
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
          'Fetched via a follow-up count query when results are truncated at the limit; absent otherwise.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when results were capped by the limit parameter and more events likely exist. ' +
          'totalCount carries the full match count when available.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when results are empty or capped — how to broaden filters or get the full count. ' +
          'Absent when the result set is non-empty and within the limit.',
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
        source: z.enum(['usgs', 'emsc']).describe('Data source queried.'),
        limit: z.number().describe('Effective result limit sent upstream.'),
        order_by: z.string().describe('Sort order sent upstream.'),
      })
      .optional()
      .describe(
        'Echo of the effective parameters sent to the upstream API, including server-resolved defaults. ' +
          'Use to diagnose unexpected or empty results — a filter absent here was not sent upstream.',
      ),
  },

  enrichmentTrailer: {
    queryEcho: {
      render: (q) =>
        `**Query echo:** ${Object.entries(q ?? {})
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' · ')}`,
    },
  },

  errors: [
    {
      reason: 'query_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Query matches more than 20,000 events — exceeds USGS search limit.',
      recovery:
        'Narrow the time range, raise min_magnitude, or add a location radius filter. ' +
        'Use earthquake_count first to gauge result size.',
    },
    {
      reason: 'invalid_radius',
      code: JsonRpcErrorCode.ValidationError,
      when: 'latitude or longitude provided without radius_km, or vice versa.',
      recovery: 'Provide latitude, longitude, and radius_km together for a location-based search.',
    },
    {
      reason: 'source_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Selected source API returns non-2xx or times out.',
      recovery: 'Try the other source (usgs or emsc) or retry after a short delay.',
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

    const config = getServerConfig();
    const limit = input.limit ?? config.defaultLimit;

    ctx.log.info('Searching earthquakes', {
      source: input.source,
      limit,
      start_time: input.start_time,
      min_magnitude: input.min_magnitude,
    });

    // Shared builder applies the documented 30-day start-time default server-side
    const params: EarthquakeQueryParams = {
      ...buildQueryParams(input),
      limit,
      orderBy: input.order_by,
    };

    let result: Awaited<ReturnType<typeof getUsgsService.prototype.searchEvents>>;
    try {
      result =
        input.source === 'emsc'
          ? await getEmscService().searchEvents(params, ctx)
          : await getUsgsService().searchEvents(params, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail('source_unavailable', err.message, {
          ...ctx.recoveryFor('source_unavailable'),
        });
      }
      // Plain Error from UsgsService.searchEvents query_too_broad path (data.reason set by service)
      if ((err as { data?: { reason?: string } }).data?.reason === 'query_too_broad') {
        throw ctx.fail('query_too_broad', (err as Error).message, {
          ...ctx.recoveryFor('query_too_broad'),
        });
      }
      throw err;
    }

    ctx.log.info('Search completed', { source: input.source, count: result.count });

    // Echo the effective upstream parameters on every success path — USGS-only
    // filters are excluded for EMSC because buildFdsnQuery does not send them.
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
        source: input.source,
        limit,
        order_by: input.order_by,
      },
    });

    const truncated = result.count === limit && result.count > 0;

    // Populate enrichment — totalCount and truncated flag are meta about the result set,
    // not domain payload; they reach both structuredContent and content[] via enrichment.
    if (result.totalCount != null) ctx.enrich({ totalCount: result.totalCount });
    if (truncated) ctx.enrich({ truncated: true });

    if (result.count === 0) {
      ctx.enrich.notice(
        'No events matched the query. ' +
          'Try broadening the time range, lowering min_magnitude, or expanding the radius.',
      );
    } else if (truncated) {
      ctx.enrich.notice(
        result.totalCount != null
          ? `Results capped at the limit (${limit}) — ${result.totalCount} events match. Narrow filters or increase limit.`
          : `Results capped at the limit (${limit}). Use earthquake_count to get the total match count, then narrow filters or increase limit.`,
      );
    }

    return {
      count: result.count,
      source: input.source,
      events: result.events,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Source:** ${result.source.toUpperCase()} | **Count:** ${result.count}`,
      '',
    ];

    if (result.count === 0) {
      lines.push('_No events matched the query._');
    } else {
      for (const event of result.events) {
        lines.push(...formatEvent(event));
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
