/**
 * @fileoverview Resource definition for direct access to USGS real-time earthquake feeds by URI.
 * @module mcp-server/resources/definitions/earthquake-feed.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { feedSnapshots } from '@/services/feed-snapshots.js';
import { getUsgsService } from '@/services/usgs/usgs-service.js';

const VALID_TIERS = ['all', '1.0', '2.5', '4.5', 'significant'] as const;
const VALID_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
const feedParams = z.object({
  magnitude_tier: z.string().describe('Magnitude tier: all, 1.0, 2.5, 4.5, or significant.'),
  time_window: z.string().describe('Time window: hour, day, week, or month.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque continuation from next_uri; omit for the first read.'),
});

type MagnitudeTier = (typeof VALID_TIERS)[number];
type TimeWindow = (typeof VALID_WINDOWS)[number];

function isTier(s: string): s is MagnitudeTier {
  return (VALID_TIERS as readonly string[]).includes(s);
}
function isWindow(s: string): s is TimeWindow {
  return (VALID_WINDOWS as readonly string[]).includes(s);
}

export const earthquakeFeedResource = resource('earthquake://feed/{magnitude_tier}/{time_window}', {
  name: 'earthquake-feed',
  title: 'USGS Earthquake Feed',
  description:
    'Direct access to a USGS real-time earthquake feed as injectable context. magnitude_tier: all | 1.0 | 2.5 | 4.5 | significant. time_window: hour | day | week | month. Returns 100 events per page with totalCount, and next_uri when more events remain. Read next_uri verbatim to continue the retained generation. Snapshots last up to 15 minutes, subject to capacity eviction and process restart. The earthquake_get_feed tool exposes the same generation.',
  mimeType: 'application/json',
  cacheHint: { ttlMs: 0, cacheScope: 'private' },

  params: feedParams,

  output: z.object({
    count: z.number().describe('Number of events in this page.'),
    generated_at: z.string().describe('ISO 8601 UTC timestamp when USGS generated this feed.'),
    events: z
      .array(
        z
          .object({
            id: z.string().describe('USGS event identifier.'),
            title: z.string().describe('Human-readable event summary.'),
            magnitude: z
              .number()
              .nullable()
              .describe(
                'Preferred magnitude value. Null when no magnitude was computed for the event.',
              ),
            time: z.string().describe('ISO 8601 UTC origin time.'),
            place: z.string().describe('Nearest named location.'),
            latitude: z.number().describe('Epicenter latitude in decimal degrees.'),
            longitude: z.number().describe('Epicenter longitude in decimal degrees.'),
            depth_km: z
              .number()
              .nullable()
              .describe(
                'Hypocenter depth in kilometers. Null for historical events where depth was not measured.',
              ),
          })
          .describe('A single earthquake event.'),
      )
      .describe('Earthquake events, newest first.'),
    feed_url: z.string().describe('Source feed URL.'),
    totalCount: z.number().describe('Number of events in the retained feed generation.'),
    truncated: z.boolean().describe('Whether another page remains in this generation.'),
    nextCursor: z
      .string()
      .optional()
      .describe('Opaque continuation cursor shared with earthquake_get_feed.'),
    next_uri: z.string().optional().describe('Exact resource URI for the next page.'),
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USGS returns a 5xx, HTML, or is unreachable.',
      retryable: true,
      recovery: 'Retry a smaller time_window or use earthquake_search_events as a fallback.',
    },
    {
      reason: 'feed_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'USGS does not answer before the request deadline.',
      retryable: true,
      recovery: 'Retry a smaller time_window or use earthquake_search_events as a fallback.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed.',
      recovery: 'Restart the feed read without a cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'cursor_expired',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The generation expired, was evicted, or belongs to another tenant or feed.',
      recovery: 'Restart the feed read without a cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'snapshot_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The feed exceeds retained storage capacity.',
      recovery: 'Request a smaller time window or magnitude tier.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    if (!isTier(params.magnitude_tier)) {
      throw validationError(
        `Unknown magnitude tier "${params.magnitude_tier}". Valid tiers: ${VALID_TIERS.join(', ')}.`,
        { magnitude_tier: params.magnitude_tier },
      );
    }
    if (!isWindow(params.time_window)) {
      throw validationError(
        `Unknown time window "${params.time_window}". Valid windows: ${VALID_WINDOWS.join(', ')}.`,
        { time_window: params.time_window },
      );
    }

    const tier = params.magnitude_tier;
    const window = params.time_window;

    ctx.log.debug('Fetching feed resource', { tier, window });

    let snapshot: Awaited<ReturnType<typeof feedSnapshots.read>>;
    try {
      snapshot = await feedSnapshots.read(params, ctx, () =>
        getUsgsService().getFeed(tier, window, ctx),
      );
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail('feed_unavailable', `USGS feed ${tier}/${window} is unavailable.`, {
          ...ctx.recoveryFor('feed_unavailable'),
          ...(typeof err.data?.status === 'number' ? { status: err.data.status } : {}),
          ...(err.data?.retryable === false
            ? {
                retryable: false,
                recovery: {
                  hint: 'Do not retry this USGS feed. Use earthquake_search_events with source=emsc for recent events.',
                },
              }
            : {}),
        });
      }
      if (err instanceof McpError && err.code === JsonRpcErrorCode.Timeout) {
        throw ctx.fail('feed_timeout', `USGS feed ${tier}/${window} timed out.`, {
          ...ctx.recoveryFor('feed_timeout'),
        });
      }
      throw err;
    }
    const { feed: result, index, limit, cursor } = snapshot;
    const events = result.events.slice(index, index + limit).map((e) => ({
      id: e.id,
      title: e.title,
      magnitude: e.magnitude,
      time: e.time,
      place: e.place,
      latitude: e.latitude,
      longitude: e.longitude,
      depth_km: e.depth_km,
    }));
    const next = index + events.length;
    const truncated = next < result.events.length;
    return {
      count: events.length,
      generated_at: result.generatedAt,
      events,
      feed_url: result.feedUrl,
      totalCount: result.events.length,
      truncated,
      ...(truncated
        ? {
            nextCursor: cursor(next),
            next_uri: `earthquake://feed/${tier}/${window}/page/${cursor(next)}`,
          }
        : {}),
    };
  },

  list: () => ({
    resources: VALID_TIERS.flatMap((tier) =>
      VALID_WINDOWS.map((window) => ({
        uri: `earthquake://feed/${tier}/${window}`,
        name: `USGS ${tier} earthquakes (${window})`,
        description: `USGS real-time feed: ${/^[0-9]/.test(tier) ? `M${tier}+` : tier} events in the last ${window}.`,
        mimeType: 'application/json',
      })),
    ),
  }),
});

/** Separate path template keeps the original first-page URI dispatchable. */
const { list: _list, uriTemplate: _uriTemplate, ...pageDefinition } = earthquakeFeedResource;
export const earthquakeFeedPageResource = resource(
  'earthquake://feed/{magnitude_tier}/{time_window}/page/{cursor}',
  {
    ...pageDefinition,
    name: 'earthquake-feed-page',
    title: 'USGS Earthquake Feed Page',
    params: feedParams.extend({
      cursor: z.string().describe('Opaque cursor copied verbatim from next_uri.'),
    }),
  },
);
