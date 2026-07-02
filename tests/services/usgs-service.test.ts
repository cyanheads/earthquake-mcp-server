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
