/**
 * @fileoverview Tests for the earthquake-count-events tool.
 * @module tests/tools/earthquake-count-events.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeCountEvents } from '@/mcp-server/tools/definitions/earthquake-count-events.tool.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import { CALL_DEADLINE_MS } from '@/services/upstream-call.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';
import { fixture, hang } from '../helpers/usgs-fetch-stub.js';

describe('earthquakeCountEvents', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi.fn();
    mockEmscCount = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('returns count from USGS by default', async () => {
    mockUsgsCount.mockResolvedValue({ count: 342, maxAllowed: 20000, exceedsLimit: false });

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ min_magnitude: 2.5 });
    const result = await earthquakeCountEvents.handler(input, ctx);

    expect(result.source).toBe('usgs');
    expect(result.count).toBe(342);
    expect(result.max_allowed).toBe(20000);
    expect(result.exceeds_limit).toBe(false);
    expect(mockUsgsCount).toHaveBeenCalledOnce();
    expect(mockEmscCount).not.toHaveBeenCalled();
  });

  it('returns count from EMSC when source=emsc', async () => {
    mockEmscCount.mockResolvedValue({ count: 88, maxAllowed: null, exceedsLimit: false });

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', min_magnitude: 3.0 });
    const result = await earthquakeCountEvents.handler(input, ctx);

    expect(result.source).toBe('emsc');
    expect(result.count).toBe(88);
    expect(result.max_allowed).toBeNull();
    expect(result.exceeds_limit).toBe(false);
    expect(mockEmscCount).toHaveBeenCalledOnce();
  });

  it('reports exceeds_limit when count > max_allowed', async () => {
    mockUsgsCount.mockResolvedValue({ count: 25000, maxAllowed: 20000, exceedsLimit: true });

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({});
    const result = await earthquakeCountEvents.handler(input, ctx);

    expect(result.exceeds_limit).toBe(true);
    expect(result.count).toBe(25000);
  });

  it('throws invalid_radius when lat/lon provided without radius_km', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ latitude: 35.0, longitude: 139.0 });

    await expect(earthquakeCountEvents.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius when only radius_km is provided', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ radius_km: 200 });

    await expect(earthquakeCountEvents.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('accepts complete radius params', async () => {
    mockUsgsCount.mockResolvedValue({ count: 5, maxAllowed: 20000, exceedsLimit: false });

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      latitude: 35.0,
      longitude: 139.0,
      radius_km: 100,
    });
    const result = await earthquakeCountEvents.handler(input, ctx);

    expect(result.count).toBe(5);
  });

  it('propagates service errors', async () => {
    mockUsgsCount.mockRejectedValue(new Error('Count endpoint down'));

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeCountEvents.handler(input, ctx)).rejects.toThrow('Count endpoint down');
  });

  it('formats USGS count result', () => {
    const output = {
      count: 342,
      max_allowed: 20000,
      source: 'usgs' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCountEvents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('USGS');
    expect(text).toContain('342');
    expect(text).toContain('20000');
    expect(text).toContain('No');
  });

  it('formats exceeds_limit warning', () => {
    const output = {
      count: 25000,
      max_allowed: 20000,
      source: 'usgs' as const,
      exceeds_limit: true,
    };
    const blocks = earthquakeCountEvents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Yes');
    expect(text).toContain('single-request threshold');
    expect(text).toContain('offset paging');
  });

  it('formats EMSC result with null max_allowed', () => {
    const output = {
      count: 88,
      max_allowed: null,
      source: 'emsc' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCountEvents.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('EMSC');
    expect(text).toContain('Not reported by EMSC');
  });
});

describe('earthquakeCountEvents — 30-day default time window (issue #12)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi.fn().mockResolvedValue({ count: 0, maxAllowed: 20000, exceedsLimit: false });
    mockEmscCount = vi.fn().mockResolvedValue({ count: 0, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('sends an explicit startTime of end_time − 30 days when start_time is omitted', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ end_time: '2026-06-30' });
    await earthquakeCountEvents.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockUsgsCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected }),
      ctx,
    );
  });

  it('sends the same explicit startTime to EMSC instead of querying the full catalog', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', end_time: '2026-06-30' });
    await earthquakeCountEvents.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockEmscCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected }),
      ctx,
    );
  });

  it('resolves an explicit date-only start_time to midnight', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', start_time: '2026-05-31' });
    await earthquakeCountEvents.handler(input, ctx);

    expect(mockEmscCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: '2026-05-31T00:00:00' }),
      ctx,
    );
  });
});

describe('earthquakeCountEvents — queryEcho enrichment (issue #21)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi
      .fn()
      .mockResolvedValue({ count: 185, maxAllowed: 20000, exceedsLimit: false });
    mockEmscCount = vi.fn().mockResolvedValue({ count: 88, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('discloses the server-resolved 30-day window when start_time is omitted', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ min_magnitude: 5, end_time: '2026-06-30' });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({
      start_time: new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString(),
      end_time: '2026-06-30T00:00:00',
      min_magnitude: 5,
      source: 'usgs',
    });
  });

  it('a bare count still carries the window it covers', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ min_magnitude: 5 });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.start_time).toBeDefined();
    expect(typeof echo.start_time).toBe('string');
  });

  it('echoes an explicit date-only start_time as midnight', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      start_time: '2025-01-01',
      end_time: '2026-01-01',
      min_magnitude: 5,
    });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.start_time).toBe('2025-01-01T00:00:00');
    expect(echo.end_time).toBe('2026-01-01T00:00:00');
  });

  it('includes USGS-only filters in the echo for source=usgs', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({ alert_level: 'yellow', min_felt: 10, min_significance: 600 });
  });

  it('omits USGS-only filters from the echo for source=emsc (not sent upstream)', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.source).toBe('emsc');
    expect(echo).not.toHaveProperty('alert_level');
    expect(echo).not.toHaveProperty('min_felt');
    expect(echo).not.toHaveProperty('min_significance');
  });

  it('echoes the radius filters for a location-scoped count', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      latitude: 35.0,
      longitude: 139.0,
      radius_km: 100,
    });
    await earthquakeCountEvents.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({ latitude: 35.0, longitude: 139.0, radius_km: 100 });
  });

  it('renders queryEcho as a markdown trailer line, not a JSON blob', () => {
    const render = earthquakeCountEvents.enrichmentTrailer?.queryEcho?.render;
    expect(render).toBeDefined();
    const text = render!({
      start_time: '2026-05-31T00:00:00.000Z',
      end_time: '2026-06-30',
      source: 'usgs',
    });
    expect(text).toContain('**Query echo:**');
    expect(text).toContain('start_time=2026-05-31T00:00:00.000Z');
    expect(text).toContain('end_time=2026-06-30');
  });
});

describe('earthquakeCountEvents — ignored USGS-only filters for EMSC (issue #16)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi
      .fn()
      .mockResolvedValue({ count: 185, maxAllowed: 20000, exceedsLimit: false });
    mockEmscCount = vi
      .fn()
      .mockResolvedValue({ count: 638, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('names alert_level when an EMSC count supplies it', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      source: 'emsc',
      min_magnitude: 4.5,
      alert_level: 'red',
    });
    const result = await earthquakeCountEvents.handler(input, ctx);

    expect(result.count).toBe(638);
    expect(getEnrichment(ctx).ignoredFilters).toEqual(['alert_level']);
  });

  it('names every dropped filter, in schema order', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCountEvents.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual([
      'alert_level',
      'min_felt',
      'min_significance',
    ]);
  });

  it('names min_felt alone', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', min_felt: 25 });
    await earthquakeCountEvents.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_felt']);
  });

  it('names min_significance alone', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', min_significance: 600 });
    await earthquakeCountEvents.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_significance']);
  });

  it('stays absent for a USGS count, where the filters are applied', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCountEvents.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('stays absent for an EMSC count that supplies no USGS-only filter', async () => {
    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', min_magnitude: 4.5 });
    await earthquakeCountEvents.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('renders the dropped filters into content[] with the consequence spelled out', () => {
    const render = earthquakeCountEvents.enrichmentTrailer?.ignoredFilters?.render;
    expect(render).toBeDefined();

    const text = render!(['alert_level', 'min_significance']);
    expect(text).toContain('alert_level');
    expect(text).toContain('min_significance');
    expect(text).toContain('not sent upstream');
    expect(text).toContain('NOT constrained');
    expect(text).toContain('source=usgs');
  });
});

describe('earthquakeCountEvents — EMSC described as a global catalog (issue #23)', () => {
  const sourceDescription = () =>
    earthquakeCountEvents.input.shape.source.description ??
    earthquakeCountEvents.input.shape.source.def.innerType?.description ??
    '';

  it('does not scope the EMSC catalog to a region', () => {
    expect(sourceDescription()).not.toContain('covers the European-Mediterranean region');
  });

  it('names EMSC as global and attributes it to the operating organization', () => {
    expect(sourceDescription()).toContain('global');
    expect(sourceDescription()).toContain('European-Mediterranean Seismological Centre');
  });

  it('leaves usgs as the default source', () => {
    expect(earthquakeCountEvents.input.parse({}).source).toBe('usgs');
  });
});

describe('earthquakeCountEvents — upstream 4xx reason reaches the caller (issue #26)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  /** The shape fetchWithTimeout throws on a non-2xx: status-mapped code, body in data. */
  const upstreamError = (status: number, body: string) =>
    new McpError(
      status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.InvalidParams,
      `Fetch failed for https://earthquake.usgs.gov/fdsnws/event/1/count?…. Status: ${status}`,
      { status, statusText: 'Bad Request', body, errorSource: 'FetchHttpError' },
    );

  const usgsBody = `Error 400: Bad Request

Bad starttime value "2026-13-45". Valid values are ISO-8601 timestamps.

Usage details are available from https://earthquake.usgs.gov/fdsnws/event/1

Request:
/fdsnws/event/1/count?format=geojson&amp;starttime=2026-13-45

Service version:
2.7.0
`;

  const emscBody = `Error 400: Request was not properly specified: start or starttime used a bad format

Request:
http://ws2/count?format=json&start=2026-13-45

Service version: v 2.2
`;

  beforeEach(() => {
    mockUsgsCount = vi.fn();
    mockEmscCount = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('folds the USGS reason into the message, which is what content[] renders', async () => {
    mockUsgsCount.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ start_time: '2026-13-45' });
    const err = (await Promise.resolve(earthquakeCountEvents.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    expect(err.message).toContain('Bad starttime value "2026-13-45"');
    expect(err.message).toContain('USGS');
    expect(err.message).not.toContain('Usage details');
    expect(err.message).not.toContain('Service version');
  });

  it('carries the contract recovery hint and status in structuredContent data', async () => {
    mockUsgsCount.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ start_time: '2026-13-45' });

    await expect(earthquakeCountEvents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'upstream_rejected',
        status: 400,
        recovery: { hint: expect.stringContaining('offending parameter') },
      },
    });
  });

  it('does the same for EMSC, whose 400 is worded differently', async () => {
    mockEmscCount.mockRejectedValue(upstreamError(400, emscBody));

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ source: 'emsc', start_time: '2026-13-45' });
    const err = (await Promise.resolve(earthquakeCountEvents.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    expect(err.message).toContain('EMSC rejected the query');
    expect(err.message).toContain('start or starttime used a bad format');
    expect(err.message).not.toContain('ws2');
    expect((err.data as { reason?: string }).reason).toBe('upstream_rejected');
  });

  it('leaves a 5xx on the source_unavailable contract', async () => {
    mockUsgsCount.mockRejectedValue(upstreamError(503, 'Error 503: Service Unavailable'));

    const ctx = createMockContext({ errors: earthquakeCountEvents.errors });
    const input = earthquakeCountEvents.input.parse({ min_magnitude: 5 });

    await expect(earthquakeCountEvents.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable', recovery: { hint: expect.any(String) } },
    });
  });
});

/** Every text block of a tool result, joined. */
const contentText = (result: { content?: unknown }) =>
  ((result.content ?? []) as { text?: string }[]).map((block) => block.text ?? '').join('\n');

describe('earthquakeCountEvents — min_mmi and min_cdi (issue #65)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi.fn().mockResolvedValue({ count: 9, maxAllowed: 20000, exceedsLimit: false });
    mockEmscCount = vi.fn().mockResolvedValue({ count: 4, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('passes both to USGS and echoes them on both surfaces', async () => {
    const result = await runToolContract(earthquakeCountEvents, { min_mmi: 7, min_cdi: 6.5 });

    expect(mockUsgsCount.mock.calls[0]?.[0]).toMatchObject({ minMmi: 7, minCdi: 6.5 });
    expect(result.structuredContent).toMatchObject({
      count: 9,
      queryEcho: { min_mmi: 7, min_cdi: 6.5 },
    });
    expect(result.structuredContent).not.toHaveProperty('ignoredFilters');
    expect(contentText(result)).toContain('min_mmi=7');
    expect(contentText(result)).toContain('min_cdi=6.5');
  });

  it('names both as ignored on EMSC and keeps them out of the echo', async () => {
    const result = await runToolContract(earthquakeCountEvents, {
      source: 'emsc',
      min_mmi: 7,
      min_cdi: 6.5,
    });

    expect(result.structuredContent).toMatchObject({ ignoredFilters: ['min_cdi', 'min_mmi'] });
    const echo = (result.structuredContent as { queryEcho: object }).queryEcho;
    expect(echo).not.toHaveProperty('min_mmi');
    expect(echo).not.toHaveProperty('min_cdi');
    expect(contentText(result)).toContain('min_cdi, min_mmi');
    expect(contentText(result)).not.toContain('min_mmi=');
  });
});

describe('earthquakeCountEvents — a zero names the type value USGS does not list (issue #66)', () => {
  const USGS = 'https://earthquake.usgs.gov';
  type Responder = (url: URL, init?: RequestInit) => Response | Promise<Response>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  /**
   * Run the real USGS adapter against a fetch fake: the count endpoint answers `count`, the
   * vocabulary endpoint `vocabulary`, and any other URL rejects. Every path is recorded, so
   * a test reads the upstream traffic rather than trusting the fake to complain.
   */
  function stubUsgs(
    count: number,
    vocabulary: Responder = () => new Response(fixture('application.json')),
  ) {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.origin === USGS ? url.pathname : url.href);
        if (url.origin === USGS && url.pathname === '/fdsnws/event/1/count')
          return Response.json({ count, maxAllowed: 20000 });
        if (url.origin === USGS && url.pathname === '/fdsnws/event/1/application.json')
          return vocabulary(url, init);
        throw new Error(`unexpected fetch ${url.href}`);
      }),
    );
    return paths;
  }
  const COUNT = '/fdsnws/event/1/count';
  const VOCABULARY = '/fdsnws/event/1/application.json';

  beforeEach(() => {
    // A fresh service per test, so no vocabulary is cached from an earlier one.
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue(
      new usgsModule.UsgsService({} as AppConfig, {} as StorageService, USGS, 5000),
    );
    mockEmscCount = vi.fn().mockResolvedValue({ count: 0, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names the detail-group spelling of a product type and the one USGS lists', async () => {
    const paths = stubUsgs(0);
    const result = await runToolContract(earthquakeCountEvents, {
      start_time: '2026-01-01',
      end_time: '2026-11-01',
      min_magnitude: 6,
      product_type: 'moment_tensor',
    });

    const notice =
      'product_type "moment_tensor" is not a listed USGS product type; did you mean "moment-tensor"? USGS matches an unlisted value against no events.';
    expect(result.structuredContent).toMatchObject({ count: 0, notice });
    expect(contentText(result)).toContain(`> ${notice}`);
    expect(paths).toEqual([COUNT, VOCABULARY]);
  });

  it('keeps the value raw in structuredContent and escaped in content[]', async () => {
    stubUsgs(0);
    const result = await runToolContract(earthquakeCountEvents, { event_type: '*quake* `x`' });

    expect((result.structuredContent as { notice: string }).notice).toBe(
      'event_type "*quake* `x`" is not a listed USGS event type. USGS matches an unlisted value against no events.',
    );
    expect(contentText(result)).toContain(
      '> event_type "\\*quake\\* \\`x\\`" is not a listed USGS event type. USGS matches an unlisted value against no events.',
    );
  });

  it.each([
    ['a nonzero count', 114, { product_type: 'moment_tensor' }],
    ['a count without the three fields', 0, { min_magnitude: 9.5 }],
  ])('makes no lookup for %s', async (_label, count, args) => {
    const paths = stubUsgs(count);
    const result = await runToolContract(earthquakeCountEvents, args);

    expect(paths).toEqual([COUNT]);
    expect(result.structuredContent).toMatchObject({ count });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('makes no lookup for an EMSC count, whose catalog the vocabulary does not describe', async () => {
    const paths = stubUsgs(0);
    const result = await runToolContract(earthquakeCountEvents, {
      source: 'emsc',
      magnitude_type: 'mww',
      product_type: 'moment_tensor',
    });

    expect(paths).toEqual([]);
    expect(result.structuredContent).toMatchObject({ count: 0, source: 'emsc' });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('stays silent when every supplied value is listed', async () => {
    const paths = stubUsgs(0);
    const result = await runToolContract(earthquakeCountEvents, { product_type: 'Moment-Tensor' });

    expect(paths).toEqual([COUNT, VOCABULARY]);
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('returns the zero as before when the lookup fails', async () => {
    const paths = stubUsgs(0, () => new Response('Error 503', { status: 503 }));
    const result = await runToolContract(earthquakeCountEvents, { product_type: 'moment_tensor' });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ count: 0, source: 'usgs' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).not.toContain('not a listed');
    expect(paths).toEqual([COUNT, VOCABULARY]);
  });

  it('reports a cancellation during the lookup as cancellation, not as a zero', async () => {
    const controller = new AbortController();
    stubUsgs(0, (url, init) => {
      controller.abort();
      return hang(url, init);
    });
    const result = await runToolContract(
      earthquakeCountEvents,
      { product_type: 'moment_tensor' },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(contentText(result)).toContain('aborted');
  });

  it('gives the lookup only what remains of the count call deadline (issues #59, #66)', async () => {
    vi.useFakeTimers();
    // A per-attempt timeout above what the deadline leaves, so only the shared deadline can
    // end the lookup; a fresh budget would carry the call to 95 s.
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue(
      new usgsModule.UsgsService({} as AppConfig, {} as StorageService, USGS, 50_000),
    );
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        paths.push(url.origin === USGS ? url.pathname : url.href);
        if (url.origin === USGS && url.pathname === COUNT)
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(Response.json({ count: 0, maxAllowed: 20000 })), 45_000),
          );
        if (url.origin === USGS && url.pathname === VOCABULARY) return hang(url, init);
        return Promise.reject(new Error(`unexpected fetch ${url.href}`));
      }),
    );
    const started = Date.now();

    const pending = runToolContract(earthquakeCountEvents, { product_type: 'moment_tensor' });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(paths).toEqual([COUNT, VOCABULARY]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45_000);
    expect(Date.now() - started).toBeLessThanOrEqual(CALL_DEADLINE_MS);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ count: 0, source: 'usgs' });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('describes the notice field and the event_type matching', () => {
    expect(earthquakeCountEvents.enrichment?.notice?.description).toContain('USGS does not list');
    expect(earthquakeCountEvents.input.shape.event_type.description).toContain(
      'case-insensitively',
    );
    expect(earthquakeCountEvents.input.shape.event_type.description).not.toContain('verbatim');
  });
});
