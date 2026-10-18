/**
 * @fileoverview Server-specific environment variable configuration for earthquake-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

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
    .max(20000)
    .default(100)
    .describe('Default result limit for earthquake_search_events.'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(10000)
    .describe(
      'Per-attempt HTTP timeout in milliseconds. Feed/search operations also share a 50-second total deadline; standalone event/count calls use this per-attempt value.',
    ),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    usgsBaseUrl: 'USGS_BASE_URL',
    emscBaseUrl: 'EMSC_BASE_URL',
    defaultLimit: 'DEFAULT_LIMIT',
    requestTimeoutMs: 'REQUEST_TIMEOUT_MS',
  });
  return _config;
}
