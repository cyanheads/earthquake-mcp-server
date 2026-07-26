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

function makeFeature(
  unid: string,
  mag: number | null,
  extraProps: Partial<EmscFeature['properties']> = {},
): EmscFeature {
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
      ...extraProps,
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

describe('EmscService.searchEvents — unpublished fields stay unasserted (issue #22)', () => {
  it('leaves status null instead of claiming a review the source never reported', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([
            makeFeature('20260726_0000128', 5.8, { source_catalog: 'EMSC-RTS', auth: 'NEIC' }),
          ]),
        ),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.status).toBeNull();
    vi.unstubAllGlobals();
  });

  it('leaves tsunami null instead of asserting 0 from an absent field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260726_0000128', 5.8)])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.tsunami).toBeNull();
    vi.unstubAllGlobals();
  });

  it('passes source_catalog and auth through as the provenance EMSC does publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([
            makeFeature('20260726_0000125', 3.4, { source_catalog: 'EMSC-RTS', auth: 'NDI' }),
          ]),
        ),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.source_catalog).toBe('EMSC-RTS');
    expect(result.events[0]?.auth).toBe('NDI');
    vi.unstubAllGlobals();
  });

  it('omits source_catalog and auth for a sparse payload that carries neither', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260726_0000124', 4.1)])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]).not.toHaveProperty('source_catalog');
    expect(result.events[0]).not.toHaveProperty('auth');
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

describe('EmscService — FDSN offset forwarding (issue #19)', () => {
  it('sets the 1-based offset on the search querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4.2)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 3, offset: 5001 }, createMockContext() as Context);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('offset=5001');
    expect(url).toContain('limit=3');
    vi.unstubAllGlobals();
  });

  it('omits offset from the querystring when not requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4.2)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 3 }, createMockContext() as Context);

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('offset=');
    vi.unstubAllGlobals();
  });

  it('strips offset from the totalCount sub-call — the total spans every page', async () => {
    const features = Array.from({ length: 2 }, (_, i) => makeFeature(`20260601_000${i}`, 4.2));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(features)));

    const service = makeService();
    const countSpy = vi
      .spyOn(service, 'countEvents')
      .mockResolvedValue({ count: 184, maxAllowed: null, exceedsLimit: false });

    await service.searchEvents(
      { limit: 2, offset: 50, orderBy: 'time', minMagnitude: 4 },
      createMockContext() as Context,
    );

    expect(countSpy).toHaveBeenCalledWith({ minMagnitude: 4 }, expect.anything());
    vi.unstubAllGlobals();
  });
});

describe('EmscService.searchEvents — 204 No Content is an empty match set', () => {
  it('returns zero events for a 204 with an empty body instead of failing to parse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const service = makeService();
    const result = await service.searchEvents({ limit: 3 }, createMockContext() as Context);

    expect(result.count).toBe(0);
    expect(result.events).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('returns zero events when paging past the last match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 204 })));

    const service = makeService();
    const result = await service.searchEvents(
      { limit: 3, offset: 9_999_999 },
      createMockContext() as Context,
    );

    expect(result.count).toBe(0);
    vi.unstubAllGlobals();
  });
});
