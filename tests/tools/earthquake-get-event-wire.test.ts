/**
 * @fileoverview Wire-level tests for earthquake_get_event over the real service path:
 * a fetch stub serves single-event captures trimmed from live USGS responses, and
 * `runToolContract` assembles the reply both client surfaces receive.
 * @module tests/tools/earthquake-get-event-wire.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeEventResource } from '@/mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeSearchEvents } from '@/mcp-server/tools/definitions/earthquake-search-events.tool.js';
import { initEmscService } from '@/services/emsc/emsc-service.js';
import { initUsgsService } from '@/services/usgs/usgs-service.js';
import { emscFixture, hang, stubUsgsEvent } from '../helpers/usgs-fetch-stub.js';

/** Serves only the event's detail capture; a product request would be unexpected. */
const stubDetail = (eventId: string) => stubUsgsEvent(eventId).fetchMock;

beforeEach(() => {
  initUsgsService({} as AppConfig, {} as StorageService, 'https://earthquake.usgs.gov', 5000);
  initEmscService({} as AppConfig, {} as StorageService, 'https://www.seismicportal.eu', 5000);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Stub `fetch` with one responder, recording every requested URL. */
function stubFetch(responder: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      return await responder(url, init);
    }),
  );
  return urls;
}

/** SeismicPortal answering the Ridgecrest unid by ID and the search that finds it. */
function seismicPortal(url: URL): Response {
  if (url.hostname !== 'www.seismicportal.eu') throw new Error(`unexpected fetch ${url.href}`);
  return new Response(
    emscFixture(
      url.searchParams.get('eventid') === '20190706_0000043'
        ? '20190706_0000043.json'
        : '20190706_0000043.search.json',
    ),
  );
}

const recovery = (reason: string) =>
  earthquakeGetEvent.errors?.find((entry) => entry.reason === reason)?.recovery;

describe('earthquake_get_event — default response (characterization)', () => {
  it('returns event + detail for a product-poor event in one request', async () => {
    const fetchMock = stubDetail('us6000m0yg');
    const result = await runToolContract(earthquakeGetEvent, { event_id: 'us6000m0yg' });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Snapshots sort keys; the wire order is pinned separately.
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['event', 'detail']);
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "detail": {
          "origin": {
            "azimuthal_gap_deg": 90,
            "depth_error_km": 1.835,
            "depth_type": "operator assigned",
            "horizontal_error_km": 5.23,
            "num_stations_used": 65,
            "review_status": "reviewed",
          },
        },
        "event": {
          "alert": null,
          "auth": "us",
          "cdi": null,
          "depth_km": 10,
          "event_type": "earthquake",
          "event_url": "https://earthquake.usgs.gov/earthquakes/eventpage/us6000m0yg",
          "felt": null,
          "id": "us6000m0yg",
          "latitude": 37.8107,
          "longitude": 137.5664,
          "magnitude": 5.1,
          "magnitude_type": "mb",
          "mmi": null,
          "place": "73 km WSW of Sado, Japan",
          "significance": 400,
          "status": "reviewed",
          "time": "2024-01-01T09:45:26.217Z",
          "title": "M 5.1 - 73 km WSW of Sado, Japan",
          "tsunami": 0,
          "updated": "2024-03-09T21:38:23.040Z",
        },
      }
    `);
    expect(result.content).toMatchInlineSnapshot(`
      [
        {
          "text": "## M 5.1 - 73 km WSW of Sado, Japan
      **ID:** us6000m0yg | **Magnitude:** 5.1 (mb) | **Depth:** 10 km
      **Place:** 73 km WSW of Sado, Japan
      **Time:** 2024-01-01T09:45:26.217Z | **Updated:** 2024-03-09T21:38:23.040Z
      **Location:** 37.8107°, 137.5664°
      **Provenance:** Status: reviewed | Agency: us
      **PAGER Alert:** Not computed
      **Tsunami flag:** 0
      **Impact:** Significance: 400 | Not reported: DYFI felt reports, ShakeMap MMI, CDI
      **USGS page:** https://earthquake.usgs.gov/earthquakes/eventpage/us6000m0yg

      ### Analysis products
      **Origin quality:** Azimuthal gap: 90° | Stations used: 65 | Horizontal error: 5.23 km | Depth error: 1.835 km | Depth type: operator assigned | Review status: reviewed",
          "type": "text",
        },
      ]
    `);
  });

  it('returns event + detail for a product-rich event in one request', async () => {
    const fetchMock = stubDetail('us6000u18k');
    const result = await runToolContract(earthquakeGetEvent, { event_id: 'us6000u18k' });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Snapshots sort keys; the wire order is pinned separately.
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['event', 'detail']);
    expect(result.structuredContent).toMatchInlineSnapshot(`
      {
        "detail": {
          "dyfi": {
            "map_url": "https://earthquake.usgs.gov/product/dyfi/us6000u18k/us/1793155236371/us6000u18k_ciim.jpg",
            "max_cdi": 7.9,
            "responses": 2005,
          },
          "finite_fault": {
            "model_url": "https://earthquake.usgs.gov/product/finite-fault/us6000u18k_1/us/1792710177789/FFM.geojson",
            "rupture_length_km": 55,
            "rupture_width_km": 33.6,
          },
          "ground_failure": {
            "landslide_alert": "orange",
            "liquefaction_alert": "orange",
          },
          "losspager": {
            "alert_level": "orange",
            "report_url": "https://earthquake.usgs.gov/product/losspager/us6000u18k/us/1792203289601/onepager.pdf",
          },
          "moment_tensor": {
            "derived_depth_km": 13.5,
            "nodal_plane_1": {
              "dip": 74.77,
              "rake": -155.3,
              "strike": 25.21,
            },
            "nodal_plane_2": {
              "dip": 66.22,
              "rake": -16.68,
              "strike": 288.32,
            },
            "scalar_moment_nm": 377000000000000000000,
          },
          "origin": {
            "azimuthal_gap_deg": 45,
            "depth_error_km": 3.947,
            "depth_type": "from location",
            "horizontal_error_km": 6.48,
            "num_stations_used": 108,
            "review_status": "reviewed",
          },
          "shakemap": {
            "code_version": "4.5.0",
            "intensity_map_url": "https://earthquake.usgs.gov/product/shakemap/us6000u18k/us/1792203153463/download/intensity.jpg",
            "max_mmi": 7.936,
            "max_pga": 1.043,
            "max_pgv": 72.998,
          },
        },
        "event": {
          "alert": "orange",
          "associated_ids": [
            "pt26282000",
            "usauto6000u18k",
          ],
          "auth": "us",
          "cdi": 7.9,
          "depth_km": 12.647,
          "event_type": "earthquake",
          "event_url": "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k",
          "felt": 2005,
          "id": "us6000u18k",
          "latitude": 7.5868,
          "longitude": -80.769,
          "magnitude": 7.7,
          "magnitude_type": "mww",
          "mmi": 7.936,
          "place": "12 km WSW of Pitaloza Arriba, Panama",
          "significance": 1790,
          "status": "reviewed",
          "time": "2026-10-09T17:56:06.036Z",
          "title": "M 7.7 - 12 km WSW of Pitaloza Arriba, Panama",
          "tsunami": 0,
          "updated": "2026-10-28T02:40:36.371Z",
        },
      }
    `);
    expect(result.content).toMatchInlineSnapshot(`
      [
        {
          "text": "## M 7.7 - 12 km WSW of Pitaloza Arriba, Panama
      **ID:** us6000u18k | **Magnitude:** 7.7 (mww) | **Depth:** 12.647 km
      **Associated IDs:** pt26282000, usauto6000u18k
      **Place:** 12 km WSW of Pitaloza Arriba, Panama
      **Time:** 2026-10-09T17:56:06.036Z | **Updated:** 2026-10-28T02:40:36.371Z
      **Location:** 7.5868°, -80.7690°
      **Provenance:** Status: reviewed | Agency: us
      **PAGER Alert:** ORANGE
      **Tsunami flag:** 0
      **Impact:** Felt by 2005 (DYFI) | ShakeMap MMI: 7.936 | CDI: 7.9 | Significance: 1790
      **USGS page:** https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k

      ### Analysis products
      **PAGER:** Alert level: orange | Report: https://earthquake.usgs.gov/product/losspager/us6000u18k/us/1792203289601/onepager.pdf
      **ShakeMap:** Max MMI: 7.936 | Max PGA: 1.043 g | Max PGV: 72.998 cm/s | Code version: 4.5.0 | Intensity map: https://earthquake.usgs.gov/product/shakemap/us6000u18k/us/1792203153463/download/intensity.jpg
      **DYFI:** Responses: 2005 | Max CDI: 7.9 | Map: https://earthquake.usgs.gov/product/dyfi/us6000u18k/us/1793155236371/us6000u18k_ciim.jpg
      **Moment tensor:** Scalar moment: 377000000000000000000 N·m | Derived depth: 13.5 km | Nodal plane 1: strike 25.21°, dip 74.77°, rake -155.3° | Nodal plane 2: strike 288.32°, dip 66.22°, rake -16.68°
      **Ground failure:** Landslide alert: orange | Liquefaction alert: orange
      **Origin quality:** Azimuthal gap: 45° | Stations used: 108 | Horizontal error: 6.48 km | Depth error: 3.947 km | Depth type: from location | Review status: reviewed
      **Finite fault:** Rupture length: 55 km | Rupture width: 33.6 km | Model: https://earthquake.usgs.gov/product/finite-fault/us6000u18k_1/us/1792710177789/FFM.geojson",
          "type": "text",
        },
      ]
    `);
  });
});

describe('earthquake_get_event — include on the wire', () => {
  it('answers include: [] byte-identically to an omitted include, in one request', async () => {
    const fetchMock = stubDetail('us6000u18k');
    const omitted = await runToolContract(earthquakeGetEvent, { event_id: 'us6000u18k' });
    const empty = await runToolContract(earthquakeGetEvent, {
      event_id: 'us6000u18k',
      include: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(empty)).toBe(JSON.stringify(omitted));
  });

  it('carries every requested group on both surfaces', async () => {
    const { urls } = stubUsgsEvent('ci38457511', {
      'phase-data': 'ci38457511.phase-data.xml',
      // The capture of another event's forecast stands in for this event's file.
      oaf: 'us6000u18k.forecast.json',
    });
    const result = await runToolContract(earthquakeGetEvent, {
      event_id: 'ci38457511',
      include: ['aftershock_forecast', 'arrivals', 'origins', 'magnitudes', 'origins'],
    });
    expect(result.isError).not.toBe(true);
    expect(urls).toHaveLength(3);
    const structured = result.structuredContent as Record<string, unknown> & {
      origins: { event_id: string }[];
      magnitudes: { type: string }[];
      arrivals: { station: string; channel: string }[];
      aftershock_forecast: { windows: { bins: unknown[] }[] };
    };
    expect(Object.keys(structured)).toEqual([
      'event',
      'detail',
      'origins',
      'magnitudes',
      'arrivals',
      'aftershock_forecast',
    ]);
    expect(structured.origins).toHaveLength(5);
    expect(structured.magnitudes.map((m) => m.type)).toEqual(['Mh', 'Ml', 'Mw', 'Mlr', 'Me']);
    expect(structured.arrivals).toHaveLength(3);
    expect(structured.aftershock_forecast.windows).toHaveLength(4);

    const text = (result.content as { text: string }[]).map((block) => block.text).join('\n');
    for (const origin of structured.origins) expect(text).toContain(`**${origin.event_id}**`);
    for (const magnitude of structured.magnitudes) expect(text).toContain(`**${magnitude.type} `);
    expect(text.match(/^\| CI \| (TOW2|SRT) \| {2}\| H(HZ|NN) \|/gm)).toHaveLength(3);
    expect(text.match(/^\| \d \| [\d.e-]+ \|/gm)).toHaveLength(24);
  });

  it('lists unavailable groups on both surfaces', async () => {
    stubUsgsEvent('us6000m0yg', { 'phase-data': () => new Response('nope', { status: 404 }) });
    const result = await runToolContract(earthquakeGetEvent, {
      event_id: 'us6000m0yg',
      include: ['arrivals', 'aftershock_forecast'],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      unavailable_includes: [
        { group: 'arrivals', reason: 'fetch_failed' },
        { group: 'aftershock_forecast', reason: 'not_published' },
      ],
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('- arrivals: fetch_failed');
    expect(text).toContain('- aftershock_forecast: not_published');
  });

  it('lists every requested group as not_published for an EMSC unid, with no USGS request', async () => {
    const urls = stubFetch(seismicPortal);
    const result = await runToolContract(earthquakeGetEvent, {
      event_id: '20190706_0000043',
      include: ['aftershock_forecast', 'origins'],
    });
    expect(result.isError).not.toBe(true);
    expect(urls.map((url) => url.hostname)).toEqual(['www.seismicportal.eu']);
    expect(Object.keys(result.structuredContent ?? {})).toEqual(['event', 'unavailable_includes']);
    expect(result.structuredContent).toMatchObject({
      unavailable_includes: [
        { group: 'origins', reason: 'not_published' },
        { group: 'aftershock_forecast', reason: 'not_published' },
      ],
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('- origins: not_published');
    expect(text).toContain('- aftershock_forecast: not_published');
  });

  it('rejects an unknown include group without a request', async () => {
    const fetchMock = stubDetail('us6000m0yg');
    const result = await runToolContract(earthquakeGetEvent, {
      event_id: 'us6000m0yg',
      include: ['picks' as 'arrivals'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('earthquake_get_event — EMSC unids (issue #53)', () => {
  it('returns the event earthquake_search_events source=emsc returns, on tool and resource', async () => {
    const urls = stubFetch(seismicPortal);
    const lookup = await runToolContract(earthquakeGetEvent, { event_id: '20190706_0000043' });
    const search = await runToolContract(earthquakeSearchEvents, {
      source: 'emsc',
      start_time: '2019-07-06T03:19:00',
      end_time: '2019-07-06T03:21:00',
      min_magnitude: 6,
    });
    const resource = await earthquakeEventResource.handler(
      earthquakeEventResource.params!.parse({ event_id: '20190706_0000043' }),
      createMockContext({ errors: earthquakeEventResource.errors }),
    );

    expect(lookup.isError).not.toBe(true);
    expect(urls.every((url) => url.hostname === 'www.seismicportal.eu')).toBe(true);
    expect(urls.filter((url) => url.searchParams.has('eventid'))).toHaveLength(2);
    expect(Object.keys(lookup.structuredContent ?? {})).toEqual(['event']);
    const { event } = lookup.structuredContent as { event: unknown };
    expect(event).toStrictEqual((search.structuredContent as { events: unknown[] }).events[0]);
    expect(resource).toStrictEqual(lookup.structuredContent);
    expect(lookup.content).toMatchInlineSnapshot(`
      [
        {
          "text": "## M 7.1 - SOUTHERN CALIFORNIA
      **ID:** 20190706_0000043 | **Magnitude:** 7.1 (mw) | **Depth:** 10 km
      **Place:** SOUTHERN CALIFORNIA
      **Time:** 2019-07-06T03:19:57.8Z | **Updated:** 2019-07-06T03:39:00.0Z
      **Location:** 35.7900°, -117.5800°
      **Provenance:** Status: not published by source | Catalog: EMSC-RTS | Agency: EMSC
      **PAGER Alert:** Not computed
      **Tsunami flag:** not published by source
      **Impact:** Not reported: DYFI felt reports, ShakeMap MMI, CDI, significance

      ### Analysis products
      _No projected analysis fields are available for this event; this does not imply zero impact._",
          "type": "text",
        },
      ]
    `);
  });

  it.each([
    // An unknown unid: SeismicPortal answers 204 with an empty body.
    ['20190706_9999999', 'www.seismicportal.eu', () => new Response(null, { status: 204 })],
    // A six-digit sequence is not the unid shape, so USGS answers it — with a 404.
    ['20190706_000043', 'earthquake.usgs.gov', () => new Response('', { status: 404 })],
  ])(
    'returns not_found for %s with a recovery naming both ID shapes',
    async (event_id, host, answer) => {
      const urls = stubFetch(answer);
      const result = await runToolContract(earthquakeGetEvent, { event_id });
      expect(urls.map((url) => url.hostname)).toEqual([host]);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'not_found', recovery: { hint: recovery('not_found') } },
        },
      });
      expect(recovery('not_found')).toContain('"us6000sznj"');
      expect(recovery('not_found')).toContain('"20190706_0000043"');
      expect(JSON.stringify(result.content)).toContain('20190706_0000043');
      await expect(
        earthquakeEventResource.handler(
          { event_id },
          createMockContext({ errors: earthquakeEventResource.errors }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'not_found' } });
    },
  );

  it.each([
    [
      'source_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
      () => new Response('', { status: 503 }),
    ],
    ['source_timeout', JsonRpcErrorCode.Timeout, hang],
  ] as const)('maps a failing SeismicPortal lookup to %s', async (reason, code, answer) => {
    vi.useFakeTimers();
    const urls = stubFetch(answer);
    const pending = runToolContract(earthquakeGetEvent, { event_id: '20190706_0000043' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.hostname === 'www.seismicportal.eu')).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code, data: { reason, retryable: true, recovery: { hint: recovery(reason) } } },
    });
    expect(JSON.stringify(result.content)).toContain('Recovery:');
  });
});

describe('earthquake_get_event — associated network IDs (issue #53)', () => {
  it('resolves the alias us70004bn0 to ci38457511 and lists the other IDs on both surfaces', async () => {
    const { urls } = stubUsgsEvent('us70004bn0', {}, 'ci38457511.detail.json');
    const result = await runToolContract(earthquakeGetEvent, { event_id: 'us70004bn0' });
    expect(urls).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      event: {
        id: 'ci38457511',
        associated_ids: ['us70004bn0', 'at00pu7alg', 'pt19187000', 'iscgem616203758'],
      },
    });
    expect((result.content as { text: string }[])[0]?.text.split('\n')).toContain(
      '**Associated IDs:** us70004bn0, at00pu7alg, pt19187000, iscgem616203758',
    );
  });
});
