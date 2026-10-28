/**
 * @fileoverview Projects the preferred `phase-data` product's QuakeML into the
 * `magnitudes` and `arrivals` include groups of an event lookup.
 * @module services/usgs/quakeml
 */

import { isRecord } from '@cyanheads/mcp-ts-core/utils';
import { XMLParser } from 'fast-xml-parser';
import { maybe, num } from './product-fields.js';
import type { EventArrival, EventMagnitude } from './types.js';

/** Elements QuakeML repeats; a single occurrence must still parse as a list. */
const LIST_ELEMENTS = new Set(['event', 'origin', 'arrival', 'pick', 'magnitude']);

/**
 * Attributes kept unprefixed, namespace prefixes dropped, every value left a string
 * (no numeric coercion), and entities left unexpanded — the document is read for
 * identifiers and numbers only, so nothing needs decoding.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  isArray: (name, _path, _isLeaf, isAttribute) => !isAttribute && LIST_ELEMENTS.has(name),
});

/** An ISO 8601 date-time with no UTC offset, which CI's automatic picks publish. */
const OFFSETLESS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

type XmlNode = Record<string, unknown>;

/** Own child of a parsed element; inherited keys never answer. */
function child(node: unknown, key: string): unknown {
  return isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined;
}

/** Text content of an element (bare or alongside attributes); blank reads as absent. */
function text(node: unknown): string | undefined {
  const value = typeof node === 'string' ? node : child(node, '#text');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function list(node: unknown, key: string): XmlNode[] {
  const value = child(node, key);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** QuakeML real quantities nest their number under `value`. */
function quantity(node: unknown, key: string): number | undefined {
  return num(text(child(child(node, key), 'value')));
}

/** Pick times without an offset are UTC by QuakeML convention; say so explicitly. */
function utcTime(value: string | undefined): string | undefined {
  return value != null && OFFSETLESS_DATETIME.test(value) ? `${value}Z` : value;
}

/**
 * Parse a phase-data QuakeML document and return its event element. Throws when
 * the text is not QuakeML carrying an event.
 */
export function parsePhaseData(xml: string): XmlNode {
  const doc: unknown = parser.parse(xml);
  const event = list(child(child(doc, 'quakeml'), 'eventParameters'), 'event')[0];
  if (!event) throw new Error('Phase-data document carries no QuakeML event.');
  return event;
}

/** Event-level magnitudes in document order; station magnitudes are summarized as `station_count`. */
export function projectMagnitudes(event: XmlNode): EventMagnitude[] {
  const preferredId = text(child(event, 'preferredMagnitudeID'));
  return list(event, 'magnitude').map((magnitude) => ({
    ...maybe('type', text(child(magnitude, 'type'))),
    ...maybe('value', quantity(magnitude, 'mag')),
    ...maybe('station_count', num(text(child(magnitude, 'stationCount')))),
    ...maybe('evaluation_mode', text(child(magnitude, 'evaluationMode'))),
    ...maybe('evaluation_status', text(child(magnitude, 'evaluationStatus'))),
    ...maybe('agency', text(child(child(magnitude, 'creationInfo'), 'agencyID'))),
    is_preferred: preferredId != null && child(magnitude, 'publicID') === preferredId,
  }));
}

/**
 * Arrivals of the document's preferred origin, joined to their picks and sorted by
 * epicentral distance (arrivals without one last). Throws when the document names
 * no preferred origin or the named origin is missing.
 */
export function projectArrivals(event: XmlNode): EventArrival[] {
  const preferredId = text(child(event, 'preferredOriginID'));
  const origin = list(event, 'origin').find((o) => child(o, 'publicID') === preferredId);
  if (preferredId == null || origin == null) {
    throw new Error('Phase-data document names no preferred origin it carries.');
  }
  const picks = new Map<unknown, XmlNode>(
    list(event, 'pick').map((p) => [child(p, 'publicID'), p]),
  );

  const arrivals = list(origin, 'arrival').map((arrival): EventArrival => {
    const pick = picks.get(text(child(arrival, 'pickID')));
    const waveform = child(pick, 'waveformID');
    const attr = (name: string) => {
      const value = child(waveform, name);
      return typeof value === 'string' ? value : undefined;
    };
    return {
      ...maybe('network', attr('networkCode')),
      ...maybe('station', attr('stationCode')),
      ...maybe('location', attr('locationCode')),
      ...maybe('channel', attr('channelCode')),
      ...maybe('phase', text(child(arrival, 'phase'))),
      ...maybe('time', utcTime(text(child(child(pick, 'time'), 'value')))),
      ...maybe('time_residual_s', num(text(child(arrival, 'timeResidual')))),
      ...maybe('distance_deg', num(text(child(arrival, 'distance')))),
      ...maybe('azimuth_deg', num(text(child(arrival, 'azimuth')))),
      ...maybe('time_weight', num(text(child(arrival, 'timeWeight')))),
    };
  });
  return arrivals.toSorted(
    (a, b) =>
      (a.distance_deg ?? Number.POSITIVE_INFINITY) - (b.distance_deg ?? Number.POSITIVE_INFINITY),
  );
}
