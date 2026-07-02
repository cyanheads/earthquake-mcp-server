/**
 * @fileoverview Resource definition for direct access to USGS real-time earthquake feeds by URI.
 * @module mcp-server/resources/definitions/earthquake-feed.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { getUsgsService } from '@/services/usgs/usgs-service.js';

const VALID_TIERS = ['all', '1.0', '2.5', '4.5', 'significant'] as const;
const VALID_WINDOWS = ['hour', 'day', 'week', 'month'] as const;

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
    'Direct access to a USGS real-time earthquake feed as injectable context. ' +
    'magnitude_tier: all | 1.0 | 2.5 | 4.5 | significant. ' +
    'time_window: hour | day | week | month.',
  mimeType: 'application/json',

  params: z.object({
    magnitude_tier: z.string().describe('Magnitude tier: all, 1.0, 2.5, 4.5, or significant.'),
    time_window: z.string().describe('Time window: hour, day, week, or month.'),
  }),

  output: z.object({
    count: z.number().describe('Number of events in the feed.'),
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
  }),

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

    const result = await getUsgsService().getFeed(tier, window, ctx);

    return {
      count: result.count,
      generated_at: result.generatedAt,
      events: result.events.map((e) => ({
        id: e.id,
        title: e.title,
        magnitude: e.magnitude,
        time: e.time,
        place: e.place,
        latitude: e.latitude,
        longitude: e.longitude,
        depth_km: e.depth_km,
      })),
      feed_url: result.feedUrl,
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
