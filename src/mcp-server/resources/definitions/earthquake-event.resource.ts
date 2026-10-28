/**
 * @fileoverview Resource definition for accessing earthquake event detail by USGS event ID or
 * EMSC unid via URI.
 * @module mcp-server/resources/definitions/earthquake-event.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { EarthquakeDetailSchema, EarthquakeEventSchema } from '@/mcp-server/tools/schemas.js';
import { getEmscService, isEmscEventId } from '@/services/emsc/emsc-service.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeEventResource = resource('earthquake://event/{event_id}', {
  name: 'earthquake-event',
  title: 'Earthquake Event',
  description:
    'Earthquake event detail by USGS event ID or EMSC event ID (e.g. "20190706_0000043") as injectable context. Returns the normalized event; a USGS event adds the analysis products only the single-event response holds: PAGER alert, ShakeMap ground motion, DYFI felt reports, moment tensor, ground-failure alerts, origin quality, and finite-fault rupture dimensions. Groups with no projected field are omitted; EMSC publishes none of them. Use event IDs from earthquake_get_feed or earthquake_search_events results.',
  mimeType: 'application/json',

  params: z.object({
    event_id: z
      .string()
      .transform((value, ctx) => {
        try {
          return decodeURIComponent(value);
        } catch (err) {
          if (!(err instanceof URIError)) throw err;
          ctx.addIssue({ code: 'custom', message: 'Use a valid percent-encoded event ID.' });
          return z.NEVER;
        }
      })
      .pipe(z.string().trim().min(1, 'Provide a nonblank event ID from a feed or search result.'))
      .describe(
        'USGS event ID, e.g. "us6000sznj" or "hv74966427", or EMSC event ID, e.g. "20190706_0000043".',
      ),
  }),

  output: z.object({
    event: EarthquakeEventSchema.describe('Full earthquake event detail.'),
    detail: EarthquakeDetailSchema.optional().describe(
      'Projected USGS analysis products. Absent when no projected field is available; absence does not mean impact was zero.',
    ),
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

  async handler(params, ctx) {
    ctx.log.debug('Fetching event resource', { event_id: params.event_id });
    const emsc = isEmscEventId(params.event_id);
    let result: Awaited<ReturnType<UsgsService['getEvent']>>;
    try {
      result = emsc
        ? await getEmscService().getEvent(params.event_id, ctx)
        : await getUsgsService().getEvent(params.event_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.data?.reason === 'event_deleted') {
        throw ctx.fail('event_deleted', err.message, { ...ctx.recoveryFor('event_deleted') });
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `No earthquake event found for ID "${params.event_id}". Verify the ID from a feed or search result.`,
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
    return {
      event: result.event,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  },
});
