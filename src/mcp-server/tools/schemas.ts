/**
 * @fileoverview Shared Zod schemas for earthquake event output fields used across tool definitions.
 * @module mcp-server/tools/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Zod schema for a normalized earthquake event returned by feeds and search results. */
export const EarthquakeEventSchema = z.object({
  id: z.string().describe('USGS or EMSC event identifier.'),
  title: z
    .string()
    .describe('Human-readable event summary, e.g. "M 6.0 - 13 km S of Honaunau-Napoopoo, Hawaii".'),
  magnitude: z
    .number()
    .nullable()
    .describe(
      'Preferred magnitude value. Null when no magnitude was computed for the event (the title renders it as "M ?").',
    ),
  magnitude_type: z.string().describe('Magnitude type (ml, mww, mw, mb, etc.).'),
  time: z.string().describe('ISO 8601 UTC origin time.'),
  updated: z.string().describe('ISO 8601 UTC time this record was last updated.'),
  place: z.string().describe('Nearest named location.'),
  latitude: z.number().describe('Epicenter latitude in decimal degrees.'),
  longitude: z.number().describe('Epicenter longitude in decimal degrees.'),
  depth_km: z
    .number()
    .nullable()
    .describe(
      'Hypocenter depth in kilometers. Shallow (<70 km), intermediate (70–300 km), or deep (>300 km). Null for historical events where depth was not measured.',
    ),
  felt: z
    .number()
    .nullable()
    .describe(
      'Number of DYFI (Did You Feel It?) responses. Null when USGS has received no reports for the event, and always null for EMSC, which publishes no DYFI field — a null is not evidence the event went unfelt.',
    ),
  cdi: z
    .number()
    .nullable()
    .describe(
      'Maximum reported intensity (Community Decimal Intensity, 0–12 scale), derived from DYFI responses. Null when USGS computed no DYFI intensity, and always null for EMSC, which publishes no such field.',
    ),
  mmi: z
    .number()
    .nullable()
    .describe(
      'Maximum ShakeMap instrumental intensity (Modified Mercalli, 0–12 scale). Null when USGS produced no ShakeMap for the event, and always null for EMSC, which publishes no such field.',
    ),
  alert: z
    .enum(['green', 'yellow', 'orange', 'red'])
    .nullable()
    .describe(
      'PAGER estimated impact alert level. Null when USGS ran no PAGER assessment, and always null for EMSC, which publishes no such field.',
    ),
  tsunami: z
    .number()
    .nullable()
    .describe(
      'USGS tsunami flag: 1 for large events in oceanic regions, 0 otherwise. It is not a warning — USGS states the flag does not indicate whether a tsunami did or will exist; check NOAA (tsunami.gov) for actual alert status. Null when the source publishes no such flag, as EMSC does not.',
    ),
  significance: z
    .number()
    .nullable()
    .describe(
      'USGS significance score (0–2000+). Combines magnitude, felt reports, PAGER. Null when USGS computed no score, and always null for EMSC, which publishes no such field.',
    ),
  status: z
    .enum(['automatic', 'reviewed', 'deleted'])
    .nullable()
    .describe(
      'Human-review state: "automatic" (posted by automatic processing, not yet verified by a person), "reviewed" (examined by an analyst), or "deleted". Null when the source publishes no review status — EMSC does not, so treat an EMSC solution as unverified and subject to revision rather than final.',
    ),
  source_catalog: z
    .string()
    .optional()
    .describe(
      'Upstream catalog this solution came from, e.g. "EMSC-RTS" (EMSC real-time seismicity, revised as analysis continues). Absent for USGS, which publishes no catalog identifier on event records.',
    ),
  auth: z
    .string()
    .optional()
    .describe(
      'Code of the agency or network the source names as authoritative for this solution, e.g. "NEIC", "BMKG", "NDI" from EMSC or "us", "ci", "ak" from USGS. Absent when the source reports none.',
    ),
  event_url: z.string().optional().describe('USGS event page URL. Present for USGS events only.'),
  detail_url: z
    .string()
    .optional()
    .describe('URL to fetch the full GeoJSON detail record. Present in USGS list responses.'),
});

/** Inferred from EarthquakeEventSchema — the output type for a normalized earthquake event. */
export type EarthquakeEventOutput = z.infer<typeof EarthquakeEventSchema>;

/** Format a single earthquake event as markdown lines. Renders all schema fields for format-parity. */
export function formatEvent(event: EarthquakeEventOutput): string[] {
  const lines: string[] = [];
  lines.push(`## ${event.title}`);
  lines.push(
    `**ID:** ${event.id} | **Magnitude:** ${event.magnitude !== null ? event.magnitude : 'unknown'} (${event.magnitude_type}) | **Depth:** ${event.depth_km !== null ? `${event.depth_km} km` : 'unknown'}`,
  );
  lines.push(`**Place:** ${event.place}`);
  lines.push(`**Time:** ${event.time} | **Updated:** ${event.updated}`);
  lines.push(`**Location:** ${event.latitude.toFixed(4)}°, ${event.longitude.toFixed(4)}°`);

  // Provenance — review state plus whatever catalog/agency the source named.
  // A null status is rendered, never dropped: it means the source publishes none.
  const provenance = [`Status: ${event.status ?? 'not published by source'}`];
  if (event.source_catalog) provenance.push(`Catalog: ${event.source_catalog}`);
  if (event.auth) provenance.push(`Agency: ${event.auth}`);
  lines.push(`**Provenance:** ${provenance.join(' | ')}`);

  lines.push(
    `**PAGER Alert:** ${event.alert !== null ? event.alert.toUpperCase() : 'Not computed'}`,
  );
  // Render tsunami as its raw value so the linter's format-parity sentinel check passes
  lines.push(
    `**Tsunami flag:** ${
      event.tsunami === null
        ? 'not published by source'
        : `${event.tsunami}${event.tsunami !== 0 ? ' ⚠️ Large oceanic event — check tsunami.gov for actual alert status' : ''}`
    }`,
  );

  // Every impact field reaches content[]: present ones with their value, absent
  // ones collected into one "Not reported" segment so a fully sparse event reads
  // as a single line rather than four.
  const impactParts: string[] = [];
  const notReported: string[] = [];
  if (event.felt !== null) impactParts.push(`Felt by ${event.felt} (DYFI)`);
  else notReported.push('DYFI felt reports');
  if (event.mmi !== null) impactParts.push(`ShakeMap MMI: ${event.mmi}`);
  else notReported.push('ShakeMap MMI');
  if (event.cdi !== null) impactParts.push(`CDI: ${event.cdi}`);
  else notReported.push('CDI');
  if (event.significance !== null) impactParts.push(`Significance: ${event.significance}`);
  else notReported.push('significance');
  if (notReported.length > 0) impactParts.push(`Not reported: ${notReported.join(', ')}`);
  lines.push(`**Impact:** ${impactParts.join(' | ')}`);

  if (event.event_url) lines.push(`**USGS page:** ${event.event_url}`);
  if (event.detail_url) lines.push(`**Detail URL:** ${event.detail_url}`);

  return lines;
}
