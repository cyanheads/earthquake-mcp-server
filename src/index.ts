#!/usr/bin/env node
/**
 * @fileoverview earthquake-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { earthquakeEventResource } from './mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeFeedResource } from './mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCount } from './mcp-server/tools/definitions/earthquake-count.tool.js';
import { earthquakeGetEvent } from './mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from './mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearch } from './mcp-server/tools/definitions/earthquake-search.tool.js';
import { initEmscService } from './services/emsc/emsc-service.js';
import { initUsgsService } from './services/usgs/usgs-service.js';

await createApp({
  name: 'earthquake-mcp-server',
  title: 'earthquake-mcp-server',
  instructions:
    'Use the earthquake_* tools to query seismic data from USGS ComCat and the EMSC SeismicPortal; no API key required. ' +
    'earthquake_get_feed gives USGS real-time magnitude tiers for current activity; earthquake_search handles historical or filtered queries, sized first with earthquake_count (search caps at 20,000 events). ' +
    'Both emit network-specific event IDs (e.g. us6000sznj) for earthquake_get_event, which returns full USGS detail (EMSC has no per-event endpoint). ' +
    'USGS carries richer metadata (PAGER, DYFI, ShakeMap); source=emsc is an independent global catalog from the European-Mediterranean Seismological Centre, useful for cross-checking an event of any region against a separate network, and does not apply USGS-only filters (the response names them in ignoredFilters).',
  tools: [earthquakeGetFeed, earthquakeSearch, earthquakeGetEvent, earthquakeCount],
  resources: [earthquakeFeedResource, earthquakeEventResource],
  prompts: [],
  landing: {
    // Public catalog server — serve full inventory to unauthenticated callers
    // regardless of MCP_AUTH_MODE setting (0.9.13: requireAuth defaults to true for jwt/oauth)
    requireAuth: false,
  },
  // 2026-07-28 cache hints. The inventory surfaces are fixed at build time — no
  // definition declares an auth scope, so every caller sees the same list and it
  // cannot change without a redeploy, which is what makes a long public TTL correct.
  // `resources/read` is deliberately absent: it stays on the SDK's conservative
  // default and each resource opts in through its own `cacheHint`.
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  setup(core) {
    const config = getServerConfig();
    initUsgsService(core.config, core.storage, config.usgsBaseUrl, config.requestTimeoutMs);
    initEmscService(core.config, core.storage, config.emscBaseUrl, config.requestTimeoutMs);
  },
});
