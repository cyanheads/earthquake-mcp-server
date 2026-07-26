/**
 * @fileoverview Shared domain types for USGS and EMSC earthquake data.
 * @module services/usgs/types
 */

/**
 * Normalized earthquake event returned by both USGS and EMSC sources.
 *
 * Fields a source does not publish are never synthesized: `status` and
 * `tsunami` are null when the source reports no such value, and
 * `source_catalog` / `auth` are omitted entirely rather than filled in.
 */
export interface EarthquakeEvent {
  alert: 'green' | 'yellow' | 'orange' | 'red' | null;
  /** Agency or network the source names as authoritative — EMSC `auth`, USGS `net`. */
  auth?: string;
  cdi: number | null;
  depth_km: number | null;
  detail_url?: string;
  /** Upstream event classification — USGS `type` prose, EMSC `evtype` code. Absent when the source publishes none. */
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
  contents?: Record<string, { url?: string } | undefined>;
  properties?: TProperties;
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

/** `origin` properties read by the detail projection. */
export interface UsgsOriginProperties {
  'azimuthal-gap'?: string;
  'horizontal-error'?: string;
  'num-stations-used'?: string;
  'review-status'?: string;
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
    horizontal_error_km?: number;
    num_stations_used?: number;
    review_status?: string;
  };
  shakemap?: {
    intensity_map_url?: string;
    max_mmi?: number;
    max_pga?: number;
    max_pgv?: number;
  };
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
  maxDepthKm?: number;
  maxMagnitude?: number;
  minDepthKm?: number;
  minFelt?: number;
  minMagnitude?: number;
  minSignificance?: number;
  /** 1-based index of the first event to return. Both FDSN upstreams reject 0. */
  offset?: number;
  orderBy?: string;
  radiusKm?: number;
  startTime?: string;
}
