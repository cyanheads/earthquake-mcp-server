/**
 * @fileoverview EMSC (European-Mediterranean Seismological Centre) FDSN event API client.
 * @module services/emsc/emsc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { CALL_DEADLINE_MS, HTML_BODY, isCancellation, makeReqCtx } from '../upstream-call.js';
import type {
  EarthquakeEvent,
  EarthquakeEventCertainty,
  EarthquakeQueryParams,
  EmscCountResponse,
  EmscFeature,
  EmscFeatureCollection,
} from '../usgs/types.js';

/** 1 degree of latitude ≈ 111.2 km. */
const KM_PER_DEGREE = 111.2;

/**
 * The EMSC unid: the origin date and a seven-digit, zero-padded sequence
 * (`20190706_0000043`). USGS IDs begin with letters and USGS answers this shape
 * with 404, so the shape alone decides which catalog a lookup goes to; any other
 * ID still reaches USGS unchanged.
 */
const EMSC_EVENT_ID = /^\d{8}_\d{7}$/;

/** Whether an event ID is an EMSC unid rather than a USGS ID. */
export function isEmscEventId(eventId: string): boolean {
  return EMSC_EVENT_ID.test(eventId);
}

/**
 * EMSC publishes `evtype` as the two-character event-type code defined in
 * "Nomenclature of Event Types" (Storchak, Earle, Bossu, Presgrave, Harris &
 * Godey, 26 March 2012), produced by the NEIC-ISC-EMSC coordination and
 * published at https://www.isc.ac.uk/standards/event_types/event_types.pdf.
 * The code carries two independent axes — character 1 the certainty, character 2
 * the type — and that document names the QuakeML event types alongside the codes.
 * Those names are exactly what USGS publishes in `properties.type`, so decoding
 * the type axis here gives both sources one vocabulary, and the certainty axis
 * travels beside it rather than folded into it: a suspected explosion must never
 * read as a confirmed one. EMSC documents these codes nowhere else — neither its
 * FDSN OpenAPI schema nor its docs page mentions `evtype`.
 */
const EMSC_EVENT_CERTAINTY: Record<string, EarthquakeEventCertainty> = {
  k: 'known',
  s: 'suspected',
  u: 'unknown',
  n: 'unreported',
};

/** Character 2 of the code — the event type, named as QuakeML names it. */
const EMSC_EVENT_TYPE: Record<string, string> = {
  u: 'not reported',
  e: 'earthquake',
  a: 'anthropogenic event',
  c: 'collapse',
  x: 'explosion',
  f: 'accidental explosion',
  h: 'chemical explosion',
  g: 'controlled explosion',
  j: 'experimental explosion',
  d: 'industrial explosion',
  m: 'mining explosion',
  n: 'nuclear explosion',
  i: 'induced or triggered event',
  r: 'rock burst',
  w: 'reservoir loading',
  k: 'fluid injection',
  q: 'fluid extraction',
  p: 'crash',
  o: 'other event',
  s: 'atmospheric event',
  b: 'avalanche',
  y: 'hydroacoustic event',
  z: 'ice quake',
  l: 'landslide',
  t: 'meteorite',
  v: 'volcanic eruption',
};

/**
 * Split an EMSC `evtype` code into its two axes. A code outside the
 * nomenclature is forwarded verbatim as the type, with no certainty — it still
 * reaches the caller and still renders, where coercing it to "earthquake" would
 * silently reclassify a seismic event. EMSC ships at least one such code (`fe`).
 */
function decodeEmscEventType(code: string): {
  event_type: string;
  event_certainty?: EarthquakeEventCertainty;
} {
  if (code.length !== 2) return { event_type: code };
  const event_certainty = EMSC_EVENT_CERTAINTY[code.charAt(0)];
  const event_type = EMSC_EVENT_TYPE[code.charAt(1)];
  if (event_certainty === undefined || event_type === undefined) return { event_type: code };
  return { event_type, event_certainty };
}

/** Normalize an EMSC GeoJSON feature to the shared EarthquakeEvent domain type. */
function normalizeEmscFeature(f: EmscFeature): EarthquakeEvent {
  const p = f.properties;
  const [lon, lat, depth] = f.geometry.coordinates;

  const id = p.unid ?? f.id ?? `emsc-unknown-${Date.now()}`;
  const place = p.flynn_region ?? 'Unknown location';
  const magType = p.magtype ?? 'unknown';
  const time = p.time ?? new Date(0).toISOString();
  const updated = p.lastupdate ?? time;

  // EMSC: properties.lat/lon may duplicate geometry coordinates; use them when present
  const actualLat = typeof p.lat === 'number' ? p.lat : lat;
  const actualLon = typeof p.lon === 'number' ? p.lon : lon;
  const actualDepth = typeof p.depth === 'number' ? p.depth : depth;

  return {
    id,
    title: `M ${p.mag ?? '?'} - ${place}`,
    magnitude: p.mag ?? null,
    magnitude_type: magType,
    time,
    updated,
    place,
    latitude: actualLat,
    longitude: actualLon,
    depth_km: actualDepth,
    // EMSC does not provide USGS-specific impact fields
    felt: null,
    cdi: null,
    mmi: null,
    alert: null,
    significance: null,
    // The FDSN response carries no review-status and no tsunami field. Both stay
    // null rather than asserting "reviewed" or "no tsunami flag" from data the
    // source never published — EMSC-RTS solutions are real-time and get revised.
    status: null,
    tsunami: null,
    // What EMSC does publish about provenance, so callers can judge it themselves
    ...(p.source_catalog ? { source_catalog: p.source_catalog } : {}),
    ...(p.auth ? { auth: p.auth } : {}),
    // EMSC's title is built from magnitude and region alone, so evtype is the only
    // place the classification survives — carry it through or it is unrecoverable.
    // Split into the type axis (the vocabulary USGS also publishes, so one value
    // means one thing on both sources and the formatter's plain-"earthquake"
    // suppression reaches EMSC) and the certainty axis beside it.
    ...(p.evtype ? decodeEmscEventType(p.evtype) : {}),
  };
}

export class EmscService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    _config: AppConfig,
    _storage: StorageService,
    emscBaseUrl: string,
    timeoutMs: number,
  ) {
    this.baseUrl = emscBaseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  /**
   * Query EMSC FDSN event API. `params.offset` pages through the match set
   * (1-based, forwarded upstream). Nonempty short pages establish their total;
   * an empty first page establishes zero.
   * When the page fills the requested limit, a follow-up count query populates
   * totalCount with the real match total for the whole filter set. If that
   * follow-up fails, the page still returns and `countUnavailable` marks the
   * total as unknown rather than not attempted.
   */
  async searchEvents(
    params: EarthquakeQueryParams,
    ctx: Context,
  ): Promise<{
    events: EarthquakeEvent[];
    count: number;
    totalCount?: number;
    countUnavailable?: true;
  }> {
    const query = this.buildFdsnQuery(params);
    const url = `${this.baseUrl}/fdsnws/event/1/query?format=json&${query}`;
    const reqCtx = makeReqCtx('EmscService.searchEvents', ctx);
    const deadline = Date.now() + CALL_DEADLINE_MS;

    const result = await withRetry(
      async ({ signal, remainingMs }) => {
        const response = await fetchWithTimeout(
          url,
          Math.min(this.timeoutMs, remainingMs),
          reqCtx,
          {
            signal,
            headers: { Accept: 'application/json' },
          },
        );

        // fetchWithTimeout throws a status-mapped McpError on any non-2xx before
        // returning, so a Response here is always 2xx.
        const text = await response.text();
        if (HTML_BODY.test(text)) {
          throw serviceUnavailable('EMSC returned HTML instead of JSON.', { url });
        }

        // EMSC answers a zero-match query — including an offset past the last
        // match — with 204 No Content and an empty body, which is a match set of
        // size zero, not a parse failure.
        if (text.trim() === '') {
          return { events: [], count: 0 };
        }

        const data = JSON.parse(text) as EmscFeatureCollection;
        const events = data.features.map(normalizeEmscFeature);

        return {
          events,
          count: events.length,
        };
      },
      {
        operation: 'EmscService.searchEvents',
        deadlineMs: CALL_DEADLINE_MS,
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    // Infer short-page totals. Empty later pages cannot establish the total;
    // full pages use the count endpoint without making count failure fatal.
    const requestedLimit = params.limit ?? 100;
    if (result.count < requestedLimit && (result.count > 0 || (params.offset ?? 1) === 1))
      return { ...result, totalCount: (params.offset ?? 1) - 1 + result.count };
    if (result.count > 0 && result.count === requestedLimit) {
      // The total is a property of the filter set, not of the page — offset,
      // limit, and orderBy are stripped so every page reports the same total.
      const { limit: _limit, offset: _offset, orderBy: _orderBy, ...countParams } = params;
      try {
        const { count: totalCount } = await this.countEvents(
          countParams,
          ctx,
          Math.max(1, deadline - Date.now()),
        );
        return { ...result, totalCount };
      } catch (err) {
        if (isCancellation(err, ctx)) throw err;
        ctx.log.warning('Count sub-call for totalCount failed — returning results without it', {
          error: err instanceof Error ? err.message : String(err),
        });
        // A bare absent totalCount reads identically to "no count was needed",
        // so the failure is reported rather than inferred from the gap.
        return { ...result, countUnavailable: true };
      }
    }
    return result;
  }

  /**
   * Fetch one event by EMSC unid. SeismicPortal answers with a bare `Feature` (no
   * collection wrapper) carrying the same properties as a search result, so the
   * event is normalized exactly as search normalizes it. EMSC publishes no analysis
   * products, so there is no `detail`. An unknown unid is a 204 with an empty body,
   * mapped to NotFound; `nodata=404` is never sent, because its 404 body echoes an
   * internal host. One 50-second deadline covers every attempt and backoff.
   */
  async getEvent(unid: string, ctx: Context): Promise<{ event: EarthquakeEvent }> {
    const url = `${this.baseUrl}/fdsnws/event/1/query?eventid=${encodeURIComponent(unid)}&format=json`;
    const reqCtx = makeReqCtx('EmscService.getEvent', ctx);

    const feature = await withRetry(
      async ({ signal, remainingMs }) => {
        const response = await fetchWithTimeout(
          url,
          Math.min(this.timeoutMs, remainingMs),
          reqCtx,
          { signal, headers: { Accept: 'application/json' } },
        );

        // fetchWithTimeout throws a status-mapped McpError on any non-2xx before
        // returning, so a Response here is always 2xx.
        const text = await response.text();
        if (HTML_BODY.test(text)) {
          throw serviceUnavailable('EMSC returned HTML instead of JSON.', { eventId: unid });
        }
        if (text.trim() === '') {
          throw notFound('EMSC returned no event for the requested ID.', { eventId: unid });
        }

        const raw = JSON.parse(text) as EmscFeature | EmscFeatureCollection;
        if (raw.type !== 'Feature' || (raw.properties.unid ?? raw.id) !== unid) {
          throw notFound(`No earthquake event found for ID "${unid}".`, { eventId: unid });
        }
        return raw;
      },
      {
        operation: 'EmscService.getEvent',
        deadlineMs: CALL_DEADLINE_MS,
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    return { event: normalizeEmscFeature(feature) };
  }

  /** Count events matching a query. */
  countEvents(
    params: EarthquakeQueryParams,
    ctx: Context,
    deadlineMs?: number,
  ): Promise<{
    count: number;
    maxAllowed: number | null;
    exceedsLimit: boolean;
  }> {
    const query = this.buildFdsnQuery(params);
    const url = `${this.baseUrl}/fdsnws/event/1/count?format=json&${query}`;
    const reqCtx = makeReqCtx('EmscService.countEvents', ctx);

    return withRetry(
      async ({ signal, remainingMs }) => {
        const response = await fetchWithTimeout(
          url,
          Math.min(this.timeoutMs, remainingMs),
          reqCtx,
          {
            signal,
            headers: { Accept: 'application/json' },
          },
        );

        // fetchWithTimeout throws a status-mapped McpError on any non-2xx before
        // returning, so a Response here is always 2xx.
        const text = await response.text();
        if (HTML_BODY.test(text)) {
          throw serviceUnavailable('EMSC returned HTML instead of JSON.', { url });
        }

        const data = JSON.parse(text) as EmscCountResponse;
        const EMSC_LIMIT = 20000;
        return {
          count: data.count,
          maxAllowed: null, // EMSC count endpoint does not return maxAllowed
          exceedsLimit: data.count > EMSC_LIMIT,
        };
      },
      {
        operation: 'EmscService.countEvents',
        ...(deadlineMs != null ? { deadlineMs } : {}),
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Build FDSN query string from params, converting km radius to degrees for EMSC. */
  private buildFdsnQuery(params: EarthquakeQueryParams): string {
    const q = new URLSearchParams();

    // != null, not truthy: an empty value must reach the querystring rather than be
    // silently dropped, so a tool's queryEcho can never report a filter that was not sent.
    if (params.startTime != null) q.set('starttime', params.startTime);
    if (params.endTime != null) q.set('endtime', params.endTime);
    if (params.minMagnitude != null) q.set('minmagnitude', String(params.minMagnitude));
    if (params.maxMagnitude != null) q.set('maxmagnitude', String(params.maxMagnitude));
    if (params.magnitudeType != null) q.set('magnitudetype', params.magnitudeType);
    if (params.latitude != null) q.set('latitude', String(params.latitude));
    if (params.longitude != null) q.set('longitude', String(params.longitude));
    if (params.radiusKm != null) {
      // EMSC only supports maxradius in degrees — convert from km
      const degrees = params.radiusKm / KM_PER_DEGREE;
      q.set('maxradius', degrees.toFixed(4));
    }
    // EMSC takes the FDSN rectangle in degrees under the same parameter names as USGS,
    // so the box needs no conversion on either provider.
    if (params.minLatitude != null) q.set('minlatitude', String(params.minLatitude));
    if (params.maxLatitude != null) q.set('maxlatitude', String(params.maxLatitude));
    if (params.minLongitude != null) q.set('minlongitude', String(params.minLongitude));
    if (params.maxLongitude != null) q.set('maxlongitude', String(params.maxLongitude));
    if (params.minDepthKm != null) q.set('mindepth', String(params.minDepthKm));
    if (params.maxDepthKm != null) q.set('maxdepth', String(params.maxDepthKm));
    // EMSC does not support alertlevel, minfelt, minsig, eventtype — silently omit.
    // Its endpoint has no eventtype parameter at all and answers one with HTTP 400
    // "Unknown request parameters(s)", so sending it would fail the whole query.
    if (params.limit != null) q.set('limit', String(params.limit));
    // FDSN offset is 1-based — offset=1 is the first match, and 0 is rejected.
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.orderBy) q.set('orderby', params.orderBy);

    return q.toString();
  }
}

// --- Init/accessor pattern ---

let _service: EmscService | undefined;

export function initEmscService(
  config: AppConfig,
  storage: StorageService,
  emscBaseUrl: string,
  timeoutMs: number,
): void {
  _service = new EmscService(config, storage, emscBaseUrl, timeoutMs);
}

export function getEmscService(): EmscService {
  if (!_service) {
    throw new Error('EmscService not initialized — call initEmscService() in setup()');
  }
  return _service;
}
