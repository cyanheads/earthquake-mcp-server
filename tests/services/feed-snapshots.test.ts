/**
 * @fileoverview Snapshot ownership, retention, and admission invariants.
 * @module tests/services/feed-snapshots.test
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedSnapshots } from '@/services/feed-snapshots.js';
import type { UsgsService } from '@/services/usgs/usgs-service.js';

type Feed = Awaited<ReturnType<UsgsService['getFeed']>>;
const selection = { magnitude_tier: 'all', time_window: 'day', limit: 1 };
const feed = (stamp = 'a'): Feed => ({
  events: [],
  count: 0,
  generatedAt: stamp,
  feedUrl: 'https://earthquake.usgs.gov/feed',
});
const ctx = (tenantId = 'one') => createMockContext({ tenantId });
afterEach(() => vi.useRealTimers());

describe('FeedSnapshots', () => {
  it('deduplicates complete serialized content only within tenant and feed', async () => {
    const store = new FeedSnapshots();
    const first = await store.read(selection, ctx(), async () => feed());
    const charge = store.retainedBytes;
    const equal = await store.read(selection, ctx(), async () => feed());
    expect(equal.cursor(0)).toBe(first.cursor(0));
    expect(store.retainedBytes).toBe(charge);
    for (const [select, context, data] of [
      [selection, ctx('two'), feed()],
      [{ ...selection, time_window: 'month' }, ctx(), feed()],
      [selection, ctx(), feed('changed')],
    ] as const) {
      const distinct = await store.read(select, context, async () => data);
      expect(distinct.cursor(0)).not.toBe(first.cursor(0));
    }
    expect(store.retainedBytes).toBeGreaterThan(charge * 3);
  });
  it('rejects cross-tenant and cross-feed handles with the same expired result', async () => {
    const store = new FeedSnapshots();
    const first = await store.read(selection, ctx(), async () => feed());
    const fetch = vi.fn();
    for (const [select, context] of [
      [selection, ctx('two')],
      [{ ...selection, time_window: 'week' }, ctx()],
    ] as const) {
      await expect(
        store.read({ ...select, cursor: first.cursor(0) }, context, fetch),
      ).rejects.toMatchObject({ data: { reason: 'cursor_expired' } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not refresh expiry on reuse or continuation', async () => {
    vi.useFakeTimers();
    const store = new FeedSnapshots();
    const first = await store.read(selection, ctx(), async () => feed());
    vi.advanceTimersByTime(14 * 60000);
    await store.read(selection, ctx(), async () => feed());
    await store.read({ ...selection, cursor: first.cursor(0) }, ctx(), vi.fn());
    vi.advanceTimersByTime(60001);
    await expect(
      store.read({ ...selection, cursor: first.cursor(0) }, ctx(), vi.fn()),
    ).rejects.toMatchObject({ data: { reason: 'cursor_expired' } });
  });
  it('evicts oldest-created generations; reuse does not make one newer', async () => {
    const measurement = new FeedSnapshots();
    await measurement.read(selection, ctx(), async () => feed());
    const store = new FeedSnapshots(measurement.retainedBytes * 2 + 10);
    const first = await store.read(selection, ctx(), async () => feed('a'));
    const second = await store.read(selection, ctx(), async () => feed('b'));
    await store.read(selection, ctx(), async () => feed('a'));
    await store.read(selection, ctx(), async () => feed('c'));
    await expect(
      store.read({ ...selection, cursor: first.cursor(0) }, ctx(), vi.fn()),
    ).rejects.toMatchObject({ data: { reason: 'cursor_expired' } });
    await expect(
      store.read({ ...selection, cursor: second.cursor(0) }, ctx(), vi.fn()),
    ).resolves.toHaveProperty('feed.generatedAt', 'b');
    expect(store.retainedBytes).toBeLessThanOrEqual(measurement.retainedBytes * 2 + 10);
  });
  it('charges tiny generations and prunes expired entries before admission', async () => {
    vi.useFakeTimers();
    const store = new FeedSnapshots(3000);
    for (let i = 0; i < 100; i++) await store.read(selection, ctx(), async () => feed(String(i)));
    expect(store.retainedBytes).toBeLessThanOrEqual(3000);
    vi.advanceTimersByTime(900001);
    await store.read(selection, ctx(), async () => feed('new'));
    expect(store.retainedBytes).toBeLessThan(1500);
  });
  it('returns owned fresh graphs and deduplicates concurrent admissions', async () => {
    const store = new FeedSnapshots();
    const data = feed();
    const [first, second] = await Promise.all([
      store.read(selection, ctx(), async () => data),
      store.read(selection, ctx(), async () => data),
    ]);
    const charge = store.retainedBytes;
    first.feed.generatedAt = 'mutated';
    data.generatedAt = 'source mutated';
    expect(second.feed.generatedAt).toBe('a');
    expect(first.cursor(0)).toBe(second.cursor(0));
    const replay = await store.read({ ...selection, cursor: first.cursor(0) }, ctx(), vi.fn());
    expect(replay.feed.generatedAt).toBe('a');
    expect(store.retainedBytes).toBe(charge);
  });
  it('cancelled admission and oversized snapshots evict nothing', async () => {
    const store = new FeedSnapshots(2000);
    const first = await store.read(selection, ctx(), async () => feed());
    const charge = store.retainedBytes;
    const controller = new AbortController();
    const cancelled = createMockContext({ tenantId: 'one', signal: controller.signal });
    await expect(
      store.read(selection, cancelled, async () => {
        controller.abort();
        return feed('new');
      }),
    ).rejects.toThrow();
    await expect(
      store.read(selection, ctx(), async () => feed('x'.repeat(4000))),
    ).rejects.toMatchObject({ data: { reason: 'snapshot_too_large' } });
    expect(store.retainedBytes).toBe(charge);
    await expect(
      store.read({ ...selection, cursor: first.cursor(0) }, ctx(), vi.fn()),
    ).resolves.toHaveProperty('feed.generatedAt', 'a');
  });
  it('one cancelled concurrent fetch does not cancel or publish for another caller', async () => {
    const store = new FeedSnapshots();
    const controller = new AbortController();
    const fetch = vi.fn(async () => feed());
    controller.abort();
    const results = await Promise.allSettled([
      store.read(
        selection,
        createMockContext({ tenantId: 'one', signal: controller.signal }),
        fetch,
      ),
      store.read(selection, ctx(), fetch),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(fetch).toHaveBeenCalledTimes(2);
    const kept = store.retainedBytes;
    await store.read(selection, ctx(), fetch);
    expect(store.retainedBytes).toBe(kept);
  });
  it.each([
    '',
    'legacy',
    Buffer.from(JSON.stringify({ offset: 2, limit: 2 })).toString('base64url'),
    'x'.repeat(513),
    Buffer.from(JSON.stringify(['id', -1, 2])).toString('base64url'),
    Buffer.from(JSON.stringify(['id', 0, 1001])).toString('base64url'),
  ])('rejects malformed cursor without fetching: %s', async (cursor) => {
    const fetch = vi.fn();
    await expect(
      new FeedSnapshots().read({ ...selection, cursor }, ctx(), fetch),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor', retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts a cursor page size at the 1,000 cap as well-formed', async () => {
    const cursor = Buffer.from(JSON.stringify(['id', 0, 1000])).toString('base64url');
    await expect(
      new FeedSnapshots().read({ ...selection, cursor }, ctx(), vi.fn()),
    ).rejects.toMatchObject({ data: { reason: 'cursor_expired' } });
  });
  it('pages 100 events when the selection names no limit, and carries that size in its cursor', async () => {
    const read = await new FeedSnapshots().read(
      { magnitude_tier: 'all', time_window: 'day' },
      ctx(),
      async () => feed(),
    );
    expect(read.limit).toBe(100);
    expect(JSON.parse(Buffer.from(read.cursor(100), 'base64url').toString())[2]).toBe(100);
  });
});
