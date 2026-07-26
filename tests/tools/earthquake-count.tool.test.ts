/**
 * @fileoverview Tests for the earthquake-count tool.
 * @module tests/tools/earthquake-count.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

describe('earthquakeCount', () => {
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

    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ min_magnitude: 2.5 });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.source).toBe('usgs');
    expect(result.count).toBe(342);
    expect(result.max_allowed).toBe(20000);
    expect(result.exceeds_limit).toBe(false);
    expect(mockUsgsCount).toHaveBeenCalledOnce();
    expect(mockEmscCount).not.toHaveBeenCalled();
  });

  it('returns count from EMSC when source=emsc', async () => {
    mockEmscCount.mockResolvedValue({ count: 88, maxAllowed: null, exceedsLimit: false });

    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', min_magnitude: 3.0 });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.source).toBe('emsc');
    expect(result.count).toBe(88);
    expect(result.max_allowed).toBeNull();
    expect(result.exceeds_limit).toBe(false);
    expect(mockEmscCount).toHaveBeenCalledOnce();
  });

  it('reports exceeds_limit when count > max_allowed', async () => {
    mockUsgsCount.mockResolvedValue({ count: 25000, maxAllowed: 20000, exceedsLimit: true });

    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({});
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.exceeds_limit).toBe(true);
    expect(result.count).toBe(25000);
  });

  it('throws invalid_radius when lat/lon provided without radius_km', async () => {
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ latitude: 35.0, longitude: 139.0 });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius when only radius_km is provided', async () => {
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ radius_km: 200 });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('accepts complete radius params', async () => {
    mockUsgsCount.mockResolvedValue({ count: 5, maxAllowed: 20000, exceedsLimit: false });

    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      latitude: 35.0,
      longitude: 139.0,
      radius_km: 100,
    });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.count).toBe(5);
  });

  it('propagates service errors', async () => {
    mockUsgsCount.mockRejectedValue(new Error('Count endpoint down'));

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toThrow('Count endpoint down');
  });

  it('formats USGS count result', () => {
    const output = {
      count: 342,
      max_allowed: 20000,
      source: 'usgs' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCount.format!(output);
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
    const blocks = earthquakeCount.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Yes');
    expect(text).toContain('truncated');
  });

  it('formats EMSC result with null max_allowed', () => {
    const output = {
      count: 88,
      max_allowed: null,
      source: 'emsc' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCount.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('EMSC');
    expect(text).toContain('Not reported by EMSC');
  });
});

describe('earthquakeCount — 30-day default time window (issue #12)', () => {
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
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ end_time: '2026-06-30' });
    await earthquakeCount.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockUsgsCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected }),
      ctx,
    );
  });

  it('sends the same explicit startTime to EMSC instead of querying the full catalog', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', end_time: '2026-06-30' });
    await earthquakeCount.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockEmscCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected }),
      ctx,
    );
  });

  it('passes an explicit start_time through unchanged', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', start_time: '2026-05-31' });
    await earthquakeCount.handler(input, ctx);

    expect(mockEmscCount).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: '2026-05-31' }),
      ctx,
    );
  });
});

describe('earthquakeCount — queryEcho enrichment (issue #21)', () => {
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
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ min_magnitude: 5, end_time: '2026-06-30' });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({
      start_time: new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString(),
      end_time: '2026-06-30',
      min_magnitude: 5,
      source: 'usgs',
    });
  });

  it('a bare count still carries the window it covers', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ min_magnitude: 5 });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.start_time).toBeDefined();
    expect(typeof echo.start_time).toBe('string');
  });

  it('passes an explicit start_time through to the echo unchanged', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      start_time: '2025-01-01',
      end_time: '2026-01-01',
      min_magnitude: 5,
    });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.start_time).toBe('2025-01-01');
    expect(echo.end_time).toBe('2026-01-01');
  });

  it('includes USGS-only filters in the echo for source=usgs', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({ alert_level: 'yellow', min_felt: 10, min_significance: 600 });
  });

  it('omits USGS-only filters from the echo for source=emsc (not sent upstream)', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.source).toBe('emsc');
    expect(echo).not.toHaveProperty('alert_level');
    expect(echo).not.toHaveProperty('min_felt');
    expect(echo).not.toHaveProperty('min_significance');
  });

  it('echoes the radius filters for a location-scoped count', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      latitude: 35.0,
      longitude: 139.0,
      radius_km: 100,
    });
    await earthquakeCount.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({ latitude: 35.0, longitude: 139.0, radius_km: 100 });
  });

  it('renders queryEcho as a markdown trailer line, not a JSON blob', () => {
    const render = earthquakeCount.enrichmentTrailer?.queryEcho?.render;
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

describe('earthquakeCount — ignored USGS-only filters for EMSC (issue #16)', () => {
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
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      source: 'emsc',
      min_magnitude: 4.5,
      alert_level: 'red',
    });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.count).toBe(638);
    expect(getEnrichment(ctx).ignoredFilters).toEqual(['alert_level']);
  });

  it('names every dropped filter, in schema order', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual([
      'alert_level',
      'min_felt',
      'min_significance',
    ]);
  });

  it('names min_felt alone', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', min_felt: 25 });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_felt']);
  });

  it('names min_significance alone', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', min_significance: 600 });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_significance']);
  });

  it('stays absent for a USGS count, where the filters are applied', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('stays absent for an EMSC count that supplies no USGS-only filter', async () => {
    const ctx = createMockContext();
    const input = earthquakeCount.input.parse({ source: 'emsc', min_magnitude: 4.5 });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('renders the dropped filters into content[] with the consequence spelled out', () => {
    const render = earthquakeCount.enrichmentTrailer?.ignoredFilters?.render;
    expect(render).toBeDefined();

    const text = render!(['alert_level', 'min_significance']);
    expect(text).toContain('alert_level');
    expect(text).toContain('min_significance');
    expect(text).toContain('not sent upstream');
    expect(text).toContain('NOT constrained');
    expect(text).toContain('source=usgs');
  });
});

describe('earthquakeCount — EMSC described as a global catalog (issue #23)', () => {
  const sourceDescription = () =>
    earthquakeCount.input.shape.source.description ??
    earthquakeCount.input.shape.source.def.innerType?.description ??
    '';

  it('does not scope the EMSC catalog to a region', () => {
    expect(sourceDescription()).not.toContain('covers the European-Mediterranean region');
  });

  it('names EMSC as global and attributes it to the operating organization', () => {
    expect(sourceDescription()).toContain('global');
    expect(sourceDescription()).toContain('European-Mediterranean Seismological Centre');
  });

  it('leaves usgs as the default source', () => {
    expect(earthquakeCount.input.parse({}).source).toBe('usgs');
  });
});

describe('earthquakeCount — upstream 4xx reason reaches the caller (issue #26)', () => {
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

Bad starttime value "not-a-date". Valid values are ISO-8601 timestamps.

Usage details are available from https://earthquake.usgs.gov/fdsnws/event/1

Request:
/fdsnws/event/1/count?format=geojson&amp;starttime=not-a-date

Service version:
2.7.0
`;

  const emscBody = `Error 400: Request was not properly specified: start or starttime used a bad format

Request:
http://ws2/count?format=json&start=not-a-date

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

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ start_time: 'not-a-date' });
    const err = (await earthquakeCount.handler(input, ctx).catch((e) => e)) as McpError;

    expect(err.message).toContain('Bad starttime value "not-a-date"');
    expect(err.message).toContain('USGS');
    expect(err.message).not.toContain('Usage details');
    expect(err.message).not.toContain('Service version');
  });

  it('carries the contract recovery hint and status in structuredContent data', async () => {
    mockUsgsCount.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ start_time: 'not-a-date' });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
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

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc', start_time: 'not-a-date' });
    const err = (await earthquakeCount.handler(input, ctx).catch((e) => e)) as McpError;

    expect(err.message).toContain('EMSC rejected the query');
    expect(err.message).toContain('start or starttime used a bad format');
    expect(err.message).not.toContain('ws2');
    expect((err.data as { reason?: string }).reason).toBe('upstream_rejected');
  });

  it('leaves a 5xx on the source_unavailable contract', async () => {
    mockUsgsCount.mockRejectedValue(upstreamError(503, 'Error 503: Service Unavailable'));

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5 });

    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable', recovery: { hint: expect.any(String) } },
    });
  });
});
