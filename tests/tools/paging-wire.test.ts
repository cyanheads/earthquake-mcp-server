/**
 * @fileoverview Actual stdio dispatch, page counts and continuation, and real fetch failure contracts.
 * @module tests/tools/paging-wire.test
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { initUsgsService } from '@/services/usgs/usgs-service.js';

type Event = { id: string; title?: string };
type Output = {
  count: number;
  events: Event[];
  nextCursor?: string;
  nextOffset?: number;
  next_uri?: string;
  notice?: string;
  totalCount?: number;
  truncated?: boolean;
  queryEcho?: { limit: number };
};
type Reply = {
  id: number;
  error?: { code: number; message: string; data: Record<string, unknown> };
  result: {
    resultType?: string;
    tools?: { name: string }[];
    structuredContent?: Output;
    content?: unknown[];
    contents?: { text: string }[];
    ttlMs?: number;
    cacheScope?: string;
    isError?: boolean;
  };
};
let upstream: Server;
let child: ChildProcessWithoutNullStreams;
let mode = 'normal';
let calls = 0;
let id = 0;
let edited = false;
let oversize = false;
let requests: URL[] = [];
const pending = new Map<
  number,
  {
    resolve: (reply: Reply) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const feature = (index: number, emsc = false) => ({
  type: 'Feature',
  id: `event${index}`,
  geometry: { type: 'Point', coordinates: [1, 2, 3] },
  properties: {
    mag: 2,
    magType: 'ml',
    magtype: 'ml',
    place: '東京\\"\n'.repeat(10),
    flynn_region: '東京\\"\n'.repeat(10),
    time: emsc ? '2026-01-01T00:00:00Z' : 1767225600000,
    updated: 1767225600000,
    title: oversize ? 'x'.repeat(30000) : `Event ${index} 東京`,
    status: 'reviewed',
  },
});
function rpc(method: string, params: unknown = {}) {
  const requestId = ++id;
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`RPC ${method} timed out`));
    }, 25000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: method === 'initialize' ? params : { ...(params as object), _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } })}\n`,
    );
  });
}
const tool = (name: string, args: object) => rpc('tools/call', { name, arguments: args });
const resource = (uri: string) => rpc('resources/read', { uri });
const resourceData = (reply: Reply): Output => JSON.parse(reply.result.contents![0]!.text);

beforeAll(async () => {
  upstream = createServer((req, res) => {
    calls++;
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push(url);
    if (mode === '502' || mode === '501') {
      res.writeHead(Number(mode));
      res.end('<html>PRIVATE_UPSTREAM_BODY</html>');
      return;
    }
    if (mode === 'html') {
      res.end('<html>PRIVATE_UPSTREAM_BODY</html>');
      return;
    }
    if (mode === 'timeout' || mode === 'cancel') return;
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/count')) {
      res.end(JSON.stringify({ count: mode === 'empty' ? 0 : 140 }));
      return;
    }
    const emsc = url.pathname.startsWith('/emsc');
    const all = Array.from(
      { length: mode === 'empty' ? 0 : mode === 'short' ? 33 : 140 },
      (_, index) => feature(index, emsc),
    );
    const feed = url.pathname.includes('/summary/');
    if (feed && edited) {
      all.unshift(feature(999));
      all.splice(4, 1);
      all[5]!.properties.time = 1767225600001;
    }
    const offset = Number(url.searchParams.get('offset') ?? 1);
    const features = feed
      ? all
      : all.slice(offset - 1, offset - 1 + Number(url.searchParams.get('limit') ?? 100));
    res.end(
      JSON.stringify({
        type: 'FeatureCollection',
        features,
        metadata: {
          generated: 1767225600000,
          count: features.length,
          url: 'https://earthquake.usgs.gov/feed',
        },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  child = spawn('bun', ['src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_AUTH_MODE: 'none',
      OTEL_ENABLED: 'false',
      MCP_LOG_LEVEL: 'error',
      STORAGE_PROVIDER_TYPE: 'in-memory',
      USGS_BASE_URL: `${base}/usgs`,
      EMSC_BASE_URL: `${base}/emsc`,
      REQUEST_TIMEOUT_MS: '1000',
    },
    stdio: 'pipe',
  });
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line) as Reply;
    const waiter = pending.get(reply.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(reply.id);
      waiter.resolve(reply);
    }
  });
  const init = await rpc('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'paging-test', version: '1' },
  });
  expect(init.error).toBeUndefined();
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});
afterAll(async () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('test cleanup'));
  }
  child.stdin.end();
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('paging wire', () => {
  it('preserves equal, single, negative and offset-equivalent range bounds', async () => {
    for (const name of ['earthquake_search_events', 'earthquake_count_events']) {
      for (const args of [
        { min_magnitude: -1, max_magnitude: 0, min_depth_km: -100, max_depth_km: 0 },
        { min_magnitude: 0, max_magnitude: 0, min_depth_km: 0, max_depth_km: 0 },
        { min_magnitude: 5 },
        { max_depth_km: -1 },
        { start_time: '2025-1-1', end_time: '2025-01-01T00:00:00.000Z' },
        { start_time: '2025-01-01T01:00:00+01:00', end_time: '2025-01-01T00:00:00Z' },
      ]) {
        const reply = await tool(name, args);
        expect(reply.result.isError).not.toBe(true);
        expect(reply.result.structuredContent!.count).toBeGreaterThan(0);
      }
    }
  });
  it('rejects inverted ranges on both surfaces before any upstream request', async () => {
    for (const source of ['usgs', 'emsc']) {
      for (const name of ['earthquake_search_events', 'earthquake_count_events']) {
        for (const args of [
          { min_magnitude: 6, max_magnitude: 5 },
          { min_depth_km: 0, max_depth_km: -1 },
          { start_time: '2025-02-01', end_time: '2025-01-01' },
          { start_time: '2025-01-01T00:00:00.5', end_time: '2025-01-01T00:00:00.4Z' },
          { start_time: '2025-01-01T00:00:00-01:00', end_time: '2025-01-01T00:30:00Z' },
        ]) {
          const before = calls;
          const reply = await tool(name, { source, ...args });
          expect(reply.result.isError).toBe(true);
          expect(reply.result.structuredContent).toMatchObject({
            error: {
              code: -32007,
              data: { reason: 'invalid_range', recovery: { hint: expect.any(String) } },
            },
          });
          for (const [key, value] of Object.entries(args)) {
            expect(JSON.stringify(reply.result.structuredContent)).toContain(String(value));
            expect(JSON.stringify(reply.result.content)).toContain(key);
            expect(JSON.stringify(reply.result.content)).toContain(String(value));
          }
          expect(JSON.stringify(reply.result.content)).toContain('Recovery:');
          expect(calls).toBe(before);
        }
      }
    }
  });
  it.each(['usgs', 'emsc'])(
    '%s short pages establish totals without a count call',
    async (source) => {
      const before = calls;
      const reply = await tool('earthquake_search_events', { source, limit: 100, offset: 120 });
      expect(reply.result.isError).not.toBe(true);
      expect(reply.result.structuredContent).toMatchObject({ count: 21, totalCount: 140 });
      expect(JSON.stringify(reply.result.content)).toContain('140');
      expect(calls - before).toBe(1);
      const past = await tool('earthquake_search_events', { source, offset: 999 });
      expect(past.result.structuredContent).toMatchObject({ count: 0 });
      expect(past.result.structuredContent).not.toHaveProperty('totalCount');
      mode = 'short';
      try {
        const beforeShort = calls;
        const short = await tool('earthquake_search_events', { source, limit: 100 });
        expect(short.result.structuredContent).toMatchObject({ count: 33, totalCount: 33 });
        expect(short.result.structuredContent).not.toHaveProperty('truncated');
        expect(short.result.structuredContent).not.toHaveProperty('nextOffset');
        expect(JSON.stringify(short.result.content)).toContain('33');
        expect(calls - beforeShort).toBe(1);
      } finally {
        mode = 'normal';
      }
      mode = 'empty';
      try {
        const beforeEmpty = calls;
        const empty = await tool('earthquake_search_events', { source });
        expect(empty.result.structuredContent).toMatchObject({ count: 0, totalCount: 0 });
        expect(JSON.stringify(empty.result.content)).toContain('0');
        expect(calls - beforeEmpty).toBe(1);
      } finally {
        mode = 'normal';
      }
    },
  );
  it.each(['usgs', 'emsc'])(
    '%s forwards supported product/magnitude/review filters through real query and count adapters',
    async (source) => {
      for (const name of ['earthquake_search_events', 'earthquake_count_events']) {
        requests = [];
        const reply = await tool(name, {
          source,
          magnitude_type: 'mb',
          product_type: 'moment-tensor',
          review_status: 'reviewed',
          start_time: '2025-01-01',
          end_time: '2026-01-01',
        });
        expect(reply.result.isError).not.toBe(true);
        expect(requests.map((request) => request.pathname.split('/').at(-1))).toEqual(
          name === 'earthquake_search_events' ? ['query', 'count'] : ['count'],
        );
        for (const request of requests) {
          expect(request.searchParams.get('magnitudetype')).toBe('mb');
          expect(request.searchParams.get('producttype')).toBe(
            source === 'usgs' ? 'moment-tensor' : null,
          );
          expect(request.searchParams.get('reviewstatus')).toBe(
            source === 'usgs' ? 'reviewed' : null,
          );
        }
        expect(reply.result.structuredContent).toMatchObject({
          queryEcho: { magnitude_type: 'mb' },
        });
        expect(JSON.stringify(reply.result.content)).toContain('magnitude_type=mb');
        if (source === 'usgs') {
          expect(reply.result.structuredContent).toMatchObject({
            queryEcho: { product_type: 'moment-tensor', review_status: 'reviewed' },
          });
          expect(JSON.stringify(reply.result.content)).toContain('product_type=moment-tensor');
          expect(JSON.stringify(reply.result.content)).toContain('review_status=reviewed');
        } else {
          expect(reply.result.structuredContent).toMatchObject({
            ignoredFilters: ['product_type', 'review_status'],
          });
          expect(reply.result.structuredContent!.queryEcho).not.toHaveProperty('product_type');
          expect(reply.result.structuredContent!.queryEcho).not.toHaveProperty('review_status');
          expect(JSON.stringify(reply.result.content)).toContain('not supported by EMSC');
        }
        requests = [];
        const blank = await tool(name, {
          source,
          magnitude_type: ' ',
          product_type: '',
          review_status: '  ',
        });
        expect(blank.result.isError).not.toBe(true);
        expect(requests.map((request) => request.pathname.split('/').at(-1))).toEqual(
          name === 'earthquake_search_events' ? ['query', 'count'] : ['count'],
        );
        for (const request of requests) {
          for (const key of ['magnitudetype', 'producttype', 'reviewstatus'])
            expect(request.searchParams.has(key)).toBe(false);
        }
        for (const key of ['magnitude_type', 'product_type', 'review_status']) {
          expect(blank.result.structuredContent!.queryEcho).not.toHaveProperty(key);
          expect(JSON.stringify(blank.result.content)).not.toContain(`${key}=`);
        }
        expect(blank.result.structuredContent).not.toHaveProperty('ignoredFilters');
        mode = 'empty';
        try {
          const zero = await tool(name, { source, magnitude_type: 'future-scale' });
          expect(zero.result.isError).not.toBe(true);
          expect(zero.result.structuredContent).toMatchObject({
            count: 0,
            queryEcho: { magnitude_type: 'future-scale' },
          });
          expect(JSON.stringify(zero.result.content)).toContain('magnitude_type=future-scale');
          expect(JSON.stringify(zero.result.content)).toContain('0');
        } finally {
          mode = 'normal';
        }
        const beforeInvalid = calls;
        const invalid = await tool(name, { source, review_status: 'deleted' });
        expect(invalid.result.isError).toBe(true);
        expect(invalid.result.structuredContent).toMatchObject({ error: { code: -32602 } });
        expect(JSON.stringify(invalid.result.content)).toContain('review_status');
        expect(calls).toBe(beforeInvalid);
      }
    },
  );
  it('advertises four tools and dispatches the explicit search/count event names', async () => {
    const inventory = await rpc('tools/list');
    expect(inventory.result.tools?.map(({ name }) => name).sort()).toEqual([
      'earthquake_count_events',
      'earthquake_get_event',
      'earthquake_get_feed',
      'earthquake_search_events',
    ]);
    for (const name of ['earthquake_search_events', 'earthquake_count_events']) {
      const reply = await tool(name, { start_time: '2026-10-09', end_time: '2026-10-10' });
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).not.toBe(true);
      expect(reply.result.structuredContent!.count).toBeGreaterThan(0);
      expect(JSON.stringify(reply.result.structuredContent)).toContain('2026-10-10T00:00:00');
      expect(JSON.stringify(reply.result.content)).toContain('2026-10-10T00:00:00');
    }
  });

  it('returns 15 events by default from search and the feed tool', async () => {
    for (const [name, args] of [
      ['earthquake_search_events', {}],
      ['earthquake_get_feed', { magnitude_tier: 'all', time_window: 'week' }],
    ] as const) {
      const reply = await tool(name, args);
      expect(reply.result.isError).not.toBe(true);
      expect(reply.result.structuredContent).toMatchObject({ count: 15, truncated: true });
      expect(reply.result.structuredContent!.events).toHaveLength(15);
    }
  });
  it('walks retained feed tool pages while upstream inserts, deletes and retimes events', async () => {
    const first = await tool('earthquake_get_feed', {
      magnitude_tier: 'all',
      time_window: 'week',
      limit: 50,
    });
    expect(first.result.isError).not.toBe(true);
    expect(first.result.structuredContent).toMatchObject({ count: 50, totalCount: 140 });
    const totalCalls = calls;
    edited = true;
    let output = first.result.structuredContent!;
    const seen = output.events.map((e) => e.id);
    const firstCursor = output.nextCursor!;
    let pages = 1;
    while (output.nextCursor && pages < 20) {
      const next = await tool('earthquake_get_feed', {
        magnitude_tier: 'all',
        time_window: 'week',
        cursor: output.nextCursor,
      });
      output = next.result.structuredContent!;
      seen.push(...output.events.map((e) => e.id));
      pages++;
      expect(JSON.stringify(next.result.content)).toContain(output.events[0]!.id);
    }
    expect(output.nextCursor).toBeUndefined();
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 140 }, (_, i) => `event${i}`));
    expect(calls).toBe(totalCalls);
    const replay = await tool('earthquake_get_feed', {
      magnitude_tier: 'all',
      time_window: 'week',
      cursor: firstCursor,
    });
    expect(replay.result.structuredContent!.events[0]!.id).toBe(
      seen[first.result.structuredContent!.count],
    );
    edited = false;
  });
  it('dispatches original and continuation resources with private caching and complete projection', async () => {
    const first = await resource('earthquake://feed/all/day');
    expect(first.error).toBeUndefined();
    expect(first.result.cacheScope).not.toBe('public');
    let output = resourceData(first);
    expect(output).toMatchObject({ count: 100, totalCount: 140, truncated: true });
    const seen = output.events.map((e) => e.id);
    expect(output.events[0]).not.toHaveProperty('felt');
    const before = calls;
    let pages = 1;
    while (output.next_uri && pages < 20) {
      const next = await resource(output.next_uri);
      expect(next.error).toBeUndefined();
      output = resourceData(next);
      seen.push(...output.events.map((e) => e.id));
      pages++;
    }
    expect(pages).toBe(2);
    expect(output).toMatchObject({ count: 40, truncated: false });
    expect(seen).toEqual(Array.from({ length: 140 }, (_, i) => `event${i}`));
    expect(calls).toBe(before);
    expect(output.next_uri).toBeUndefined();
  });
  it.each(['usgs', 'emsc'])(
    '%s search returns exactly limit events per page and continues at offset + count',
    async (source) => {
      requests = [];
      let offset = 1;
      const seen: string[] = [];
      const counts: number[] = [];
      for (let pages = 0; pages < 20; pages++) {
        const reply = await tool('earthquake_search_events', {
          source,
          limit: 50,
          offset,
          start_time: '2026-01-01',
        });
        expect(reply.result.isError).not.toBe(true);
        const output = reply.result.structuredContent!;
        seen.push(...output.events.map((e) => e.id));
        counts.push(output.count);
        expect(output.queryEcho!.limit).toBe(50);
        if (output.nextOffset == null) break;
        expect(output.nextOffset).toBe(offset + output.count);
        offset = output.nextOffset;
      }
      expect(counts).toEqual([50, 50, 40]);
      expect(seen).toEqual(Array.from({ length: 140 }, (_, i) => `event${i}`));
      expect(
        requests
          .filter((r) => r.pathname.endsWith('/query'))
          .map((r) => r.searchParams.get('limit')),
      ).toEqual(['50', '50', '50']);
      requests = [];
      const clamped = await tool('earthquake_search_events', { source, limit: 20001 });
      expect(clamped.result.structuredContent).toMatchObject({
        count: 140,
        totalCount: 140,
        queryEcho: { limit: 1000 },
        notice: 'Requested limit 20001; applied limit 1000, the per-call cap.',
      });
      expect(JSON.stringify(clamped.result.content)).toContain(
        'Requested limit 20001; applied limit 1000, the per-call cap.',
      );
      expect(requests.find((r) => r.pathname.endsWith('/query'))?.searchParams.get('limit')).toBe(
        '1000',
      );
      const past = await tool('earthquake_search_events', { source, offset: 200, limit: 20000 });
      expect(past.result.structuredContent).toMatchObject({ count: 0 });
      expect(JSON.stringify(past.result.content)).toContain('last one');
    },
  );
  it('completes modern HTTP envelopes and emits private resource cache hints', async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const httpChild = spawn('bun', ['src/index.ts'], {
      env: {
        ...process.env,
        MCP_TRANSPORT_TYPE: 'http',
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: String(port),
        MCP_SESSION_MODE: 'stateless',
        MCP_AUTH_MODE: 'none',
        OTEL_ENABLED: 'false',
        MCP_LOG_LEVEL: 'error',
        STORAGE_PROVIDER_TYPE: 'in-memory',
        USGS_BASE_URL: `${base}/usgs`,
        EMSC_BASE_URL: `${base}/emsc`,
      },
      stdio: 'pipe',
    });
    httpChild.stdout.resume();
    httpChild.stderr.resume();
    const modern = async (method: string, params: object) => {
      const requestId = ++id;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
      };
      if ('name' in params) headers['Mcp-Name'] = String(params.name);
      if ('uri' in params) headers['Mcp-Name'] = String(params.uri);
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      const values = response.headers.get('content-type')?.includes('event-stream')
        ? text
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)) as Reply)
        : [JSON.parse(text) as Reply];
      const reply = values.find((value) => value.id === requestId);
      if (!reply) throw new Error(`Missing HTTP reply (${response.status})`);
      return reply;
    };
    try {
      let ready = false;
      let last: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const reply = await modern('tools/list', {});
          last = reply;
          if (!reply.error) {
            ready = true;
            break;
          }
        } catch (error) {
          last = String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(ready, JSON.stringify(last)).toBe(true);
      for (const [method, params] of [
        ['tools/call', { name: 'earthquake_get_feed', arguments: { limit: 1000 } }],
        ['tools/call', { name: 'earthquake_search_events', arguments: { limit: 20000 } }],
        ['resources/read', { uri: 'earthquake://feed/all/week' }],
      ] as const) {
        const reply = await modern(method, params);
        expect(reply.error).toBeUndefined();
        expect(reply.result.isError).not.toBe(true);
        expect(reply.result.resultType).toBe('complete');
        if (method === 'resources/read') {
          expect(reply.result.cacheScope).toBe('private');
          expect(reply.result.ttlMs).toBe(0);
          const next = await modern('resources/read', { uri: resourceData(reply).next_uri! });
          expect(next.error).toBeUndefined();
          expect(next.result.cacheScope).toBe('private');
        }
      }
      for (const marker of ['>', '-']) {
        const reply = await modern('tools/call', {
          name: 'earthquake_search_events',
          arguments: { limit: 50, event_type: `earthquake\n${marker} ${'x'.repeat(6000)}` },
        });
        expect(reply.error).toBeUndefined();
        expect(reply.result.isError).not.toBe(true);
        expect(reply.result.structuredContent).toMatchObject({ count: 50, nextOffset: 51 });
        expect(JSON.stringify(reply.result.content)).toContain('nextOffset');
      }
    } finally {
      httpChild.kill('SIGTERM');
      await new Promise<void>((resolve) => httpChild.once('exit', () => resolve()));
    }
  }, 10000);
  it('returns oversized events whole instead of failing the page', async () => {
    oversize = true;
    try {
      const reply = await tool('earthquake_get_feed', {
        magnitude_tier: 'significant',
        time_window: 'month',
      });
      expect(reply.result.isError).not.toBe(true);
      const output = reply.result.structuredContent!;
      expect(output).toMatchObject({ count: 15, totalCount: 140 });
      expect(output.events[0]!.title).toBe('x'.repeat(30000));
      expect(JSON.stringify(reply.result.content)).toContain('x'.repeat(30000));
    } finally {
      oversize = false;
    }
  });
  it.each(['502', '501', 'html', 'timeout'])(
    'maps real %s fetch failures to safe resource errors',
    async (failure) => {
      mode = failure;
      const before = calls;
      try {
        const reply = await resource('earthquake://feed/all/hour');
        expect(reply.error).toMatchObject({
          code: failure === 'timeout' ? -32004 : -32000,
          data: {
            reason: failure === 'timeout' ? 'feed_timeout' : 'feed_unavailable',
            recovery: { hint: expect.any(String) },
          },
        });
        expect(JSON.stringify(reply)).not.toContain('PRIVATE_UPSTREAM_BODY');
        expect(reply.error!.data).not.toHaveProperty('body');
        expect(reply.error!.data).not.toHaveProperty('responseBody');
        if (failure === '501') {
          expect(calls - before).toBe(1);
          expect(reply.error!.data).toMatchObject({ status: 501, retryable: false });
          expect(JSON.stringify(reply.error)).toContain('source=emsc');
        }
        if (failure === '502') expect(reply.error!.data.status).toBe(502);
      } finally {
        mode = 'normal';
      }
    },
    25000,
  );
  it('keeps real resource fetch cancellation distinct and stops retries', async () => {
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    initUsgsService({} as AppConfig, createInMemoryStorage(), `${base}/usgs`, 1000);
    const controller = new AbortController();
    mode = 'cancel';
    const before = calls;
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        earthquakeFeedResource.handler(
          { magnitude_tier: 'all', time_window: 'hour' },
          createMockContext({ errors: earthquakeFeedResource.errors, signal: controller.signal }),
        ),
      ).rejects.toMatchObject({ code: -32011 });
      expect(calls - before).toBe(1);
    } finally {
      clearTimeout(timer);
      mode = 'normal';
    }
  });
});
