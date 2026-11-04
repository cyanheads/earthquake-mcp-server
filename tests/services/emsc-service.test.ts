/**
 * @fileoverview Tests for EmscService — null-magnitude normalization and the
 * truncation-triggered totalCount count sub-call.
 * @module tests/services/emsc-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EarthquakeEventSchema, formatEvent } from '@/mcp-server/tools/schemas.js';
import { EmscService, isEmscEventId } from '@/services/emsc/emsc-service.js';
import type { EarthquakeEvent, EmscFeature, UsgsFeature } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';
import { emscFixture } from '../helpers/usgs-fetch-stub.js';

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
      // A magnitude-less EMSC record omits magtype entirely rather than
      // publishing an empty one, so the fixture omits the key too.
      ...(mag === null ? {} : { magtype: 'ml' }),
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

/** Run one EMSC feature carrying `evtype` through the service and return the normalized event. */
async function eventWithEvtype(evtype: string | undefined): Promise<EarthquakeEvent | undefined> {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse([makeFeature('20260810_0000001', 4.6, evtype == null ? {} : { evtype })]),
      ),
  );
  const result = await makeService().searchEvents({ limit: 10 }, createMockContext() as Context);
  vi.unstubAllGlobals();
  return result.events[0];
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

describe('EmscService — a field EMSC always publishes is never invented (issue #61)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const malformed = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    message: 'EMSC returned a response in an unexpected format.',
    data: { reason: 'malformed_response' },
  };

  /** An EMSC feature with the named keys removed — top-level `id` included. */
  function without(unid: string, ...keys: string[]) {
    const feature = makeFeature(unid, 3.1) as unknown as Record<string, unknown>;
    const props = feature.properties as Record<string, unknown>;
    for (const key of keys) {
      delete props[key];
      if (key === 'id') delete feature.id;
    }
    return feature;
  }

  it('fails a search page of records with no ID, origin time, or update time', async () => {
    // The shape that produced two records sharing `emsc-unknown-<now>` at the epoch.
    const sparse = ['unid', 'id', 'time', 'lastupdate'];
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        type: 'FeatureCollection',
        features: [without('20260601_0000001', ...sparse), without('20260601_0000002', ...sparse)],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeService().searchEvents({ limit: 15 }, createMockContext()),
    ).rejects.toMatchObject(malformed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no identifier', ['unid', 'id']],
    ['no origin time', ['time']],
    ['no update time', ['lastupdate']],
  ])('fails a search record with %s', async (_label, keys) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          type: 'FeatureCollection',
          features: [without('20260601_0000001', ...keys)],
        }),
      ),
    );
    await expect(
      makeService().searchEvents({ limit: 15 }, createMockContext()),
    ).rejects.toMatchObject(malformed);
  });

  it('still reads the ID from the feature id when properties.unid is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          type: 'FeatureCollection',
          features: [without('20260601_0000001', 'unid')],
        }),
      ),
    );
    const { events } = await makeService().searchEvents({ limit: 15 }, createMockContext());
    expect(events[0]?.id).toBe('20260601_0000001');
  });

  it.each([
    ['no identifier', ['unid', 'id']],
    ['no origin time', ['time']],
  ])('fails an event lookup whose Feature has %s in one request', async (_label, keys) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(without('20190706_0000043', ...keys)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeService().getEvent('20190706_0000043', createMockContext()),
    ).rejects.toMatchObject(malformed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('EmscService — a record that is not a readable feature fails as malformed (issue #60)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const malformed = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    message: 'EMSC returned a response in an unexpected format.',
    data: { reason: 'malformed_response' },
  };

  /** makeFeature as raw JSON, so any member can take a value its type rules out. */
  const raw = (unid: string) =>
    JSON.parse(JSON.stringify(makeFeature(unid, 3.1))) as Record<string, unknown>;
  const withGeometry = (geometry: unknown) => ({ ...raw('20260601_0000001'), geometry });
  const withCoordinates = (coordinates: unknown) => withGeometry({ type: 'Point', coordinates });
  const { geometry: _geometry, ...noGeometry } = raw('20260601_0000001');

  /** Run a lookup to completion under fake timers, so a retried failure shows its attempts. */
  async function settle(pending: Promise<unknown>) {
    const settled = pending.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return settled;
  }

  it.each([
    ['a null entry', null],
    ['null properties', { ...raw('20260601_0000001'), properties: null }],
    ['no geometry', noGeometry],
    ['a null geometry', withGeometry(null)],
    ['a non-point geometry', withGeometry({ type: 'MultiPoint', coordinates: [[28.2, 38.4, 10]] })],
    ['no coordinates', withGeometry({ type: 'Point' })],
    ['a string longitude', withCoordinates(['28.2', 38.4, 10])],
    ['a null latitude', withCoordinates([28.2, null, 10])],
    ['no depth', withCoordinates([28.2, 38.4])],
    ['a string depth', withCoordinates([28.2, 38.4, '10'])],
  ])('fails a search page holding %s in one request', async (_label, entry) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          type: 'FeatureCollection',
          features: [makeFeature('20260601_0000000', 4.2), entry],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await settle(makeService().searchEvents({ limit: 15 }, createMockContext())),
    ).toMatchObject(malformed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null properties', { ...raw('20190706_0000043'), properties: null }],
    ['a null geometry', { ...raw('20190706_0000043'), geometry: null }],
  ])('fails an event lookup whose Feature has %s in one request', async (_label, feature) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(Response.json(feature)));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await settle(makeService().getEvent('20190706_0000043', createMockContext())),
    ).toMatchObject(malformed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** A record carrying its position in properties too, as live EMSC records do. */
  const positioned = (unid: string, geometry: unknown) => {
    const feature = raw(unid);
    return {
      ...feature,
      properties: { ...(feature.properties as object), lat: 38.41, lon: 28.21, depth: 9 },
      geometry,
    };
  };
  const { geometry: _unused, ...positionedNoGeometry } = positioned('20260601_0000001', null);

  it.each([
    ['no geometry', positionedNoGeometry],
    ['a null geometry', positioned('20260601_0000001', null)],
    [
      'a non-point geometry',
      positioned('20260601_0000001', { type: 'MultiPoint', coordinates: [[28.2, 38.4, 10]] }),
    ],
    [
      'a string longitude',
      positioned('20260601_0000001', { type: 'Point', coordinates: ['28.2', 38.4, -10] }),
    ],
    ['no depth', positioned('20260601_0000001', { type: 'Point', coordinates: [28.2, 38.4] })],
  ])('reads the position from properties beside %s', async (_label, entry) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ type: 'FeatureCollection', features: [entry] }))),
    );
    const { events } = await makeService().searchEvents({ limit: 15 }, createMockContext());
    expect(events[0]).toMatchObject({ latitude: 38.41, longitude: 28.21, depth_km: 9 });
  });

  it('takes a coordinate properties lack from the point geometry', async () => {
    const feature = raw('20260601_0000001');
    const entry = {
      ...feature,
      properties: { ...(feature.properties as object), lat: 38.41 },
      geometry: { type: 'Point', coordinates: [28.2, 38.4, -10] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ type: 'FeatureCollection', features: [entry] }))),
    );
    const { events } = await makeService().searchEvents({ limit: 15 }, createMockContext());
    expect(events[0]).toMatchObject({ latitude: 38.41, longitude: 28.2, depth_km: -10 });
  });

  it('returns an event lookup whose Feature has a null geometry and its position in properties', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(positioned('20190706_0000043', null)))),
    );
    const { event } = await makeService().getEvent('20190706_0000043', createMockContext());
    expect(event).toMatchObject({ id: '20190706_0000043', latitude: 38.41, longitude: 28.21 });
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
    expect(countSpy).toHaveBeenCalledWith(
      { minMagnitude: 4 },
      expect.anything(),
      expect.any(Number),
    );
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

    expect(result.totalCount).toBe(1);
    expect(countSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reports countUnavailable when the count sub-call fails (issue #36)', async () => {
    const features = [makeFeature('20260601_0001', 4.2)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(features)));

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockRejectedValue(new Error('count endpoint down'));

    const result = await service.searchEvents({ limit: 1 }, createMockContext() as Context);

    // The search page itself still lands — only the total is lost.
    expect(result.count).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.totalCount).toBeUndefined();
    expect(result.countUnavailable).toBe(true);
    vi.unstubAllGlobals();
  });

  it('leaves countUnavailable off when the count sub-call succeeds (issue #36)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4.2)])),
    );

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockResolvedValue({
      count: 184,
      maxAllowed: null,
      exceedsLimit: false,
    });

    const result = await service.searchEvents({ limit: 1 }, createMockContext() as Context);

    expect(result.totalCount).toBe(184);
    expect(result).not.toHaveProperty('countUnavailable');
    vi.unstubAllGlobals();
  });

  it('leaves countUnavailable off when the count was never attempted (issue #36)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4.2)])),
    );

    const service = makeService();
    const countSpy = vi.spyOn(service, 'countEvents');

    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(countSpy).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('countUnavailable');
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

    expect(countSpy).toHaveBeenCalledWith(
      { minMagnitude: 4 },
      expect.anything(),
      expect.any(Number),
    );
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const service = makeService();
    const result = await service.searchEvents(
      { limit: 3, offset: 9_999_999 },
      createMockContext() as Context,
    );

    expect(result.count).toBe(0);
    vi.unstubAllGlobals();
  });

  it('fails an empty count body as malformed_response in one request (issue #60)', async () => {
    // Only search reads an empty body as zero matches; EMSC answers a zero count as {"count":0}.
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await makeService()
      .countEvents({}, createMockContext())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'EMSC returned a response in an unexpected format.',
      data: { reason: 'malformed_response' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('EmscService — event type normalization (issues #24, #35)', () => {
  it('carries a classification through at all — evtype is the only place EMSC publishes it', async () => {
    // EMSC builds its title from magnitude and region alone, so evtype is unrecoverable
    // once dropped.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse([makeFeature('20260726_0000042', 3.1, { evtype: 'ue' })])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.event_type).toBe('earthquake');
    expect(result.events[0]?.event_certainty).toBe('unknown');
    expect(result.events[0]?.title).not.toContain('ue');
    vi.unstubAllGlobals();
  });

  it('decodes the dominant "ke" code to the vocabulary USGS publishes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse([makeFeature('20260726_0000043', 5.2, { evtype: 'ke' })])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]?.event_type).toBe('earthquake');
    vi.unstubAllGlobals();
  });

  it('omits event_type when the payload publishes no evtype', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260726_0000044', 2.0)])),
    );

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]).not.toHaveProperty('event_type');
    vi.unstubAllGlobals();
  });

  it('never sends eventtype upstream — EMSC answers an unknown parameter with HTTP 400', async () => {
    // A Response body is single-use, so each call gets its own instance.
    const fetchMock = vi.fn(
      (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        Promise.resolve(
          new Response(JSON.stringify({ type: 'FeatureCollection', features: [], count: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, eventType: 'earthquake' },
      createMockContext() as Context,
    );
    await service.countEvents({ eventType: 'earthquake' }, createMockContext() as Context);

    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('eventtype');
      expect(String(call[0])).not.toContain('evtype');
    }
    vi.unstubAllGlobals();
  });
});

describe('EmscService — bounding-box forwarding (issue #37)', () => {
  it('forwards all four box parameters in degrees under the same FDSN names as USGS', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, minLatitude: 35, maxLatitude: 42, minLongitude: 25, maxLongitude: 45 },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('minlatitude')).toBe('35');
    expect(url.searchParams.get('maxlatitude')).toBe('42');
    expect(url.searchParams.get('minlongitude')).toBe('25');
    expect(url.searchParams.get('maxlongitude')).toBe('45');
    // radius_km converts to degrees for EMSC; the box does not.
    expect(url.searchParams.has('maxradius')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('forwards a literal 0 edge and an extended-range antimeridian box', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.countEvents(
      { minLatitude: 0, minLongitude: 170, maxLongitude: 190 },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('minlatitude')).toBe('0');
    expect(url.searchParams.get('minlongitude')).toBe('170');
    expect(url.searchParams.get('maxlongitude')).toBe('190');
    vi.unstubAllGlobals();
  });

  it('still sends no alert-level parameter of either spelling (issue #31)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, alertLevel: 'green', minLatitude: 35 },
      createMockContext() as Context,
    );

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('minalertlevel');
    expect(/[?&]alertlevel=/.test(url)).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('EmscService — no date filter is dropped by a truthy check (issue #29)', () => {
  it.each([
    ['startTime', 'starttime'],
    ['endTime', 'endtime'],
  ])('sends an empty %s rather than silently dropping it', async (field, param) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5, [field]: '' }, createMockContext() as Context);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.has(param)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('EmscService — ISF evtype decoding (issue #35)', () => {
  /** The normalized classification of one EMSC feature carrying `evtype`. */
  async function classificationFor(
    evtype: string | undefined,
  ): Promise<{ event_type?: string; event_certainty?: string }> {
    const event = await eventWithEvtype(evtype);
    return {
      ...(event?.event_type == null ? {} : { event_type: event.event_type }),
      ...(event?.event_certainty == null ? {} : { event_certainty: event.event_certainty }),
    };
  }

  it.each([
    // The type axis is the vocabulary USGS also publishes — the certainty axis
    // never bleeds into it, so every certainty of the same type reads alike.
    ['ke', 'earthquake', 'known'],
    ['se', 'earthquake', 'suspected'],
    ['ue', 'earthquake', 'unknown'],
    ['ne', 'earthquake', 'unreported'],
    // The distinction that matters most: a suspected explosion is not a known one,
    // and the two are told apart by the certainty field, not by the type.
    ['kx', 'explosion', 'known'],
    ['sx', 'explosion', 'suspected'],
    ['kn', 'nuclear explosion', 'known'],
    ['sn', 'nuclear explosion', 'suspected'],
    // The rest of the type axis, across certainties.
    ['kh', 'chemical explosion', 'known'],
    ['uh', 'chemical explosion', 'unknown'],
    ['km', 'mining explosion', 'known'],
    ['sm', 'mining explosion', 'suspected'],
    ['si', 'induced or triggered event', 'suspected'],
    ['ui', 'induced or triggered event', 'unknown'],
    ['kz', 'ice quake', 'known'],
    ['kl', 'landslide', 'known'],
    ['kv', 'volcanic eruption', 'known'],
    // The nomenclature's null type — no type was reported, which the certainty
    // axis still qualifies.
    ['uu', 'not reported', 'unknown'],
    ['nu', 'not reported', 'unreported'],
  ])('decodes %s to type "%s" with certainty "%s"', async (code, type, certainty) => {
    await expect(classificationFor(code)).resolves.toEqual({
      event_type: type,
      event_certainty: certainty,
    });
  });

  it.each([
    // "fe" is live on EMSC (2 events in a 60-day sample) and its leading "f" is
    // not one of the nomenclature's certainty characters — guessing at it would
    // misclassify a seismic event.
    'fe',
    // Unknown type character, documented certainty.
    'k7',
    // Not a two-character code at all.
    'earthquake',
    'k',
  ])('forwards the unmapped code %s verbatim, with no certainty claim', async (code) => {
    // No event_certainty key at all — an undecodable code asserts nothing.
    await expect(classificationFor(code)).resolves.toEqual({ event_type: code });
  });

  it('omits both fields when EMSC published no evtype', async () => {
    await expect(classificationFor(undefined)).resolves.toEqual({});
    await expect(classificationFor('')).resolves.toEqual({});
  });
});

describe('EMSC and USGS agree on one event_type vocabulary (issue #35)', () => {
  /** Minimal USGS feature carrying just the classification under test. */
  function usgsFeatureWithType(type: string): UsgsFeature {
    return {
      type: 'Feature',
      id: 'us6000abcd',
      geometry: { type: 'Point', coordinates: [28.2, 38.4, 10] },
      properties: {
        mag: 4.6,
        magType: 'mb',
        place: 'WESTERN TURKEY',
        time: 1_780_000_000_000,
        updated: 1_780_000_600_000,
        status: 'reviewed',
        tsunami: 0,
        title: 'M 4.6 - WESTERN TURKEY',
        type,
      },
    };
  }

  function usgsResponse(features: UsgsFeature[]): Response {
    return new Response(
      JSON.stringify({
        type: 'FeatureCollection',
        features,
        metadata: {
          generated: 1_780_000_000_000,
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

  it.each([
    ['ke', 'earthquake'],
    // Parity holds regardless of how sure EMSC was — certainty is its own field.
    ['se', 'earthquake'],
    ['ue', 'earthquake'],
    ['km', 'mining explosion'],
    ['sz', 'ice quake'],
  ])(
    'reports the same event_type for the same event whether EMSC (%s) or USGS served it',
    async (emscCode, usgsType) => {
      const emscEvent = await eventWithEvtype(emscCode);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(usgsResponse([usgsFeatureWithType(usgsType)])),
      );
      const usgs = await new UsgsService(
        {} as AppConfig,
        {} as StorageService,
        'https://earthquake.usgs.gov',
        5000,
      ).searchEvents({ limit: 10 }, createMockContext() as Context);
      vi.unstubAllGlobals();

      expect(emscEvent?.event_type).toBe(usgs.events[0]?.event_type);
      expect(usgs.events[0]?.event_type).toBe(usgsType);
      // USGS publishes no certainty axis, so only the EMSC side carries one.
      expect(usgs.events[0]?.event_certainty).toBeUndefined();
      expect(emscEvent?.event_certainty).toBeDefined();
    },
  );
});

describe('EMSC event_type reaches content[] the same way it reaches structuredContent (issue #35)', () => {
  async function renderedEventFor(evtype: string): Promise<string> {
    const event = EarthquakeEventSchema.parse(await eventWithEvtype(evtype));
    return formatEvent(event).join('\n');
  }

  it('leaves an ordinary EMSC earthquake out of the rendered text, as USGS already is', async () => {
    await expect(renderedEventFor('ke')).resolves.not.toContain('**Event type:**');
  });

  it('renders a suspected EMSC earthquake, in the normalized vocabulary and not as a raw code', async () => {
    const text = await renderedEventFor('se');
    expect(text).toContain('**Event type:** earthquake (certainty: suspected)');
    expect(text).not.toContain('**Event type:** se');
  });

  it('renders the certainty of an unusual event type, so suspected never reads as confirmed', async () => {
    await expect(renderedEventFor('sx')).resolves.toContain(
      '**Event type:** explosion (certainty: suspected)',
    );
    await expect(renderedEventFor('kx')).resolves.toContain(
      '**Event type:** explosion (certainty: known)',
    );
  });

  it('renders an earthquake of unknown certainty rather than passing it off as ordinary', async () => {
    await expect(renderedEventFor('ue')).resolves.toContain(
      '**Event type:** earthquake (certainty: unknown)',
    );
  });

  it('still renders an unmapped code so it cannot vanish from the text surface', async () => {
    const text = await renderedEventFor('fe');
    expect(text).toContain('**Event type:** fe');
    // Nothing to claim about certainty, so nothing is claimed.
    expect(text).not.toContain('certainty:');
  });
});

describe('isEmscEventId — routes on the EMSC unid shape (issue #53)', () => {
  it.each(['20190706_0000043', '19980101_0000021', '20261028_0000191'])('accepts %s', (id) => {
    expect(isEmscEventId(id)).toBe(true);
  });

  it.each([
    '20190706_000043', // six-digit sequence
    '20190706_00000430',
    '2019070600000043',
    '20190706_43',
    ' 20190706_0000043',
    'us70004bn0',
    'ci38457511',
    'official20110311054624120_30',
    '775626', // EMSC source_id, not a unid
  ])('leaves %j to USGS', (id) => {
    expect(isEmscEventId(id)).toBe(false);
  });
});

describe('EmscService.getEvent — lookup by EMSC unid (issue #53)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads the bare Feature SeismicPortal returns into the event a search returns', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(emscFixture('20190706_0000043.json')))
      .mockResolvedValueOnce(new Response(emscFixture('20190706_0000043.search.json')));
    vi.stubGlobal('fetch', fetchMock);

    const { event } = await makeService().getEvent('20190706_0000043', createMockContext());
    const search = await makeService().searchEvents({ limit: 10 }, createMockContext());

    expect(event).toStrictEqual(search.events[0]);
    expect(event).toStrictEqual({
      id: '20190706_0000043',
      title: 'M 7.1 - SOUTHERN CALIFORNIA',
      magnitude: 7.1,
      magnitude_type: 'mw',
      time: '2019-07-06T03:19:57.8Z',
      updated: '2019-07-06T03:39:00.0Z',
      place: 'SOUTHERN CALIFORNIA',
      latitude: 35.79,
      longitude: -117.58,
      // properties.depth (10), not the negated geometry coordinate (-10).
      depth_km: 10,
      felt: null,
      cdi: null,
      mmi: null,
      alert: null,
      significance: null,
      status: null,
      tsunami: null,
      source_catalog: 'EMSC-RTS',
      auth: 'EMSC',
      event_type: 'earthquake',
      event_certainty: 'known',
    });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.seismicportal.eu/fdsnws/event/1/query',
    );
    // nodata=404 is never sent: its 404 body names an internal host.
    expect([...url.searchParams]).toEqual([
      ['eventid', '20190706_0000043'],
      ['format', 'json'],
    ]);
  });

  it('resolves a 1998 EMSC-EMB unid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(emscFixture('19980101_0000021.json'))),
    );
    const { event } = await makeService().getEvent('19980101_0000021', createMockContext());
    expect(event).toMatchObject({
      id: '19980101_0000021',
      magnitude: 2.9,
      magnitude_type: 'MD',
      time: '1998-01-01T01:02:13.2Z',
      place: 'WESTERN TURKEY',
      source_catalog: 'EMSC-EMB',
    });
  });

  it('leaves unpublished provenance absent on a sparse Feature', async () => {
    const feature = JSON.parse(emscFixture('20190706_0000043.json')) as EmscFeature;
    for (const key of [
      'evtype',
      'auth',
      'source_catalog',
      'flynn_region',
      'mag',
      'magtype',
    ] as const)
      delete feature.properties[key];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(feature)));
    const { event } = await makeService().getEvent('20190706_0000043', createMockContext());
    expect(event).toMatchObject({
      id: '20190706_0000043',
      title: 'M ? - Unknown location',
      magnitude: null,
      magnitude_type: 'unknown',
      place: 'Unknown location',
    });
    for (const key of ['source_catalog', 'auth', 'event_type', 'event_certainty', 'associated_ids'])
      expect(event).not.toHaveProperty(key);
  });

  it.each([200, 204])('maps an empty %s body to NotFound in one request', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      makeService().getEvent('20190706_9999999', createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a FeatureCollection', () => emscFixture('20190706_0000043.search.json'), '20190706_0000043'],
    ['a different event', () => emscFixture('19980101_0000021.json'), '20190706_0000043'],
  ])('rejects %s as NotFound', async (_label, body, unid) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body())));
    await expect(makeService().getEvent(unid, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('reports an HTML body as ServiceUnavailable after retrying', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('<!DOCTYPE html><p>busy</p>')));
    vi.stubGlobal('fetch', fetchMock);
    const pending = makeService()
      .getEvent('20190706_0000043', createMockContext())
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('bounds a lookup that keeps timing out by one 50 s deadline across retries', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener('abort', fail, { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new EmscService(
      {} as AppConfig,
      {} as StorageService,
      'https://www.seismicportal.eu',
      45_000,
    );
    const pending = service
      .getEvent('20190706_0000043', createMockContext())
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    // A per-attempt 45 s timeout retried would run to 90 s and more.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThanOrEqual(50_000);
  });
});
