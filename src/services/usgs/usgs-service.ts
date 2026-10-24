/**
 * @fileoverview USGS Earthquake Hazards Program API client — real-time feeds and FDSN event queries.
 * @module services/usgs/usgs-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  EarthquakeEvent,
  EarthquakeEventDetail,
  EarthquakeQueryParams,
  NodalPlane,
  UsgsCountResponse,
  UsgsDyfiProperties,
  UsgsFeature,
  UsgsFeatureCollection,
  UsgsFiniteFaultProperties,
  UsgsGroundFailureProperties,
  UsgsLossPagerProperties,
  UsgsMomentTensorProperties,
  UsgsOriginProperties,
  UsgsProduct,
  UsgsShakeMapProperties,
} from './types.js';

/** Convert a USGS epoch-millisecond timestamp to an ISO 8601 string. */
function epochMsToIso(ms: number | null | undefined): string {
  if (ms == null) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

/**
 * Build an operation-labelled child of the handler context for withRetry/fetchWithTimeout.
 * `Context extends RequestContext`, so passing `ctx` as the parent inherits every
 * correlation field. The label is what the child adds: `ctx.operation` names the calling
 * tool, while `fetchWithTimeout` reports `context.operation` on a timeout — so the error
 * names the upstream call that hung, not whichever tool reached it.
 */
function makeReqCtx(operation: string, ctx: Context) {
  return requestContextService.createRequestContext({ operation, parentContext: ctx });
}

/** Normalize a USGS GeoJSON feature to the shared EarthquakeEvent domain type. */
function normalizeUsgsFeature(f: UsgsFeature): EarthquakeEvent {
  const p = f.properties;
  const [lon, lat, depth] = f.geometry.coordinates;

  const rawStatus = p.status ?? 'automatic';
  const status: 'automatic' | 'reviewed' | 'deleted' =
    rawStatus === 'reviewed' || rawStatus === 'deleted' ? rawStatus : 'automatic';

  const rawAlert = p.alert;
  const alert: 'green' | 'yellow' | 'orange' | 'red' | null =
    rawAlert === 'green' || rawAlert === 'yellow' || rawAlert === 'orange' || rawAlert === 'red'
      ? rawAlert
      : null;

  return {
    id: f.id,
    title: p.title ?? `M ${p.mag ?? '?'} - ${p.place ?? 'Unknown location'}`,
    magnitude: p.mag ?? null,
    magnitude_type: p.magType ?? 'unknown',
    time: epochMsToIso(p.time),
    updated: epochMsToIso(p.updated),
    place: p.place ?? 'Unknown location',
    latitude: lat,
    longitude: lon,
    depth_km: depth,
    felt: p.felt ?? null,
    cdi: p.cdi ?? null,
    mmi: p.mmi ?? null,
    alert,
    tsunami: p.tsunami ?? null,
    significance: p.sig ?? null,
    status,
    // USGS `net` is the contributor considered the preferred source for the
    // event — the same provenance EMSC reports as `auth`. USGS publishes no
    // catalog identifier on event records, so source_catalog stays absent.
    ...(p.net ? { auth: p.net } : {}),
    // USGS labels non-tectonic records the same way it labels earthquakes, so the
    // classification travels with every event rather than only the unusual ones.
    ...(p.type ? { event_type: p.type } : {}),
    ...(p.url ? { event_url: p.url } : {}),
    ...(p.detail ? { detail_url: p.detail } : {}),
  };
}

/** Parse a USGS product property — every value arrives as a string — into a finite number. */
function num(value: string | undefined): number | undefined {
  if (value == null) return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * URL of the first content file whose key ends with one of the given suffixes.
 * Some filenames are prefixed with the event ID (DYFI), so keys are matched by
 * suffix rather than looked up whole.
 */
function contentUrl(
  product: UsgsProduct<unknown> | undefined,
  ...suffixes: string[]
): string | undefined {
  const contents = product?.contents;
  if (!contents) return;
  for (const suffix of suffixes) {
    const key = Object.keys(contents).find((name) => name.endsWith(suffix));
    const url = key != null ? contents[key]?.url : undefined;
    if (url != null) return url;
  }
  return;
}

/** Keep a projected product group only when at least one of its fields survived. */
function group<T extends object>(fields: T): T | undefined {
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** Contribute `{ key: value }` when the value survived projection, nothing when it did not. */
function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** A nodal plane is only meaningful with all three angles — drop a partial one. */
function nodalPlane(
  strike: number | undefined,
  dip: number | undefined,
  rake: number | undefined,
): NodalPlane | undefined {
  if (strike == null || dip == null || rake == null) return;
  return { strike, dip, rake };
}

/**
 * Project the `products` blob USGS attaches to a single-event response into flat,
 * named fields. Groups the event does not carry are omitted, never nulled — a bare
 * automatic event usually has only `origin` and `phase-data`. Nothing here costs a
 * second request; every value is already in the response `getEvent` makes.
 */
function projectDetail(
  products: Record<string, UsgsProduct[] | undefined> | undefined,
): EarthquakeEventDetail | undefined {
  if (!products) return;

  const pager = products.losspager?.[0] as UsgsProduct<UsgsLossPagerProperties> | undefined;
  const shakemap = products.shakemap?.[0] as UsgsProduct<UsgsShakeMapProperties> | undefined;
  const dyfi = products.dyfi?.[0] as UsgsProduct<UsgsDyfiProperties> | undefined;
  const fault = products['finite-fault']?.[0] as UsgsProduct<UsgsFiniteFaultProperties> | undefined;
  const tensorProps = products['moment-tensor']?.[0]?.properties as
    | UsgsMomentTensorProperties
    | undefined;
  const failureProps = products['ground-failure']?.[0]?.properties as
    | UsgsGroundFailureProperties
    | undefined;
  const originProps = products.origin?.[0]?.properties as UsgsOriginProperties | undefined;
  const codeVersion = shakemap?.properties?.['shakemap-code-version'];
  const rawPgv = num(shakemap?.properties?.maxpgv);
  // This producer revision exported ln(cm/s); later 4.0.2 revisions publish linear PGV.
  const maxPgv =
    rawPgv !== undefined &&
    (codeVersion === '4.0.2+335.gcbad862' || codeVersion === '4.0.2+335.gcbad862.dirty')
      ? Math.exp(rawPgv)
      : rawPgv;

  return group({
    ...maybe(
      'losspager',
      group({
        ...maybe('alert_level', pager?.properties?.alertlevel),
        ...maybe('report_url', contentUrl(pager, 'onepager.pdf')),
      }),
    ),
    ...maybe(
      'shakemap',
      group({
        ...maybe('max_mmi', num(shakemap?.properties?.maxmmi)),
        ...maybe('max_pga', num(shakemap?.properties?.maxpga)),
        ...maybe('max_pgv', Number.isFinite(maxPgv) ? maxPgv : undefined),
        ...maybe('code_version', codeVersion),
        ...maybe(
          'intensity_map_url',
          contentUrl(shakemap, 'download/intensity.jpg', 'download/intensity.pdf'),
        ),
      }),
    ),
    ...maybe(
      'dyfi',
      group({
        ...maybe('responses', num(dyfi?.properties?.['num-responses'])),
        ...maybe('max_cdi', num(dyfi?.properties?.maxmmi)),
        ...maybe('map_url', contentUrl(dyfi, '_ciim.jpg', '_ciim.pdf')),
      }),
    ),
    ...maybe(
      'moment_tensor',
      group({
        ...maybe('scalar_moment_nm', num(tensorProps?.['scalar-moment'])),
        ...maybe('derived_depth_km', num(tensorProps?.['derived-depth'])),
        ...maybe(
          'nodal_plane_1',
          nodalPlane(
            num(tensorProps?.['nodal-plane-1-strike']),
            num(tensorProps?.['nodal-plane-1-dip']),
            num(tensorProps?.['nodal-plane-1-rake']),
          ),
        ),
        ...maybe(
          'nodal_plane_2',
          nodalPlane(
            num(tensorProps?.['nodal-plane-2-strike']),
            num(tensorProps?.['nodal-plane-2-dip']),
            num(tensorProps?.['nodal-plane-2-rake']),
          ),
        ),
      }),
    ),
    ...maybe(
      'ground_failure',
      group({
        ...maybe('landslide_alert', failureProps?.['landslide-alert']),
        ...maybe('liquefaction_alert', failureProps?.['liquefaction-alert']),
      }),
    ),
    ...maybe(
      'origin',
      group({
        ...maybe('azimuthal_gap_deg', num(originProps?.['azimuthal-gap'])),
        ...maybe('num_stations_used', num(originProps?.['num-stations-used'])),
        ...maybe('horizontal_error_km', num(originProps?.['horizontal-error'])),
        ...maybe('depth_error_km', num(originProps?.['vertical-error'])),
        ...maybe('review_status', originProps?.['review-status']),
      }),
    ),
    ...maybe(
      'finite_fault',
      group({
        ...maybe('rupture_length_km', num(fault?.properties?.['model-length'])),
        ...maybe('rupture_width_km', num(fault?.properties?.['model-width'])),
        ...maybe('model_url', contentUrl(fault, 'FFM.geojson', 'basic_inversion.param')),
      }),
    ),
  });
}

export class UsgsService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    _config: AppConfig,
    _storage: StorageService,
    usgsBaseUrl: string,
    timeoutMs: number,
  ) {
    this.baseUrl = usgsBaseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** Fetch a pre-computed USGS real-time feed. */
  getFeed(
    magnitudeTier: 'all' | '1.0' | '2.5' | '4.5' | 'significant',
    timeWindow: 'hour' | 'day' | 'week' | 'month',
    ctx: Context,
  ): Promise<{ events: EarthquakeEvent[]; generatedAt: string; count: number; feedUrl: string }> {
    const feedUrl = `${this.baseUrl}/earthquakes/feed/v1.0/summary/${magnitudeTier}_${timeWindow}.geojson`;
    const reqCtx = makeReqCtx('UsgsService.getFeed', ctx);

    return withRetry(
      async ({ signal, remainingMs }) => {
        const response = await fetchWithTimeout(
          feedUrl,
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
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'USGS returned HTML instead of GeoJSON — likely rate-limited or a CDN error.',
            { feedUrl },
          );
        }

        const data = JSON.parse(text) as UsgsFeatureCollection;
        const events = data.features.map(normalizeUsgsFeature);

        return {
          events,
          generatedAt: epochMsToIso(data.metadata.generated),
          count: data.metadata.count,
          feedUrl: data.metadata.url ?? feedUrl,
        };
      },
      {
        operation: 'UsgsService.getFeed',
        deadlineMs: 50_000,
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Query USGS FDSN event API. `params.offset` pages through the match set
   * (1-based, forwarded upstream). Nonempty short pages establish their total
   * before byte shaping; an empty first page establishes zero.
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
    const url = `${this.baseUrl}/fdsnws/event/1/query?format=geojson&${query}`;
    const reqCtx = makeReqCtx('UsgsService.searchEvents', ctx);
    const deadline = Date.now() + 50_000;

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
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('USGS returned HTML instead of GeoJSON.', { url });
        }

        const data = JSON.parse(text) as UsgsFeatureCollection;
        const events = data.features.map(normalizeUsgsFeature);

        return {
          events,
          count: events.length,
        };
      },
      {
        operation: 'UsgsService.searchEvents',
        deadlineMs: 50_000,
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    // Infer short-page totals before byte shaping. Empty later pages cannot establish
    // the total; full pages use the count endpoint without making count failure fatal.
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
        if (
          ctx.signal?.aborted ||
          (err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled)
        )
          throw err;
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
   * Fetch a single event by USGS event ID. The single-event response carries a
   * `products` blob the list responses omit; it is projected into `detail` here
   * so the caller gets more than a search result already holds, without a second
   * request. `detail` is absent when the event carries no projectable product.
   */
  async getEvent(
    eventId: string,
    ctx: Context,
  ): Promise<{ event: EarthquakeEvent; detail?: EarthquakeEventDetail }> {
    eventId = eventId.trim();
    if (eventId.length === 0) {
      throw validationError('Provide a nonblank USGS event ID from a feed or search result.');
    }
    const url = `${this.baseUrl}/fdsnws/event/1/query?eventid=${encodeURIComponent(eventId)}&format=geojson`;
    const reqCtx = makeReqCtx('UsgsService.getEvent', ctx);

    return await withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
            signal: ctx.signal,
            headers: { Accept: 'application/json' },
          });
        } catch (err) {
          if (err instanceof McpError && err.data?.status === 409) {
            throw notFound('This earthquake event was deleted by USGS.', {
              reason: 'event_deleted',
              retryable: false,
              eventId,
            });
          }
          throw err;
        }

        // fetchWithTimeout throws McpError(NotFound) for 404 before we reach here.
        // Non-404 non-2xx responses are also thrown by fetchWithTimeout.

        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('USGS returned HTML instead of GeoJSON.', { eventId });
        }

        if (text.trim().length === 0) {
          throw notFound('USGS returned no event for the requested ID.', { eventId });
        }
        const raw = JSON.parse(text) as UsgsFeature | UsgsFeatureCollection;
        const requestedId = eventId.toLowerCase();
        if (
          raw.type !== 'Feature' ||
          (raw.id.toLowerCase() !== requestedId &&
            !raw.properties.ids?.split(',').some((id) => id.trim().toLowerCase() === requestedId))
        ) {
          throw notFound(
            `No earthquake event found for ID "${eventId}". Verify the ID from a feed or search result.`,
            { eventId },
          );
        }
        const feature = raw;
        const detail = projectDetail(feature.properties.products);
        return {
          event: normalizeUsgsFeature(feature),
          ...(detail ? { detail } : {}),
        };
      },
      {
        operation: 'UsgsService.getEvent',
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
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
    const url = `${this.baseUrl}/fdsnws/event/1/count?format=geojson&${query}`;
    const reqCtx = makeReqCtx('UsgsService.countEvents', ctx);

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
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('USGS returned HTML instead of JSON.', { url });
        }

        const data = JSON.parse(text) as UsgsCountResponse;
        const maxAllowed = data.maxAllowed ?? 20000;
        return {
          count: data.count,
          maxAllowed,
          exceedsLimit: data.count > maxAllowed,
        };
      },
      {
        operation: 'UsgsService.countEvents',
        ...(deadlineMs != null ? { deadlineMs } : {}),
        context: reqCtx,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  /** Build FDSN query string from params. */
  private buildFdsnQuery(params: EarthquakeQueryParams): string {
    const q = new URLSearchParams();

    // != null, not truthy: an empty value must reach the querystring rather than be
    // silently dropped, so a tool's queryEcho can never report a filter that was not sent.
    if (params.startTime != null) q.set('starttime', params.startTime);
    if (params.endTime != null) q.set('endtime', params.endTime);
    if (params.minMagnitude != null) q.set('minmagnitude', String(params.minMagnitude));
    if (params.maxMagnitude != null) q.set('maxmagnitude', String(params.maxMagnitude));
    if (params.magnitudeType != null) q.set('magnitudetype', params.magnitudeType);
    if (params.productType != null) q.set('producttype', params.productType);
    if (params.reviewStatus != null) q.set('reviewstatus', params.reviewStatus);
    if (params.latitude != null) q.set('latitude', String(params.latitude));
    if (params.longitude != null) q.set('longitude', String(params.longitude));
    if (params.radiusKm != null) q.set('maxradiuskm', String(params.radiusKm));
    if (params.minLatitude != null) q.set('minlatitude', String(params.minLatitude));
    if (params.maxLatitude != null) q.set('maxlatitude', String(params.maxLatitude));
    if (params.minLongitude != null) q.set('minlongitude', String(params.minLongitude));
    if (params.maxLongitude != null) q.set('maxlongitude', String(params.maxLongitude));
    if (params.minDepthKm != null) q.set('mindepth', String(params.minDepthKm));
    if (params.maxDepthKm != null) q.set('maxdepth', String(params.maxDepthKm));
    // minalertlevel, not alertlevel: USGS defines alertlevel as an exact match, which
    // would drop yellow/orange/red events from the minimum the input documents.
    if (params.alertLevel) q.set('minalertlevel', params.alertLevel);
    if (params.minFelt != null) q.set('minfelt', String(params.minFelt));
    if (params.minSignificance != null) q.set('minsig', String(params.minSignificance));
    if (params.eventType != null) q.set('eventtype', params.eventType);
    if (params.limit != null) q.set('limit', String(params.limit));
    // FDSN offset is 1-based — offset=1 is the first match, and 0 is rejected.
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.orderBy) q.set('orderby', params.orderBy);

    return q.toString();
  }
}

// --- Init/accessor pattern ---

let _service: UsgsService | undefined;

export function initUsgsService(
  config: AppConfig,
  storage: StorageService,
  usgsBaseUrl: string,
  timeoutMs: number,
): void {
  _service = new UsgsService(config, storage, usgsBaseUrl, timeoutMs);
}

export function getUsgsService(): UsgsService {
  if (!_service) {
    throw new Error('UsgsService not initialized — call initUsgsService() in setup()');
  }
  return _service;
}
