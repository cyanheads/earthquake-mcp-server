/**
 * @fileoverview Retained-feed and serialized-page contract regressions.
 * @module tests/tools/feed-retention.test
 */
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearchEvents } from '@/mcp-server/tools/definitions/earthquake-search-events.tool.js';
import type { EarthquakeEvent } from '@/services/usgs/types.js';
import * as usgs from '@/services/usgs/usgs-service.js';

const event = (id: string): EarthquakeEvent => ({
  id,
  title: `M 1 - ${id}`,
  magnitude: 1,
  magnitude_type: 'ml',
  time: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
  place: '東京\\"\n',
  latitude: 1,
  longitude: 2,
  depth_km: null,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: null,
  significance: null,
  status: null,
});
function fixture(size: number) {
  return {
    events: Array.from({ length: size }, (_, i) => event(`id${i}`)),
    count: size,
    generatedAt: '2026-01-01T00:00:00Z',
    feedUrl: 'https://earthquake.usgs.gov/feed',
  };
}
afterEach(() => vi.restoreAllMocks());
function mockFeed(size: number) {
  const feed = fixture(size);
  const getFeed = vi.fn().mockResolvedValue(feed);
  vi.spyOn(usgs, 'getUsgsService').mockReturnValue({ getFeed } as unknown as usgs.UsgsService);
  return { feed, getFeed };
}
describe('feed retention', () => {
  it('reports a past-end retained page without refetching or replacing its total', async () => {
    const { getFeed } = mockFeed(3);
    const first = await runToolContract(earthquakeGetFeed, { limit: 1 });
    const token = JSON.parse(
      Buffer.from(
        (first.structuredContent as { nextCursor: string }).nextCursor,
        'base64url',
      ).toString(),
    ) as [string, number, number];
    token[1] = 10;
    const reply = await runToolContract(earthquakeGetFeed, {
      cursor: Buffer.from(JSON.stringify(token)).toString('base64url'),
    });
    expect(reply.structuredContent).toMatchObject({ count: 0, totalCount: 3 });
    expect(JSON.stringify(reply.content)).toContain('last one');
    expect(getFeed).toHaveBeenCalledTimes(1);
  });
  it('bounds search candidates and advances by emitted rows', async () => {
    const searchEvents = vi
      .fn()
      .mockResolvedValue({ events: fixture(100).events, count: 100, totalCount: 150 });
    vi.spyOn(usgs, 'getUsgsService').mockReturnValue({
      searchEvents,
    } as unknown as usgs.UsgsService);
    const result = await runToolContract(earthquakeSearchEvents, { limit: 20000, offset: 2 });
    expect(searchEvents.mock.calls[0]?.[0].limit).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    const output = result.structuredContent as {
      count: number;
      nextOffset: number;
      queryEcho: { limit: number };
    };
    expect(output.nextOffset).toBe(2 + output.count);
    expect(output.queryEcho.limit).toBe(100);
  });
  it('continues the retained generation after upstream edits without fetching again', async () => {
    const { feed, getFeed } = mockFeed(6);
    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    await earthquakeGetFeed.handler(earthquakeGetFeed.input.parse({ limit: 2 }), ctx);
    feed.events.unshift(event('inserted'));
    const result = await runToolContract(earthquakeGetFeed, {
      cursor: getEnrichment(ctx).nextCursor as string,
    });
    expect(result.structuredContent).toMatchObject({ events: [{ id: 'id2' }, { id: 'id3' }] });
    expect(getFeed).toHaveBeenCalledTimes(1);
  });
  it('bounds both final tool surfaces including UTF-8 and continuation trailers', async () => {
    mockFeed(1000);
    const result = await runToolContract(earthquakeGetFeed, { limit: 1000 });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000);
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      nextCursor: expect.any(String),
    });
  });
  it('maps resource availability errors without upstream data', async () => {
    const { getFeed } = mockFeed(0);
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    getFeed.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unsafe body', {
        status: 501,
        retryable: false,
        body: 'unsafe',
      }),
    );
    await expect(
      earthquakeFeedResource.handler(
        { magnitude_tier: 'all', time_window: 'hour' },
        createMockContext({ errors: earthquakeFeedResource.errors }),
      ),
    ).rejects.toMatchObject({
      data: {
        reason: 'feed_unavailable',
        status: 501,
        retryable: false,
        recovery: { hint: expect.stringContaining('source=emsc') },
      },
    });
  });
  it('characterizes full tool fields and compact resource projection', async () => {
    mockFeed(1);
    const result = await runToolContract(earthquakeGetFeed, {});
    expect(result.structuredContent).toMatchObject({
      count: 1,
      events: [{ id: 'id0', felt: null }],
    });
    expect(JSON.stringify(result.content)).toContain('id0');
    const resource = await earthquakeFeedResource.handler(
      { magnitude_tier: 'all', time_window: 'day' },
      createMockContext({ errors: earthquakeFeedResource.errors }),
    );
    expect(resource.events[0]).toMatchObject({ id: 'id0', depth_km: null });
    expect(resource.events[0]).not.toHaveProperty('felt');
  });
});
