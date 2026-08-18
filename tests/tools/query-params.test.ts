/**
 * @fileoverview Tests for the shared query-param builder and its 30-day start-time default.
 * @module tests/tools/query-params.test
 */

import { describe, expect, it } from 'vitest';
import {
  buildQueryParams,
  defaultStartTime,
  earthquakeFilterFields,
  FDSN_TIMESTAMP_PATTERN,
  ignoredUsgsFilters,
  normalizeFdsnTimestamp,
} from '@/mcp-server/tools/query-params.js';

const DAY_MS = 86_400_000;

describe('defaultStartTime', () => {
  it('resolves to exactly 30 days before an explicit end_time', () => {
    expect(defaultStartTime('2026-06-30')).toBe(
      new Date(new Date('2026-06-30').getTime() - 30 * DAY_MS).toISOString(),
    );
  });

  it('resolves to ~30 days before now when end_time is omitted', () => {
    const before = Date.now();
    const resolved = new Date(defaultStartTime()!).getTime();
    const after = Date.now();
    expect(resolved).toBeGreaterThanOrEqual(before - 30 * DAY_MS);
    expect(resolved).toBeLessThanOrEqual(after - 30 * DAY_MS);
  });

  it('returns undefined for an unparseable end_time (upstream rejects it)', () => {
    expect(defaultStartTime('not-a-date')).toBeUndefined();
  });
});

describe('buildQueryParams', () => {
  it('applies the 30-day default when start_time is omitted (issue #12)', () => {
    const params = buildQueryParams({ end_time: '2026-06-30', min_magnitude: 5 });
    expect(params.startTime).toBe(
      new Date(new Date('2026-06-30').getTime() - 30 * DAY_MS).toISOString(),
    );
    expect(params.endTime).toBe('2026-06-30');
    expect(params.minMagnitude).toBe(5);
  });

  it('passes an explicit start_time through unchanged', () => {
    const params = buildQueryParams({ start_time: '2026-05-31', end_time: '2026-06-30' });
    expect(params.startTime).toBe('2026-05-31');
  });

  it('maps all filter fields to their FDSN param names', () => {
    const params = buildQueryParams({
      start_time: '2026-01-01',
      end_time: '2026-02-01',
      min_magnitude: 2.5,
      max_magnitude: 8,
      latitude: 35,
      longitude: 139,
      radius_km: 100,
      min_depth_km: 0,
      max_depth_km: 70,
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
      event_type: 'quarry blast',
    });
    expect(params).toEqual({
      startTime: '2026-01-01',
      endTime: '2026-02-01',
      minMagnitude: 2.5,
      maxMagnitude: 8,
      latitude: 35,
      longitude: 139,
      radiusKm: 100,
      minDepthKm: 0,
      maxDepthKm: 70,
      alertLevel: 'yellow',
      minFelt: 10,
      minSignificance: 600,
      eventType: 'quarry blast',
    });
  });

  it('omits absent optional filters instead of sending undefined', () => {
    const params = buildQueryParams({ start_time: '2026-01-01' });
    expect(Object.keys(params)).toEqual(['startTime']);
  });
});

describe('ignoredUsgsFilters', () => {
  it('names event_type among the USGS-only filters an EMSC query drops (issue #24)', () => {
    // EMSC's FDSN endpoint has no eventtype parameter and answers one with HTTP 400,
    // so the filter has to be reported as ignored rather than forwarded.
    expect(ignoredUsgsFilters({ event_type: 'earthquake' }, 'emsc')).toEqual(['event_type']);
  });

  it('reports event_type alongside the other USGS-only filters', () => {
    expect(
      ignoredUsgsFilters(
        { alert_level: 'red', event_type: 'earthquake', min_felt: 5, min_significance: 600 },
        'emsc',
      ),
    ).toEqual(['alert_level', 'event_type', 'min_felt', 'min_significance']);
  });

  it('reports nothing for a USGS query, where every filter is sent', () => {
    expect(ignoredUsgsFilters({ event_type: 'earthquake', alert_level: 'red' }, 'usgs')).toEqual(
      [],
    );
  });

  it('reports nothing when no USGS-only filter was supplied', () => {
    expect(ignoredUsgsFilters({ min_magnitude: 5 }, 'emsc')).toEqual([]);
  });
});

describe('normalizeFdsnTimestamp (issue #29)', () => {
  it.each([
    ['2020', '2020-01-01'],
    ['2020-3', '2020-03-01'],
    ['2020-3-5', '2020-03-05'],
    ['2020-03-5', '2020-03-05'],
    ['2020-3-05', '2020-03-05'],
  ])('expands and zero-pads %s to %s', (input, expected) => {
    expect(normalizeFdsnTimestamp(input)).toBe(expected);
  });

  it.each([
    '2020-03-05',
    '2026-05-23T00:00:00',
    '2020-03-05T00:00:00.000Z',
    '2026-05-23T00:00:00+02:00',
  ])('leaves the already-canonical %s untouched', (input) => {
    expect(normalizeFdsnTimestamp(input)).toBe(input);
  });

  it('preserves the time part while padding the date part', () => {
    expect(normalizeFdsnTimestamp('2020-3-5T04:05:06.700Z')).toBe('2020-03-05T04:05:06.700Z');
    expect(normalizeFdsnTimestamp('2020 04:05')).toBe('2020-01-01 04:05');
  });

  it('leaves a calendar-invalid but digit-shaped value for the upstream to reject', () => {
    // Local validation is shape-only on purpose — USGS names the offending parameter
    // far better than a local calendar check could.
    expect(normalizeFdsnTimestamp('2026-13-45')).toBe('2026-13-45');
  });

  it('returns an unrecognized value unchanged rather than inventing a date', () => {
    for (const value of ['last tuesday', '03/05/2020', '', '[object Object]T00:00:00']) {
      expect(normalizeFdsnTimestamp(value)).toBe(value);
    }
  });
});

describe('FDSN_TIMESTAMP_PATTERN (issue #29)', () => {
  it.each([
    '2020-03-05',
    '2020-3-5',
    '2026-05-23T00:00:00',
    '2020-03-05T00:00:00.000Z',
    '2020-03-05 00:00',
    '2020',
    '2026-13-45',
  ])('admits %s — recoverable or upstream-decidable', (value) => {
    expect(FDSN_TIMESTAMP_PATTERN.test(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    '03/05/2020',
    'NaN-NaN-NaNT00:00:00.000Z',
    'last tuesday',
    '[object Object]T00:00:00',
  ])('rejects %s — ambiguous or no recoverable intent', (value) => {
    expect(FDSN_TIMESTAMP_PATTERN.test(value)).toBe(false);
  });

  it('admits what defaultStartTime emits, so the server default is never self-rejected', () => {
    // Acceptance criterion: defaultStartTime()'s .toISOString() output must survive
    // whatever validator lands on the input field.
    expect(FDSN_TIMESTAMP_PATTERN.test(defaultStartTime()!)).toBe(true);
    expect(FDSN_TIMESTAMP_PATTERN.test(defaultStartTime('2026-06-30')!)).toBe(true);
  });
});

describe('buildQueryParams — timestamp normalization (issue #29)', () => {
  it('normalizes an explicit start_time before it reaches either adapter', () => {
    expect(buildQueryParams({ start_time: '2020-3-5' }).startTime).toBe('2020-03-05');
    expect(buildQueryParams({ start_time: '2020' }).startTime).toBe('2020-01-01');
  });

  it('normalizes end_time on the same rule', () => {
    const params = buildQueryParams({ start_time: '2020-01-01', end_time: '2020-3-5' });
    expect(params.endTime).toBe('2020-03-05');
  });

  it('anchors the 30-day default to the normalized end_time, not the raw one', () => {
    const params = buildQueryParams({ end_time: '2020' });
    expect(params.endTime).toBe('2020-01-01');
    expect(params.startTime).toBe(
      new Date(new Date('2020-01-01').getTime() - 30 * DAY_MS).toISOString(),
    );
  });

  it('leaves the server-resolved default in its own ISO form', () => {
    const params = buildQueryParams({ end_time: '2026-06-30' });
    expect(params.startTime).toBe(defaultStartTime('2026-06-30'));
  });

  it('forwards a calendar-invalid date so the upstream is what rejects it', () => {
    expect(buildQueryParams({ start_time: '2026-13-45' }).startTime).toBe('2026-13-45');
  });
});

describe('buildQueryParams — bounding box (issue #37)', () => {
  it('maps all four box fields to their camelCase FDSN param names', () => {
    const params = buildQueryParams({
      start_time: '2026-01-01',
      min_latitude: 32.5,
      max_latitude: 42,
      min_longitude: -125,
      max_longitude: -114,
    });
    expect(params).toMatchObject({
      minLatitude: 32.5,
      maxLatitude: 42,
      minLongitude: -125,
      maxLongitude: -114,
    });
  });

  it('forwards a literal 0 edge — a truthy guard would drop the equator', () => {
    const params = buildQueryParams({
      start_time: '2026-01-01',
      min_latitude: 0,
      min_longitude: 0,
      max_longitude: 0,
    });
    expect(params.minLatitude).toBe(0);
    expect(params.minLongitude).toBe(0);
    expect(params.maxLongitude).toBe(0);
  });

  it('accepts any single edge on its own', () => {
    expect(Object.keys(buildQueryParams({ start_time: '2026-01-01', max_latitude: 60 }))).toEqual([
      'startTime',
      'maxLatitude',
    ]);
  });

  it('carries the box alongside the circle group rather than replacing it', () => {
    const params = buildQueryParams({
      start_time: '2026-01-01',
      latitude: 35,
      longitude: -120,
      radius_km: 500,
      min_latitude: 30,
      max_latitude: 40,
    });
    expect(params.radiusKm).toBe(500);
    expect(params.minLatitude).toBe(30);
    expect(params.maxLatitude).toBe(40);
  });

  it('omits every box field when none was supplied', () => {
    const params = buildQueryParams({ start_time: '2026-01-01' });
    for (const key of ['minLatitude', 'maxLatitude', 'minLongitude', 'maxLongitude'] as const) {
      expect(params).not.toHaveProperty(key);
    }
  });
});

describe('ignoredUsgsFilters — bounding box is supported by both providers (issue #37)', () => {
  it('never names a box field as dropped for EMSC', () => {
    expect(
      ignoredUsgsFilters(
        { min_latitude: 0, max_latitude: 40, min_longitude: 0, max_longitude: 20 },
        'emsc',
      ),
    ).toEqual([]);
  });
});

describe('earthquakeFilterFields — shared validator bounds (issue #32)', () => {
  it.each([
    ['radius_km', 20001.6, 20001.7],
    ['min_depth_km', 1000, 1000.1],
    ['max_depth_km', 1000, 1000.1],
    ['min_latitude', 90, 90.1],
    ['max_latitude', 90, 90.1],
    ['min_longitude', 360, 360.1],
    ['max_longitude', 360, 360.1],
  ])('%s accepts %s and rejects %s', (field, accepted, rejected) => {
    const schema = earthquakeFilterFields[field as keyof typeof earthquakeFilterFields];
    expect(schema.safeParse(accepted).success).toBe(true);
    expect(schema.safeParse(rejected).success).toBe(false);
  });

  it.each([
    ['min_depth_km', -100, -100.1],
    ['max_depth_km', -100, -100.1],
    ['min_latitude', -90, -90.1],
    ['max_latitude', -90, -90.1],
    ['min_longitude', -360, -360.1],
    ['max_longitude', -360, -360.1],
  ])('%s accepts the lower bound %s and rejects %s', (field, accepted, rejected) => {
    const schema = earthquakeFilterFields[field as keyof typeof earthquakeFilterFields];
    expect(schema.safeParse(accepted).success).toBe(true);
    expect(schema.safeParse(rejected).success).toBe(false);
  });

  it('rejects a blank or whitespace-only event_type and trims a real one', () => {
    expect(earthquakeFilterFields.event_type.safeParse('').success).toBe(false);
    expect(earthquakeFilterFields.event_type.safeParse('   ').success).toBe(false);
    expect(earthquakeFilterFields.event_type.parse('  quarry blast  ')).toBe('quarry blast');
  });
});
