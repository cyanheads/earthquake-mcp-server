/**
 * @fileoverview Tool definition for fetching full detail for one earthquake event by USGS
 * event ID or EMSC unid.
 * @module mcp-server/tools/definitions/earthquake-get-event.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  AftershockForecastSchema,
  EarthquakeDetailSchema,
  EarthquakeEventSchema,
  EventArrivalSchema,
  EventMagnitudeSchema,
  EventOriginSchema,
  formatEvent,
  formatEventDetail,
  formatEventIncludes,
  UnavailableIncludeSchema,
} from '@/mcp-server/tools/schemas.js';
import { getEmscService, isEmscEventId } from '@/services/emsc/emsc-service.js';
import { normalizeIncludeGroups, unpublishedIncludes } from '@/services/usgs/event-includes.js';
import { EVENT_INCLUDE_GROUPS } from '@/services/usgs/types.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeGetEvent = tool('earthquake_get_event', {
  title: 'Get Earthquake Event Detail',
  description: `Fetch one earthquake by event ID: a USGS ID, or an EMSC ID (an origin date and seven-digit sequence, e.g. "20190706_0000043"). Returns the same normalized event a search result carries. For a USGS event it adds a projection of the analysis products only the single-event response holds: PAGER impact alert and report link, ShakeMap peak intensity and ground motion, DYFI felt-report totals, the moment-tensor focal mechanism, landslide and liquefaction alerts, origin quality (azimuthal gap, station count, location uncertainty, depth type), and finite-fault rupture dimensions. Product groups are omitted when no projected field is available — a small automatic event typically carries only origin quality, while a large reviewed one has most of it. Opt into more with include: alternative origin solutions, magnitude solutions, phase arrivals, or the USGS aftershock forecast; a requested group that is not returned is listed in unavailable_includes. EMSC publishes none of these products, so an EMSC event has no detail and lists every requested group as not_published. Event IDs appear in the "id" field of earthquake_get_feed and earthquake_search_events results; a USGS event's associated_ids are also accepted.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    event_id: z
      .string()
      .trim()
      .min(1, 'Provide a nonblank event ID from a feed or search result.')
      .describe(
        'USGS event ID, e.g. "hv74966427" or "us6000sznj", or EMSC event ID, e.g. "20190706_0000043". Found in the "id" field of earthquake_get_feed and earthquake_search_events results.',
      ),
    include: z
      .array(z.enum(EVENT_INCLUDE_GROUPS))
      .optional()
      .describe(
        'Optional groups: origins (every contributed origin solution, no extra request), magnitudes and arrivals (one shared phase-data download; every arrival of the preferred origin, nearest first), aftershock_forecast (one extra request). Omit for the default response.',
      ),
  }),

  output: z.object({
    event: EarthquakeEventSchema.describe('Full earthquake event detail.'),
    detail: EarthquakeDetailSchema.optional().describe(
      'Projected USGS analysis products. Absent when no projected field is available; absence does not mean impact was zero.',
    ),
    origins: z
      .array(EventOriginSchema)
      .optional()
      .describe('Every origin product, preferred first. Present when requested and published.'),
    magnitudes: z
      .array(EventMagnitudeSchema)
      .optional()
      .describe('Magnitude solutions from the preferred phase-data product, in document order.'),
    arrivals: z
      .array(EventArrivalSchema)
      .optional()
      .describe('All phase arrivals of the preferred origin, sorted by distance ascending.'),
    aftershock_forecast: AftershockForecastSchema.optional().describe(
      'USGS Operational Aftershock Forecast; probabilities change with each update.',
    ),
    unavailable_includes: z
      .array(UnavailableIncludeSchema)
      .optional()
      .describe('Requested groups not returned, with the reason. Absent when all were returned.'),
  }),

  errors: [
    {
      reason: 'event_deleted',
      code: JsonRpcErrorCode.NotFound,
      when: 'USGS reports that the requested event was deleted.',
      retryable: false,
      recovery:
        'Search earthquake_search_events around the same time and location for a possible replacement event.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No USGS or EMSC event matches the provided event_id.',
      recovery:
        'Verify the event ID from a feed or search result. USGS IDs are network-specific strings like "us6000sznj" or "hv74966427"; EMSC IDs are an origin date and seven-digit sequence like "20190706_0000043".',
    },
    {
      reason: 'source_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS or EMSC event API returns a 5xx, serves HTML, or is unreachable.',
      retryable: true,
      recovery:
        'Retry after a short delay. The same event also appears in earthquake_search_events results (source=emsc for an EMSC ID), and a recent USGS event in earthquake_get_feed results, which carry the normalized record without the products.',
    },
    {
      reason: 'source_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The USGS or EMSC event API did not answer before the request deadline.',
      retryable: true,
      recovery:
        'Retry the same event ID — a single-event lookup carries no filters to reduce. If it keeps timing out, read the event from an earthquake_search_events result (source=emsc for an EMSC ID).',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching earthquake event detail', { event_id: input.event_id });

    const emsc = isEmscEventId(input.event_id);
    let result: Awaited<ReturnType<UsgsService['getEvent']>>;
    try {
      result = emsc
        ? {
            ...(await getEmscService().getEvent(input.event_id, ctx)),
            ...unpublishedIncludes(normalizeIncludeGroups(input.include)),
          }
        : await getUsgsService().getEvent(input.event_id, ctx, input.include ?? []);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'event_deleted') {
        throw ctx.fail('event_deleted', err.message, { ...ctx.recoveryFor('event_deleted') });
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `No earthquake event found for ID "${input.event_id}". Verify the ID from a feed or search result.`,
          { ...ctx.recoveryFor('not_found') },
        );
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail(
          'source_unavailable',
          err.message,
          {
            ...ctx.recoveryFor('source_unavailable'),
            ...(err.data?.retryable === false
              ? {
                  retryable: false,
                  recovery: {
                    hint: emsc
                      ? "Do not retry this EMSC lookup: SeismicPortal does not implement it. The ID begins with the event's origin date (YYYYMMDD); find the same event in the USGS catalog with earthquake_search_events (source=usgs) on that date near its location, then look it up by its USGS ID."
                      : 'Do not retry this USGS lookup: it is not implemented upstream. Use earthquake_search_events with source=emsc to find the event by time and location.',
                  },
                }
              : {}),
          },
          { cause: err },
        );
      }
      // A timeout classifies as Timeout, not ServiceUnavailable — it needs its own
      // branch or it bypasses the contract and reaches the caller with no recovery hint.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Timeout) {
        throw ctx.fail('source_timeout', err.message, {
          ...ctx.recoveryFor('source_timeout'),
        });
      }
      throw err;
    }

    ctx.log.info('Event fetched', {
      event_id: input.event_id,
      magnitude: result.event.magnitude,
      place: result.event.place,
      products: result.detail != null ? Object.keys(result.detail) : [],
      unavailable_includes: result.unavailable_includes ?? [],
    });

    return result;
  },

  format: (result) => {
    const lines = [
      ...formatEvent(result.event),
      ...formatEventDetail(result.detail),
      ...formatEventIncludes(result),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
