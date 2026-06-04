/**
 * @fileoverview Tool definition for searching earthquakes via USGS or EMSC FDSN query API.
 * @module mcp-server/tools/definitions/earthquake-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
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
          'Defaults to 30 days before end_time if omitted.',
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
  // and recovery guidance for empty or capped result sets. Populated via ctx.enrich(...)
  // so it reaches both structuredContent and content[] automatically.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total events matching the query before the limit was applied. ' +
          'Absent when the upstream API does not report a total count.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when results were capped by the limit parameter and more events likely exist. ' +
          'Use earthquake_count to get the total match count.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery guidance when results are empty or capped — how to broaden filters or get the full count. ' +
          'Absent when the result set is non-empty and within the limit.',
      ),
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

    // Use conditional spreads to satisfy exactOptionalPropertyTypes
    const params: EarthquakeQueryParams = {
      limit,
      orderBy: input.order_by,
      ...(input.start_time != null ? { startTime: input.start_time } : {}),
      ...(input.end_time != null ? { endTime: input.end_time } : {}),
      ...(input.min_magnitude != null ? { minMagnitude: input.min_magnitude } : {}),
      ...(input.max_magnitude != null ? { maxMagnitude: input.max_magnitude } : {}),
      ...(input.latitude != null ? { latitude: input.latitude } : {}),
      ...(input.longitude != null ? { longitude: input.longitude } : {}),
      ...(input.radius_km != null ? { radiusKm: input.radius_km } : {}),
      ...(input.min_depth_km != null ? { minDepthKm: input.min_depth_km } : {}),
      ...(input.max_depth_km != null ? { maxDepthKm: input.max_depth_km } : {}),
      ...(input.alert_level != null ? { alertLevel: input.alert_level } : {}),
      ...(input.min_felt != null ? { minFelt: input.min_felt } : {}),
      ...(input.min_significance != null ? { minSignificance: input.min_significance } : {}),
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
        `Results capped at the limit (${limit}). Use earthquake_count to get the total match count, then narrow filters or increase limit.`,
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
