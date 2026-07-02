/**
 * @fileoverview Tests for the shared query-param builder and its 30-day start-time default.
 * @module tests/tools/query-params.test
 */

import { describe, expect, it } from 'vitest';
import { buildQueryParams, defaultStartTime } from '@/mcp-server/tools/query-params.js';

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
    });
  });

  it('omits absent optional filters instead of sending undefined', () => {
    const params = buildQueryParams({ start_time: '2026-01-01' });
    expect(Object.keys(params)).toEqual(['startTime']);
  });
});
