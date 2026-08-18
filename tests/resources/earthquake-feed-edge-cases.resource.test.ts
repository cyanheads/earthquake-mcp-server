/**
 * @fileoverview Edge-case tests for the earthquake-feed resource.
 * @module tests/resources/earthquake-feed-edge-cases.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

/**
 * `list` receives the SDK's request-handler extra, not a Context. This listing
 * ignores it, so a minimal literal is enough.
 */
const listExtra = {
  signal: new AbortController().signal,
  requestId: 'test',
  sendNotification: () => Promise.resolve(),
  sendRequest: () => Promise.resolve({} as never),
};

const baseEvent: EarthquakeEventOutput = {
  id: 'us7654321',
  title: 'M 3.0 - Northern Europe',
  magnitude: 3.0,
  magnitude_type: 'ml',
  time: '2026-05-01T00:00:00.000Z',
  updated: '2026-05-01T00:05:00.000Z',
  place: 'Northern Europe',
  latitude: 60.0,
  longitude: 25.0,
  depth_km: 12,
  felt: 5,
  cdi: 2.0,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: 80,
  status: 'reviewed',
};

describe('earthquakeFeedResource — handler service error propagation', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('propagates service errors from getFeed', async () => {
    mockGetFeed.mockRejectedValue(new Error('CDN unavailable'));

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '2.5',
      time_window: 'day',
    });

    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toThrow('CDN unavailable');
  });

  it('propagates McpError from service', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetFeed.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'USGS feed timeout', {}),
    );

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '4.5',
      time_window: 'week',
    });

    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });
});

describe('earthquakeFeedResource — field projection', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('strips USGS-only impact fields from feed resource events', async () => {
    mockGetFeed.mockResolvedValue({
      events: [baseEvent],
      generatedAt: '2026-05-01T00:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '2.5',
      time_window: 'day',
    });
    const result = await earthquakeFeedResource.handler(params, ctx);

    const event = result.events[0]!;
    // Core fields present
    expect(event.id).toBeDefined();
    expect(event.title).toBeDefined();
    expect(event.magnitude).toBeDefined();
    expect(event.time).toBeDefined();
    expect(event.place).toBeDefined();
    expect(event.latitude).toBeDefined();
    expect(event.longitude).toBeDefined();
    // USGS-only fields excluded
    expect((event as Record<string, unknown>).felt).toBeUndefined();
    expect((event as Record<string, unknown>).cdi).toBeUndefined();
    expect((event as Record<string, unknown>).mmi).toBeUndefined();
    expect((event as Record<string, unknown>).alert).toBeUndefined();
    expect((event as Record<string, unknown>).significance).toBeUndefined();
    expect((event as Record<string, unknown>).tsunami).toBeUndefined();
  });

  it('preserves depth_km even when null', async () => {
    const nullDepthEvent = { ...baseEvent, depth_km: null };
    mockGetFeed.mockResolvedValue({
      events: [nullDepthEvent],
      generatedAt: '2026-05-01T00:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/1.0_day.geojson',
    });

    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '1.0',
      time_window: 'day',
    });
    const result = await earthquakeFeedResource.handler(params, ctx);

    expect(result.events[0]?.depth_km).toBeNull();
  });
});

describe('earthquakeFeedResource — list', () => {
  it('each listed resource URI matches the expected pattern', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    for (const r of listing.resources) {
      // earthquake://feed/<tier>/<window>
      expect(r.uri).toMatch(/^earthquake:\/\/feed\/[^/]+\/[^/]+$/);
    }
  });

  it('each listed resource has a non-empty name', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    for (const r of listing.resources) {
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it('each listed resource has a description', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    for (const r of listing.resources) {
      expect(typeof r.description).toBe('string');
      expect(r.description?.length).toBeGreaterThan(0);
    }
  });

  it('each listed resource specifies application/json mimeType', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    for (const r of listing.resources) {
      expect(r.mimeType).toBe('application/json');
    }
  });

  it('listing contains exactly 20 entries (5 tiers × 4 windows)', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    expect(listing.resources).toHaveLength(20);
  });

  it('all tier values appear in the listing URIs', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    const uris = listing.resources.map((r) => r.uri);
    for (const tier of ['all', '1.0', '2.5', '4.5', 'significant']) {
      const matches = uris.filter((u) => u.includes(`/feed/${tier}/`));
      // Each tier should appear 4 times (one per window)
      expect(matches).toHaveLength(4);
    }
  });

  it('all time window values appear in the listing URIs', async () => {
    const listing = await earthquakeFeedResource.list!(listExtra);
    const uris = listing.resources.map((r) => r.uri);
    for (const window of ['hour', 'day', 'week', 'month']) {
      const matches = uris.filter((u) => u.endsWith(`/${window}`));
      // Each window should appear 5 times (one per tier)
      expect(matches).toHaveLength(5);
    }
  });
});

describe('earthquakeFeedResource — params validation', () => {
  it('params schema accepts any string (validation is in handler)', () => {
    // The resource uses z.string() for both params — validation happens at handler time
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: 'unknown-tier',
      time_window: 'unknown-window',
    });
    expect(params.magnitude_tier).toBe('unknown-tier');
    expect(params.time_window).toBe('unknown-window');
  });

  it('handler throws validationError for invalid magnitude_tier', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '99.9',
      time_window: 'day',
    });
    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown magnitude tier'),
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('handler throws validationError for invalid time_window', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '2.5',
      time_window: 'century',
    });
    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown time window'),
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('handler throws validationError for injection-attempt tier', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: "'; DROP TABLE events; --",
      time_window: 'day',
    });
    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown magnitude tier'),
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('handler throws validationError for injection-attempt window', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext();
    const params = earthquakeFeedResource.params!.parse({
      magnitude_tier: '2.5',
      time_window: '../../../etc/passwd',
    });
    await expect(earthquakeFeedResource.handler(params, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unknown time window'),
      code: JsonRpcErrorCode.ValidationError,
    });
  });
});
