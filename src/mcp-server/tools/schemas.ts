/**
 * @fileoverview Shared Zod schemas for earthquake event output fields used across tool definitions.
 * @module mcp-server/tools/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { EVENT_INCLUDE_GROUPS } from '@/services/usgs/types.js';

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
  associated_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Other network IDs USGS lists for this event, in upstream order; earthquake_get_event accepts them. Absent when USGS lists none, and for EMSC events.',
    ),
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
      depth_type: z
        .string()
        .optional()
        .describe(
          'How the depth was set, as published, e.g. "from location" or "operator assigned" (fixed, not solved for).',
        ),
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
        (origin.depth_type ? `Depth type: ${origin.depth_type} | ` : '') +
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
  if (event.associated_ids) lines.push(`**Associated IDs:** ${event.associated_ids.join(', ')}`);
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

/** One contributed origin solution. */
export const EventOriginSchema = z
  .object({
    source: z.string().optional().describe('Network that contributed this origin product.'),
    event_id: z.string().optional().describe("Contributing network's ID for the event."),
    is_preferred: z.boolean().describe('True for the origin USGS prefers (listed first).'),
    time: z.string().optional().describe('ISO 8601 UTC origin time.'),
    latitude: z.number().optional().describe('Epicenter latitude, decimal degrees.'),
    longitude: z.number().optional().describe('Epicenter longitude, decimal degrees.'),
    depth_km: z.number().optional().describe('Hypocenter depth, km.'),
    depth_type: z
      .string()
      .optional()
      .describe(
        'How the depth was set, as published, e.g. "from location" or "operator assigned".',
      ),
    magnitude: z.number().optional().describe('Magnitude published with this origin.'),
    magnitude_type: z.string().optional().describe('Magnitude type, e.g. mww, mb, Mi.'),
    review_status: z.string().optional().describe('Review status as published by the network.'),
    evaluation_status: z.string().optional().describe('QuakeML evaluation status, e.g. final.'),
    num_stations_used: z.number().optional().describe('Stations used in the location.'),
    num_phases_used: z.number().optional().describe('Phases used in the location.'),
    azimuthal_gap_deg: z.number().optional().describe('Largest azimuthal gap, degrees.'),
    standard_error_s: z.number().optional().describe('RMS travel-time residual, seconds.'),
    minimum_distance_deg: z
      .number()
      .optional()
      .describe('Distance to the nearest station, degrees.'),
    horizontal_error_km: z.number().optional().describe('Horizontal location uncertainty, km.'),
    depth_error_km: z.number().optional().describe('Depth uncertainty, km.'),
  })
  .describe('One origin solution from an origin product.');

/** One event-level magnitude solution. */
export const EventMagnitudeSchema = z
  .object({
    type: z.string().optional().describe('Magnitude type, e.g. Mww, mb, Ml.'),
    value: z.number().optional().describe('Magnitude value.'),
    station_count: z.number().optional().describe('Stations contributing to this magnitude.'),
    evaluation_mode: z
      .string()
      .optional()
      .describe('QuakeML evaluation mode: manual or automatic.'),
    evaluation_status: z.string().optional().describe('QuakeML evaluation status, e.g. reviewed.'),
    agency: z.string().optional().describe('Agency that computed the magnitude.'),
    is_preferred: z.boolean().describe("True for the document's preferred magnitude."),
  })
  .describe('One event-level magnitude solution.');

/** One phase arrival on the preferred origin. */
export const EventArrivalSchema = z
  .object({
    network: z.string().optional().describe('SEED network code.'),
    station: z.string().optional().describe('SEED station code.'),
    location: z
      .string()
      .optional()
      .describe('SEED location code as published; "" and "--" both mean blank.'),
    channel: z.string().optional().describe('SEED channel code.'),
    phase: z.string().optional().describe('Phase name, e.g. P, Pn, S.'),
    time: z.string().optional().describe('ISO 8601 UTC pick time.'),
    time_residual_s: z.number().optional().describe('Travel-time residual, seconds.'),
    distance_deg: z.number().optional().describe('Epicentral distance, degrees.'),
    azimuth_deg: z.number().optional().describe('Azimuth from epicenter to station, degrees.'),
    time_weight: z.number().optional().describe('Weight of the arrival time in the location.'),
  })
  .describe('One phase arrival joined to its pick.');

const ForecastBinSchema = z
  .object({
    magnitude: z.number().describe('Minimum magnitude of this bin.'),
    probability: z
      .number()
      .describe('Probability (0–1) of at least one aftershock at or above it.'),
    count_median: z.number().optional().describe('Median expected count.'),
    count_p95_min: z.number().optional().describe('Lower bound of the 95% count range.'),
    count_p95_max: z.number().optional().describe('Upper bound of the 95% count range.'),
  })
  .describe('One magnitude bin.');

/** USGS Operational Aftershock Forecast. */
export const AftershockForecastSchema = z.object({
  advisory_window: z.string().describe('Window USGS headlines in its advisory, e.g. "1 Week".'),
  created: z.string().describe('ISO 8601 UTC time the forecast was issued.'),
  expires: z.string().describe('ISO 8601 UTC expiry of the forecast.'),
  next_update: z
    .string()
    .optional()
    .describe('ISO 8601 UTC time of the next scheduled update; absent once updates stop.'),
  windows: z
    .array(
      z
        .object({
          label: z.string().describe('Window label, e.g. "1 Day", "1 Week".'),
          start: z
            .string()
            .describe('ISO 8601 UTC window start (the forecast issue time, not now).'),
          end: z.string().describe('ISO 8601 UTC window end.'),
          above_mainshock: z
            .object({
              magnitude: z.number().describe('Mainshock magnitude.'),
              probability: z
                .number()
                .describe(
                  'Probability (0–1) of an aftershock at or above the mainshock magnitude.',
                ),
            })
            .optional()
            .describe(
              'Chance of an aftershock as large as the mainshock; absent when unpublished.',
            ),
          bins: z.array(ForecastBinSchema).describe('Magnitude bins in upstream order.'),
        })
        .describe('One forecast window.'),
    )
    .describe('Forecast windows in upstream order.'),
});

/** A requested include group the response does not carry. */
export const UnavailableIncludeSchema = z
  .object({
    group: z.enum(EVENT_INCLUDE_GROUPS).describe('The requested group.'),
    reason: z
      .enum(['not_published', 'fetch_failed'])
      .describe(
        'not_published: the event has no product for it. fetch_failed: the product exists but could not be fetched or parsed.',
      ),
  })
  .describe('One requested group that was not returned.');

type EventOrigin = z.infer<typeof EventOriginSchema>;
type EventMagnitude = z.infer<typeof EventMagnitudeSchema>;
type EventArrival = z.infer<typeof EventArrivalSchema>;
type AftershockForecastOutput = z.infer<typeof AftershockForecastSchema>;
type UnavailableInclude = z.infer<typeof UnavailableIncludeSchema>;

/** The include groups of an event lookup, as `format()` receives them. */
interface EventIncludesOutput {
  aftershock_forecast?: AftershockForecastOutput | undefined;
  arrivals?: EventArrival[] | undefined;
  magnitudes?: EventMagnitude[] | undefined;
  origins?: EventOrigin[] | undefined;
  unavailable_includes?: UnavailableInclude[] | undefined;
}

/** Escape what would end or split a Markdown table cell. */
function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'number' ? String(value) : value.replace(/[\\|]/g, '\\$&');
}

/** `label: value` segments for the values present, joined into one line. */
function segments(parts: [string, string | number | undefined, string?][]): string {
  return parts
    .filter(([, value]) => value !== undefined)
    .map(([label, value, unit = '']) => `${label}: ${value}${unit}`)
    .join(' | ');
}

function formatOrigin(origin: EventOrigin): string {
  const name = origin.event_id ?? 'origin';
  const tags = [
    origin.source ? `source ${origin.source}` : undefined,
    origin.is_preferred ? 'preferred' : undefined,
  ].filter((tag) => tag != null);
  const head = `- **${name}**${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
  const location =
    origin.latitude !== undefined || origin.longitude !== undefined
      ? `${origin.latitude ?? '?'}°, ${origin.longitude ?? '?'}°`
      : undefined;
  const body = segments([
    ['Time', origin.time],
    ['Location', location],
    ['Depth', origin.depth_km, ' km'],
    ['Depth type', origin.depth_type],
    ['Magnitude', origin.magnitude],
    ['Magnitude type', origin.magnitude_type],
    ['Review status', origin.review_status],
    ['Evaluation status', origin.evaluation_status],
    ['Stations used', origin.num_stations_used],
    ['Phases used', origin.num_phases_used],
    ['Azimuthal gap', origin.azimuthal_gap_deg, '°'],
    ['Standard error', origin.standard_error_s, ' s'],
    ['Minimum distance', origin.minimum_distance_deg, '°'],
    ['Horizontal error', origin.horizontal_error_km, ' km'],
    ['Depth error', origin.depth_error_km, ' km'],
  ]);
  return body ? `${head}: ${body}` : head;
}

function formatMagnitude(magnitude: EventMagnitude): string {
  const name = [magnitude.type, magnitude.value].filter((part) => part !== undefined).join(' ');
  const head = `- **${name || 'magnitude'}**${magnitude.is_preferred ? ' (preferred)' : ''}`;
  const body = segments([
    ['Stations', magnitude.station_count],
    ['Evaluation mode', magnitude.evaluation_mode],
    ['Evaluation status', magnitude.evaluation_status],
    ['Agency', magnitude.agency],
  ]);
  return body ? `${head}: ${body}` : head;
}

const UNAVAILABLE_TEXT: Record<UnavailableInclude['reason'], string> = {
  not_published: 'no product for this group is published for this event',
  fetch_failed: 'the product exists but could not be fetched or parsed',
};

/** Render the requested include groups as markdown lines — every entry, nothing summarized. */
export function formatEventIncludes(result: EventIncludesOutput): string[] {
  const lines: string[] = [];

  if (result.origins) {
    lines.push('', `### Origins (${result.origins.length})`, ...result.origins.map(formatOrigin));
  }

  if (result.magnitudes) {
    lines.push('', `### Magnitudes (${result.magnitudes.length})`);
    if (result.magnitudes.length === 0)
      lines.push('_The phase-data document lists no magnitudes._');
    lines.push(...result.magnitudes.map(formatMagnitude));
  }

  if (result.arrivals) {
    lines.push('', `### Arrivals (${result.arrivals.length}, preferred origin, nearest first)`);
    if (result.arrivals.length === 0) {
      lines.push('_The preferred origin lists no arrivals._');
    } else {
      lines.push(
        '| Network | Station | Location | Channel | Phase | Time (UTC) | Residual (s) | Distance (°) | Azimuth (°) | Time weight |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...result.arrivals.map(
          (a) =>
            `| ${[a.network, a.station, a.location, a.channel, a.phase, a.time, a.time_residual_s, a.distance_deg, a.azimuth_deg, a.time_weight].map(cell).join(' | ')} |`,
        ),
      );
    }
  }

  const forecast = result.aftershock_forecast;
  if (forecast) {
    lines.push(
      '',
      '### Aftershock forecast (USGS OAF)',
      segments([
        ['Advisory window', forecast.advisory_window],
        ['Created', forecast.created],
        ['Expires', forecast.expires],
        ['Next update', forecast.next_update],
      ]),
    );
    for (const window of forecast.windows) {
      const above = window.above_mainshock;
      lines.push(
        '',
        `**${window.label}** (${window.start} → ${window.end})` +
          (above
            ? ` | Above mainshock (≥ M${above.magnitude}): probability ${above.probability}`
            : ''),
        '',
        '| Magnitude ≥ | Probability | Median count | 95% count min | 95% count max |',
        '|---|---|---|---|---|',
        ...window.bins.map(
          (bin) =>
            `| ${[bin.magnitude, bin.probability, bin.count_median, bin.count_p95_min, bin.count_p95_max].map(cell).join(' | ')} |`,
        ),
      );
    }
  }

  if (result.unavailable_includes) {
    lines.push(
      '',
      '### Unavailable includes',
      ...result.unavailable_includes.map(
        ({ group, reason }) => `- ${group}: ${reason} — ${UNAVAILABLE_TEXT[reason]}`,
      ),
    );
  }

  return lines;
}
