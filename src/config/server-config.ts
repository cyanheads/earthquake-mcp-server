/**
 * @fileoverview Server-specific environment variable configuration for earthquake-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Most events one search or feed call returns, and the largest page size a feed cursor
 * carries. A page of 1,000 full events serializes to about 1.2 MB across both surfaces.
 */
export const MAX_LIMIT = 1000;

const ServerConfigSchema = z.object({
  usgsBaseUrl: z
    .string()
    .url()
    .default('https://earthquake.usgs.gov')
    .describe('USGS API base URL. Override for testing or mirroring.'),
  emscBaseUrl: z
    .string()
    .url()
    .default('https://www.seismicportal.eu')
    .describe('EMSC API base URL. Override for testing or mirroring.'),
  defaultLimit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(15)
    .describe('Default result limit for earthquake_search_events.'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Clamp a search or feed limit above 1,000 to 1,000 with a notice. False advertises and enforces a schema maximum of 1,000 instead.',
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(10000)
    .describe(
      'Per-attempt HTTP timeout in milliseconds. Feed, search, and event calls also share a 50-second total deadline across every request and retry; standalone count calls use this per-attempt value.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    usgsBaseUrl: 'USGS_BASE_URL',
    emscBaseUrl: 'EMSC_BASE_URL',
    defaultLimit: 'DEFAULT_LIMIT',
    requestTimeoutMs: 'REQUEST_TIMEOUT_MS',
    clampLimits: 'EARTHQUAKE_CLAMP_LIMITS',
  });
  return _config;
}
