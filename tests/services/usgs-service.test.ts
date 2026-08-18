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

  it('reports countUnavailable when the count sub-call fails (issue #36)', async () => {
    const features = Array.from({ length: 2 }, (_, i) => makeFeature(`us${i}`, 5));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse(features)));

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockRejectedValue(new Error('count endpoint down'));

    const result = await service.searchEvents({ limit: 2 }, createMockContext() as Context);

    // The search page itself still lands — only the total is lost.
    expect(result.count).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.totalCount).toBeUndefined();
    expect(result.countUnavailable).toBe(true);
    vi.unstubAllGlobals();
  });

  it('leaves countUnavailable off when the count sub-call succeeds (issue #36)', async () => {
    const features = Array.from({ length: 2 }, (_, i) => makeFeature(`us${i}`, 5));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse(features)));

    const service = makeService();
    vi.spyOn(service, 'countEvents').mockResolvedValue({
      count: 91,
      maxAllowed: 20000,
      exceedsLimit: false,
    });

    const result = await service.searchEvents({ limit: 2 }, createMockContext() as Context);

    expect(result.totalCount).toBe(91);
    expect(result).not.toHaveProperty('countUnavailable');
    vi.unstubAllGlobals();
  });

  it('leaves countUnavailable off when the count was never attempted (issue #36)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)])));

    const service = makeService();
    const countSpy = vi.spyOn(service, 'countEvents');

    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(countSpy).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('countUnavailable');
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

describe('UsgsService — event type normalization and filter (issue #24)', () => {
  it.each(['quarry blast', 'explosion', 'ice quake'])(
    'carries the upstream %s classification through normalization',
    async (type) => {
      const feature = makeFeature('ci40000000', 1.5);
      feature.properties.type = type;
      feature.properties.title = `M 1.5 ${type} - 6 km S of Mojave, CA`;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

      const service = makeService();
      const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

      expect(result.events[0]?.event_type).toBe(type);
      vi.unstubAllGlobals();
    },
  );

  it('omits event_type when the payload carries no type', async () => {
    const feature = makeFeature('us1', 4.5);
    delete feature.properties.type;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]).not.toHaveProperty('event_type');
    vi.unstubAllGlobals();
  });

  it('forwards eventType as the FDSN eventtype parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, eventType: 'quarry blast' },
      createMockContext() as Context,
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('eventtype=quarry+blast');
    vi.unstubAllGlobals();
  });

  it('omits eventtype from the querystring when no filter was supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5 }, createMockContext() as Context);

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('eventtype=');
    vi.unstubAllGlobals();
  });
});

/**
 * Shapes below mirror the live single-event response for the M7.5 Noto Peninsula
 * event (us6000m0xl): every product property is a string, and content files are
 * keyed by filename with the URL nested under `url`.
 */
function productRichFeature(): UsgsFeature {
  const feature = makeFeature('us6000m0xl', 7.5);
  feature.properties.products = {
    losspager: [
      {
        properties: { alertlevel: 'red', maxmmi: '9' },
        contents: {
          'json/losses.json': { url: 'https://earthquake.usgs.gov/…/json/losses.json' },
          'onepager.pdf': { url: 'https://earthquake.usgs.gov/…/onepager.pdf' },
        },
      },
    ],
    shakemap: [
      {
        properties: { maxmmi: '8.793', maxpga: '1.669', maxpgv: '120.336' },
        contents: {
          'download/intensity.jpg': { url: 'https://earthquake.usgs.gov/…/intensity.jpg' },
          'download/intensity_overlay.png': { url: 'https://earthquake.usgs.gov/…/overlay.png' },
        },
      },
    ],
    dyfi: [
      {
        properties: { 'num-responses': '420', numResp: '420', maxmmi: '8.9' },
        contents: {
          'us6000m0xl_ciim.jpg': { url: 'https://earthquake.usgs.gov/…/us6000m0xl_ciim.jpg' },
          'us6000m0xl_ciim_geo.jpg': { url: 'https://earthquake.usgs.gov/…/ciim_geo.jpg' },
        },
      },
    ],
    'moment-tensor': [
      {
        properties: {
          'scalar-moment': '2.27E+20',
          'derived-depth': '15.5',
          'nodal-plane-1-strike': '49.23',
          'nodal-plane-1-dip': '41.32',
          'nodal-plane-1-rake': '102.5',
          'nodal-plane-2-strike': '212.78',
          'nodal-plane-2-dip': '49.86',
          'nodal-plane-2-rake': '79.22',
        },
      },
    ],
    'ground-failure': [
      { properties: { 'landslide-alert': 'orange', 'liquefaction-alert': 'red' } },
    ],
    origin: [
      {
        properties: {
          'azimuthal-gap': '36',
          'num-stations-used': '282',
          'horizontal-error': '4.03',
          'vertical-error': '1.807',
          'review-status': 'reviewed',
        },
      },
    ],
    'finite-fault': [
      {
        properties: { 'model-length': '175.0000', 'model-width': '45.0000' },
        contents: { 'FFM.geojson': { url: 'https://earthquake.usgs.gov/…/FFM.geojson' } },
      },
    ],
    'phase-data': [{ properties: { 'azimuthal-gap': '36' } }],
  };
  return feature;
}

/** A bare automatic event: only origin and phase-data, every impact product absent. */
function bareFeature(): UsgsFeature {
  const feature = makeFeature('hv75008152', 2.1);
  feature.properties.status = 'automatic';
  feature.properties.products = {
    origin: [{ properties: { 'azimuthal-gap': '178', 'num-stations-used': '9' } }],
    'phase-data': [{ properties: { 'azimuthal-gap': '178' } }],
  };
  return feature;
}

describe('UsgsService.getEvent — product projection (issue #25)', () => {
  it('projects every product group from a product-rich event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([productRichFeature()])));

    const service = makeService();
    const { event, detail } = await service.getEvent('us6000m0xl', createMockContext() as Context);

    expect(event.id).toBe('us6000m0xl');
    expect(detail).toEqual({
      losspager: {
        alert_level: 'red',
        report_url: 'https://earthquake.usgs.gov/…/onepager.pdf',
      },
      shakemap: {
        max_mmi: 8.793,
        max_pga: 1.669,
        max_pgv: 120.336,
        intensity_map_url: 'https://earthquake.usgs.gov/…/intensity.jpg',
      },
      dyfi: {
        responses: 420,
        max_cdi: 8.9,
        map_url: 'https://earthquake.usgs.gov/…/us6000m0xl_ciim.jpg',
      },
      moment_tensor: {
        scalar_moment_nm: 2.27e20,
        derived_depth_km: 15.5,
        nodal_plane_1: { strike: 49.23, dip: 41.32, rake: 102.5 },
        nodal_plane_2: { strike: 212.78, dip: 49.86, rake: 79.22 },
      },
      ground_failure: { landslide_alert: 'orange', liquefaction_alert: 'red' },
      origin: {
        azimuthal_gap_deg: 36,
        num_stations_used: 282,
        horizontal_error_km: 4.03,
        depth_error_km: 1.807,
        review_status: 'reviewed',
      },
      finite_fault: {
        rupture_length_km: 175,
        rupture_width_km: 45,
        model_url: 'https://earthquake.usgs.gov/…/FFM.geojson',
      },
    });
    vi.unstubAllGlobals();
  });

  it('omits absent product groups on a bare automatic event rather than nulling them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([bareFeature()])));

    const service = makeService();
    const { detail } = await service.getEvent('hv75008152', createMockContext() as Context);

    expect(detail).toEqual({ origin: { azimuthal_gap_deg: 178, num_stations_used: 9 } });
    for (const group of [
      'losspager',
      'shakemap',
      'dyfi',
      'moment_tensor',
      'ground_failure',
      'finite_fault',
    ]) {
      expect(detail).not.toHaveProperty(group);
    }
    vi.unstubAllGlobals();
  });

  it('leaves detail absent entirely when the event carries no products', async () => {
    const feature = makeFeature('nc12345678', 1.1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const result = await service.getEvent('nc12345678', createMockContext() as Context);

    expect(result).not.toHaveProperty('detail');
    expect(result.event.id).toBe('nc12345678');
    vi.unstubAllGlobals();
  });

  it('drops a nodal plane missing one of its three angles', async () => {
    const feature = makeFeature('us1', 6.2);
    feature.properties.products = {
      'moment-tensor': [
        {
          properties: {
            'scalar-moment': '1.5E+18',
            'nodal-plane-1-strike': '49.23',
            'nodal-plane-1-dip': '41.32',
          },
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const { detail } = await service.getEvent('us1', createMockContext() as Context);

    expect(detail?.moment_tensor).toEqual({ scalar_moment_nm: 1.5e18 });
    vi.unstubAllGlobals();
  });

  it('skips an unparseable numeric property instead of emitting NaN', async () => {
    const feature = makeFeature('us1', 6.2);
    feature.properties.products = {
      shakemap: [{ properties: { maxmmi: 'n/a', maxpga: '1.5' } }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([feature])));

    const service = makeService();
    const { detail } = await service.getEvent('us1', createMockContext() as Context);

    expect(detail?.shakemap).toEqual({ max_pga: 1.5 });
    vi.unstubAllGlobals();
  });

  it('leaves list normalization untouched — products never reach a search result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geojsonResponse([productRichFeature()])));

    const service = makeService();
    const result = await service.searchEvents({ limit: 10 }, createMockContext() as Context);

    expect(result.events[0]).not.toHaveProperty('detail');
    expect(result.events[0]).not.toHaveProperty('products');
    vi.unstubAllGlobals();
  });
});

describe('UsgsService — PAGER alert level is a minimum, not an exact match (issue #31)', () => {
  /**
   * `'minalertlevel=green'` contains `'alertlevel=green'` as a literal substring, so a
   * `not.toContain('alertlevel=green')` assertion passes even with the bug present. Every
   * check below anchors on a parameter boundary instead.
   */
  const bareAlertLevelParam = /[?&]alertlevel=/;

  it.each(['green', 'yellow', 'orange', 'red'])(
    'sends %s as minalertlevel on a search, never the exact-match alertlevel',
    async (level) => {
      const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
      vi.stubGlobal('fetch', fetchMock);

      const service = makeService();
      await service.searchEvents({ limit: 5, alertLevel: level }, createMockContext() as Context);

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain(`minalertlevel=${level}`);
      expect(bareAlertLevelParam.test(url)).toBe(false);
      vi.unstubAllGlobals();
    },
  );

  it('sends minalertlevel on a count too — both tools share the builder', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ count: 934, maxAllowed: 20000 }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.countEvents({ alertLevel: 'green' }, createMockContext() as Context);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('minalertlevel=green');
    expect(bareAlertLevelParam.test(url)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('omits both alert parameters when no alert_level filter was supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5 }, createMockContext() as Context);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('minalertlevel=');
    expect(bareAlertLevelParam.test(url)).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('UsgsService — bounding-box forwarding (issue #37)', () => {
  it('forwards all four box parameters under their verbatim FDSN names, unconverted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, minLatitude: 32.5, maxLatitude: 42, minLongitude: -125, maxLongitude: -114 },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('minlatitude')).toBe('32.5');
    expect(url.searchParams.get('maxlatitude')).toBe('42');
    expect(url.searchParams.get('minlongitude')).toBe('-125');
    expect(url.searchParams.get('maxlongitude')).toBe('-114');
    vi.unstubAllGlobals();
  });

  it('forwards a literal 0 edge — the equator and prime meridian are real constraints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, minLatitude: 0, minLongitude: 0, maxLongitude: 0 },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('minlatitude')).toBe('0');
    expect(url.searchParams.get('minlongitude')).toBe('0');
    expect(url.searchParams.get('maxlongitude')).toBe('0');
    expect(url.searchParams.has('maxlatitude')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('forwards an extended-range antimeridian box verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      { limit: 5, minLongitude: 170, maxLongitude: 190 },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('minlongitude')).toBe('170');
    expect(url.searchParams.get('maxlongitude')).toBe('190');
    vi.unstubAllGlobals();
  });

  it('sends the box alongside the circle group rather than replacing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents(
      {
        limit: 5,
        latitude: 35,
        longitude: -120,
        radiusKm: 500,
        minLatitude: 30,
        maxLatitude: 40,
      },
      createMockContext() as Context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('maxradiuskm')).toBe('500');
    expect(url.searchParams.get('minlatitude')).toBe('30');
    expect(url.searchParams.get('maxlatitude')).toBe('40');
    vi.unstubAllGlobals();
  });

  it('omits every box parameter when none was supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5 }, createMockContext() as Context);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    for (const name of ['minlatitude', 'maxlatitude', 'minlongitude', 'maxlongitude']) {
      expect(url.searchParams.has(name)).toBe(false);
    }
    vi.unstubAllGlobals();
  });
});

describe('UsgsService — no filter is dropped by a truthy check (issues #29, #32)', () => {
  it.each([
    ['startTime', 'starttime'],
    ['endTime', 'endtime'],
    ['eventType', 'eventtype'],
  ])('sends an empty %s rather than silently dropping it', async (field, param) => {
    const fetchMock = vi.fn().mockResolvedValue(geojsonResponse([makeFeature('us1', 5)]));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    await service.searchEvents({ limit: 5, [field]: '' }, createMockContext() as Context);

    // Empty is byte-identical to absent upstream, but it must be *present* in the
    // querystring so a queryEcho built from the same params can never over-report.
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.has(param)).toBe(true);
    expect(url.searchParams.get(param)).toBe('');
    vi.unstubAllGlobals();
  });
});
