/**
 * @fileoverview Tables the 2xx body handling every USGS and EMSC call shares: parsing and
 * shape-checking a body, reading one whose connection drops, and the retry predicate that
 * keeps a malformed body from being retried while everything else stays transient.
 * @module tests/services/upstream-call.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isJsonObject,
  isTransientUpstream,
  malformedResponse,
  parseJsonBody,
  readResponseText,
} from '@/services/upstream-call.js';

/** Captured before any stub, for the loopback server only. */
const realFetch = globalThis.fetch;

/** Text a JSON parser or the runtime's socket layer authors. */
const ENGINE_TEXT =
  /JSON|SyntaxError|Parse error|position \d|Unexpected token|ECONNRESET|socket|verbose|terminated|other side/i;

const reqCtx = () => requestContextService.createRequestContext({ operation: 'upstreamCallTest' });
const hasFeatures = (value: unknown): value is { features: unknown[] } =>
  isJsonObject(value) && Array.isArray(value.features);

/** The value `run` throws; fails the test when it returns. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unmocked fetch'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseJsonBody', () => {
  it.each([
    ['truncated JSON', '{"type":"FeatureCollection",'],
    ['plain text', 'Service temporarily unavailable'],
    ['an empty body', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"FeatureCollection"'],
    ['a number', '42'],
    ['an object without the field read next', '{}'],
    ['the field in the wrong type', '{"features":{}}'],
  ])('fails %s as malformed_response with a fixed message', (_label, body) => {
    const err = thrownBy(() => parseJsonBody(body, 'EMSC', hasFeatures));
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'EMSC returned a response in an unexpected format.',
      data: { reason: 'malformed_response' },
    });
    expect((err as McpError).data?.retryable).toBeUndefined();
    expect(
      JSON.stringify({ message: (err as McpError).message, data: (err as McpError).data }),
    ).not.toMatch(ENGINE_TEXT);
  });

  it('keeps the parser error as the cause, for the log only', () => {
    const err = thrownBy(() => parseJsonBody('{"type":', 'USGS', hasFeatures)) as McpError;
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('returns the parsed document when the shape holds', () => {
    expect(parseJsonBody('{"features":[{"id":"a"}]}', 'USGS', hasFeatures)).toEqual({
      features: [{ id: 'a' }],
    });
  });

  it.each([
    ['null', null, false],
    ['an array', [], false],
    ['a string', 'x', false],
    ['an object', {}, true],
  ])('isJsonObject reads %s as %s', (_label, value, expected) => {
    expect(isJsonObject(value)).toBe(expected);
  });
});

describe('isTransientUpstream', () => {
  it('does not retry a malformed body', () => {
    expect(isTransientUpstream(malformedResponse('USGS'))).toBe(false);
  });

  it.each([
    [
      'a ServiceUnavailable without a reason (HTML, 5xx, dropped body)',
      serviceUnavailable('x'),
      true,
    ],
    ['a raw runtime error', new TypeError('fetch failed'), true],
    [
      'an explicit retryable: false (HTTP 501)',
      serviceUnavailable('x', { retryable: false }),
      false,
    ],
    ['a NotFound', new McpError(JsonRpcErrorCode.NotFound, 'x'), false],
    [
      'a caller-side deadline',
      new McpError(JsonRpcErrorCode.Timeout, 'x', { errorSource: 'FetchSignalTimeout' }),
      false,
    ],
  ])('keeps the framework default for %s', (_label, error, expected) => {
    expect(isTransientUpstream(error)).toBe(expected);
  });
});

describe('readResponseText — a connection dropped mid-body', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    // Promises 400 bytes, sends the first few, then closes the socket.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '400' });
      res.write('{"type":"FeatureCollection","features":[', () => res.socket?.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("converts the runtime's read error into a retryable ServiceUnavailable with a fixed message", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit) =>
        new URL(String(url)).origin === origin
          ? realFetch(url, init)
          : Promise.reject(new Error('unmocked fetch')),
      ),
    );
    const response = await fetchWithTimeout(`${origin}/fdsnws/event/1/query`, 5000, reqCtx());
    const err = (await readResponseText(response, 'USGS').catch((e: unknown) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('USGS closed the connection before the response was complete.');
    expect(err.data?.reason).toBeUndefined();
    expect(isTransientUpstream(err)).toBe(true);
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(ENGINE_TEXT);
    // The framework hands the read error back unclassified (cyanheads/mcp-ts-core#819).
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause).not.toBeInstanceOf(McpError);
  });
});

/** A 2xx body that sends one chunk, then errors with the abort reason the way platform fetch does. */
function abortableBody(signal: AbortSignal | null | undefined, onPull?: () => void): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"FeatureCollection",'));
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      pull() {
        onPull?.();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('readResponseText — classified read failures pass through', () => {
  it('keeps a body the attempt timeout cut short as Timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => Promise.resolve(abortableBody(init?.signal))),
    );
    const response = await fetchWithTimeout('https://usgs.test/feed.geojson', 1000, reqCtx());
    const pending = readResponseText(response, 'USGS').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { errorSource: 'FetchTimeout' },
    });
  });

  it('keeps a caller cancellation mid-body as RequestCancelled', async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        // The caller walks away once the body is streaming.
        Promise.resolve(abortableBody(init?.signal, () => caller.abort())),
      ),
    );
    const response = await fetchWithTimeout('https://usgs.test/feed.geojson', 5000, reqCtx(), {
      signal: caller.signal,
    });
    const err = (await readResponseText(response, 'USGS').catch((e: unknown) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(err.message).toBe('fetch GET https://usgs.test/… was aborted.');
  });
});
