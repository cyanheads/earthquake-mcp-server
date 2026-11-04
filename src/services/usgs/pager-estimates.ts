/**
 * @fileoverview Projects the preferred `losspager` product's JSON content files — the
 * USGS PAGER loss and exposure estimates — into the `pager` include group.
 * @module services/usgs/pager-estimates
 */

import { z } from '@cyanheads/mcp-ts-core';
import { maybe, num } from './product-fields.js';
import type { PagerEstimates } from './types.js';

/**
 * The `losspager` content files the group reads. Every product that publishes them
 * lists them under `json/`; root-level copies appear only on recent products, and
 * products older than the JSON files list none of the three.
 */
export const PAGER_FILES = {
  alerts: 'json/alerts.json',
  exposures: 'json/exposures.json',
  comments: 'json/comments.json',
} as const;

/**
 * One alert of `alerts.json`; `type`, `units`, `gvalue`, and `summary` are ignored.
 * Bracket bounds are numeric strings upstream. The level and colors are labels a
 * bracket can do without, so they may be absent; bounds and probabilities are the
 * estimate itself, and a file without them fails the group.
 */
const RawAlertSchema = z.object({
  level: z.string().nullish(),
  bins: z.array(
    z.object({
      color: z.string().nullish(),
      min: z.string(),
      max: z.string(),
      probability: z.number(),
    }),
  ),
});

const RawAlertsSchema = z.object({ fatality: RawAlertSchema, economic: RawAlertSchema });

/** `population_exposure` of `exposures.json`; `maximum_border_mmi` and `economic_exposure` are ignored. */
const RawExposuresSchema = z.object({
  population_exposure: z.object({
    mmi: z.array(z.number()),
    aggregated_exposure: z.array(z.number()),
    country_exposures: z.array(
      z.object({ country_code: z.string(), exposure: z.array(z.number()) }),
    ),
  }),
});

/** The impact statements of `comments.json`; the structure, historical, and secondary comments are ignored. */
const RawCommentsSchema = z.object({
  impact1: z.string().nullish(),
  impact2: z.string().nullish(),
});

/** A bracket bound as a number; an unparseable one fails the group. */
function bound(value: string): number {
  const parsed = num(value);
  if (parsed === undefined) throw new Error('A PAGER bracket bound is not a number.');
  return parsed;
}

function projectAlert(alert: z.infer<typeof RawAlertSchema>): PagerEstimates['fatality'] {
  return {
    ...maybe('level', alert.level ?? undefined),
    bins: alert.bins.map((bin) => ({
      min: bound(bin.min),
      max: bound(bin.max),
      ...maybe('color', bin.color ?? undefined),
      probability: bin.probability,
    })),
  };
}

/**
 * Parse the PAGER content files into both alerts with every bracket, the impact
 * statements, and every exposure row, all in upstream order. `comments` is the text of
 * `json/comments.json` when the product lists it. Throws when a file is not JSON or
 * lacks a field the projection requires.
 */
export function projectPagerEstimates(files: {
  alerts: string;
  exposures: string;
  comments?: string | undefined;
}): PagerEstimates {
  const alerts = RawAlertsSchema.parse(JSON.parse(files.alerts));
  const exposure = RawExposuresSchema.parse(JSON.parse(files.exposures)).population_exposure;
  const comments =
    files.comments === undefined ? undefined : RawCommentsSchema.parse(JSON.parse(files.comments));
  const impact = [comments?.impact1, comments?.impact2].filter(
    (statement): statement is string => statement != null && statement.trim().length > 0,
  );
  return {
    fatality: projectAlert(alerts.fatality),
    economic: projectAlert(alerts.economic),
    ...maybe('impact', impact.length > 0 ? impact : undefined),
    exposure: {
      mmi: exposure.mmi,
      population: exposure.aggregated_exposure,
      countries: exposure.country_exposures.map((row) => ({
        country_code: row.country_code,
        population: row.exposure,
      })),
    },
  };
}
