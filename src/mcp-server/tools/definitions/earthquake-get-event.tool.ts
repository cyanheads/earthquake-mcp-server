/**
 * @fileoverview Tool definition for fetching full detail for a specific USGS earthquake event.
 * @module mcp-server/tools/definitions/earthquake-get-event.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  EarthquakeDetailSchema,
  EarthquakeEventSchema,
  formatEvent,
  formatEventDetail,
} from '@/mcp-server/tools/schemas.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeGetEvent = tool('earthquake_get_event', {
  title: 'Get Earthquake Event Detail',
  description:
    'Fetch detail for a specific earthquake by USGS event ID. ' +
    'Returns the same normalized event a search result carries, plus a projection of the ' +
    'analysis products only the single-event response holds: PAGER impact alert and report link, ' +
    'ShakeMap peak intensity and ground motion, DYFI felt-report totals, the moment-tensor focal ' +
    'mechanism, landslide and liquefaction alerts, origin quality (azimuthal gap, station count, ' +
    'location uncertainty), and finite-fault rupture dimensions. ' +
    'Products are omitted when USGS produced none — a small automatic event typically has no ' +
    'detail at all, while a large reviewed one has most of it. ' +
    'Event IDs appear in the "id" field of earthquake_get_feed and earthquake_search results. ' +
    'This tool is USGS-only — EMSC events have no per-event detail endpoint.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    event_id: z
      .string()
      .describe(
        'USGS event ID, e.g. "hv74966427" or "us6000sznj". ' +
          'Found in the "id" field of earthquake_get_feed and earthquake_search results.',
      ),
  }),

  output: z.object({
    event: EarthquakeEventSchema.describe('Full earthquake event detail.'),
    detail: EarthquakeDetailSchema.optional().describe(
      'Analysis products USGS attached to this event. Absent when the event carries none — ' +
        'that means no product was produced, not that impact was zero.',
    ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No event matches the provided event_id.',
      recovery:
        'Verify the event ID from a feed or search result. ' +
        'IDs are network-specific strings like "us6000sznj" or "hv74966427".',
    },
    {
      reason: 'source_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS event API returns a 5xx, serves HTML, or is unreachable.',
      retryable: true,
      recovery:
        'Retry after a short delay. The same event also appears in earthquake_search and ' +
        'earthquake_get_feed results, which carry the normalized record without the products.',
    },
    {
      reason: 'source_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The USGS event API did not answer before the request deadline.',
      retryable: true,
      recovery:
        'Retry the same event ID — a single-event lookup carries no filters to reduce. If it ' +
        'keeps timing out, read the event from an earthquake_search or earthquake_get_feed result.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching earthquake event detail', { event_id: input.event_id });

    let result: Awaited<ReturnType<UsgsService['getEvent']>>;
    try {
      result = await getUsgsService().getEvent(input.event_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `No earthquake event found for ID "${input.event_id}". Verify the ID from a feed or search result.`,
          { ...ctx.recoveryFor('not_found') },
        );
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail('source_unavailable', err.message, {
          ...ctx.recoveryFor('source_unavailable'),
        });
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
    });

    return {
      event: result.event,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  },

  format: (result) => {
    const lines = [...formatEvent(result.event), ...formatEventDetail(result.detail)];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
