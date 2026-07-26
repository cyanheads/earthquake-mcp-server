/**
 * @fileoverview Tests for UsgsService — null-magnitude normalization and the
 * truncation-triggered totalCount count sub-call.
 * @module tests/services/usgs-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsgsFeature } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';

function makeService(): UsgsService {
  return new UsgsService(
    {} as AppConfig,
    {} as StorageService,
    'https://earthquake.usgs.gov',
    5000,
  );
}

function makeFeature(id: string, mag: number | null): UsgsFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [-178.5, 52.0, 33] },
    properties: {
      mag,
      magType: mag === null ? 'unknown' : 'mb',
      place: '234 km SE of Attu Station, Alaska',
      time: 1748736000000,
      updated: 1748736600000,
      status: 'reviewed',
      tsunami: 0,
      title: `M ${mag ?? '?'} - 234 km SE of Attu Station, Alaska`,
    },
  };
}

function geojsonResponse(features: UsgsFeature[]): Response {
  return new Response(
    JSON.stringify({
      type: 'FeatureCollection',
      features,
      metadata: {
        generated: 1748736000000,
        url: 'https://earthquake.usgs.gov/fdsnws/event/1/query',
        title: 'USGS Earthquakes',
        status: 200,
        api: '1.14.1',
        count: features.length,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsgsService.searchEvents — null magnitude normalization (issue #13)', () => {
  it('passes a null upstream mag through as magnitude null, not 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us7000suvk', null)])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.magnitude).toBeNull();
    expect(result.events[0]?.magnitude_type).toBe('unknown');
    vi.unstubAllGlobals();
  });

  it('preserves a real magnitude value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 4.5)])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.magnitude).toBe(4.5);
    vi.unstubAllGlobals();
  });
});

describe('UsgsService.searchEvents — provenance normalization (issue #22)', () => {
  it('keeps the upstream-reported review status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 4.5)])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.status).toBe('reviewed');
    vi.unstubAllGlobals();
  });

  it('maps the contributor network to auth and leaves source_catalog absent', async () => {
    const feature = makeFeature('us1', 4.5);
    feature.properties.net = 'ci';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.auth).toBe('ci');
    expect(result.events[0]).not.toHaveProperty('source_catalog');
    vi.unstubAllGlobals();
  });

  it('leaves tsunami null when a sparse payload omits the flag', async () => {
    const feature = makeFeature('us1', 4.5);
    delete feature.properties.tsunami;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.tsunami).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('UsgsService.searchEvents — totalCount count sub-call (issue #11)', () => {
  it('fetches the real total via countEvents when results are truncated at the limit', async () => {
    const features = Array.from({ length: 3 }, (_, i) => makeFeature(`us${i}`, 5));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse(features)));

    const service = makeService();
    const countSpy = vi
      .spyOn(service, 'countEvents')
      .mockResolvedValue({ count: 4821, maxAllowed: 20000, exceedsLimit: false });

    const params = { limit: 3, orderBy: 'time', minMagnitude: 5 };
    const result = await service.searchEvents(params, createMockContext() as Context);

    expect(result.count).toBe(3);
    expect(result.totalCount).toBe(4821);
    // Count sub-call reuses the query filters but strips limit/orderBy
    expect(countSpy).toHaveBeenCalledWith({ minMagnitude: 5 }, expect.anything());
    vi.unstubAllGlobals();
  });

  it('does not make the count sub-call when results are below the limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)])));

    const service = makeService();
    const countSpy = vi.spyOn(service, 'countEvents');

    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.totalCount).toBeUndefined();
    expect(countSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('degrades to an absent totalCount when the count sub-call fails', async () => {
    const features = Array.from({ length: 2 }, (_, i) => makeFeature(`us${i}`, 5));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse(features)));

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockRejectedValue(new Error('count endpoint down'));

    const result = await service.searchEvents({ limit: 2 }, createMockContext() as Context);

    expect(result.count).toBe(2);
    expect(result.totalCount).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('UsgsService — FDSN offset forwarding (issue #19)', () => {
  it('sets the 1-based offset on the search querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5, offset: 20001 }, createMockContext() as Context);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('offset=20001');
    expect(url).toContain('limit=5');
    vi.unstubAllGlobals();
  });

  it('omits offset from the querystring when not requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5 }, createMockContext() as Context);

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('offset=');
    vi.unstubAllGlobals();
  });

  it('strips offset from the totalCount sub-call — the total spans every page', async () => {
    const features = Array.from({ length: 3 }, (_, i) => makeFeature(`us${i}`, 5));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse(features)));

    const service = makeService();
    const countSpy = vi
      .spyOn(service, 'countEvents')
      .mockResolvedValue({ count: 4821, maxAllowed: 20000, exceedsLimit: false });

    await service.searchEvents(
      { limit: 3, offset: 100, orderBy: 'time', minMagnitude: 5 },
      createMockContext() as Context,
    );

    expect(countSpy).toHaveBeenCalledWith({ minMagnitude: 5 }, expect.anything());
    vi.unstubAllGlobals();
  });
});

describe('UsgsService — non-2xx surfaces as a status-mapped error (issue #20)', () => {
  it('raises the generic status-mapped error for a 400, not a query_too_broad reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'Error 400: Bad Request\n\n78824 matching events exceeds search limit of 20000. ' +
              'Modify the search to match fewer events.',
            { status: 400, statusText: 'Bad Request' },
          ),
        ),
    );

    const service = makeService();
    const err = await service
      .searchEvents({ minMagnitude: 0 }, createMockContext() as Context)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
    expect((err as { data?: { status?: number } }).data?.status).toBe(400);
    vi.unstubAllGlobals();
  });
});
