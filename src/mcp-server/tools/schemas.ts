/**
 * @fileoverview Shared Zod schemas for earthquake event output fields used across tool definitions.
 * @module mcp-server/tools/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Zod schema for a normalized earthquake event returned by feeds and search results. */
export const EarthquakeEventSchema = z.object({
  id: z.string().describe('USGS or EMSC event identifier.'),
  title: z.string().describe('Event summary, e.g. "M 6.0 - Hawaii".'),
  magnitude: z
    .number()
    .nullable()
    .describe('Preferred magnitude; null if not computed (title: "M ?").'),
  magnitude_type: z.string().describe('Magnitude type (ml, mww, mw, mb, etc.).'),
  time: z.string().describe('ISO 8601 UTC origin time.'),
  updated: z.string().describe('ISO 8601 UTC time this record was last updated.'),
  place: z.string().describe('Nearest named location.'),
  latitude: z.number().describe('Epicenter latitude in decimal degrees.'),
  longitude: z.number().describe('Epicenter longitude in decimal degrees.'),
  depth_km: z.number().nullable().describe('Hypocenter depth in km; null if unmeasured.'),
  felt: z
    .number()
    .nullable()
    .describe(
      'DYFI (Did You Feel It?) response count; null if no USGS reports or source has no DYFI (EMSC). Null does not mean unfelt.',
    ),
  cdi: z
    .number()
    .nullable()
    .describe(
      'Maximum DYFI Community Decimal Intensity (0–12); null if uncomputed or unsupported (EMSC).',
    ),
  mmi: z
    .number()
    .nullable()
    .describe(
      'Maximum ShakeMap Modified Mercalli intensity (0–12); null without a ShakeMap or for EMSC.',
    ),
  alert: z
    .enum(['green', 'yellow', 'orange', 'red'])
    .nullable()
    .describe('PAGER estimated impact; null without an assessment or for EMSC.'),
  tsunami: z
    .number()
    .nullable()
    .describe(
      'USGS tsunami flag: 1 for large oceanic events, 0 otherwise; null if unpublished (EMSC). Not a warning or evidence of a tsunami; check NOAA tsunami.gov for alerts.',
    ),
  significance: z
    .number()
    .nullable()
    .describe(
      'USGS significance (0–2000+), combining magnitude, felt reports and PAGER; null if uncomputed or for EMSC.',
    ),
  status: z
    .enum(['automatic', 'reviewed', 'deleted'])
    .nullable()
    .describe(
      'Review state: automatic (unverified), reviewed (analyst checked), or deleted. Null if unpublished (EMSC); such solutions remain unverified and subject to revision.',
    ),
  source_catalog: z
    .string()
    .optional()
    .describe('Solution catalog, e.g. EMSC-RTS (real-time, subject to revision). Absent for USGS.'),
  auth: z
    .string()
    .optional()
    .describe('Authoritative agency/network code (EMSC auth or USGS net); absent if unpublished.'),
  event_type: z
    .string()
    .optional()
    .describe(
      'QuakeML classification (earthquake, quarry blast, explosion, etc.). EMSC codes decode to USGS names; unknown codes pass through verbatim. Certainty is separate. Absent if unpublished; either catalog includes non-tectonic events.',
    ),
  event_certainty: z
    .enum(['known', 'suspected', 'unknown', 'unreported'])
    .optional()
    .describe(
      'EMSC classification certainty: known (asserted), suspected, unknown, or unreported. Suspected is not confirmed. Absent for USGS and unrecognized EMSC codes.',
    ),
  event_url: z.string().optional().describe('USGS event page URL. Present for USGS events only.'),
  detail_url: z
    .string()
    .optional()
    .describe('URL to fetch the full GeoJSON detail record. Present in USGS list responses.'),
});

/** Inferred from EarthquakeEventSchema — the output type for a normalized earthquake event. */
export type EarthquakeEventOutput = z.infer<typeof EarthquakeEventSchema>;

/** One nodal plane of a moment-tensor solution. */
const NodalPlaneSchema = z.object({
  strike: z.number().describe('Fault plane strike in degrees clockwise from north (0–360).'),
  dip: z.number().describe('Fault plane dip in degrees from horizontal (0–90).'),
  rake: z
    .number()
    .describe('Slip direction, degrees (-180..180): ~90 reverse, ~-90 normal, ~0/180 strike-slip.'),
});

/**
 * Curated projection of the analysis products USGS attaches to a single-event
 * response. Every group is optional and omitted when no projected field is
 * available. Absence never implies zero impact or proves no product was produced.
 */
export const EarthquakeDetailSchema = z.object({
  losspager: z
    .object({
      alert_level: z
        .string()
        .optional()
        .describe('PAGER impact alert level — "green", "yellow", "orange", or "red".'),
      report_url: z
        .string()
        .optional()
        .describe('URL of the PAGER one-page PDF summary of estimated impact.'),
    })
    .optional()
    .describe(
      'PAGER assessment; fatality/economic-loss brackets are in report_url, not this projection. Absent without projected fields.',
    ),
  shakemap: z
    .object({
      code_version: z
        .string()
        .optional()
        .describe('ShakeMap producer code version reported by USGS.'),
      max_mmi: z
        .number()
        .optional()
        .describe(
          'Maximum modeled shaking intensity across the ShakeMap grid (Modified Mercalli).',
        ),
      max_pga: z
        .number()
        .optional()
        .describe('Maximum modeled peak ground acceleration, in g (fraction of standard gravity).'),
      max_pgv: z.number().optional().describe('Maximum modeled peak ground velocity, in cm/s.'),
      intensity_map_url: z
        .string()
        .optional()
        .describe('URL of the rendered ShakeMap intensity map image.'),
    })
    .optional()
    .describe('ShakeMap modeled ground-motion summary. Absent without projected fields.'),
  dyfi: z
    .object({
      responses: z.number().optional().describe('Public DYFI (Did You Feel It?) report count.'),
      max_cdi: z
        .number()
        .optional()
        .describe('Maximum Community Decimal Intensity derived from those reports (0–12 scale).'),
      map_url: z.string().optional().describe('URL of the rendered DYFI intensity map image.'),
    })
    .optional()
    .describe('Felt-report summary. Absent without projected fields.'),
  moment_tensor: z
    .object({
      scalar_moment_nm: z.number().optional().describe('Scalar seismic moment, newton-metres.'),
      derived_depth_km: z.number().optional().describe('Moment-tensor centroid depth, km.'),
      nodal_plane_1: NodalPlaneSchema.optional().describe(
        'First nodal plane; either plane may be the fault.',
      ),
      nodal_plane_2: NodalPlaneSchema.optional().describe(
        'Auxiliary nodal plane; seismic data alone cannot distinguish the true fault.',
      ),
    })
    .optional()
    .describe('Focal mechanism; absent without projected fields.'),
  ground_failure: z
    .object({
      landslide_alert: z
        .string()
        .optional()
        .describe('Landslide hazard alert level — "green", "yellow", "orange", or "red".'),
      liquefaction_alert: z
        .string()
        .optional()
        .describe('Liquefaction hazard alert level — "green", "yellow", "orange", or "red".'),
    })
    .optional()
    .describe('Secondary-hazard alert levels. Absent without projected fields.'),
  origin: z
    .object({
      azimuthal_gap_deg: z
        .number()
        .optional()
        .describe(
          'Largest station azimuthal gap, degrees; >~180 means poorly constrained location.',
        ),
      num_stations_used: z
        .number()
        .optional()
        .describe('Number of seismic stations used in the location solution.'),
      horizontal_error_km: z
        .number()
        .optional()
        .describe('Horizontal location uncertainty in kilometers.'),
      depth_error_km: z.number().optional().describe('Depth uncertainty in kilometers.'),
      review_status: z
        .string()
        .optional()
        .describe('Origin review state published by its network.'),
    })
    .optional()
    .describe(
      'Location-quality metrics for the preferred origin; absent without projected fields.',
    ),
  finite_fault: z
    .object({
      rupture_length_km: z
        .number()
        .optional()
        .describe('Modeled rupture length along strike, in kilometers.'),
      rupture_width_km: z
        .number()
        .optional()
        .describe('Modeled rupture width down dip, in kilometers.'),
      model_url: z.string().optional().describe('URL of the finite-fault rupture model file.'),
    })
    .optional()
    .describe('Finite-fault rupture model for large events; absent without projected fields.'),
});

/** Inferred from EarthquakeDetailSchema — the product projection for a single event. */
export type EarthquakeDetailOutput = z.infer<typeof EarthquakeDetailSchema>;

/** Render a projected field with its unit, or say the product omitted it. Never implies zero. */
function detailValue(value: number | string | undefined, unit = ''): string {
  return value == null ? 'not published' : `${value}${unit}`;
}

/**
 * Render the product projection as markdown lines. Renders every schema field for
 * format-parity, and says so plainly when a group is absent rather than implying zero.
 */
export function formatEventDetail(detail: EarthquakeDetailOutput | undefined): string[] {
  const lines: string[] = ['', '### Analysis products'];
  if (detail == null || Object.keys(detail).length === 0) {
    lines.push(
      '_No projected analysis fields are available for this event; this does not imply zero impact._',
    );
    return lines;
  }

  const pager = detail.losspager;
  if (pager) {
    lines.push(
      `**PAGER:** Alert level: ${detailValue(pager.alert_level)}` +
        (pager.report_url ? ` | Report: ${pager.report_url}` : ''),
    );
  }

  const shakemap = detail.shakemap;
  if (shakemap) {
    lines.push(
      `**ShakeMap:** Max MMI: ${detailValue(shakemap.max_mmi)} | ` +
        `Max PGA: ${detailValue(shakemap.max_pga, ' g')} | ` +
        `Max PGV: ${detailValue(shakemap.max_pgv, ' cm/s')}` +
        (shakemap.code_version ? ` | Code version: ${shakemap.code_version}` : '') +
        (shakemap.intensity_map_url ? ` | Intensity map: ${shakemap.intensity_map_url}` : ''),
    );
  }

  const dyfi = detail.dyfi;
  if (dyfi) {
    lines.push(
      `**DYFI:** Responses: ${detailValue(dyfi.responses)} | ` +
        `Max CDI: ${detailValue(dyfi.max_cdi)}` +
        (dyfi.map_url ? ` | Map: ${dyfi.map_url}` : ''),
    );
  }

  const tensor = detail.moment_tensor;
  if (tensor) {
    const planes = [tensor.nodal_plane_1, tensor.nodal_plane_2]
      .map((plane, index) =>
        plane
          ? `Nodal plane ${index + 1}: strike ${plane.strike}°, dip ${plane.dip}°, rake ${plane.rake}°`
          : undefined,
      )
      .filter((text) => text != null);
    lines.push(
      `**Moment tensor:** Scalar moment: ${detailValue(tensor.scalar_moment_nm, ' N·m')} | ` +
        `Derived depth: ${detailValue(tensor.derived_depth_km, ' km')}` +
        (planes.length > 0 ? ` | ${planes.join(' | ')}` : ''),
    );
  }

  const failure = detail.ground_failure;
  if (failure) {
    lines.push(
      `**Ground failure:** Landslide alert: ${detailValue(failure.landslide_alert)} | ` +
        `Liquefaction alert: ${detailValue(failure.liquefaction_alert)}`,
    );
  }

  const origin = detail.origin;
  if (origin) {
    lines.push(
      `**Origin quality:** Azimuthal gap: ${detailValue(origin.azimuthal_gap_deg, '°')} | ` +
        `Stations used: ${detailValue(origin.num_stations_used)} | ` +
        `Horizontal error: ${detailValue(origin.horizontal_error_km, ' km')} | ` +
        `Depth error: ${detailValue(origin.depth_error_km, ' km')} | ` +
        `Review status: ${detailValue(origin.review_status)}`,
    );
  }

  const fault = detail.finite_fault;
  if (fault) {
    lines.push(
      `**Finite fault:** Rupture length: ${detailValue(fault.rupture_length_km, ' km')} | ` +
        `Rupture width: ${detailValue(fault.rupture_width_km, ' km')}` +
        (fault.model_url ? ` | Model: ${fault.model_url}` : ''),
    );
  }

  return lines;
}

/** Format a single earthquake event as markdown lines. Renders all schema fields for format-parity. */
export function formatEvent(event: EarthquakeEventOutput): string[] {
  const lines: string[] = [];
  lines.push(`## ${event.title}`);
  lines.push(
    `**ID:** ${event.id} | **Magnitude:** ${event.magnitude !== null ? event.magnitude : 'unknown'} (${event.magnitude_type}) | **Depth:** ${event.depth_km !== null ? `${event.depth_km} km` : 'unknown'}`,
  );
  lines.push(`**Place:** ${event.place}`);
  // USGS titles carry the classification for non-earthquakes, EMSC titles never do.
  // Rendering anything other than a plain "earthquake" keeps quarry blasts and
  // explosions from reading as seismicity in the text-only surface. An asserted
  // certainty is the unremarkable case and stays out on its own, but anything less
  // than "known" makes even a plain earthquake worth a line — and once the line is
  // rendered the certainty travels with it, so a suspected explosion in content[]
  // can never read as a confirmed one.
  const unusualType = event.event_type != null && event.event_type !== 'earthquake';
  const unusualCertainty = event.event_certainty != null && event.event_certainty !== 'known';
  if (unusualType || unusualCertainty) {
    lines.push(
      `**Event type:** ${event.event_type ?? 'not published by source'}` +
        (event.event_certainty != null ? ` (certainty: ${event.event_certainty})` : ''),
    );
  }
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
