/**
 * @fileoverview Tests for the opt-in include groups of a USGS event lookup — origins,
 * magnitudes, arrivals, and the aftershock forecast — at the service seam, with the
 * real fetch/retry path running against captures trimmed from live USGS responses.
 * @module tests/services/event-includes.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectAftershockForecast } from '@/services/usgs/aftershock-forecast.js';
import { normalizeIncludeGroups, unpublishedIncludes } from '@/services/usgs/event-includes.js';
import { parsePhaseData, projectArrivals, projectMagnitudes } from '@/services/usgs/quakeml.js';
import { EVENT_INCLUDE_GROUPS, type EventIncludeGroup } from '@/services/usgs/types.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';
import { fixture, hang, stubUsgsEvent } from '../helpers/usgs-fetch-stub.js';

const service = (timeoutMs = 5000) =>
  new UsgsService({} as AppConfig, {} as StorageService, 'https://earthquake.usgs.gov', timeoutMs);

const lookup = (eventId: string, include: readonly EventIncludeGroup[], ctx?: Context) =>
  service().getEvent(eventId, ctx ?? (createMockContext() as Context), include);

const phaseData = (name: string) => parsePhaseData(fixture(name));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('include normalization', () => {
  it('dedupes and orders requested groups canonically', () => {
    expect(EVENT_INCLUDE_GROUPS).toEqual([
      'origins',
      'magnitudes',
      'arrivals',
      'aftershock_forecast',
    ]);
    expect(
      normalizeIncludeGroups(['aftershock_forecast', 'arrivals', 'arrivals', 'origins']),
    ).toEqual(['origins', 'arrivals', 'aftershock_forecast']);
    expect(normalizeIncludeGroups(undefined)).toEqual([]);
  });

  it('reports every group not_published for a source with no USGS products', () => {
    expect(unpublishedIncludes(['origins', 'aftershock_forecast'])).toEqual({
      unavailable_includes: [
        { group: 'origins', reason: 'not_published' },
        { group: 'aftershock_forecast', reason: 'not_published' },
      ],
    });
    expect(unpublishedIncludes([])).toEqual({});
  });
});

describe('origins — from the detail response, no extra request', () => {
  it('returns every origin product, preferred first, with sparse fields absent', async () => {
    const { urls } = stubUsgsEvent('ci38457511');
    const result = await lookup('ci38457511', ['origins']);

    expect(urls).toHaveLength(1);
    expect(result.unavailable_includes).toBeUndefined();
    const origins = result.origins ?? [];
    expect(origins.map((o) => [o.source, o.event_id, o.is_preferred, o.depth_km])).toEqual([
      ['ci', 'ci38457511', true, 8],
      ['us', 'us70004bn0', false, 8],
      ['pt', 'pt19187000', false, 100],
      ['at', 'at00pu7alg', false, 100],
      ['us', 'iscgem616203758', false, 11.4],
    ]);
    expect(origins[0]).toEqual({
      source: 'ci',
      event_id: 'ci38457511',
      is_preferred: true,
      time: '2019-07-06T03:19:53.040Z',
      latitude: 35.7695,
      longitude: -117.5993333,
      depth_km: 8,
      depth_type: 'operator assigned',
      magnitude: 7.1,
      magnitude_type: 'mw',
      review_status: 'reviewed',
      evaluation_status: 'final',
      num_stations_used: 77,
      num_phases_used: 85,
      azimuthal_gap_deg: 43,
      standard_error_s: 0.22,
      minimum_distance_deg: 0.04616,
      horizontal_error_km: 0.19,
      depth_error_km: 31.61,
    });
    // pt publishes no evaluation status, error fields, or depth type; at omits evaluation
    // status but reports a literal zero horizontal error, which stays a zero.
    for (const key of [
      'evaluation_status',
      'horizontal_error_km',
      'depth_error_km',
      'depth_type',
    ]) {
      expect(origins[2]).not.toHaveProperty(key);
    }
    expect(origins[2]?.azimuthal_gap_deg).toBe(86.39999308800056);
    expect(origins[3]).not.toHaveProperty('evaluation_status');
    expect(origins[3]?.horizontal_error_km).toBe(0);
    expect(origins[3]?.minimum_distance_deg).toBe(0);
  });

  it('is not_published when the event carries no origin product', async () => {
    const detail = JSON.parse(fixture('us6000m0yg.detail.json'));
    delete detail.properties.products.origin;
    const { urls } = stubUsgsEvent('us6000m0yg', {}, () => Response.json(detail));
    const result = await lookup('us6000m0yg', ['origins']);
    expect(urls).toHaveLength(1);
    expect(result).not.toHaveProperty('origins');
    expect(result.unavailable_includes).toEqual([{ group: 'origins', reason: 'not_published' }]);
  });
});

describe('QuakeML projection', () => {
  it('projects event magnitudes with the preferred one flagged', () => {
    expect(projectMagnitudes(phaseData('us6000m0yg.phase-data.xml'))).toEqual([
      {
        type: 'mb',
        value: 5.1,
        station_count: 45,
        evaluation_mode: 'manual',
        evaluation_status: 'reviewed',
        agency: 'us',
        is_preferred: true,
      },
    ]);
    const m0xl = projectMagnitudes(phaseData('us6000m0xl.phase-data.xml'));
    expect(m0xl.map((m) => [m.type, m.value, m.is_preferred])).toEqual([
      ['mb', 6.9, false],
      ['Ms_20', 7.2, false],
      ['Mww', 7.5, true],
    ]);
  });

  it('leaves sparse magnitude fields absent rather than defaulted', () => {
    expect(projectMagnitudes(phaseData('ak20419010.phase-data.xml'))).toEqual([
      { type: 'mw', value: 7.1, is_preferred: true },
    ]);
    expect(projectMagnitudes(phaseData('aka2026viylbm.phase-data.xml'))).toEqual([
      { type: 'ML', value: 3, station_count: 101, agency: 'AK', is_preferred: true },
    ]);
  });

  it('joins arrivals to picks and sorts them by distance, not document order', () => {
    const arrivals = projectArrivals(phaseData('us6000m0yg.phase-data.xml'));
    // Document order is 17.38°, 150.6°, 39.12°, 1.367°, 7.359°.
    expect(arrivals.map((a) => a.distance_deg)).toEqual([
      1.3667, 7.35893, 17.3807, 39.1215, 150.607,
    ]);
    expect(arrivals[0]).toEqual({
      network: 'IM',
      station: 'MJAR',
      location: 'F0',
      channel: 'HHZ',
      phase: 'Pn',
      time: '2024-01-01T09:45:50.69Z',
      time_residual_s: -0.68,
      distance_deg: 1.3667,
      azimuth_deg: 157.748,
      time_weight: 1.22,
    });
  });

  it("returns only the preferred origin's arrivals when several origins carry them", () => {
    const event = phaseData('ci38457511.phase-data.xml');
    // The trimmed document keeps three arrivals on each of three origins.
    const all = fixture('ci38457511.phase-data.xml').match(/<arrival\b/g) ?? [];
    expect(all).toHaveLength(9);
    const arrivals = projectArrivals(event);
    expect(arrivals.map((a) => [a.station, a.channel, a.phase])).toEqual([
      ['TOW2', 'HHZ', 'P'],
      ['TOW2', 'HNN', 'S'],
      ['SRT', 'HHZ', 'P'],
    ]);
  });

  it('reads offset-less pick times as UTC and emits them with Z', () => {
    const times = projectArrivals(phaseData('ci41567984.phase-data.xml')).map((a) => a.time);
    expect(times).toEqual([
      '2026-10-28T02:41:47.79Z',
      '2026-10-28T02:41:40.60Z',
      '2026-10-28T02:41:51.03Z',
      '2026-10-28T02:41:42.62Z',
    ]);
    expect(fixture('ci41567984.phase-data.xml')).toContain('<value>2026-10-28T02:41:51.03</value>');
  });

  it('leaves an unpublished location code absent', () => {
    const arrivals = projectArrivals(phaseData('aka2026viylbm.phase-data.xml'));
    expect(arrivals).toHaveLength(6);
    for (const arrival of arrivals) expect(arrival).not.toHaveProperty('location');
    expect(arrivals[0]?.station).toBe('BRSE');
  });

  it('refuses a document whose preferred origin is missing', () => {
    const xml = fixture('us6000m0yg.phase-data.xml').replace(
      /<preferredOriginID>[^<]*<\/preferredOriginID>/,
      '<preferredOriginID>quakeml:us.anss.org/origin/other</preferredOriginID>',
    );
    expect(() => projectArrivals(parsePhaseData(xml))).toThrow(/preferred origin/);
    // Magnitudes do not depend on the preferred origin.
    expect(projectMagnitudes(parsePhaseData(xml))).toHaveLength(1);
  });

  it.each([
    ['plain text', 'not xml at all'],
    [
      'XML without an event',
      '<?xml version="1.0"?><q:quakeml xmlns:q="x"><eventParameters/></q:quakeml>',
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parsePhaseData(body)).toThrow();
  });
});

describe('aftershock forecast projection', () => {
  it('returns every window and bin in upstream order with ISO times', () => {
    const forecast = projectAftershockForecast(fixture('us6000u18k.forecast.json'));
    expect(forecast).toMatchObject({
      advisory_window: '1 Month',
      created: '2026-10-26T15:54:39.480Z',
      expires: '2027-10-27T02:21:23.226Z',
      next_update: '2026-11-02T16:00:28.116Z',
    });
    expect(forecast.windows.map((w) => w.label)).toEqual(['1 Day', '1 Week', '1 Month', '1 Year']);
    const week = forecast.windows[1];
    expect(week).toMatchObject({
      start: '2026-10-26T16:00:28.116Z',
      end: '2026-11-02T16:00:28.116Z',
      above_mainshock: { magnitude: 7.7, probability: 0.001 },
    });
    expect(week?.bins.map((b) => b.magnitude)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(week?.bins[2]).toEqual({
      magnitude: 5,
      probability: 0.3919,
      count_median: 0,
      count_p95_min: 0,
      count_p95_max: 3,
    });
    expect(week?.bins[3]?.probability).toBe(0.0479);
  });

  it('takes bin magnitudes from the file and omits a next update upstream dropped', () => {
    expect(
      projectAftershockForecast(fixture('nc75458907.forecast.json')).windows[0]?.bins.map(
        (b) => b.magnitude,
      ),
    ).toEqual([3, 4, 5, 6, 7]);
    const ended = projectAftershockForecast(fixture('us6000qw60.forecast.json'));
    expect(ended).not.toHaveProperty('next_update');
    expect(ended.advisory_window).toBe('1 Year');
  });

  it('omits above_mainshock and bin counts when upstream does', () => {
    const raw = JSON.parse(fixture('us6000qw60.forecast.json'));
    delete raw.forecast[0].aboveMainshockMag;
    delete raw.forecast[0].bins[0].median;
    raw.forecast[0].bins[0].p95maximum = null;
    const forecast = projectAftershockForecast(JSON.stringify(raw));
    expect(forecast.windows[0]).not.toHaveProperty('above_mainshock');
    expect(forecast.windows[0]?.bins[0]).not.toHaveProperty('count_median');
    expect(forecast.windows[0]?.bins[0]).not.toHaveProperty('count_p95_max');
    expect(forecast.windows[0]?.bins[0]).toHaveProperty('count_p95_min');
  });

  it.each([
    ['non-JSON', '<html>busy</html>'],
    [
      'a missing window list',
      JSON.stringify({ advisoryTimeFrame: '1 Week', creationTime: 1, expireTime: 2 }),
    ],
    [
      'a string probability',
      fixture('nc75458907.forecast.json').replace(
        /"probability":\s*0\.002061/,
        '"probability":"0.002061"',
      ),
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => projectAftershockForecast(body)).toThrow();
  });
});

describe('UsgsService.getEvent — include requests', () => {
  it('makes one upstream request when nothing is included', async () => {
    const { urls } = stubUsgsEvent('ci38457511');
    const result = await lookup('ci38457511', []);
    expect(urls).toHaveLength(1);
    expect(Object.keys(result)).toEqual(['event', 'detail']);
  });

  it('fetches the phase-data QuakeML once for magnitudes and arrivals together', async () => {
    const { urls } = stubUsgsEvent('us6000m0yg', { 'phase-data': 'us6000m0yg.phase-data.xml' });
    const result = await lookup('us6000m0yg', ['arrivals', 'magnitudes', 'arrivals']);
    expect(urls).toEqual([
      'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000m0yg&format=geojson',
      'https://earthquake.usgs.gov/product/phase-data/us6000m0yg/us/1710020303040/quakeml.xml',
    ]);
    expect(result.magnitudes).toHaveLength(1);
    expect(result.arrivals).toHaveLength(5);
    expect(result.unavailable_includes).toBeUndefined();
    expect(Object.keys(result)).toEqual(['event', 'detail', 'magnitudes', 'arrivals']);
  });

  it('reports a group whose product is absent as not_published, without a request', async () => {
    const { urls } = stubUsgsEvent('us6000m0yg', { 'phase-data': 'us6000m0yg.phase-data.xml' });
    const result = await lookup('us6000m0yg', ['aftershock_forecast', 'magnitudes']);
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('/oaf/'))).toBe(false);
    expect(result.magnitudes).toHaveLength(1);
    expect(result).not.toHaveProperty('aftershock_forecast');
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'not_published' },
    ]);
  });

  it('reports every group not_published on an event with no products', async () => {
    const detail = JSON.parse(fixture('us6000m0yg.detail.json'));
    delete detail.properties.products;
    const { urls } = stubUsgsEvent('us6000m0yg', {}, () => Response.json(detail));
    const result = await lookup('us6000m0yg', [...EVENT_INCLUDE_GROUPS]);
    expect(urls).toHaveLength(1);
    expect(result.unavailable_includes).toEqual(
      EVENT_INCLUDE_GROUPS.map((group) => ({ group, reason: 'not_published' })),
    );
  });

  it('fetches the forecast with one extra request', async () => {
    const { urls } = stubUsgsEvent('us6000u18k', { oaf: 'us6000u18k.forecast.json' });
    const result = await lookup('us6000u18k', ['aftershock_forecast']);
    expect(urls).toEqual([
      'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000u18k&format=geojson',
      'https://earthquake.usgs.gov/product/oaf/us6000u18k/us/1793030666272/forecast.json',
    ]);
    expect(result.aftershock_forecast?.windows).toHaveLength(4);
  });

  it('runs the phase-data and forecast requests concurrently', async () => {
    const pending: Array<() => void> = [];
    const held = (name: string) => (): Promise<Response> =>
      new Promise((resolve) => pending.push(() => resolve(new Response(fixture(name)))));
    const { urls } = stubUsgsEvent('ci38457511', {
      'phase-data': held('ci38457511.phase-data.xml'),
      oaf: held('us6000u18k.forecast.json'),
    });
    const promise = lookup('ci38457511', [...EVENT_INCLUDE_GROUPS]);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Both product requests are in flight before either has answered.
    expect(urls).toHaveLength(3);
    for (const release of pending) release();
    const result = await promise;
    expect(Object.keys(result)).toEqual([
      'event',
      'detail',
      'origins',
      'magnitudes',
      'arrivals',
      'aftershock_forecast',
    ]);
  });
});

describe('UsgsService.getEvent — a failed product degrades only its groups', () => {
  it.each([
    ['404', () => new Response('missing', { status: 404 })],
    ['HTML', () => new Response('<!DOCTYPE html><html>busy</html>', { status: 200 })],
    ['unparseable body', () => new Response('{"truncated":', { status: 200 })],
  ])('lists the phase-data groups as fetch_failed on a %s', async (_label, respond) => {
    vi.useFakeTimers();
    const { urls } = stubUsgsEvent('ci38457511', {
      'phase-data': respond,
      oaf: 'us6000u18k.forecast.json',
    });
    const promise = lookup('ci38457511', [...EVENT_INCLUDE_GROUPS]);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.event.id).toBe('ci38457511');
    expect(result.detail?.origin?.depth_type).toBe('operator assigned');
    expect(result.origins).toHaveLength(5);
    expect(result.aftershock_forecast?.windows).toHaveLength(4);
    expect(result).not.toHaveProperty('magnitudes');
    expect(result).not.toHaveProperty('arrivals');
    expect(result.unavailable_includes).toEqual([
      { group: 'magnitudes', reason: 'fetch_failed' },
      { group: 'arrivals', reason: 'fetch_failed' },
    ]);
    expect(urls.filter((u) => u.includes('/oaf/'))).toHaveLength(1);
  });

  it('retries a 5xx product request before giving up on it', async () => {
    vi.useFakeTimers();
    const { urls } = stubUsgsEvent('us6000u18k', {
      oaf: () => new Response('unavailable', { status: 503 }),
    });
    const promise = lookup('us6000u18k', ['aftershock_forecast']);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(urls.filter((u) => u.includes('/oaf/'))).toHaveLength(4);
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'fetch_failed' },
    ]);
  });

  it('does not retry a forecast that fetched but failed its schema', async () => {
    const { urls } = stubUsgsEvent('us6000u18k', {
      oaf: () => Response.json({ advisoryTimeFrame: '1 Week' }),
    });
    const result = await lookup('us6000u18k', ['aftershock_forecast']);
    expect(urls.filter((u) => u.includes('/oaf/'))).toHaveLength(1);
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'fetch_failed' },
    ]);
  });

  it('degrades only arrivals when the preferred origin is missing from the document', async () => {
    const xml = fixture('us6000m0yg.phase-data.xml').replace(
      /<preferredOriginID>[^<]*<\/preferredOriginID>/,
      '',
    );
    stubUsgsEvent('us6000m0yg', { 'phase-data': () => new Response(xml) });
    const result = await lookup('us6000m0yg', ['magnitudes', 'arrivals']);
    expect(result.magnitudes).toHaveLength(1);
    expect(result.unavailable_includes).toEqual([{ group: 'arrivals', reason: 'fetch_failed' }]);
  });

  it('does not fetch a content URL off the configured USGS origin', async () => {
    const detail = JSON.parse(fixture('us6000u18k.detail.json'));
    detail.properties.products.oaf[0].contents['forecast.json'].url =
      'https://attacker.example/forecast.json';
    const { urls } = stubUsgsEvent('us6000u18k', {}, () => Response.json(detail));
    const result = await lookup('us6000u18k', ['aftershock_forecast']);
    expect(urls).toHaveLength(1);
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'fetch_failed' },
    ]);
  });

  it('does not follow a USGS content URL that redirects off the configured origin', async () => {
    const offOrigin = 'https://attacker.example/product/oaf/us6000u18k/us/1/forecast.json';
    // Platform fetch semantics: unless the request asks for `redirect: 'manual'`, the
    // 302 is followed and the off-origin target answers with a forecast.
    const { urls } = stubUsgsEvent('us6000u18k', {
      oaf: (url, init) => {
        if (url.origin !== 'https://earthquake.usgs.gov') {
          return new Response(fixture('us6000u18k.forecast.json'));
        }
        return init?.redirect === 'manual'
          ? new Response(null, { status: 302, headers: { location: offOrigin } })
          : fetch(offOrigin, init);
      },
    });
    const result = await lookup('us6000u18k', ['aftershock_forecast']);
    expect(urls.some((u) => new URL(u).origin === 'https://attacker.example')).toBe(false);
    // A 3xx is not retried: one product request, then the group degrades.
    expect(urls.filter((u) => u.includes('/oaf/'))).toHaveLength(1);
    expect(result).not.toHaveProperty('aftershock_forecast');
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'fetch_failed' },
    ]);
  });
});

describe('UsgsService.getEvent — one deadline and cancellation', () => {
  it('bounds the event request and the product requests with one 50 s deadline', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    // The event answers at 45 s; the forecast request then hangs. A per-request
    // deadline would let it run past 90 s — the shared one ends it at 50 s.
    const { urls } = stubUsgsEvent(
      'us6000u18k',
      { oaf: hang },
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Response(fixture('us6000u18k.detail.json'))), 45_000),
        ),
    );
    const promise = service(45_000).getEvent('us6000u18k', createMockContext() as Context, [
      'aftershock_forecast',
    ]);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(Date.now() - started).toBeLessThanOrEqual(50_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45_000);
    expect(urls.filter((u) => u.includes('/oaf/')).length).toBeGreaterThanOrEqual(1);
    expect(result.event.id).toBe('us6000u18k');
    expect(result.unavailable_includes).toEqual([
      { group: 'aftershock_forecast', reason: 'fetch_failed' },
    ]);
  });

  it('bounds a default lookup that keeps timing out by the same deadline', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    stubUsgsEvent('us6000u18k', {}, hang);
    const promise = service(45_000)
      .getEvent('us6000u18k', createMockContext() as Context)
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(Date.now() - started).toBeLessThanOrEqual(50_000);
  });

  it('propagates cancellation during a product request instead of degrading the group', async () => {
    const controller = new AbortController();
    const { urls } = stubUsgsEvent('us6000u18k', {
      oaf: (url, init) => {
        controller.abort();
        return hang(url, init);
      },
    });
    const pending = service().getEvent(
      'us6000u18k',
      createMockContext({ signal: controller.signal }) as Context,
      ['aftershock_forecast'],
    );
    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(urls.filter((u) => u.includes('/oaf/'))).toHaveLength(1);
  });
});
