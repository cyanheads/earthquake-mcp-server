/**
 * @fileoverview Shared domain types for USGS and EMSC earthquake data.
 * @module services/usgs/types
 */

/** Normalized earthquake event returned by both USGS and EMSC sources. */
export interface EarthquakeEvent {
  alert: 'green' | 'yellow' | 'orange' | 'red' | null;
  cdi: number | null;
  depth_km: number | null;
  detail_url?: string;
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
  status: 'automatic' | 'reviewed' | 'deleted';
  time: string;
  title: string;
  tsunami: number;
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
  products?: Record<string, unknown>;
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
  latitude?: number;
  limit?: number;
  longitude?: number;
  maxDepthKm?: number;
  maxMagnitude?: number;
  minDepthKm?: number;
  minFelt?: number;
  minMagnitude?: number;
  minSignificance?: number;
  orderBy?: string;
  radiusKm?: number;
  startTime?: string;
}
