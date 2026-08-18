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
import { EarthquakeEventSchema, formatEvent } from '@/mcp-server/tools/schemas.js';
import { EmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeEvent, EmscFeature, UsgsFeature } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';

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
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([makeFeature('20260601_0001', 4)]));
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
