/**
 * @fileoverview Tests for the earthquake-feed resource.
 * @module tests/resources/earthquake-feed.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const sampleEvent: EarthquakeEventOutput = {
  id: 'us6000sznj',
  title: 'M 5.1 - 20 km NW of Hilo, Hawaii',
  magnitude: 5.1,
  magnitude_type: 'ml',
  time: '2026-05-23T09:00:00.000Z',
  updated: '2026-05-23T09:15:00.000Z',
  place: '20 km NW of Hilo, Hawaii',
  latitude: 19.7297,
  longitude: -155.1398,
  depth_km: 15,
  felt: 10,
  cdi: 3.0,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: 210,
  status: 'reviewed',
};

describe('earthquakeFeedResource', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('returns feed data for valid tier and window', async () => {
    mockGetFeed.mockResolvedValue({
      events: [sampleEvent],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params.parse({
      magnitude_tier: '2.5',
      time_window: 'day',
    });
    const result = await earthquakeFeedResource.handler(params, ctx);

    expect(result.count).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('us6000sznj');
    expect(result.generated_at).toBe('2026-05-23T10:00:00.000Z');
    expect(result.feed_url).toContain('usgs.gov');
    expect(mockGetFeed).toHaveBeenCalledWith('2.5', 'day', ctx);
  });

  it('throws validationError for invalid magnitude_tier', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params.parse({
      magnitude_tier: 'invalid',
      time_window: 'day',
    });

    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown magnitude tier'),
      code: JsonRpcErrorCode.ValidationError,
    } satisfies Partial<InstanceType<typeof McpError>>);
  });

  it('throws validationError for invalid time_window', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params.parse({
      magnitude_tier: '2.5',
      time_window: 'decade',
    });

    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown time window'),
      code: JsonRpcErrorCode.ValidationError,
    } satisfies Partial<InstanceType<typeof McpError>>);
  });

  it('accepts all valid magnitude tiers', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    });

    const ctx = createMockContext();
    for (const tier of ['all', '1.0', '2.5', '4.5', 'significant']) {
      const params = earthquakeFeedResource.params.parse({
        magnitude_tier: tier,
        time_window: 'hour',
      });
      const result = await earthquakeFeedResource.handler(params, ctx);
      expect(result.count).toBe(0);
    }
  });

  it('accepts all valid time windows', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson',
    });

    const ctx = createMockContext();
    for (const window of ['hour', 'day', 'week', 'month']) {
      const params = earthquakeFeedResource.params.parse({
        magnitude_tier: '2.5',
        time_window: window,
      });
      const result = await earthquakeFeedResource.handler(params, ctx);
      expect(result.count).toBe(0);
    }
  });

  it('projects only required fields in the returned events', async () => {
    // Returned event has more fields than the resource output schema requires
    mockGetFeed.mockResolvedValue({
      events: [sampleEvent],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params.parse({
      magnitude_tier: '2.5',
      time_window: 'day',
    });
    const result = await earthquakeFeedResource.handler(params, ctx);

    const event = result.events[0]!;
    expect(event.id).toBeDefined();
    expect(event.title).toBeDefined();
    expect(event.magnitude).toBeDefined();
    expect(event.time).toBeDefined();
    expect(event.place).toBeDefined();
    expect(event.latitude).toBeDefined();
    expect(event.longitude).toBeDefined();
    expect(event.depth_km).toBeDefined();
    // USGS-specific fields not in the resource output schema
    expect((event as Record<string, unknown>).felt).toBeUndefined();
    expect((event as Record<string, unknown>).alert).toBeUndefined();
  });

  it('lists all valid feed combinations', () => {
    const listing = earthquakeFeedResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    // 5 tiers * 4 windows = 20 combinations
    expect(listing.resources).toHaveLength(20);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri).toMatch(/^earthquake:\/\/feed\//);
    }
  });
});
