/**
 * @fileoverview Shared tool-input → FDSN query-param builder for earthquake_search and earthquake_count.
 * Resolves the documented 30-day default time window server-side so USGS and EMSC behave identically
 * (EMSC applies no upstream default and would otherwise query its entire catalog).
 * @module mcp-server/tools/query-params
 */

import type { EarthquakeQueryParams } from '@/services/usgs/types.js';

/** Filter inputs shared by the earthquake_search and earthquake_count input schemas. */
export interface EarthquakeFilterInput {
  alert_level?: 'green' | 'yellow' | 'orange' | 'red' | undefined;
  end_time?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  max_depth_km?: number | undefined;
  max_magnitude?: number | undefined;
  min_depth_km?: number | undefined;
  min_felt?: number | undefined;
  min_magnitude?: number | undefined;
  min_significance?: number | undefined;
  radius_km?: number | undefined;
  start_time?: string | undefined;
}

/** Documented default time window applied when start_time is omitted. */
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Resolve the default start time: 30 days before end_time, or before now when
 * end_time is also omitted. Returns undefined for an unparseable end_time —
 * the upstream API rejects the bad end_time itself.
 */
export function defaultStartTime(endTime?: string): string | undefined {
  const anchor = endTime != null ? new Date(endTime) : new Date();
  if (Number.isNaN(anchor.getTime())) return;
  return new Date(anchor.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
}

/**
 * Build FDSN query params from tool input, applying the 30-day start-time
 * default. Conditional spreads satisfy exactOptionalPropertyTypes.
 */
export function buildQueryParams(input: EarthquakeFilterInput): EarthquakeQueryParams {
  const startTime = input.start_time ?? defaultStartTime(input.end_time);
  return {
    ...(startTime != null ? { startTime } : {}),
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
}
