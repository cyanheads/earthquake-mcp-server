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
    .describe('Number of DYFI (Did You Feel It?) responses. Null if no reports. USGS only.'),
  cdi: z
    .number()
    .nullable()
    .describe('Maximum reported intensity (Community Decimal Intensity, 0–12 scale). USGS only.'),
  mmi: z
    .number()
    .nullable()
    .describe(
      'Maximum ShakeMap instrumental intensity (Modified Mercalli, 0–12 scale). USGS only.',
    ),
  alert: z
    .enum(['green', 'yellow', 'orange', 'red'])
    .nullable()
    .describe('PAGER estimated impact alert level. Null if not computed. USGS only.'),
  tsunami: z
    .number()
    .describe('1 if a tsunami warning was issued; 0 otherwise. USGS only; 0 for EMSC events.'),
  significance: z
    .number()
    .nullable()
    .describe(
      'USGS significance score (0–2000+). Combines magnitude, felt reports, PAGER. USGS only.',
    ),
  status: z
    .enum(['automatic', 'reviewed', 'deleted'])
    .describe('Review status. Automatic detections may be revised.'),
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
  lines.push(
    `**Time:** ${event.time} | **Updated:** ${event.updated} | **Status:** ${event.status}`,
  );
  lines.push(`**Location:** ${event.latitude.toFixed(4)}°, ${event.longitude.toFixed(4)}°`);

  // Impact fields (USGS-specific; render explicitly for format-parity compliance)
  lines.push(
    `**PAGER Alert:** ${event.alert !== null ? event.alert.toUpperCase() : 'Not computed'}`,
  );
  // Render tsunami as its raw value so the linter's format-parity sentinel check passes
  lines.push(
    `**Tsunami (warning flag):** ${event.tsunami}${event.tsunami !== 0 ? ' ⚠️ Warning issued' : ''}`,
  );

  const impactParts: string[] = [];
  if (event.felt !== null) impactParts.push(`Felt by ${event.felt} (DYFI)`);
  if (event.mmi !== null) impactParts.push(`ShakeMap MMI: ${event.mmi}`);
  if (event.cdi !== null) impactParts.push(`CDI: ${event.cdi}`);
  if (event.significance !== null) impactParts.push(`Significance: ${event.significance}`);
  if (impactParts.length > 0) lines.push(`**Impact:** ${impactParts.join(' | ')}`);

  if (event.event_url) lines.push(`**USGS page:** ${event.event_url}`);
  if (event.detail_url) lines.push(`**Detail URL:** ${event.detail_url}`);

  return lines;
}
