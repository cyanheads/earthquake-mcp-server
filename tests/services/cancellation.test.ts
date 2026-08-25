/**
 * @fileoverview Pins the cancellation path both service clients thread through
 * `ctx.signal` — into `fetchWithTimeout` and into `withRetry`.
 *
 * Cancellation is invisible to every other test in this suite: a handler test
 * never aborts, so a service that quietly dropped `signal` from either call would
 * stay green while a cancelled request kept fetching and retrying against USGS or
 * EMSC. Two properties matter and neither follows from the other — the call must
 * *fail* on an aborted signal, and the retry ladder must not run afterwards.
 *
 * @module tests/services/cancellation.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmscService } from '@/services/emsc/emsc-service.js';
import type { UsgsFeature } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const usgs = () =>
  new UsgsService({} as AppConfig, {} as StorageService, 'https://usgs.test', 5000);
const emsc = () =>
  new EmscService({} as AppConfig, {} as StorageService, 'https://emsc.test', 5000);

const feature = (id: string): UsgsFeature => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [-178.5, 52.0, 33] },
  properties: {
    mag: 4.5,
    magType: 'mb',
    place: '234 km SE of Attu Station, Alaska',
    time: 1748736000000,
    updated: 1748736600000,
    status: 'reviewed',
    tsunami: 0,
    title: 'M 4.5 - 234 km SE of Attu Station, Alaska',
  },
});

/** A GeoJSON page of `n` events — the shape both providers' search paths parse. */
const page = (n: number) =>
  new Response(
    JSON.stringify({
      type: 'FeatureCollection',
      features: Array.from({ length: n }, (_, i) => feature(`us${i}`)),
      metadata: { generated: 1748736000000, url: 'u', title: 'T', status: 200, api: '1', count: n },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/**
 * A fetch that honors the abort signal the way the platform does — rejecting an
 * in-flight request rather than hanging. A stub that ignores `signal` would make
 * every assertion below pass for the wrong reason.
 */
function abortAwareFetch(onCall?: (call: number) => Response | undefined) {
  let calls = 0;
  return vi.fn((_url: string, init?: RequestInit) => {
    calls += 1;
    const canned = onCall?.(calls);
    if (canned) return Promise.resolve(canned);
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) return fail();
      signal?.addEventListener('abort', fail);
    });
  });
}

/** Every upstream entry point, invoked with an already-aborted request. */
const entryPoints = [
  { name: 'UsgsService.getFeed', run: (ctx: Context) => usgs().getFeed('2.5', 'day', ctx) },
  {
    name: 'UsgsService.searchEvents',
    run: (ctx: Context) => usgs().searchEvents({ limit: 10 }, ctx),
  },
  { name: 'UsgsService.getEvent', run: (ctx: Context) => usgs().getEvent('us6000sznj', ctx) },
  {
    name: 'UsgsService.countEvents',
    run: (ctx: Context) => usgs().countEvents({ limit: 10 }, ctx),
  },
  {
    name: 'EmscService.searchEvents',
    run: (ctx: Context) => emsc().searchEvents({ limit: 10 }, ctx),
  },
  {
    name: 'EmscService.countEvents',
    run: (ctx: Context) => emsc().countEvents({ limit: 10 }, ctx),
  },
] as const;

describe.each(entryPoints)('$name — an aborted request', ({ run }) => {
  it('fails instead of returning a result', async () => {
    vi.stubGlobal('fetch', abortAwareFetch());
    const controller = new AbortController();
    controller.abort();

    await expect(run(createMockContext({ signal: controller.signal }) as Context)).rejects.toThrow(
      /abort/i,
    );
  });

  it('does not run the retry ladder against an upstream the caller walked away from', async () => {
    const fetchSpy = abortAwareFetch();
    vi.stubGlobal('fetch', fetchSpy);
    const controller = new AbortController();
    controller.abort();

    await run(createMockContext({ signal: controller.signal }) as Context).catch(() => undefined);

    // One attempt, not the default four. withRetry treats Timeout/ServiceUnavailable
    // as transient, so without the signal wired through it would back off and retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a live signal does not interfere', () => {
  it('completes a normal call when the signal was never aborted', async () => {
    // Guards the guard: if the stub rejected unconditionally, every assertion
    // above would pass on a service that ignored `signal` entirely.
    vi.stubGlobal(
      'fetch',
      abortAwareFetch(() => page(2)),
    );
    const controller = new AbortController();

    const result = await usgs().searchEvents(
      { limit: 10 },
      createMockContext({ signal: controller.signal }) as Context,
    );

    expect(result.count).toBe(2);
  });
});

describe('cancellation past the first upstream call', () => {
  it.each([
    { name: 'UsgsService', search: (ctx: Context) => usgs().searchEvents({ limit: 2 }, ctx) },
    { name: 'EmscService', search: (ctx: Context) => emsc().searchEvents({ limit: 2 }, ctx) },
  ])('$name keeps the page when the count sub-call is aborted', async ({ search }) => {
    // A page truncated at the limit triggers a second request for the match total.
    // Aborting between the two exercises the failover branch, not the happy path.
    const controller = new AbortController();
    const fetchSpy = abortAwareFetch((call) => {
      if (call !== 1) return;
      controller.abort();
      return page(2);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await search(createMockContext({ signal: controller.signal }) as Context);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(2);
    // The page is worth more than the total: losing the events to report a failed
    // count would throw away the work the first request already paid for.
    expect(result.totalCount).toBeUndefined();
    expect(result.countUnavailable).toBe(true);
  });
});
