/**
 * @fileoverview Preserves upstream retry decisions through earthquake tool and resource contracts.
 * @module tests/tools/upstream-retry-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeEventResource } from '@/mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCountEvents } from '@/mcp-server/tools/definitions/earthquake-count-events.tool.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearchEvents } from '@/mcp-server/tools/definitions/earthquake-search-events.tool.js';
import { initEmscService } from '@/services/emsc/emsc-service.js';
import { initUsgsService } from '@/services/usgs/usgs-service.js';

beforeEach(() => {
  initUsgsService({} as AppConfig, createInMemoryStorage(), 'https://usgs.test', 1000);
  initEmscService({} as AppConfig, createInMemoryStorage(), 'https://emsc.test', 1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The recovery text a definition declares for a reason — what both surfaces must carry. */
function declaredRecovery(
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
) {
  return errors?.find((entry) => entry.reason === reason)?.recovery;
}

/** A USGS record with no origin time, update time, or status (issue #61). */
const sparseUsgsFeature = (id: string) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [-150.1, 61.2, 10] },
  properties: { mag: 3.1, place: 'Southern Alaska', time: null, updated: null },
});

/** An EMSC record with no identifier, origin time, or update time (issue #61). */
const sparseEmscFeature = (lat: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.5, lat, -10] },
  properties: { mag: 3.1, magtype: 'ml', flynn_region: 'GREECE', lat, lon: 21.5, depth: 10 },
});

const sparseUsgsPage = {
  type: 'FeatureCollection',
  features: [sparseUsgsFeature('ak0000test1')],
  metadata: { generated: 1793762688000, count: 1 },
};

/** A USGS record carrying every field the normalizer requires. */
const usgsFeature = (id: string) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [-150.1, 61.2, 10] },
  properties: { mag: 3.1, place: 'Southern Alaska', time: 1793762000000, updated: 1793762600000 },
});

/** An EMSC record carrying every field the normalizer requires. */
const emscFeature = (unid: string) => ({
  type: 'Feature',
  id: unid,
  geometry: { type: 'Point', coordinates: [21.5, 38.2, -10] },
  properties: {
    unid,
    time: '2026-11-03T00:00:00.000Z',
    lastupdate: '2026-11-03T00:05:00.000Z',
    mag: 3.1,
    magtype: 'ml',
    flynn_region: 'GREECE',
    lat: 38.2,
    lon: 21.5,
    depth: 10,
  },
});

const usgsPage = (...features: object[]) => ({
  type: 'FeatureCollection',
  features,
  metadata: { generated: 1793762688000, count: features.length },
});

/** Replaces one member of a complete record with a value no feature carries. */
type Misshape = (feature: object) => object;

/**
 * The two members a normalizer dereferences before it reads any field (issue #60). EMSC also
 * publishes the position in properties and reads it from there first, so the geometry case
 * leaves none there.
 */
const misshapes: [string, Misshape][] = [
  ['null properties', (feature) => ({ ...feature, properties: null })],
  [
    'a null geometry and no position in properties',
    (feature) => {
      const {
        lat: _lat,
        lon: _lon,
        depth: _depth,
        ...properties
      } = (feature as { properties: Record<string, unknown> }).properties;
      return { ...feature, geometry: null, properties };
    },
  ],
];

const calls = [
  {
    name: 'USGS search',
    source: 'USGS',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeSearchEvents.errors, 'source_unavailable'),
    emptyObject: 'unavailable',
    sparse: sparseUsgsPage,
    misshapen: (shape: Misshape) =>
      usgsPage(usgsFeature('ak0000test1'), shape(usgsFeature('ak0000test2'))),
    run: () => runToolContract(earthquakeSearchEvents, { source: 'usgs' }),
  },
  {
    name: 'EMSC search',
    source: 'EMSC',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeSearchEvents.errors, 'source_unavailable'),
    emptyObject: 'unavailable',
    sparse: {
      type: 'FeatureCollection',
      features: [sparseEmscFeature(38.2), sparseEmscFeature(39.2)],
    },
    misshapen: (shape: Misshape) => ({
      type: 'FeatureCollection',
      features: [emscFeature('20261103_0000001'), shape(emscFeature('20261103_0000002'))],
    }),
    run: () => runToolContract(earthquakeSearchEvents, { source: 'emsc' }),
  },
  {
    name: 'USGS count',
    source: 'USGS',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeCountEvents.errors, 'source_unavailable'),
    emptyObject: 'unavailable',
    sparse: undefined,
    misshapen: undefined,
    run: () => runToolContract(earthquakeCountEvents, { source: 'usgs' }),
  },
  {
    name: 'EMSC count',
    source: 'EMSC',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeCountEvents.errors, 'source_unavailable'),
    emptyObject: 'unavailable',
    sparse: undefined,
    misshapen: undefined,
    run: () => runToolContract(earthquakeCountEvents, { source: 'emsc' }),
  },
  {
    name: 'feed',
    source: 'USGS',
    reason: 'feed_unavailable',
    recovery: declaredRecovery(earthquakeGetFeed.errors, 'feed_unavailable'),
    emptyObject: 'unavailable',
    sparse: sparseUsgsPage,
    misshapen: (shape: Misshape) =>
      usgsPage(usgsFeature('ak0000test1'), shape(usgsFeature('ak0000test2'))),
    run: () => runToolContract(earthquakeGetFeed, {}),
  },
  {
    name: 'event',
    source: 'USGS',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeGetEvent.errors, 'source_unavailable'),
    emptyObject: 'not_found',
    sparse: sparseUsgsFeature('us6000sznj'),
    misshapen: (shape: Misshape) => shape(usgsFeature('us6000sznj')),
    run: () => runToolContract(earthquakeGetEvent, { event_id: 'us6000sznj' }),
  },
  {
    name: 'EMSC event',
    source: 'EMSC',
    reason: 'source_unavailable',
    recovery: declaredRecovery(earthquakeGetEvent.errors, 'source_unavailable'),
    emptyObject: 'not_found',
    sparse: {
      ...sparseEmscFeature(38.2),
      id: '20190706_0000043',
      properties: { ...sparseEmscFeature(38.2).properties, unid: '20190706_0000043' },
    },
    misshapen: (shape: Misshape) => shape(emscFeature('20190706_0000043')),
    run: () => runToolContract(earthquakeGetEvent, { event_id: '20190706_0000043' }),
  },
] as const;

/** Text a JSON parser, a property read on a wrong-shape body, or the runtime's socket layer authors. */
const ENGINE_TEXT =
  /JSON|SyntaxError|Parse error|position \d|undefined|Cannot read|evaluating|ECONNRESET|verbose|terminated/;

/** A 2xx response whose connection drops after the first bytes of the body. */
function droppedBody(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"FeatureCollection","features":['));
        controller.error(
          new Error(
            'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
          ),
        );
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe.each(calls)(
  '$name upstream retry contract',
  ({ run, source, reason, recovery, emptyObject, sparse, misshapen }) => {
    /** The declared *_unavailable failure on both surfaces, carrying no parser or engine text. */
    function expectUnavailable(result: Awaited<ReturnType<typeof run>>, message: string) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message,
          data: { reason, retryable: true, recovery: { hint: recovery } },
        },
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain(message);
      expect(text).toContain(String(recovery));
      expect(text).not.toContain('Do not retry');
      expect(JSON.stringify([result.content, result.structuredContent])).not.toMatch(ENGINE_TEXT);
    }

    it.each([
      ['truncated JSON', '{"type":"FeatureCollection",'],
      ['plain text', 'Service temporarily unavailable'],
      ['null', 'null'],
    ])(
      'fails a %s 2xx body in one request, without parser text (issue #60)',
      async (_label, body) => {
        const fetchSpy = vi.fn(() => Promise.resolve(new Response(body, { status: 200 })));
        vi.stubGlobal('fetch', fetchSpy);
        const result = await run();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expectUnavailable(result, `${source} returned a response in an unexpected format.`);
      },
    );

    // Counts carry no event records, so only the paths that normalize one are listed.
    if (sparse !== undefined) {
      it('fails a record missing a field the source always publishes, inventing none (issue #61)', async () => {
        const fetchSpy = vi.fn(() => Promise.resolve(Response.json(sparse)));
        vi.stubGlobal('fetch', fetchSpy);
        const result = await run();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expectUnavailable(result, `${source} returned a response in an unexpected format.`);
        expect(JSON.stringify([result.content, result.structuredContent])).not.toMatch(
          /emsc-unknown-|1970-01-01|automatic/,
        );
      });
    }

    if (misshapen !== undefined) {
      it.each(misshapes)(
        'fails a record with %s in one request, without engine text (issue #60)',
        async (_label, shape) => {
          vi.useFakeTimers();
          const fetchSpy = vi.fn(() => Promise.resolve(Response.json(misshapen(shape))));
          vi.stubGlobal('fetch', fetchSpy);
          const pending = run();
          await vi.runAllTimersAsync();
          const result = await pending;
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expectUnavailable(result, `${source} returned a response in an unexpected format.`);
        },
      );
    }

    it(`answers a {} 2xx body as ${emptyObject} in one request (issue #60)`, async () => {
      const fetchSpy = vi.fn(() => Promise.resolve(Response.json({})));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await run();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      if (emptyObject === 'not_found') {
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
        });
      } else {
        expectUnavailable(result, `${source} returned a response in an unexpected format.`);
      }
    });

    it('retries a connection dropped mid-body, then fails without engine text (issue #60)', async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn(() => Promise.resolve(droppedBody()));
      vi.stubGlobal('fetch', fetchSpy);
      const pending = run();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expectUnavailable(
        result,
        `${source} closed the connection before the response was complete. (failed after 4 attempts)`,
      );
    });

    it('retries an HTML body before failing as a recoverable service failure', async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn(() =>
        Promise.resolve(new Response('<!DOCTYPE html><p>busy</p>', { status: 200 })),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const pending = run();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason } },
      });
    });

    it('retries a network failure before failing as a recoverable service failure', async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
      vi.stubGlobal('fetch', fetchSpy);
      const pending = run();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason } },
      });
    });

    it('does not retry HTTP 501 and tells both client surfaces not to retry', async () => {
      const fetchSpy = vi.fn(() =>
        Promise.resolve(new Response('Not implemented', { status: 501 })),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await run();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { retryable: false } },
      });
      expect(JSON.stringify(result.content)).toContain('Do not retry');
    });

    it('retries HTTP 500 before returning a recoverable service failure', async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn(() =>
        Promise.resolve(new Response('Upstream failed', { status: 500 })),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const pending = run();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
      expect(JSON.stringify(result.content)).not.toContain('Do not retry');
    });
  },
);

it('preserves HTTP 501 on event and feed resource failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('Not implemented', { status: 501 }))),
  );
  for (const pending of [
    () =>
      earthquakeEventResource.handler(
        { event_id: 'us6000sznj' },
        createMockContext({ errors: earthquakeEventResource.errors }),
      ),
    () =>
      earthquakeFeedResource.handler(
        { magnitude_tier: '2.5', time_window: 'day' },
        createMockContext({ errors: earthquakeFeedResource.errors }),
      ),
  ]) {
    await expect(pending()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
  }
});

describe('resources — a malformed 2xx body (issues #60, #61)', () => {
  const resources = [
    {
      name: 'event resource',
      run: () =>
        earthquakeEventResource.handler(
          { event_id: 'us6000sznj' },
          createMockContext({ errors: earthquakeEventResource.errors }),
        ),
      reason: 'source_unavailable',
      message: 'USGS returned a response in an unexpected format.',
      recovery: declaredRecovery(earthquakeEventResource.errors, 'source_unavailable'),
      sparse: sparseUsgsFeature('us6000sznj'),
    },
    {
      name: 'feed resource',
      run: () =>
        earthquakeFeedResource.handler(
          { magnitude_tier: '2.5', time_window: 'day' },
          createMockContext({ errors: earthquakeFeedResource.errors }),
        ),
      reason: 'feed_unavailable',
      message: 'USGS feed 2.5/day is unavailable.',
      recovery: declaredRecovery(earthquakeFeedResource.errors, 'feed_unavailable'),
      sparse: sparseUsgsPage,
    },
  ];
  const bodies = resources.flatMap((resource) => [
    {
      ...resource,
      body: 'truncated JSON',
      respond: () => new Response('{"type":"FeatureCollection",'),
    },
    {
      ...resource,
      body: 'a record with no origin time',
      respond: () => Response.json(resource.sparse),
    },
  ]);

  it.each(bodies)(
    '$name fails $body as $reason in one request',
    async ({ run, reason, message, recovery, respond }) => {
      const fetchSpy = vi.fn(() => Promise.resolve(respond()));
      vi.stubGlobal('fetch', fetchSpy);
      const err = await (async () => run())().catch((e: unknown) => e);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message,
        data: { reason, recovery: { hint: recovery } },
      });
      expect(JSON.stringify((err as { data?: unknown }).data)).not.toMatch(ENGINE_TEXT);
    },
  );
});
