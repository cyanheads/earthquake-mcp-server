/**
 * @fileoverview Tests for the earthquake-get-feed tool.
 * @module tests/tools/earthquake-get-feed.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const sampleEvent: EarthquakeEventOutput = {
  id: 'us6000sznj',
  title: 'M 6.2 - 10 km NE of Anchorage, Alaska',
  magnitude: 6.2,
  magnitude_type: 'mww',
  time: '2026-05-01T12:00:00.000Z',
  updated: '2026-05-01T12:30:00.000Z',
  place: '10 km NE of Anchorage, Alaska',
  latitude: 61.2181,
  longitude: -149.9003,
  depth_km: 40,
  felt: 120,
  cdi: 5.2,
  mmi: 6.1,
  alert: 'yellow',
  tsunami: 0,
  significance: 820,
  status: 'reviewed',
  event_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000sznj',
  detail_url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000sznj&format=geojson',
};

const sparseEvent: EarthquakeEventOutput = {
  id: 'us0000abc1',
  title: 'M 2.5 - Unknown location',
  magnitude: 2.5,
  magnitude_type: 'ml',
  time: '2026-05-02T00:00:00.000Z',
  updated: '2026-05-02T00:05:00.000Z',
  place: 'Unknown location',
  latitude: 0,
  longitude: 0,
  depth_km: 10,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'automatic',
};

describe('earthquakeGetFeed', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('returns feed data for valid input', async () => {
    mockGetFeed.mockResolvedValue({
      events: [sampleEvent],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: '2.5', time_window: 'day' });
    const result = await earthquakeGetFeed.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe('us6000sznj');
    expect(result.generated_at).toBe('2026-05-23T10:00:00.000Z');
    expect(result.feed_url).toContain('usgs.gov');
  });

  it('applies defaults for magnitude_tier and time_window', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({});
    const result = await earthquakeGetFeed.handler(input, ctx);

    expect(input.magnitude_tier).toBe('2.5');
    expect(input.time_window).toBe('day');
    expect(result.count).toBe(0);
    expect(mockGetFeed).toHaveBeenCalledWith('2.5', 'day', ctx);
  });

  it('handles empty feed gracefully', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({
      magnitude_tier: 'significant',
      time_window: 'hour',
    });
    const result = await earthquakeGetFeed.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it('populates notice enrichment when feed is empty', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({
      magnitude_tier: 'significant',
      time_window: 'hour',
    });
    await earthquakeGetFeed.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toBeDefined();
    expect(notice).toContain('significant/hour');
  });

  it('does not populate notice enrichment when feed has events', async () => {
    mockGetFeed.mockResolvedValue({
      events: [sampleEvent],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 1,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: '2.5', time_window: 'day' });
    await earthquakeGetFeed.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('propagates service errors', async () => {
    mockGetFeed.mockRejectedValue(new Error('Service unavailable'));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: '4.5', time_window: 'week' });

    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toThrow('Service unavailable');
  });

  it('formats output with all event fields', () => {
    const output = {
      count: 1,
      generated_at: '2026-05-23T10:00:00.000Z',
      events: [sampleEvent],
      feed_url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    };
    const blocks = earthquakeGetFeed.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('us6000sznj');
    expect(text).toContain('6.2');
    expect(text).toContain('Anchorage');
    expect(text).toContain('earthquake.usgs.gov');
  });

  it('formats empty feed with fallback message', () => {
    const output = {
      count: 0,
      generated_at: '2026-05-23T10:00:00.000Z',
      events: [],
      feed_url:
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson',
    };
    const blocks = earthquakeGetFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No events');
  });

  it('formats sparse event without fabricating null fields', () => {
    const output = {
      count: 1,
      generated_at: '2026-05-23T10:00:00.000Z',
      events: [sparseEvent],
      feed_url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    };
    const blocks = earthquakeGetFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // sparse event should still render without crashing
    expect(text).toContain('us0000abc1');
    // null alert should render as "Not computed", not as a real alert level
    expect(text).toContain('Not computed');
  });
});

describe('earthquakeGetFeed — cursor pagination (issue #18)', () => {
  let mockGetFeed: ReturnType<typeof vi.fn>;

  /** A feed larger than one page, so paging is actually exercised. */
  function bigFeed(size: number) {
    return {
      events: Array.from({ length: size }, (_, i) => ({ ...sampleEvent, id: `us${i}` })),
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: size,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson',
    };
  }

  beforeEach(() => {
    mockGetFeed = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: mockGetFeed,
    } as unknown as usgsModule.UsgsService);
  });

  it('caps a large feed at the default page size and discloses the full total', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(10_656));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: 'all', time_window: 'month' });
    const result = await earthquakeGetFeed.handler(input, ctx);

    expect(result.count).toBe(100);
    expect(result.events).toHaveLength(100);
    expect(getEnrichment(ctx).totalCount).toBe(10_656);
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).nextCursor).toEqual(expect.any(String));
  });

  it('honors an explicit limit for the first page', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(500));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ limit: 25 });
    const result = await earthquakeGetFeed.handler(input, ctx);

    expect(result.count).toBe(25);
    expect(result.events[0]?.id).toBe('us0');
  });

  it('walks the whole feed across pages with no gaps or repeats', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(250));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
      const input = earthquakeGetFeed.input.parse({
        limit: 100,
        ...(cursor != null ? { cursor } : {}),
      });
      const result = await earthquakeGetFeed.handler(input, ctx);
      seen.push(...result.events.map((e) => e.id));
      cursor = getEnrichment(ctx).nextCursor as string | undefined;
      pages += 1;
    } while (cursor != null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(seen[0]).toBe('us0');
    expect(seen[249]).toBe('us249');
  });

  it('omits nextCursor on the last page', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(150));

    const firstCtx = createMockContext({ errors: earthquakeGetFeed.errors });
    await earthquakeGetFeed.handler(earthquakeGetFeed.input.parse({ limit: 100 }), firstCtx);
    const cursor = getEnrichment(firstCtx).nextCursor as string;

    const lastCtx = createMockContext({ errors: earthquakeGetFeed.errors });
    const result = await earthquakeGetFeed.handler(
      earthquakeGetFeed.input.parse({ limit: 100, cursor }),
      lastCtx,
    );

    expect(result.count).toBe(50);
    expect(getEnrichment(lastCtx).nextCursor).toBeUndefined();
    expect(getEnrichment(lastCtx).truncated).toBeUndefined();
    expect(getEnrichment(lastCtx).totalCount).toBe(150);
  });

  it('leaves a feed that fits in one page untruncated', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(12));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const result = await earthquakeGetFeed.handler(earthquakeGetFeed.input.parse({}), ctx);

    expect(result.count).toBe(12);
    expect(getEnrichment(ctx).totalCount).toBe(12);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(getEnrichment(ctx).nextCursor).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('notices a capped page and names the cursor as the next step', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(10_656));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ magnitude_tier: 'all', time_window: 'month' });
    await earthquakeGetFeed.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('10656');
    expect(notice).toContain('nextCursor');
  });

  it('rejects a malformed cursor rather than silently restarting the feed', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(500));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ cursor: 'not-a-real-cursor' });

    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toThrow(/cursor/i);
  });

  it('reports an empty page past the end without claiming the feed is empty', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(10));

    const seedCtx = createMockContext({ errors: earthquakeGetFeed.errors });
    await earthquakeGetFeed.handler(earthquakeGetFeed.input.parse({ limit: 5 }), seedCtx);
    const cursor = getEnrichment(seedCtx).nextCursor as string;

    // Shrink the feed under the cursor's offset, as a regeneration between calls would
    mockGetFeed.mockResolvedValue(bigFeed(3));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const result = await earthquakeGetFeed.handler(
      earthquakeGetFeed.input.parse({ limit: 5, cursor }),
      ctx,
    );

    expect(result.count).toBe(0);
    expect(getEnrichment(ctx).totalCount).toBe(3);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('last one');
  });

  it('still reports an empty feed as empty, not as a paging dead end', async () => {
    mockGetFeed.mockResolvedValue({
      events: [],
      generatedAt: '2026-05-23T10:00:00.000Z',
      count: 0,
      feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson',
    });

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({
      magnitude_tier: 'significant',
      time_window: 'hour',
    });
    await earthquakeGetFeed.handler(input, ctx);

    expect(getEnrichment(ctx).totalCount).toBe(0);
    expect(getEnrichment(ctx).notice as string).toContain('significant/hour');
  });

  it('renders the page it returned, so content[] matches structuredContent', async () => {
    mockGetFeed.mockResolvedValue(bigFeed(500));

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({ limit: 3 });
    const result = await earthquakeGetFeed.handler(input, ctx);

    const text = (earthquakeGetFeed.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Count:** 3');
    expect(text).toContain('us0');
    expect(text).toContain('us2');
    expect(text).not.toContain('us3');
  });
});
