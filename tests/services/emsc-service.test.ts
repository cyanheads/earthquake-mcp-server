/**
 * @fileoverview Tests for EmscService — null-magnitude normalization and the
 * truncation-triggered totalCount count sub-call.
 * @module tests/services/emsc-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmscService } from '@/services/emsc/emsc-service.js';
import type { EmscFeature } from '@/services/usgs/types.js';

function makeService(): EmscService {
  return new EmscService(
    {} as AppConfig,
    {} as StorageService,
    'https://www.seismicportal.eu',
    5000,
  );
}

function makeFeature(unid: string, mag: number | null): EmscFeature {
  return {
    type: 'Feature',
    id: unid,
    geometry: { type: 'Point', coordinates: [28.2, 38.4, 10] },
    properties: {
      unid,
      mag,
      magtype: mag === null ? undefined : 'ml',
      flynn_region: 'WESTERN TURKEY',
      time: '2026-06-01T00:00:00.000Z',
      lastupdate: '2026-06-01T00:10:00.000Z',
    },
  };
}

function jsonResponse(features: EmscFeature[]): Response {
  return new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EmscService.searchEvents — null magnitude normalization (issue #13)', () => {
  it('passes a null upstream mag through as magnitude null, not 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', null)])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.magnitude).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('EmscService.searchEvents — totalCount count sub-call (issue #11)', () => {
  it('fetches the real total via countEvents when results are truncated at the limit', async () => {
    const features = Array.from({ length: 2 }, (_, i) => makeFeature(`20260601_000${i}`, 4.2));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(features)));

    const service = makeService();
    const countSpy = vi
      .spyOn(service, 'countEvents')
      .mockResolvedValue({ count: 184, maxAllowed: null, exceedsLimit: false });

    const params = { limit: 2, orderBy: 'time', minMagnitude: 4 };
    const result = await service.searchEvents(params, createMockContext() as Context);

    expect(result.count).toBe(2);
    expect(result.totalCount).toBe(184);
    expect(countSpy).toHaveBeenCalledWith({ minMagnitude: 4 }, expect.anything());
    vi.unstubAllGlobals();
  });

  it('does not make the count sub-call when results are below the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4.2)])),
    );

    const service = makeService();
    const countSpy = vi.spyOn(service, 'countEvents');

    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.totalCount).toBeUndefined();
    expect(countSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('degrades to an absent totalCount when the count sub-call fails', async () => {
    const features = [makeFeature('20260601_0001', 4.2)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(features)));

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockRejectedValue(new Error('count endpoint down'));

    const result = await service.searchEvents({ limit: 1 }, createMockContext() as Context);

    expect(result.count).toBe(1);
    expect(result.totalCount).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
