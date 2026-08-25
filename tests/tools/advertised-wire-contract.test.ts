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
import { describe, expect, it } from 'vitest';
import { earthquakeFeedResource } from '@/mcp-server/resources/definitions/earthquake-feed.resource.js';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import { earthquakeGetFeed } from '@/mcp-server/tools/definitions/earthquake-get-feed.tool.js';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';

/** Every tool, plus one input each that satisfies its required fields. */
const tools = [
  { name: 'earthquake_get_feed', tool: earthquakeGetFeed, valid: {} },
  { name: 'earthquake_search', tool: earthquakeSearch, valid: { min_magnitude: 5 } },
  { name: 'earthquake_count', tool: earthquakeCount, valid: { min_magnitude: 5 } },
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
  it('caps a cached read at the USGS feed regeneration interval', () => {
    // USGS regenerates these feeds about once a minute, so a re-read inside the
    // window cannot return anything staler than a fresh fetch would.
    expect(earthquakeFeedResource.cacheHint).toEqual({ ttlMs: 60_000, cacheScope: 'public' });
  });
});
