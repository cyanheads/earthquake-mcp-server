/**
 * @fileoverview Pins the upstream-timeout path end to end: what the framework's
 * `fetchWithTimeout` actually throws when a request exceeds its deadline, and that
 * each tool remaps it onto a declared error contract carrying a recovery hint.
 *
 * The two halves are load-bearing together. The framework classifies a timeout as
 * `Timeout` (-32004), not `ServiceUnavailable` (-32000), so a guard that matches only
 * `ServiceUnavailable` lets a timeout bypass the contract and reach the caller with no
 * recovery hint. The grounding test below asserts the framework's classification
 * directly, so a future framework change that moves it fails here rather than silently
 * routing timeouts around every contract.
 *
 * @module tests/tools/timeout-contract.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeEventResource } from '@/mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

/** What `fetchWithTimeout` raises on a deadline overrun, as the services see it. */
const upstreamTimeout = () =>
  new McpError(JsonRpcErrorCode.Timeout, 'fetch GET https://earthquake.usgs.gov timed out.', {
    errorSource: 'FetchTimeout',
  });

/** Recovery text the contract declares for a reason — the hint callers must receive. */
const contractRecovery = (
  errors: readonly { reason: string; recovery: string }[] | undefined,
  reason: string,
) => errors?.find((e: { reason: string }) => e.reason === reason)?.recovery;

describe('fetchWithTimeout — framework timeout classification', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // Accepts the connection and never answers, so only the deadline ends the request.
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('classifies a request timeout as Timeout (-32004), not ServiceUnavailable', async () => {
    const reqCtx = requestContextService.createRequestContext({ operation: 'timeoutContractTest' });

    const err = await fetchWithTimeout(url, 50, reqCtx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.Timeout);
    expect((err as McpError).code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((err as McpError).data).toMatchObject({ errorSource: 'FetchTimeout' });
  });
});

describe('tool contracts — an upstream timeout lands on a declared reason', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('earthquake_search maps a timeout to source_timeout with the contract hint', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'source_timeout',
        recovery: { hint: contractRecovery(earthquakeSearch.errors, 'source_timeout') },
      },
    });
  });

  it('earthquake_count maps a timeout to source_timeout with the contract hint', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'source_timeout',
        recovery: { hint: contractRecovery(earthquakeCount.errors, 'source_timeout') },
      },
    });
  });

  it('earthquake_get_feed maps a timeout to feed_timeout with the contract hint', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getFeed: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeGetFeed.errors });
    const input = earthquakeGetFeed.input.parse({});

    await expect(earthquakeGetFeed.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'feed_timeout',
        recovery: { hint: contractRecovery(earthquakeGetFeed.errors, 'feed_timeout') },
      },
    });
  });

  it('keeps a timeout distinct from the *_unavailable reason', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.not.toMatchObject({
      data: { reason: 'source_unavailable' },
    });
  });

  it('earthquake_get_event maps a timeout to source_timeout with the contract hint', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'us6000sznj' });

    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'source_timeout',
        recovery: { hint: contractRecovery(earthquakeGetEvent.errors, 'source_timeout') },
      },
    });
  });

  it('earthquake-event resource maps a timeout to source_timeout with the contract hint', async () => {
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: vi.fn().mockRejectedValue(upstreamTimeout()),
    } as unknown as usgsModule.UsgsService);

    const ctx = createMockContext({ errors: earthquakeEventResource.errors });
    const params = earthquakeEventResource.params!.parse({ event_id: 'us6000sznj' });

    await expect(earthquakeEventResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'source_timeout',
        recovery: { hint: contractRecovery(earthquakeEventResource.errors, 'source_timeout') },
      },
    });
  });

  it('every definition that reaches an upstream declares a timeout reason', () => {
    // A tool or resource with no timeout reason lets the framework's Timeout code
    // bubble with no recovery hint — the gap issue #28 closed on the event lookup.
    const declared = [
      earthquakeSearch.errors,
      earthquakeCount.errors,
      earthquakeGetFeed.errors,
      earthquakeGetEvent.errors,
      earthquakeEventResource.errors,
    ];
    for (const errors of declared) {
      expect(errors?.some((e) => e.code === JsonRpcErrorCode.Timeout)).toBe(true);
      expect(errors?.some((e) => e.code === JsonRpcErrorCode.ServiceUnavailable)).toBe(true);
    }
  });
});
