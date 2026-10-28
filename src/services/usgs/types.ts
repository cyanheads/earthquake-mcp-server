/**
 * @fileoverview Shared domain types for USGS and EMSC earthquake data.
 * @module services/usgs/types
 */

/**
 * Certainty with which a source asserts an event's classification — the first
 * character of EMSC's two-character event-type code. USGS publishes no such axis.
 */
export type EarthquakeEventCertainty = 'known' | 'suspected' | 'unknown' | 'unreported';

/**
 * Normalized earthquake event returned by both USGS and EMSC sources.
 *
 * Fields a source does not publish are never synthesized: `status` and
 * `tsunami` are null when the source reports no such value, and
 * `source_catalog` / `auth` are omitted entirely rather than filled in.
 */
export interface EarthquakeEvent {
  alert: 'green' | 'yellow' | 'orange' | 'red' | null;
  /** USGS only: the other network IDs `properties.ids` lists for the event, in upstream order. Absent when it lists none. */
  associated_ids?: string[];
  /** Agency or network the source names as authoritative — EMSC `auth`, USGS `net`. */
  auth?: string;
  cdi: number | null;
  depth_km: number | null;
  detail_url?: string;
  /** How certain the source is of `event_type`. EMSC only — USGS publishes no certainty axis. */
  event_certainty?: EarthquakeEventCertainty;
  /** Event classification in the QuakeML names USGS publishes; EMSC's `evtype` code is decoded to them. Absent when the source publishes none. */
  event_type?: string;
  event_url?: string;
  felt: number | null;
  id: string;
  latitude: number;
  longitude: number;
  magnitude: number | null;
  magnitude_type: string;
  mmi: number | null;
  place: string;
  significance: number | null;
  /** Upstream catalog the solution came from, e.g. "EMSC-RTS". */
  source_catalog?: string;
  status: 'automatic' | 'reviewed' | 'deleted' | null;
  time: string;
  title: string;
  tsunami: number | null;
  updated: string;
}

/** Raw USGS GeoJSON feature properties from list/query responses. */
export interface UsgsFeatureProperties {
  alert?: string | null;
  cdi?: number | null;
  code?: string | null;
  detail?: string | null;
  dmin?: number | null;
  felt?: number | null;
  gap?: number | null;
  ids?: string | null;
  mag?: number | null;
  magType?: string | null;
  mmi?: number | null;
  net?: string | null;
  nst?: number | null;
  place?: string | null;
  /** Present on single-event (eventid) responses only; list responses omit it. */
  products?: Record<string, UsgsProduct[] | undefined>;
  rms?: number | null;
  sig?: number | null;
  sources?: string | null;
  status?: string | null;
  time?: number | null;
  title?: string | null;
  tsunami?: number | null;
  type?: string | null;
  types?: string | null;
  tz?: number | null;
  updated?: number | null;
  url?: string | null;
}

/**
 * One entry of `properties.products[<productType>]` on a single-event response.
 * Every value inside `properties` arrives as a string, including the numeric ones.
 */
export interface UsgsProduct<TProperties = Record<string, string | undefined>> {
  /** Product code — for an `origin` product, the contributing network's event ID. */
  code?: string;
  contents?: Record<string, { url?: string } | undefined>;
  properties?: TProperties;
  /** Network that contributed the product. */
  source?: string;
}

/** `losspager` properties read by the detail projection. */
export interface UsgsLossPagerProperties {
  alertlevel?: string;
}

/** `shakemap` properties read by the detail projection. */
export interface UsgsShakeMapProperties {
  maxmmi?: string;
  maxpga?: string;
  maxpgv?: string;
  'shakemap-code-version'?: string;
}

/** `dyfi` properties read by the detail projection. */
export interface UsgsDyfiProperties {
  maxmmi?: string;
  'num-responses'?: string;
}

/** `moment-tensor` properties read by the detail projection. */
export interface UsgsMomentTensorProperties {
  'derived-depth'?: string;
  'nodal-plane-1-dip'?: string;
  'nodal-plane-1-rake'?: string;
  'nodal-plane-1-strike'?: string;
  'nodal-plane-2-dip'?: string;
  'nodal-plane-2-rake'?: string;
  'nodal-plane-2-strike'?: string;
  'scalar-moment'?: string;
}

/** `ground-failure` properties read by the detail projection. */
export interface UsgsGroundFailureProperties {
  'landslide-alert'?: string;
  'liquefaction-alert'?: string;
}

/** `origin` properties read by the detail projection and the `origins` include group. */
export interface UsgsOriginProperties {
  'azimuthal-gap'?: string;
  depth?: string;
  /** How the depth was set, e.g. "from location" or "operator assigned". */
  'depth-type'?: string;
  'evaluation-status'?: string;
  eventtime?: string;
  'horizontal-error'?: string;
  latitude?: string;
  longitude?: string;
  magnitude?: string;
  'magnitude-type'?: string;
  /** Distance to the nearest station, in degrees. */
  'minimum-distance'?: string;
  'num-phases-used'?: string;
  'num-stations-used'?: string;
  'review-status'?: string;
  /** RMS travel-time residual, in seconds. */
  'standard-error'?: string;
  /** Depth uncertainty in km — USGS names the vertical component this way. */
  'vertical-error'?: string;
}

/** `finite-fault` properties read by the detail projection. */
export interface UsgsFiniteFaultProperties {
  'model-length'?: string;
  'model-width'?: string;
}

/** Strike, dip, and rake of one nodal plane of a moment-tensor solution, in degrees. */
export interface NodalPlane {
  dip: number;
  rake: number;
  strike: number;
}

/**
 * Curated projection of the `products` blob USGS attaches to a single-event
 * response. Each group is present only when the event carries that product and
 * at least one of its fields parsed — a bare automatic event usually has none.
 */
export interface EarthquakeEventDetail {
  dyfi?: {
    map_url?: string;
    max_cdi?: number;
    responses?: number;
  };
  finite_fault?: {
    model_url?: string;
    rupture_length_km?: number;
    rupture_width_km?: number;
  };
  ground_failure?: {
    landslide_alert?: string;
    liquefaction_alert?: string;
  };
  losspager?: {
    alert_level?: string;
    report_url?: string;
  };
  moment_tensor?: {
    derived_depth_km?: number;
    nodal_plane_1?: NodalPlane;
    nodal_plane_2?: NodalPlane;
    scalar_moment_nm?: number;
  };
  origin?: {
    azimuthal_gap_deg?: number;
    depth_error_km?: number;
    depth_type?: string;
    horizontal_error_km?: number;
    num_stations_used?: number;
    review_status?: string;
  };
  shakemap?: {
    code_version?: string;
    intensity_map_url?: string;
    max_mmi?: number;
    max_pga?: number;
    max_pgv?: number;
  };
}

/** Opt-in `earthquake_get_event` groups, in the order responses report them. */
export const EVENT_INCLUDE_GROUPS = [
  'origins',
  'magnitudes',
  'arrivals',
  'aftershock_forecast',
] as const;

export type EventIncludeGroup = (typeof EVENT_INCLUDE_GROUPS)[number];

/** One contributed origin solution, from an `origin` product on the single-event response. */
export interface EventOrigin {
  azimuthal_gap_deg?: number;
  depth_error_km?: number;
  depth_km?: number;
  depth_type?: string;
  evaluation_status?: string;
  event_id?: string;
  horizontal_error_km?: number;
  /** True for the first origin product — the one USGS ranks as preferred. */
  is_preferred: boolean;
  latitude?: number;
  longitude?: number;
  magnitude?: number;
  magnitude_type?: string;
  minimum_distance_deg?: number;
  num_phases_used?: number;
  num_stations_used?: number;
  review_status?: string;
  source?: string;
  standard_error_s?: number;
  time?: string;
}

/** One event-level magnitude solution from the preferred phase-data QuakeML. */
export interface EventMagnitude {
  agency?: string;
  evaluation_mode?: string;
  evaluation_status?: string;
  is_preferred: boolean;
  station_count?: number;
  type?: string;
  value?: number;
}

/** One phase arrival on the preferred origin, joined to its pick. */
export interface EventArrival {
  azimuth_deg?: number;
  channel?: string;
  distance_deg?: number;
  location?: string;
  network?: string;
  phase?: string;
  station?: string;
  time?: string;
  time_residual_s?: number;
  time_weight?: number;
}

/** Probability and expected count of aftershocks at or above one magnitude. */
interface AftershockForecastBin {
  count_median?: number;
  count_p95_max?: number;
  count_p95_min?: number;
  magnitude: number;
  probability: number;
}

/** One forecast window of the USGS Operational Aftershock Forecast. */
interface AftershockForecastWindow {
  above_mainshock?: { magnitude: number; probability: number };
  bins: AftershockForecastBin[];
  end: string;
  label: string;
  start: string;
}

/** Projection of the `oaf` product's `forecast.json`. */
export interface AftershockForecast {
  advisory_window: string;
  created: string;
  expires: string;
  next_update?: string;
  windows: AftershockForecastWindow[];
}

/** A requested include group the response does not carry, and why. */
export interface UnavailableInclude {
  group: EventIncludeGroup;
  reason: 'not_published' | 'fetch_failed';
}

/** The include groups an event lookup returns — each present only when requested and available. */
export interface EventIncludes {
  aftershock_forecast?: AftershockForecast;
  arrivals?: EventArrival[];
  magnitudes?: EventMagnitude[];
  origins?: EventOrigin[];
  unavailable_includes?: UnavailableInclude[];
}

/** Raw USGS GeoJSON feature. */
export interface UsgsFeature {
  geometry: {
    type: 'Point';
    coordinates: [number, number, number | null]; // [lon, lat, depth_km] — depth is null for historical events
  };
  id: string;
  properties: UsgsFeatureProperties;
  type: 'Feature';
}

/** Raw USGS GeoJSON FeatureCollection response. */
export interface UsgsFeatureCollection {
  bbox?: number[];
  features: UsgsFeature[];
  metadata: {
    generated: number;
    url: string;
    title: string;
    status: number;
    api: string;
    count: number;
  };
  type: 'FeatureCollection';
}

/** Raw USGS count response. */
export interface UsgsCountResponse {
  count: number;
  maxAllowed: number;
}

/** Raw EMSC event properties. */
export interface EmscEventProperties {
  auth?: string | null;
  depth?: number | null;
  evtype?: string | null;
  flynn_region?: string | null;
  lastupdate?: string;
  lat?: number | null;
  lon?: number | null;
  mag?: number | null;
  magtype?: string | null;
  source_catalog?: string | null;
  time?: string;
  unid?: string;
}

/** Raw EMSC GeoJSON feature. */
export interface EmscFeature {
  geometry: {
    type: 'Point';
    coordinates: [number, number, number | null];
  };
  id?: string;
  properties: EmscEventProperties;
  type: 'Feature';
}

/** Raw EMSC JSON response (format=json). */
export interface EmscFeatureCollection {
  features: EmscFeature[];
  type: 'FeatureCollection';
}

/** Raw EMSC count response. */
export interface EmscCountResponse {
  count: number;
}

/** Query parameters shared by both USGS and EMSC search/count endpoints. */
export interface EarthquakeQueryParams {
  alertLevel?: string;
  endTime?: string;
  /** FDSN `eventtype` filter. USGS-only — EMSC's endpoint rejects the parameter outright. */
  eventType?: string;
  latitude?: number;
  limit?: number;
  longitude?: number;
  magnitudeType?: string;
  maxDepthKm?: number;
  /** FDSN `maxlatitude` — northern edge of a bounding box, in degrees. */
  maxLatitude?: number;
  /** FDSN `maxlongitude` — eastern edge of a bounding box, in degrees. Extends past ±180 for an antimeridian box. */
  maxLongitude?: number;
  maxMagnitude?: number;
  minDepthKm?: number;
  minFelt?: number;
  /** FDSN `minlatitude` — southern edge of a bounding box, in degrees. */
  minLatitude?: number;
  /** FDSN `minlongitude` — western edge of a bounding box, in degrees. Extends past ±180 for an antimeridian box. */
  minLongitude?: number;
  minMagnitude?: number;
  minSignificance?: number;
  /** 1-based index of the first event to return. Both FDSN upstreams reject 0. */
  offset?: number;
  orderBy?: string;
  productType?: string;
  radiusKm?: number;
  reviewStatus?: 'automatic' | 'reviewed';
  startTime?: string;
}
