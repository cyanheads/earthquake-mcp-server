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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmscService } from '@/services/emsc/emsc-service.js';
import { CALL_DEADLINE_MS } from '@/services/upstream-call.js';
import type { UsgsFeature } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';

afterEach(() => {
  vi.useRealTimers();
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

/** A USGS GeoJSON page of `n` events. */
const page = (n: number) =>
  new Response(
    JSON.stringify({
      type: 'FeatureCollection',
      features: Array.from({ length: n }, (_, i) => feature(`us${i}`)),
      metadata: { generated: 1748736000000, url: 'u', title: 'T', status: 200, api: '1', count: n },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/** An EMSC JSON page of `n` events, with the ISO times and unid EMSC publishes. */
const emscPage = (n: number) =>
  Response.json({
    type: 'FeatureCollection',
    features: Array.from({ length: n }, (_, i) => ({
      type: 'Feature',
      id: `20260601_000000${i}`,
      geometry: { type: 'Point', coordinates: [28.2, 38.4, -10] },
      properties: {
        unid: `20260601_000000${i}`,
        mag: 4.5,
        time: '2026-06-01T00:00:00.000Z',
        lastupdate: '2026-06-01T00:10:00.000Z',
      },
    })),
  });

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
  {
    name: 'EmscService.getEvent',
    run: (ctx: Context) => emsc().getEvent('20190706_0000043', ctx),
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

describe.each(entryPoints)('$name — a cancellation while the body streams', ({ run }) => {
  it('propagates as RequestCancelled after one request, not as a dropped connection (issue #60)', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(body) {
              body.enqueue(new TextEncoder().encode('{"type":"FeatureCollection",'));
              // Platform fetch errors an in-flight body with the abort reason.
              init?.signal?.addEventListener('abort', () => body.error(init.signal?.reason), {
                once: true,
              });
            },
            pull() {
              // The caller walks away once the body is streaming.
              controller.abort();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const err = await run(createMockContext({ signal: controller.signal }) as Context).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringMatching(
        /^fetch GET https:\/\/(usgs|emsc)\.test\/…(\?…)? was aborted\.$/,
      ),
    });
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
  it.each(['feed', 'usgs', 'emsc'] as const)(
    '%s shares one deadline across requests and retry backoff',
    async (source) => {
      vi.useFakeTimers();
      const started = Date.now();
      let requests = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
              requests += 1;
              if (source !== 'feed' && requests === 1)
                setTimeout(() => resolve(source === 'emsc' ? emscPage(2) : page(2)), 30_000);
              const fail = () => reject(new DOMException('Aborted', 'AbortError'));
              if (init?.signal?.aborted) fail();
              else init?.signal?.addEventListener('abort', fail, { once: true });
            }),
        ),
      );
      const ctx = createMockContext() as Context;
      const service =
        source === 'emsc'
          ? new EmscService({} as AppConfig, {} as StorageService, 'https://test', 45000)
          : new UsgsService({} as AppConfig, {} as StorageService, 'https://test', 45000);
      const promise =
        source === 'feed'
          ? (service as UsgsService).getFeed('all', 'day', ctx)
          : service.searchEvents({ limit: 2 }, ctx);
      const observed = promise.then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      // The count sub-call gets what remains of the search's deadline; a fresh one would
      // carry the chain to 80 s.
      expect(Date.now() - started).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      expect(await observed).toMatchObject(
        source === 'feed' ? { code: -32004 } : { count: 2, countUnavailable: true },
      );
    },
  );
  it.each([
    {
      name: 'UsgsService',
      service: () =>
        new UsgsService({} as AppConfig, {} as StorageService, 'https://usgs.test', 30_000),
    },
    {
      name: 'EmscService',
      service: () =>
        new EmscService({} as AppConfig, {} as StorageService, 'https://emsc.test', 30_000),
    },
  ])(
    '$name standalone count settles within one 50 s deadline across retries (issue #59)',
    async ({ service }) => {
      vi.useFakeTimers();
      const started = Date.now();
      // Accepts every request and never answers, so only a timeout ends one.
      const fetchSpy = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const fail = () =>
              reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            if (init?.signal?.aborted) fail();
            else init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const pending = service()
        .countEvents({ minMagnitude: 5 }, createMockContext() as Context)
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = await pending;

      // Four 30 s attempts plus backoff would run to about 127 s.
      expect(Date.now() - started).toBeLessThanOrEqual(CALL_DEADLINE_MS);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: CALL_DEADLINE_MS },
      });
      // One 30 s attempt, a backoff, then a second attempt cut short by the deadline.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    {
      name: 'UsgsService',
      search: (ctx: Context) => usgs().searchEvents({ limit: 2 }, ctx),
      firstPage: () => page(2),
    },
    {
      name: 'EmscService',
      search: (ctx: Context) => emsc().searchEvents({ limit: 2 }, ctx),
      firstPage: () => emscPage(2),
    },
  ])(
    '$name preserves cancellation when the count sub-call is aborted',
    async ({ search, firstPage }) => {
      // A page truncated at the limit triggers a second request for the match total.
      // Aborting between the two exercises the failover branch, not the happy path.
      const controller = new AbortController();
      const fetchSpy = abortAwareFetch((call) => {
        if (call !== 1) return;
        controller.abort();
        return firstPage();
      });
      vi.stubGlobal('fetch', fetchSpy);

      const pending = search(createMockContext({ signal: controller.signal }) as Context);
      await expect(pending).rejects.toThrow(/abort/i);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );
});
