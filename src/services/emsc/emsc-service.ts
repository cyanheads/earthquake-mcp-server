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
  EarthquakeQueryParams,
  EmscCountResponse,
  EmscFeature,
  EmscFeatureCollection,
} from '../usgs/types.js';

/** 1 degree of latitude ≈ 111.2 km. */
const KM_PER_DEGREE = 111.2;

/** Build a request context from a handler context for use with withRetry/fetchWithTimeout. */
function makeReqCtx(operation: string, ctx: Context) {
  return requestContextService.createRequestContext({
    operation,
    parentContext: {
      requestId: ctx.requestId,
      traceId: ctx.traceId,
      tenantId: ctx.tenantId,
      timestamp: new Date().toISOString(),
    },
  });
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
   * totalCount with the real match total for the whole filter set.
   */
  async searchEvents(
    params: EarthquakeQueryParams,
    ctx: Context,
  ): Promise<{
    events: EarthquakeEvent[];
    count: number;
    totalCount?: number;
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

    if (params.startTime) q.set('starttime', params.startTime);
    if (params.endTime) q.set('endtime', params.endTime);
    if (params.minMagnitude != null) q.set('minmagnitude', String(params.minMagnitude));
    if (params.maxMagnitude != null) q.set('maxmagnitude', String(params.maxMagnitude));
    if (params.latitude != null) q.set('latitude', String(params.latitude));
    if (params.longitude != null) q.set('longitude', String(params.longitude));
    if (params.radiusKm != null) {
      // EMSC only supports maxradius in degrees — convert from km
      const degrees = params.radiusKm / KM_PER_DEGREE;
      q.set('maxradius', degrees.toFixed(4));
    }
    if (params.minDepthKm != null) q.set('mindepth', String(params.minDepthKm));
    if (params.maxDepthKm != null) q.set('maxdepth', String(params.maxDepthKm));
    // EMSC does not support alertlevel, minfelt, minsig — silently omit
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
