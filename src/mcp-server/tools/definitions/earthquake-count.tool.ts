/**
 * @fileoverview Tool definition for counting earthquakes matching filters without fetching full records.
 * @module mcp-server/tools/definitions/earthquake-count.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getEmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import { getUsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeCount = tool('earthquake_count', {
  title: 'Count Earthquakes',
  description:
    'Count earthquakes matching filters without fetching full records. ' +
    'Use for statistical queries ("how many M5+ earthquakes in 2025?") or to gauge result size ' +
    'before calling earthquake_search. ' +
    'When exceeds_limit is true, the count exceeds 20,000 and a full search would be truncated — ' +
    'narrow filters before fetching. ' +
    'USGS returns the max_allowed cap (20,000); EMSC count endpoint does not return this field ' +
    '(max_allowed will be null). ' +
    'USGS-specific filters (alert_level, min_felt, min_significance) are ignored when source=emsc.',
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
    source: z
      .enum(['usgs', 'emsc'])
      .default('usgs')
      .describe(
        'Data source. ' +
          '"usgs" covers global events with PAGER, DYFI, and ShakeMap metadata. ' +
          '"emsc" covers the European-Mediterranean region.',
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
      when: 'Selected source API returns non-2xx or times out.',
      recovery: 'Try the other source (usgs or emsc) or retry after a short delay.',
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

    // Use conditional spreads to satisfy exactOptionalPropertyTypes
    const params: EarthquakeQueryParams = {
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

    let result: Awaited<ReturnType<typeof getUsgsService.prototype.countEvents>>;
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
      throw err;
    }

    ctx.log.info('Count completed', {
      source: input.source,
      count: result.count,
      exceeds_limit: result.exceedsLimit,
    });

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
