/**
 * @fileoverview The one cap shared by the search and feed `limit` inputs: the input
 * field, and the clamp that reduces an over-cap value with a notice, log line, and counter.
 * @module mcp-server/tools/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, MAX_LIMIT } from '@/config/server-config.js';

const clamps = createCounter(
  'earthquake.limit.clamps',
  'Search and feed limits clamped to the per-call cap',
  '{clamp}',
);

type LimitedTool = 'earthquake_search_events' | 'earthquake_get_feed';

/**
 * Optional positive-integer `limit` field. While clamping is on it advertises no maximum —
 * `multipleOf(1)`, since `.int()` advertises the safe-integer ceiling as `maximum`; with
 * `EARTHQUAKE_CLAMP_LIMITS=false` it advertises and enforces `maximum: 1000`.
 *
 * `describe` receives the clause stating what the cap means in the active mode and returns
 * the field's description. Bounds and description both read the config lazily — the bounds
 * at registration and parse time, the description (a getter) each time it is read — so
 * neither touches `getServerConfig()` before `createApp()` loads `.env`.
 */
export function limitSchema(describe: (capRule: string) => string) {
  return z
    .lazy(() =>
      getServerConfig().clampLimits
        ? z.number().multipleOf(1, 'Send limit as a whole number, not a fractional one.').min(1)
        : z.number().int().min(1).max(MAX_LIMIT),
    )
    .optional()
    .meta({
      get description() {
        return describe(
          getServerConfig().clampLimits
            ? 'a larger value returns at most 1,000 and says so'
            : 'at most 1,000',
        );
      },
    });
}

/**
 * Reduce a requested count above the cap to the cap. A clamp logs, increments
 * `earthquake.limit.clamps`, and returns a notice naming the requested and applied values.
 */
export function clampLimit(
  requested: number,
  tool: LimitedTool,
  ctx: Context,
): { applied: number; notice?: string } {
  if (requested <= MAX_LIMIT) return { applied: requested };
  ctx.log.info('Clamped limit', { tool, requested, applied: MAX_LIMIT });
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  return {
    applied: MAX_LIMIT,
    notice: `Requested limit ${requested}; applied limit ${MAX_LIMIT}, the per-call cap.`,
  };
}
