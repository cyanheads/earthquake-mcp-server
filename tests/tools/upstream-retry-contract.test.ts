/**
 * @fileoverview Preserves upstream retry decisions through earthquake tool and resource contracts.
 * @module tests/tools/upstream-retry-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeEventResource } from '@/mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';
import { initEmscService } from '@/services/emsc/emsc-service.js';
import { initUsgsService } from '@/services/usgs/usgs-service.js';

beforeEach(() => {
  initUsgsService({} as AppConfig, createInMemoryStorage(), 'https://usgs.test', 1000);
  initEmscService({} as AppConfig, createInMemoryStorage(), 'https://emsc.test', 1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const calls = [
  { name: 'USGS search', run: () => runToolContract(earthquakeSearch, { source: 'usgs' }) },
  { name: 'EMSC search', run: () => runToolContract(earthquakeSearch, { source: 'emsc' }) },
  { name: 'USGS count', run: () => runToolContract(earthquakeCount, { source: 'usgs' }) },
  { name: 'EMSC count', run: () => runToolContract(earthquakeCount, { source: 'emsc' }) },
  { name: 'feed', run: () => runToolContract(earthquakeGetFeed, {}) },
  { name: 'event', run: () => runToolContract(earthquakeGetEvent, { event_id: 'us6000sznj' }) },
];

describe.each(calls)('$name upstream retry contract', ({ run }) => {
  it('does not retry HTTP 501 and tells both client surfaces not to retry', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('Not implemented', { status: 501 })));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await run();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { retryable: false } },
    });
    expect(JSON.stringify(result.content)).toContain('Do not retry');
  });

  it('retries HTTP 500 before returning a recoverable service failure', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('Upstream failed', { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    const pending = run();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable },
    });
    expect(JSON.stringify(result.content)).not.toContain('Do not retry');
  });
});

it('preserves HTTP 501 on event and feed resource failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('Not implemented', { status: 501 }))),
  );
  for (const pending of [
    () =>
      earthquakeEventResource.handler(
        { event_id: 'us6000sznj' },
        createMockContext({ errors: earthquakeEventResource.errors }),
      ),
    () =>
      earthquakeFeedResource.handler(
        { magnitude_tier: '2.5', time_window: 'day' },
        createMockContext(),
      ),
  ]) {
    await expect(pending()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
  }
});
