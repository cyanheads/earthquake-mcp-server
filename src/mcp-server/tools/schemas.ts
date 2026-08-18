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
  event_type: z
    .string()
    .optional()
    .describe(
      'What kind of event this is, in one vocabulary whichever source served it — the QuakeML ' +
        'type names USGS publishes ("earthquake", "quarry blast", "explosion", "ice quake"). ' +
        "EMSC's two-character code is decoded to the same names, so the same event carries the " +
        'same value from either source; how sure the source is rides on event_certainty instead. ' +
        'A code outside the published nomenclature is forwarded verbatim rather than guessed at. ' +
        'Not every record in either catalog is a tectonic earthquake. Absent when the source ' +
        'publishes no classification.',
    ),
  event_certainty: z
    .enum(['known', 'suspected', 'unknown', 'unreported'])
    .optional()
    .describe(
      'How certain the source is of event_type: "known" (asserted), "suspected", "unknown", or ' +
        '"unreported". EMSC publishes this as the first character of its event-type code — ' +
        'a suspected explosion is not a confirmed one, and this is the only field that says so. ' +
        'Absent for USGS, which publishes no certainty axis, and absent for an EMSC code outside ' +
        'the published nomenclature.',
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
    .describe(
      'Slip direction in degrees (-180 to 180). Near 90 is reverse faulting, near -90 normal, near 0 or 180 strike-slip.',
    ),
});

/**
 * Curated projection of the analysis products USGS attaches to a single-event
 * response. Every group is optional and omitted when the event carries no such
 * product — absence means "not produced for this event", never zero.
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
      'PAGER impact assessment. Estimated fatality and economic-loss brackets live in a separate ' +
        'content file and are not part of this response — fetch report_url for them.',
    ),
  shakemap: z
    .object({
      max_mmi: z
        .number()
        .optional()
        .describe(
          'Maximum modeled shaking intensity across the ShakeMap grid (Modified Mercalli).',
        ),
      max_pga: z
        .number()
        .optional()
        .describe(
          'Maximum modeled peak ground acceleration, in g — a fraction of standard gravity, ' +
            'as USGS ShakeMap publishes it (0.4 is four tenths of g).',
        ),
      max_pgv: z.number().optional().describe('Maximum modeled peak ground velocity, in cm/s.'),
      intensity_map_url: z
        .string()
        .optional()
        .describe('URL of the rendered ShakeMap intensity map image.'),
    })
    .optional()
    .describe('ShakeMap modeled ground-motion summary. Absent when no ShakeMap was produced.'),
  dyfi: z
    .object({
      responses: z
        .number()
        .optional()
        .describe('Number of "Did You Feel It?" reports the public submitted.'),
      max_cdi: z
        .number()
        .optional()
        .describe('Maximum Community Decimal Intensity derived from those reports (0–12 scale).'),
      map_url: z.string().optional().describe('URL of the rendered DYFI intensity map image.'),
    })
    .optional()
    .describe('Felt-report summary. Absent when no DYFI product exists for the event.'),
  moment_tensor: z
    .object({
      scalar_moment_nm: z
        .number()
        .optional()
        .describe('Scalar seismic moment in newton-metres — the physical size of the rupture.'),
      derived_depth_km: z
        .number()
        .optional()
        .describe('Centroid depth in kilometers derived from the moment-tensor inversion.'),
      nodal_plane_1: NodalPlaneSchema.optional().describe(
        'First nodal plane of the focal mechanism. Either plane can be the true fault.',
      ),
      nodal_plane_2: NodalPlaneSchema.optional().describe(
        'Second nodal plane — the auxiliary solution, indistinguishable from the first on seismic data alone.',
      ),
    })
    .optional()
    .describe('Focal-mechanism solution. Absent for events with no moment-tensor inversion.'),
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
    .describe('Secondary-hazard alert levels. Absent when no ground-failure model was run.'),
  origin: z
    .object({
      azimuthal_gap_deg: z
        .number()
        .optional()
        .describe(
          'Largest azimuthal gap between stations, in degrees. Gaps above ~180 make the location poorly constrained.',
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
        .describe('Review state of the origin solution as the contributing network published it.'),
    })
    .optional()
    .describe('Location-quality metrics for the preferred origin.'),
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
    .describe('Finite-fault rupture model. Produced only for large events.'),
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
      '_No analysis products on this event — USGS publishes them for larger or reviewed events._',
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
