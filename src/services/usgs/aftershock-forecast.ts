/**
 * @fileoverview Projects the `oaf` product's `forecast.json` — the USGS Operational
 * Aftershock Forecast — into the `aftershock_forecast` include group.
 * @module services/usgs/aftershock-forecast
 */

import { z } from '@cyanheads/mcp-ts-core';
import { maybe } from './product-fields.js';
import type { AftershockForecast } from './types.js';

/**
 * The fields read from `forecast.json`; everything else (fractiles, bar charts,
 * model parameters, observations, narrative text) is ignored. Times are epoch ms.
 */
const RawForecastSchema = z.object({
  advisoryTimeFrame: z.string(),
  creationTime: z.number(),
  expireTime: z.number(),
  nextForecastTime: z.number().nullish(),
  forecast: z.array(
    z.object({
      label: z.string(),
      timeStart: z.number(),
      timeEnd: z.number(),
      aboveMainshockMag: z.object({ magnitude: z.number(), probability: z.number() }).nullish(),
      bins: z.array(
        z.object({
          magnitude: z.number(),
          probability: z.number(),
          median: z.number().nullish(),
          p95minimum: z.number().nullish(),
          p95maximum: z.number().nullish(),
        }),
      ),
    }),
  ),
});

/** Epoch ms → ISO 8601 UTC; an out-of-range instant throws. */
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Parse `forecast.json` text into every window and bin in upstream order. Throws when
 * the text is not JSON or lacks a field the projection reads.
 */
export function projectAftershockForecast(json: string): AftershockForecast {
  const raw = RawForecastSchema.parse(JSON.parse(json));
  return {
    advisory_window: raw.advisoryTimeFrame,
    created: iso(raw.creationTime),
    expires: iso(raw.expireTime),
    ...maybe('next_update', raw.nextForecastTime == null ? undefined : iso(raw.nextForecastTime)),
    windows: raw.forecast.map((window) => ({
      label: window.label,
      start: iso(window.timeStart),
      end: iso(window.timeEnd),
      ...maybe(
        'above_mainshock',
        window.aboveMainshockMag == null
          ? undefined
          : {
              magnitude: window.aboveMainshockMag.magnitude,
              probability: window.aboveMainshockMag.probability,
            },
      ),
      bins: window.bins.map((bin) => ({
        magnitude: bin.magnitude,
        probability: bin.probability,
        ...maybe('count_median', bin.median ?? undefined),
        ...maybe('count_p95_min', bin.p95minimum ?? undefined),
        ...maybe('count_p95_max', bin.p95maximum ?? undefined),
      })),
    })),
  };
}
