/**
 * @fileoverview Resolves the opt-in include groups of an event lookup — alternative
 * origins, magnitudes, phase arrivals, and the aftershock forecast — from the products
 * on a USGS single-event response.
 * @module services/usgs/event-includes
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { isCancellation } from '../upstream-call.js';
import { projectAftershockForecast } from './aftershock-forecast.js';
import { maybe, num } from './product-fields.js';
import { parsePhaseData, projectArrivals, projectMagnitudes } from './quakeml.js';
import {
  EVENT_INCLUDE_GROUPS,
  type EventIncludeGroup,
  type EventIncludes,
  type EventOrigin,
  type UnavailableInclude,
  type UsgsOriginProperties,
  type UsgsProduct,
} from './types.js';

/** Fetches one product content file as text; throws on any failure. */
type ProductTextFetcher = (url: string) => Promise<string>;

/** Requested groups deduplicated, in the canonical order responses report them. */
export function normalizeIncludeGroups(
  requested: readonly EventIncludeGroup[] | undefined,
): EventIncludeGroup[] {
  return EVENT_INCLUDE_GROUPS.filter((group) => requested?.includes(group));
}

/**
 * Every requested group reported as `not_published`, for an event whose source carries
 * no USGS products at all. Empty when nothing was requested.
 */
export function unpublishedIncludes(groups: readonly EventIncludeGroup[]): EventIncludes {
  return groups.length === 0
    ? {}
    : { unavailable_includes: groups.map((group) => ({ group, reason: 'not_published' })) };
}

/** One `origin` product's properties; the first product is the one USGS prefers. */
function projectOrigin(product: UsgsProduct<UsgsOriginProperties>, index: number): EventOrigin {
  const p = product.properties;
  return {
    ...maybe('source', product.source),
    ...maybe('event_id', product.code),
    is_preferred: index === 0,
    ...maybe('time', p?.eventtime),
    ...maybe('latitude', num(p?.latitude)),
    ...maybe('longitude', num(p?.longitude)),
    ...maybe('depth_km', num(p?.depth)),
    ...maybe('depth_type', p?.['depth-type']),
    ...maybe('magnitude', num(p?.magnitude)),
    ...maybe('magnitude_type', p?.['magnitude-type']),
    ...maybe('review_status', p?.['review-status']),
    ...maybe('evaluation_status', p?.['evaluation-status']),
    ...maybe('num_stations_used', num(p?.['num-stations-used'])),
    ...maybe('num_phases_used', num(p?.['num-phases-used'])),
    ...maybe('azimuthal_gap_deg', num(p?.['azimuthal-gap'])),
    ...maybe('standard_error_s', num(p?.['standard-error'])),
    ...maybe('minimum_distance_deg', num(p?.['minimum-distance'])),
    ...maybe('horizontal_error_km', num(p?.['horizontal-error'])),
    ...maybe('depth_error_km', num(p?.['vertical-error'])),
  };
}

/** Run a product fetch-and-parse; a failure degrades to `undefined`, a cancellation rethrows. */
async function settle<T>(
  task: () => Promise<T>,
  label: string,
  ctx: Context,
): Promise<T | undefined> {
  try {
    return await task();
  } catch (err) {
    if (isCancellation(err, ctx)) throw err;
    ctx.log.warning(`${label} unavailable — reporting its include groups as fetch_failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
}

/** Run a synchronous projection; a throw degrades to `undefined`. */
function attempt<T>(project: () => T, label: string, ctx: Context): T | undefined {
  try {
    return project();
  } catch (err) {
    ctx.log.warning(`${label} did not project — reporting it as fetch_failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
}

/**
 * Resolve the requested groups against an event's products. `origins` reads the
 * response already fetched; `magnitudes` and `arrivals` share one fetch of the
 * preferred `phase-data` product's `quakeml.xml`; `aftershock_forecast` fetches the
 * `oaf` product's `forecast.json`. The two fetches run concurrently. A group whose
 * product the event lacks is `not_published` with no request; a failed fetch or
 * projection is `fetch_failed`. Cancellation propagates.
 */
export async function loadEventIncludes(
  groups: readonly EventIncludeGroup[],
  products: Record<string, UsgsProduct[] | undefined> | undefined,
  fetchText: ProductTextFetcher,
  ctx: Context,
): Promise<EventIncludes> {
  const wants = (group: EventIncludeGroup) => groups.includes(group);
  const unavailable = new Map<EventIncludeGroup, UnavailableInclude['reason']>();
  const includes: EventIncludes = {};

  const phaseGroups = groups.filter((g) => g === 'magnitudes' || g === 'arrivals');
  const phaseUrl = products?.['phase-data']?.[0]?.contents?.['quakeml.xml']?.url;
  const forecastUrl = products?.oaf?.[0]?.contents?.['forecast.json']?.url;

  const [phaseEvent, forecast] = await Promise.all([
    phaseGroups.length > 0 && phaseUrl != null
      ? settle(async () => parsePhaseData(await fetchText(phaseUrl)), 'Phase-data QuakeML', ctx)
      : undefined,
    wants('aftershock_forecast') && forecastUrl != null
      ? settle(
          async () => projectAftershockForecast(await fetchText(forecastUrl)),
          'Aftershock forecast',
          ctx,
        )
      : undefined,
  ]);

  if (wants('origins')) {
    const origins = (products?.origin ?? []).map((product, index) =>
      projectOrigin(product as UsgsProduct<UsgsOriginProperties>, index),
    );
    if (origins.length > 0) includes.origins = origins;
    else unavailable.set('origins', 'not_published');
  }

  if (phaseUrl == null) {
    for (const group of phaseGroups) unavailable.set(group, 'not_published');
  } else {
    if (wants('magnitudes')) {
      const magnitudes =
        phaseEvent && attempt(() => projectMagnitudes(phaseEvent), 'Magnitudes', ctx);
      if (magnitudes) includes.magnitudes = magnitudes;
      else unavailable.set('magnitudes', 'fetch_failed');
    }
    if (wants('arrivals')) {
      const arrivals = phaseEvent && attempt(() => projectArrivals(phaseEvent), 'Arrivals', ctx);
      if (arrivals) includes.arrivals = arrivals;
      else unavailable.set('arrivals', 'fetch_failed');
    }
  }

  if (wants('aftershock_forecast')) {
    if (forecastUrl == null) unavailable.set('aftershock_forecast', 'not_published');
    else if (forecast == null) unavailable.set('aftershock_forecast', 'fetch_failed');
    else includes.aftershock_forecast = forecast;
  }

  if (unavailable.size > 0) {
    includes.unavailable_includes = EVENT_INCLUDE_GROUPS.filter((g) => unavailable.has(g)).map(
      (group) => ({ group, reason: unavailable.get(group) as UnavailableInclude['reason'] }),
    );
  }
  return includes;
}
