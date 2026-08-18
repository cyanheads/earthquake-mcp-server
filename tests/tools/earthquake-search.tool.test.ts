/**
 * @fileoverview Tests for the earthquake-search tool.
 * @module tests/tools/earthquake-search.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const sampleEvent: EarthquakeEventOutput = {
  id: 'us6000sznj',
  title: 'M 5.8 - 50 km W of Tokyo, Japan',
  magnitude: 5.8,
  magnitude_type: 'mww',
  time: '2026-05-01T08:00:00.000Z',
  updated: '2026-05-01T08:30:00.000Z',
  place: '50 km W of Tokyo, Japan',
  latitude: 35.6762,
  longitude: 139.6503,
  depth_km: 35,
  felt: 50,
  cdi: 4.1,
  mmi: 4.8,
  alert: 'green',
  tsunami: 0,
  significance: 540,
  status: 'reviewed',
  event_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000sznj',
};

const emscEvent: EarthquakeEventOutput = {
  id: 'emsc-2026-xyz',
  title: 'M 4.2 - TURKEY',
  magnitude: 4.2,
  magnitude_type: 'ml',
  time: '2026-05-01T06:00:00.000Z',
  updated: '2026-05-01T06:10:00.000Z',
  place: 'TURKEY',
  latitude: 39.0,
  longitude: 35.0,
  depth_km: 12,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'reviewed',
};

describe('earthquakeSearch', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    mockEmscSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('searches USGS by default', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    const result = await earthquakeSearch.handler(input, ctx);

    expect(result.source).toBe('usgs');
    expect(result.count).toBe(1);
    expect(result.events[0]?.id).toBe('us6000sznj');
    expect(mockUsgsSearch).toHaveBeenCalledOnce();
    expect(mockEmscSearch).not.toHaveBeenCalled();
  });

  it('routes to EMSC when source=emsc', async () => {
    mockEmscSearch.mockResolvedValue({ events: [emscEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', min_magnitude: 3.0 });
    const result = await earthquakeSearch.handler(input, ctx);

    expect(result.source).toBe('emsc');
    expect(result.events[0]?.id).toBe('emsc-2026-xyz');
    expect(mockEmscSearch).toHaveBeenCalledOnce();
    expect(mockUsgsSearch).not.toHaveBeenCalled();
  });

  it('throws invalid_radius when lat/lon provided without radius_km', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ latitude: 35.0, longitude: 139.0 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius when radius_km provided without lat/lon', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ radius_km: 100 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('accepts complete radius search params', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      latitude: 35.0,
      longitude: 139.0,
      radius_km: 100,
    });
    const result = await earthquakeSearch.handler(input, ctx);
    expect(result.count).toBe(0);
  });

  it('populates totalCount enrichment when service returns it', async () => {
    mockUsgsSearch.mockResolvedValue({
      events: [sampleEvent],
      count: 1,
      totalCount: 500,
    });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).totalCount).toBe(500);
  });

  it('omits totalCount enrichment when service does not return it', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({});
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).totalCount).toBeUndefined();
  });

  it('sets truncated enrichment when count equals limit', async () => {
    // Default limit is 100 from server config, so mock exactly 100 events
    const events = Array.from({ length: 100 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 100 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 100 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('does not set truncated enrichment when count is below limit', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 100 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('populates notice enrichment on empty results', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 8.0 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toBeDefined();
    expect(notice).toContain('No events');
  });

  it('populates notice enrichment when results are truncated', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toBeDefined();
    expect(notice).toContain('earthquake_count');
  });

  it('truncation notice carries the total match count when the service returns it', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5, totalCount: 4821 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toContain('4821');
    expect(notice).not.toContain('earthquake_count');
  });

  it('does not populate notice on normal non-empty result', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('propagates service errors', async () => {
    mockUsgsSearch.mockRejectedValue(new Error('USGS down'));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toThrow('USGS down');
  });

  it('formats results with source and count', () => {
    const output = {
      count: 1,
      source: 'usgs' as const,
      events: [sampleEvent],
    };
    const blocks = earthquakeSearch.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('USGS');
    expect(text).toContain('us6000sznj');
    expect(text).toContain('5.8');
    expect(text).toContain('Tokyo');
  });

  it('formats empty results with no-events message', () => {
    const output = { count: 0, source: 'usgs' as const, events: [] };
    const blocks = earthquakeSearch.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No events');
  });
});

describe('earthquakeSearch — 30-day default time window (issue #12)', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn().mockResolvedValue({ events: [], count: 0 });
    mockEmscSearch = vi.fn().mockResolvedValue({ events: [], count: 0 });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('sends an explicit startTime of end_time − 30 days when start_time is omitted', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ end_time: '2026-06-30' });
    await earthquakeSearch.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockUsgsSearch).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected, endTime: '2026-06-30' }),
      ctx,
    );
  });

  it('sends the same explicit startTime to EMSC — no upstream default divergence', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', end_time: '2026-06-30' });
    await earthquakeSearch.handler(input, ctx);

    const expected = new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString();
    expect(mockEmscSearch).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: expected }),
      ctx,
    );
  });

  it('passes an explicit start_time through unchanged', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ start_time: '2026-05-31' });
    await earthquakeSearch.handler(input, ctx);

    expect(mockUsgsSearch).toHaveBeenCalledWith(
      expect.objectContaining({ startTime: '2026-05-31' }),
      ctx,
    );
  });
});

describe('earthquakeSearch — queryEcho enrichment (issue #11)', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    mockEmscSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('populates queryEcho with effective params including the resolved start_time', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ end_time: '2026-06-30', min_magnitude: 5 });
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({
      start_time: new Date(new Date('2026-06-30').getTime() - 30 * 86_400_000).toISOString(),
      end_time: '2026-06-30',
      min_magnitude: 5,
      source: 'usgs',
      limit: 100,
      order_by: 'time',
    });
  });

  it('populates queryEcho on the empty-result path too', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 9.5 });
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toBeDefined();
    expect(echo.min_magnitude).toBe(9.5);
    expect(echo.source).toBe('usgs');
  });

  it('includes USGS-only filters in the echo for source=usgs', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).toMatchObject({ alert_level: 'yellow', min_felt: 10, min_significance: 600 });
  });

  it('omits USGS-only filters from the echo for source=emsc (not sent upstream)', async () => {
    mockEmscSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.source).toBe('emsc');
    expect(echo).not.toHaveProperty('alert_level');
    expect(echo).not.toHaveProperty('min_felt');
    expect(echo).not.toHaveProperty('min_significance');
  });

  it('echoes the offset when one was sent upstream', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ offset: 101 });
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo.offset).toBe(101);
  });

  it('omits offset from the echo when the first page was fetched', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({});
    await earthquakeSearch.handler(input, ctx);

    const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
    expect(echo).not.toHaveProperty('offset');
  });

  it('renders queryEcho as a markdown trailer line, not a JSON blob', () => {
    const render = earthquakeSearch.enrichmentTrailer?.queryEcho?.render;
    expect(render).toBeDefined();
    const text = render!({
      start_time: '2026-05-31T00:00:00.000Z',
      source: 'usgs',
      limit: 100,
      order_by: 'time',
    });
    expect(text).toContain('**Query echo:**');
    expect(text).toContain('start_time=2026-05-31T00:00:00.000Z');
    expect(text).toContain('limit=100');
  });
});

describe('earthquakeSearch — offset paging (issue #19)', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    mockEmscSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('rejects offset=0 — both upstream APIs count from 1', () => {
    expect(() => earthquakeSearch.input.parse({ offset: 0 })).toThrow();
  });

  it('accepts offset=1 as the first match', () => {
    expect(earthquakeSearch.input.parse({ offset: 1 }).offset).toBe(1);
  });

  it('forwards offset to the USGS service', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ offset: 20001, limit: 20000 });
    await earthquakeSearch.handler(input, ctx);

    expect(mockUsgsSearch).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 20001, limit: 20000 }),
      ctx,
    );
  });

  it('forwards offset to the EMSC service', async () => {
    mockEmscSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', offset: 5001 });
    await earthquakeSearch.handler(input, ctx);

    expect(mockEmscSearch).toHaveBeenCalledWith(expect.objectContaining({ offset: 5001 }), ctx);
  });

  it('omits offset from the upstream params when the caller did not page', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({});
    await earthquakeSearch.handler(input, ctx);

    expect(mockUsgsSearch.mock.calls[0]?.[0]).not.toHaveProperty('offset');
  });

  it('surfaces nextOffset when a capped result leaves events unretrieved', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5, totalCount: 4821 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).nextOffset).toBe(6);
  });

  it('advances nextOffset from the requested offset, not from 1', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5, totalCount: 4821 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5, offset: 101 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).nextOffset).toBe(106);
  });

  it('omits nextOffset on a full page that exactly exhausts the match set', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5, totalCount: 10 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5, offset: 6 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
  });

  it('omits nextOffset when the page was not capped', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [sampleEvent], count: 1 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 100 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).nextOffset).toBeUndefined();
  });

  it('truncation notice names offset as the next step, never "increase limit"', async () => {
    const events = Array.from({ length: 20000 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 20000, totalCount: 78820 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 20000 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('offset=20001');
    expect(notice).not.toContain('increase limit');
  });

  it('truncation notice without a known total still names the next offset', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ ...sampleEvent, id: `us${i}` }));
    mockUsgsSearch.mockResolvedValue({ events, count: 5 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ limit: 5 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('offset=6');
    expect(notice).not.toContain('increase limit');
  });

  it('an empty page past the end says the previous page was the last', async () => {
    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ offset: 90001 });
    await earthquakeSearch.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('offset 90001');
    expect(notice).toContain('last one');
  });
});

describe('earthquakeSearch — ignored USGS-only filters for EMSC (issue #16)', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn().mockResolvedValue({ events: [sampleEvent], count: 1 });
    mockEmscSearch = vi.fn().mockResolvedValue({ events: [emscEvent], count: 1 });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('names alert_level when an EMSC query supplies it', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      source: 'emsc',
      min_magnitude: 4.5,
      alert_level: 'red',
    });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['alert_level']);
  });

  it('names every dropped filter, in schema order', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      source: 'emsc',
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual([
      'alert_level',
      'min_felt',
      'min_significance',
    ]);
  });

  it('names min_felt alone', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', min_felt: 25 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_felt']);
  });

  it('names min_significance alone', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', min_significance: 600 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['min_significance']);
  });

  it('stays absent for a USGS query, where the filters are applied', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({
      alert_level: 'yellow',
      min_felt: 10,
      min_significance: 600,
    });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('stays absent for an EMSC query that supplies no USGS-only filter', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', min_magnitude: 4.5 });
    await earthquakeSearch.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
  });

  it('renders the dropped filters into content[] with the consequence spelled out', () => {
    const render = earthquakeSearch.enrichmentTrailer?.ignoredFilters?.render;
    expect(render).toBeDefined();

    const text = render!(['alert_level', 'min_felt']);
    expect(text).toContain('alert_level');
    expect(text).toContain('min_felt');
    expect(text).toContain('not sent upstream');
    expect(text).toContain('NOT constrained');
    expect(text).toContain('source=usgs');
  });
});

describe('earthquakeSearch — upstream 4xx reason reaches the caller (issue #26)', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;

  /** The shape fetchWithTimeout throws on a non-2xx: status-mapped code, body in data. */
  const upstreamError = (status: number, body: string) =>
    new McpError(
      status >= 500 ? JsonRpcErrorCode.ServiceUnavailable : JsonRpcErrorCode.InvalidParams,
      `Fetch failed for https://earthquake.usgs.gov/fdsnws/event/1/query?…. Status: ${status}`,
      { status, statusText: 'Bad Request', body, errorSource: 'FetchHttpError' },
    );

  const usgsBody = `Error 400: Bad Request

Bad starttime value "2026-13-45". Valid values are ISO-8601 timestamps.

Usage details are available from https://earthquake.usgs.gov/fdsnws/event/1

Request:
/fdsnws/event/1/query?format=geojson&amp;starttime=2026-13-45

Service version:
2.7.0
`;

  const emscBody = `Error 400: Request was not properly specified: start or starttime used a bad format

Request:
http://ws2/query?format=json&start=2026-13-45

Service version: v 2.2
`;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    mockEmscSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
    } as unknown as emscModule.EmscService);
  });

  it('folds the USGS reason into the message, which is what content[] renders', async () => {
    mockUsgsSearch.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ start_time: '2026-13-45', limit: 5 });
    const err = (await Promise.resolve(earthquakeSearch.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    expect(err.message).toContain('Bad starttime value "2026-13-45"');
    expect(err.message).toContain('ISO-8601');
    expect(err.message).toContain('USGS');
  });

  it('bounds the folded USGS reason — no usage URL, timestamp, or service version', async () => {
    mockUsgsSearch.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ start_time: '2026-13-45' });
    const err = (await Promise.resolve(earthquakeSearch.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    expect(err.message).not.toContain('Usage details');
    expect(err.message).not.toContain('Service version');
    expect(err.message).not.toContain('2.7.0');
  });

  it('carries the contract recovery hint and status in structuredContent data', async () => {
    mockUsgsSearch.mockRejectedValue(upstreamError(400, usgsBody));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ start_time: '2026-13-45' });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: {
        reason: 'upstream_rejected',
        status: 400,
        recovery: { hint: expect.stringContaining('offending parameter') },
      },
    });
  });

  it('does the same for EMSC, whose 400 is worded differently', async () => {
    mockEmscSearch.mockRejectedValue(upstreamError(400, emscBody));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ source: 'emsc', start_time: '2026-13-45' });
    const err = (await Promise.resolve(earthquakeSearch.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    expect(err.message).toContain('EMSC rejected the query');
    expect(err.message).toContain('start or starttime used a bad format');
    expect(err.message).not.toContain('ws2');
    expect((err.data as { reason?: string }).reason).toBe('upstream_rejected');
  });

  it('leaves a 5xx on the source_unavailable contract', async () => {
    mockUsgsSearch.mockRejectedValue(upstreamError(503, 'Error 503: Service Unavailable'));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable', recovery: { hint: expect.any(String) } },
    });
  });

  it('rethrows an error with no upstream body unchanged', async () => {
    mockUsgsSearch.mockRejectedValue(new Error('socket hang up'));

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5 });

    await expect(earthquakeSearch.handler(input, ctx)).rejects.toThrow('socket hang up');
  });
});

describe('earthquakeSearch — query_too_broad contract removed (issue #20)', () => {
  it('no longer declares a query_too_broad error contract', () => {
    const reasons = earthquakeSearch.errors?.map((e) => e.reason) ?? [];
    expect(reasons).not.toContain('query_too_broad');
    expect(reasons).toEqual(expect.arrayContaining(['invalid_radius', 'source_unavailable']));
  });

  it('does not describe the 20,000 cap as a hard ceiling', () => {
    expect(earthquakeSearch.description).toContain('offset');
    expect(earthquakeSearch.description).not.toContain('Results are capped at 20,000');
  });
});

describe('earthquakeSearch — EMSC described as a global catalog (issue #23)', () => {
  const sourceDescription = () =>
    earthquakeSearch.input.shape.source.description ??
    earthquakeSearch.input.shape.source.def.innerType?.description ??
    '';

  it('does not scope the EMSC catalog to a region', () => {
    expect(earthquakeSearch.description).not.toContain('European-Mediterranean, independent');
    expect(sourceDescription()).not.toContain('covers the European-Mediterranean region');
    expect(sourceDescription()).not.toContain('European-focused');
  });

  it('names EMSC as global and attributes it to the operating organization', () => {
    expect(earthquakeSearch.description).toContain('independent global');
    expect(sourceDescription()).toContain('global');
    expect(sourceDescription()).toContain('European-Mediterranean Seismological Centre');
  });

  it('keeps the caveats that are genuinely EMSC-specific', () => {
    const text = sourceDescription();
    expect(text).toContain('PAGER');
    expect(text).toContain('per-event detail');
    expect(text).toContain('densest');
  });

  it('leaves usgs as the default source', () => {
    expect(earthquakeSearch.input.parse({}).source).toBe('usgs');
  });
});
