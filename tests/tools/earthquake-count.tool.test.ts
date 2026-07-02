/**
 * @fileoverview Tests for the earthquake-count tool.
 * @module tests/tools/earthquake-count.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
