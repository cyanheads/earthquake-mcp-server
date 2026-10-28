#!/usr/bin/env node
/**
 * @fileoverview earthquake-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { earthquakeEventResource } from './mcp-server/resources/definitions/earthquake-event.resource.js';
import {
  earthquakeFeedPageResource,
  earthquakeFeedResource,
} from './mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCountEvents } from './mcp-server/tools/definitions/earthquake-count-events.tool.js';
import { earthquakeGetEvent } from './mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from './mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearchEvents } from './mcp-server/tools/definitions/earthquake-search-events.tool.js';
import { initEmscService } from './services/emsc/emsc-service.js';
import { initUsgsService } from './services/usgs/usgs-service.js';

const SERVER_TITLE = 'earthquake-mcp-server';

await createApp({
  name: 'earthquake-mcp-server',
  title: SERVER_TITLE,
  /**
   * No handler calls ctx.requestInput. MCP_SESSION_MODE overrides this default;
   * explicitly choosing auto uses the framework's stateful resolution.
   */
  sessionMode: 'stateless',
  instructions:
    'Query keyless USGS ComCat and independent global EMSC SeismicPortal data. earthquake_get_feed covers USGS current activity; earthquake_search_events covers historical/filtered queries, sized with earthquake_count_events. Search returns limit events per page (at most 1,000); continue with nextOffset, including beyond 20,000 matches. earthquake_get_event takes the id of any feed or search result, USGS (us6000sznj) or EMSC (20190706_0000043). USGS events add PAGER, DYFI, ShakeMap and other products, plus include groups (alternative origins, magnitudes, phase arrivals, aftershock forecast); EMSC events carry neither, and EMSC search discloses unsupported filters in ignoredFilters.',
  tools: [earthquakeGetFeed, earthquakeSearchEvents, earthquakeGetEvent, earthquakeCountEvents],
  resources: [earthquakeFeedResource, earthquakeFeedPageResource, earthquakeEventResource],
  prompts: [],
  skills: 'skills',
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
