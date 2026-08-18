/**
 * @fileoverview EMSC (European-Mediterranean Seismological Centre) FDSN event API client.
 * @module services/emsc/emsc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
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
 * Build an operation-labelled child of the handler context for withRetry/fetchWithTimeout.
 * Both accept the handler `Context` directly, but `fetchWithTimeout` reads
 * `context.operation` for its log and error labels and `Context` carries none —
 * so the label is what this helper exists for, not the field slice.
 */
function makeReqCtx(operation: string, ctx: Context) {
  return requestContextService.createRequestContext({
    operation,
    parentContext: {
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      tenantId: ctx.tenantId,
    },
  });
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
   * (1-based, forwarded to the upstream `offset` parameter). When results are
   * truncated at the requested limit, a follow-up count query populates
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

    const result = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
        });

        // fetchWithTimeout throws a status-mapped McpError on any non-2xx before
        // returning, so a Response here is always 2xx.
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
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
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    // EMSC's search response carries no match total — the real total comes from
    // the FDSN count endpoint. Fetch it only when results were truncated at the
    // limit; a count failure degrades to an absent totalCount rather than
    // failing the search.
    const requestedLimit = params.limit ?? 100;
    if (result.count > 0 && result.count === requestedLimit) {
      // The total is a property of the filter set, not of the page — offset,
      // limit, and orderBy are stripped so every page reports the same total.
      const { limit: _limit, offset: _offset, orderBy: _orderBy, ...countParams } = params;
      try {
        const { count: totalCount } = await this.countEvents(countParams, ctx);
        return { ...result, totalCount };
      } catch (err) {
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

  /** Count events matching a query. */
  countEvents(
    params: EarthquakeQueryParams,
    ctx: Context,
  ): Promise<{
    count: number;
    maxAllowed: number | null;
    exceedsLimit: boolean;
  }> {
    const query = this.buildFdsnQuery(params);
    const url = `${this.baseUrl}/fdsnws/event/1/count?format=json&${query}`;
    const reqCtx = makeReqCtx('EmscService.countEvents', ctx);

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
        });

        // fetchWithTimeout throws a status-mapped McpError on any non-2xx before
        // returning, so a Response here is always 2xx.
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
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
