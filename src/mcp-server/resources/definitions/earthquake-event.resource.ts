/**
 * @fileoverview Resource definition for accessing full USGS earthquake event detail by ID via URI.
 * @module mcp-server/resources/definitions/earthquake-event.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { EarthquakeDetailSchema, EarthquakeEventSchema } from '@/mcp-server/tools/schemas.js';
import { getUsgsService, type UsgsService } from '@/services/usgs/usgs-service.js';

export const earthquakeEventResource = resource('earthquake://event/{event_id}', {
  name: 'earthquake-event',
  title: 'USGS Earthquake Event',
  description:
    'Earthquake event detail by USGS event ID as injectable context. ' +
    'Returns the normalized event plus the analysis products only the single-event response ' +
    'holds: PAGER alert, ShakeMap ground motion, DYFI felt reports, moment tensor, ground-failure ' +
    'alerts, origin quality, and finite-fault rupture dimensions, each omitted when USGS ' +
    'produced none. Use event IDs from earthquake_get_feed or earthquake_search results.',
  mimeType: 'application/json',

  params: z.object({
    event_id: z.string().describe('USGS event ID, e.g. "us6000sznj" or "hv74966427".'),
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

  async handler(params, ctx) {
    ctx.log.debug('Fetching event resource', { event_id: params.event_id });
    let result: Awaited<ReturnType<UsgsService['getEvent']>>;
    try {
      result = await getUsgsService().getEvent(params.event_id, ctx);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw ctx.fail(
          'not_found',
          `No earthquake event found for ID "${params.event_id}". Verify the ID from a feed or search result.`,
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
    return {
      event: result.event,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  },
});
