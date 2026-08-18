/**
 * @fileoverview Shared tool-input filter schema and FDSN query-param builder for
 * earthquake_search and earthquake_count. Owns the single copy of every filter validator
 * the two tools share, so a bound can never drift between them. Resolves the documented
 * 30-day default time window server-side so USGS and EMSC behave identically (EMSC applies
 * no upstream default and would otherwise query its entire catalog), normalizes recoverable
 * timestamp shapes to a canonical form before either adapter builds a request, echoes the
 * filters that were actually sent, and names the USGS-only filters an EMSC query drops so
 * both tools can report them.
 * @module mcp-server/tools/query-params
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';

/**
 * Timestamp shapes carrying recoverable date intent. Deliberately shape-only, not
 * calendar-aware: a digit-shaped but impossible date (`2026-13-45`) passes here and is
 * rejected by the upstream, which names the offending parameter better than a local
 * calendar check could. Ambiguous (`03/05/2020`) and intentless (`last tuesday`, an empty
 * string) input has no accepting branch and fails before any network call.
 */
export const FDSN_TIMESTAMP_PATTERN =
  /^\d{4}(-\d{1,2}(-\d{1,2})?)?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const FDSN_TIMESTAMP_MESSAGE =
  'Must be an ISO 8601 date or date-time, e.g. "2026-01-01", "2026-1-1", ' +
  '"2026-05-23T00:00:00", or "2026-05-23T00:00:00.000Z". A bare year expands to January 1st. ' +
  'Slash-separated dates and relative phrases are not accepted.';

/** Splits a timestamp into its year / month / day parts and whatever trails them. */
const FDSN_DATE_PARTS = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(.*)$/;

/**
 * Canonicalize a caller-supplied timestamp so both upstreams answer the same question.
 * Zero-pads an unpadded month or day and expands a bare year (or year-month) to the first
 * day of the period — `2020` means nothing to USGS (HTTP 200, zero matches) and means
 * `2020-01-01` to EMSC, so the divergence is resolved here rather than left to `source`.
 * Any value the pattern above admits is returned in `YYYY-MM-DD` form with its time part
 * untouched; anything else is returned unchanged for the upstream to reject.
 */
export function normalizeFdsnTimestamp(value: string): string {
  const parts = FDSN_DATE_PARTS.exec(value);
  const year = parts?.[1];
  if (year === undefined) return value;
  const month = (parts?.[2] ?? '1').padStart(2, '0');
  const day = (parts?.[3] ?? '1').padStart(2, '0');
  return `${year}-${month}-${day}${parts?.[4] ?? ''}`;
}

/**
 * Filter validators shared by the earthquake_search and earthquake_count input schemas.
 * Each tool spreads this object into its own `z.object({ ...earthquakeFilterFields, ... })`
 * and re-describes only the fields whose tool-specific wording earns it, so the bounds
 * themselves exist in exactly one place.
 */
export const earthquakeFilterFields = {
  start_time: z
    .string()
    .regex(FDSN_TIMESTAMP_PATTERN, FDSN_TIMESTAMP_MESSAGE)
    .optional()
    .describe(
      'Start of time range as ISO 8601 (e.g. "2026-01-01" or "2026-05-23T00:00:00"). ' +
        'A bare year expands to January 1st and an unpadded month or day is zero-padded, ' +
        'so both sources honor the same window. ' +
        'Defaults to 30 days before end_time (or before the current time) if omitted — ' +
        'applied server-side so USGS and EMSC honor the same window.',
    ),
  end_time: z
    .string()
    .regex(FDSN_TIMESTAMP_PATTERN, FDSN_TIMESTAMP_MESSAGE)
    .optional()
    .describe(
      'End of time range as ISO 8601, in the same forms start_time accepts. ' +
        'Defaults to current time if omitted.',
    ),
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
    .max(20001.6)
    .optional()
    .describe(
      "Search radius in kilometers from the lat/lon point. Max 20001.6, the ceiling USGS enforces — half the Earth's great-circle circumference. " +
        'Converted to degrees for EMSC (1° ≈ 111.2 km).',
    ),
  min_latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe(
      'Southern edge of a bounding-box search, in degrees. Independent of the other three ' +
        'box parameters — supply any of them. Must not exceed max_latitude when both are given.',
    ),
  max_latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Northern edge of a bounding-box search, in degrees.'),
  min_longitude: z
    .number()
    .min(-360)
    .max(360)
    .optional()
    .describe(
      'Western edge of a bounding-box search, in degrees. Range extends beyond ±180 so a box ' +
        'can cross the antimeridian (e.g. min_longitude=170, max_longitude=190) — always keep ' +
        'min_longitude at or below max_longitude rather than inverting the pair.',
    ),
  max_longitude: z
    .number()
    .min(-360)
    .max(360)
    .optional()
    .describe('Eastern edge of a bounding-box search, in degrees.'),
  min_depth_km: z
    .number()
    .min(-100)
    .max(1000)
    .optional()
    .describe(
      'Minimum depth in kilometers. Bounded to the documented -100 to 1000 km catalog envelope. ' +
        'Shallow quakes (0–70 km) typically cause more surface damage than deep quakes (>300 km).',
    ),
  max_depth_km: z
    .number()
    .min(-100)
    .max(1000)
    .optional()
    .describe(
      'Maximum depth in kilometers. Bounded to the documented -100 to 1000 km catalog envelope.',
    ),
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
  event_type: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Filter by upstream event classification, e.g. "earthquake" to exclude quarry blasts and ' +
        'explosions, or "quarry blast" to see only those. Matched verbatim against the USGS ' +
        'catalog, which accepts any string and returns zero matches for an unrecognized one. ' +
        'Only available from USGS.',
    ),
};

const earthquakeFilterSchema = z.object(earthquakeFilterFields);

/** Filter inputs shared by the earthquake_search and earthquake_count input schemas. */
export type EarthquakeFilterInput = z.infer<typeof earthquakeFilterSchema>;

/**
 * Filters only the USGS FDSN API implements — EMSC has no equivalent parameter.
 * `event_type` is here because EMSC's endpoint rejects an `eventtype` parameter
 * outright with HTTP 400, so forwarding it would fail the query rather than
 * merely go unapplied. The bounding box is deliberately absent: both providers
 * implement the FDSN rectangle parameters identically.
 */
const USGS_ONLY_FILTERS = ['alert_level', 'event_type', 'min_felt', 'min_significance'] as const;

/**
 * Name the USGS-only filters the caller supplied that will not reach the upstream
 * query. Empty for a USGS query, where every filter is sent.
 */
export function ignoredUsgsFilters(
  input: EarthquakeFilterInput,
  source: 'usgs' | 'emsc',
): string[] {
  if (source !== 'emsc') return [];
  return USGS_ONLY_FILTERS.filter((name) => input[name] != null);
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
 * Build FDSN query params from tool input, canonicalizing caller-supplied timestamps and
 * applying the 30-day start-time default. Every value returned here is one both adapters
 * forward verbatim, so a tool's queryEcho built from this result reports only what was
 * actually sent. Conditional spreads satisfy exactOptionalPropertyTypes.
 */
export function buildQueryParams(input: EarthquakeFilterInput): EarthquakeQueryParams {
  const endTime = input.end_time != null ? normalizeFdsnTimestamp(input.end_time) : undefined;
  const startTime =
    input.start_time != null ? normalizeFdsnTimestamp(input.start_time) : defaultStartTime(endTime);
  return {
    ...(startTime != null ? { startTime } : {}),
    ...(endTime != null ? { endTime } : {}),
    ...(input.min_magnitude != null ? { minMagnitude: input.min_magnitude } : {}),
    ...(input.max_magnitude != null ? { maxMagnitude: input.max_magnitude } : {}),
    ...(input.latitude != null ? { latitude: input.latitude } : {}),
    ...(input.longitude != null ? { longitude: input.longitude } : {}),
    ...(input.radius_km != null ? { radiusKm: input.radius_km } : {}),
    ...(input.min_latitude != null ? { minLatitude: input.min_latitude } : {}),
    ...(input.max_latitude != null ? { maxLatitude: input.max_latitude } : {}),
    ...(input.min_longitude != null ? { minLongitude: input.min_longitude } : {}),
    ...(input.max_longitude != null ? { maxLongitude: input.max_longitude } : {}),
    ...(input.min_depth_km != null ? { minDepthKm: input.min_depth_km } : {}),
    ...(input.max_depth_km != null ? { maxDepthKm: input.max_depth_km } : {}),
    ...(input.alert_level != null ? { alertLevel: input.alert_level } : {}),
    ...(input.min_felt != null ? { minFelt: input.min_felt } : {}),
    ...(input.min_significance != null ? { minSignificance: input.min_significance } : {}),
    ...(input.event_type != null ? { eventType: input.event_type } : {}),
  };
}

/**
 * Echo of the shared filters an adapter will send, keyed by the tool-input names a caller
 * would re-supply. Built from the params rather than the raw input, so server-resolved and
 * canonicalized values are reported as they were actually sent. USGS-only filters are left
 * out of an EMSC echo because that adapter never forwards them — `ignoredUsgsFilters` names
 * them instead. Each tool adds its own non-filter keys (source, limit, offset, order_by).
 */
export function filterQueryEcho(params: EarthquakeQueryParams, source: 'usgs' | 'emsc') {
  const isUsgs = source !== 'emsc';
  return {
    ...(params.startTime != null ? { start_time: params.startTime } : {}),
    ...(params.endTime != null ? { end_time: params.endTime } : {}),
    ...(params.minMagnitude != null ? { min_magnitude: params.minMagnitude } : {}),
    ...(params.maxMagnitude != null ? { max_magnitude: params.maxMagnitude } : {}),
    ...(params.latitude != null ? { latitude: params.latitude } : {}),
    ...(params.longitude != null ? { longitude: params.longitude } : {}),
    ...(params.radiusKm != null ? { radius_km: params.radiusKm } : {}),
    ...(params.minLatitude != null ? { min_latitude: params.minLatitude } : {}),
    ...(params.maxLatitude != null ? { max_latitude: params.maxLatitude } : {}),
    ...(params.minLongitude != null ? { min_longitude: params.minLongitude } : {}),
    ...(params.maxLongitude != null ? { max_longitude: params.maxLongitude } : {}),
    ...(params.minDepthKm != null ? { min_depth_km: params.minDepthKm } : {}),
    ...(params.maxDepthKm != null ? { max_depth_km: params.maxDepthKm } : {}),
    ...(isUsgs && params.alertLevel != null ? { alert_level: params.alertLevel } : {}),
    ...(isUsgs && params.minFelt != null ? { min_felt: params.minFelt } : {}),
    ...(isUsgs && params.minSignificance != null
      ? { min_significance: params.minSignificance }
      : {}),
    ...(isUsgs && params.eventType != null ? { event_type: params.eventType } : {}),
  };
}
