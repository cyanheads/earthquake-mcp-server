/**
 * @fileoverview Pins the advertised wire contract every client reads before it ever
 * calls a tool — the surface mcp-ts-core 0.12.0 changed underneath this server.
 *
 * Three things moved at once and none of them are visible from a handler test:
 * tool inputs became strict at the root (`additionalProperties: false` advertised,
 * an undeclared key rejected by name instead of silently stripped), the emitted
 * dialect moved to JSON Schema 2020-12, and `error` became the reserved failure-envelope
 * key that `tool()` throws on at definition time. A handler test passes either way,
 * so the advertised bytes need their own assertions or a regression ships silently.
 *
 * @module tests/tools/advertised-wire-contract.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeEventResource } from '@/mcp-server/resources/definitions/earthquake-event.resource.js';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCountEvents } from '@/mcp-server/tools/definitions/earthquake-count-events.tool.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearchEvents } from '@/mcp-server/tools/definitions/earthquake-search-events.tool.js';
import { initEmscService } from '@/services/emsc/emsc-service.js';
import { initUsgsService } from '@/services/usgs/usgs-service.js';

describe('event and FDSN regressions — real service wire path', () => {
  beforeEach(() => {
    initUsgsService({} as AppConfig, {} as StorageService, 'https://earthquake.usgs.gov', 5000);
    initEmscService({} as AppConfig, {} as StorageService, 'https://www.seismicportal.eu', 5000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['', ' \r\n '])(
    'rejects blank event %j on both surfaces without fetch',
    async (event_id) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const result = await runToolContract(earthquakeGetEvent, { event_id });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(JSON.stringify(result.content)).toContain('nonblank');
      expect(() => earthquakeEventResource.params!.parse({ event_id })).toThrow('nonblank');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [409, 'event_deleted'],
    [404, 'not_found'],
  ] as const)(
    'maps upstream %s to %s with clean recovery on tool and resource',
    async (status, reason) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response('Request: http://private/query', { status })),
        );
      vi.stubGlobal('fetch', fetchMock);
      const result = await runToolContract(earthquakeGetEvent, { event_id: 'ci41350791' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason } },
      });
      expect(JSON.stringify(result.content)).toContain('Recovery:');
      expect(JSON.stringify(result.content)).toContain(reason);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('responseBody');
      const err = await Promise.resolve(
        earthquakeEventResource.handler(
          { event_id: 'ci41350791' },
          createMockContext({ errors: earthquakeEventResource.errors }),
        ),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason,
          recovery: {
            hint: earthquakeEventResource.errors?.find((entry) => entry.reason === reason)
              ?.recovery,
          },
        },
      });
      if (status === 409) {
        expect(result.structuredContent).toMatchObject({ error: { data: { retryable: false } } });
        expect(err).toMatchObject({ data: { retryable: false } });
      }
      expect(JSON.stringify(err)).not.toContain('private');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('carries corrected PGV and producer version through tool and resource outputs', async () => {
    const feature = {
      type: 'Feature',
      id: 'official20110311054624120_30',
      geometry: { type: 'Point', coordinates: [142, 38, 29] },
      properties: {
        mag: 9.1,
        ids: ',usc0001xgp,',
        products: {
          shakemap: [
            {
              properties: {
                maxpgv: '4.43',
                maxpga: '1.669',
                'shakemap-code-version': '4.0.2+335.gcbad862',
              },
            },
          ],
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json(feature))),
    );
    const result = await runToolContract(earthquakeGetEvent, { event_id: 'USC0001XGP' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      detail: {
        shakemap: {
          max_pgv: 83.93141691026881,
          max_pga: 1.669,
          code_version: '4.0.2+335.gcbad862',
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('83.93141691026881 cm/s');
    expect(JSON.stringify(result.content)).toContain('4.0.2+335.gcbad862');
    const resource = await earthquakeEventResource.handler(
      { event_id: 'usc0001xgp' },
      createMockContext({ errors: earthquakeEventResource.errors }),
    );
    expect(resource).toEqual(result.structuredContent);
    expect(earthquakeEventResource.output!.parse(resource).detail?.shakemap?.code_version).toBe(
      '4.0.2+335.gcbad862',
    );
  });

  it.each([earthquakeSearchEvents, earthquakeCountEvents])(
    'extracts EMSC JSON detail through $name on both error surfaces',
    async (tool) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() =>
          Promise.resolve(
            Response.json(
              {
                detail:
                  'Error 400: Request was not properly specified: start or starttime used a bad format\n\nRequest:\nhttp://private/query\nService version: 2.2',
              },
              { status: 400 },
            ),
          ),
        ),
      );
      const result = await runToolContract(tool, { source: 'emsc', start_time: '2026-13-45' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          message:
            'EMSC rejected the query: Request was not properly specified: start or starttime used a bad format',
          data: {
            reason: 'upstream_rejected',
            status: 400,
            recovery: { hint: expect.any(String) },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain(
        'EMSC rejected the query: Request was not properly specified',
      );
      expect(JSON.stringify(result.content)).toContain('Recovery:');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(result)).not.toContain('responseBody');
    },
  );
});

/** Every tool, plus one input each that satisfies its required fields. */
const tools = [
  { name: 'earthquake_get_feed', tool: earthquakeGetFeed, valid: {} },
  { name: 'earthquake_search_events', tool: earthquakeSearchEvents, valid: { min_magnitude: 5 } },
  { name: 'earthquake_count_events', tool: earthquakeCountEvents, valid: { min_magnitude: 5 } },
  { name: 'earthquake_get_event', tool: earthquakeGetEvent, valid: { event_id: 'us6000sznj' } },
] as const;

type EmittedSchema = {
  $schema?: string;
  additionalProperties?: unknown;
  properties?: Record<string, unknown>;
};

const emit = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input' }) as unknown as EmittedSchema;

describe.each(tools)('$name — advertised inputSchema', ({ tool, valid }) => {
  it('mirrors a contract-runner argument rejection into both client surfaces', async () => {
    const argumentsWithUnknownKey = { ...valid, bogus_key: 1 };
    const result = await runToolContract(
      tool,
      argumentsWithUnknownKey as z.input<typeof tool.input>,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      // runToolContract routes through the same parseToolArguments call the HTTP
      // pipeline makes, so an argument rejection carries the code a client receives.
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(JSON.stringify(result.structuredContent)).toContain('bogus_key');
    expect(JSON.stringify(result.content)).toContain('bogus_key');
  });

  it('advertises additionalProperties: false at the root', () => {
    expect(emit(tool.input).additionalProperties).toBe(false);
  });

  it('advertises the 2020-12 dialect, which strict clients require before dispatching', () => {
    expect(emit(tool.input).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('rejects an undeclared key by name instead of stripping it', () => {
    const result = tool.input.safeParse({ ...valid, bogus_key: 1 });

    expect(result.success).toBe(false);
    // Named, not just refused: a caller that misreads the schema needs to be told
    // which key it invented, and the rejection must sit at the root.
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect((issue as { keys?: string[] } | undefined)?.keys).toEqual(['bogus_key']);
    expect(issue?.path).toEqual([]);
  });

  it('names a near-miss typo of a real field rather than ignoring it silently', () => {
    // The DX case strictness exists for: pre-0.12 this parsed clean and the filter
    // was silently dropped, so the caller got unfiltered results and no signal.
    const result = tool.input.safeParse({ ...valid, min_magnitud: 5 });

    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect((issue as { keys?: string[] } | undefined)?.keys).toEqual(['min_magnitud']);
  });

  it('still accepts an input built only from declared keys', () => {
    // Guards the opposite failure: strictness that over-tightens and rejects
    // a legitimate call would make every assertion above vacuously true.
    expect(tool.input.safeParse(valid).success).toBe(true);
  });

  it('reserves `error` — it is the failure envelope key, never a success field', () => {
    // `tool()` throws at definition time on an `output`/`enrichment` field named
    // `error`, so importing this module is itself the guard. These assertions make
    // the reason legible when someone later reaches for the name.
    expect(Object.keys(tool.output.shape)).not.toContain('error');
    expect(Object.keys(tool.enrichment ?? {})).not.toContain('error');
  });
});

describe('earthquake-feed resource — cache hint', () => {
  it('keeps tenant-bound continuation tokens out of shared caches', () => {
    expect(earthquakeFeedResource.cacheHint).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });
});
