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
  it('sends a clamped search limit upstream and returns the whole page with both notices', async () => {
    const searchEvents = vi
      .fn()
      .mockResolvedValue({ events: fixture(1000).events, count: 1000, totalCount: 1500 });
    vi.spyOn(usgs, 'getUsgsService').mockReturnValue({
      searchEvents,
    } as unknown as usgs.UsgsService);
    const result = await runToolContract(earthquakeSearchEvents, { limit: 20000, offset: 2 });
    expect(searchEvents.mock.calls[0]?.[0].limit).toBe(1000);
    expect(result.structuredContent).toMatchObject({
      count: 1000,
      nextOffset: 1002,
      truncated: true,
      queryEcho: { limit: 1000 },
      notice:
        'Requested limit 20000; applied limit 1000, the per-call cap. Showing events 2–1001 of 1500 matches. Call again with offset=1002 and the same filters, source, limit and order_by for the next page.',
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Requested limit 20000; applied limit 1000, the per-call cap.');
    expect(text).toContain('Showing events 2–1001 of 1500 matches.');
    expect(text).toContain('id999');
  });
  it('sends the default search limit of 15 upstream without a clamp notice', async () => {
    const searchEvents = vi
      .fn()
      .mockResolvedValue({ events: fixture(15).events, count: 15, totalCount: 40 });
    vi.spyOn(usgs, 'getUsgsService').mockReturnValue({
      searchEvents,
    } as unknown as usgs.UsgsService);
    const result = await runToolContract(earthquakeSearchEvents, {});
    expect(searchEvents.mock.calls[0]?.[0].limit).toBe(15);
    expect(result.structuredContent).toMatchObject({ count: 15, nextOffset: 16 });
    expect(JSON.stringify(result)).not.toContain('Requested limit');
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
  it('clamps a first-page feed limit to the cap and continues from the last returned event', async () => {
    mockFeed(1001);
    const result = await runToolContract(earthquakeGetFeed, { limit: 1001 });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as { events: { id: string }[]; nextCursor: string };
    expect(output).toMatchObject({
      count: 1000,
      totalCount: 1001,
      truncated: true,
      notice:
        'Requested limit 1001; applied limit 1000, the per-call cap. Showing 1000 of 1001 events. Call again with nextCursor as cursor and the same magnitude_tier and time_window.',
    });
    expect(output.events.at(-1)?.id).toBe('id999');
    const text = JSON.stringify(result.content);
    expect(text).toContain('Requested limit 1001; applied limit 1000, the per-call cap.');
    expect(text).toContain('id999');
    const next = await runToolContract(earthquakeGetFeed, { cursor: output.nextCursor });
    expect(next.structuredContent).toMatchObject({ count: 1, events: [{ id: 'id1000' }] });
  });
  it('returns 15 feed events by default', async () => {
    mockFeed(16);
    const result = await runToolContract(earthquakeGetFeed, {});
    expect(result.structuredContent).toMatchObject({ count: 15, totalCount: 16, truncated: true });
    expect(JSON.stringify(result)).not.toContain('Requested limit');
  });
  it('keeps the cursor page size and discloses no clamp for an unused over-cap limit', async () => {
    mockFeed(10);
    const first = await runToolContract(earthquakeGetFeed, { limit: 3 });
    const cursor = (first.structuredContent as { nextCursor: string }).nextCursor;
    const next = await runToolContract(earthquakeGetFeed, { cursor, limit: 5000 });
    expect(next.structuredContent).toMatchObject({
      count: 3,
      events: [{ id: 'id3' }, { id: 'id4' }, { id: 'id5' }],
    });
    expect(JSON.stringify(next)).not.toContain('Requested limit');
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
  it('pages the feed resource 100 events at a time and continues through next_uri', async () => {
    mockFeed(101);
    const ctx = () => createMockContext({ errors: earthquakeFeedResource.errors });
    const first = await earthquakeFeedResource.handler(
      { magnitude_tier: 'all', time_window: 'day' },
      ctx(),
    );
    expect(first).toMatchObject({ count: 100, totalCount: 101, truncated: true });
    expect(first.events).toHaveLength(100);
    expect(first.events.at(-1)?.id).toBe('id99');
    const cursor = first.next_uri!.split('/page/')[1]!;
    expect(first.nextCursor).toBe(cursor);
    const last = await earthquakeFeedResource.handler(
      { magnitude_tier: 'all', time_window: 'day', cursor },
      ctx(),
    );
    expect(last).toMatchObject({ count: 1, truncated: false, events: [{ id: 'id100' }] });
    expect(last).not.toHaveProperty('next_uri');
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
