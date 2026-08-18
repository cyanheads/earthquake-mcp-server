/**
 * @fileoverview Edge-case and validation boundary tests for the earthquake-count tool.
 * @module tests/tools/earthquake-count-edge-cases.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

describe('earthquakeCount — input schema boundaries', () => {
  it('rejects min_magnitude below -1', () => {
    expect(() => earthquakeCount.input.parse({ min_magnitude: -2 })).toThrow();
  });

  it('rejects min_magnitude above 10', () => {
    expect(() => earthquakeCount.input.parse({ min_magnitude: 11 })).toThrow();
  });

  it('accepts min_magnitude at boundary values -1 and 10', () => {
    expect(earthquakeCount.input.parse({ min_magnitude: -1 }).min_magnitude).toBe(-1);
    expect(earthquakeCount.input.parse({ min_magnitude: 10 }).min_magnitude).toBe(10);
  });

  it('rejects latitude below -90', () => {
    expect(() => earthquakeCount.input.parse({ latitude: -91 })).toThrow();
  });

  it('rejects latitude above 90', () => {
    expect(() => earthquakeCount.input.parse({ latitude: 91 })).toThrow();
  });

  it('rejects longitude below -180', () => {
    expect(() => earthquakeCount.input.parse({ longitude: -181 })).toThrow();
  });

  it('rejects longitude above 180', () => {
    expect(() => earthquakeCount.input.parse({ longitude: 181 })).toThrow();
  });

  it('rejects radius_km above the USGS-enforced 20001.6 ceiling (issue #32)', () => {
    expect(() => earthquakeCount.input.parse({ radius_km: 20001.7 })).toThrow();
    expect(() => earthquakeCount.input.parse({ radius_km: 20002 })).toThrow();
  });

  it('accepts radius_km at boundary 20001.6 (issue #32)', () => {
    expect(earthquakeCount.input.parse({ radius_km: 20001.6 }).radius_km).toBe(20001.6);
  });

  it('rejects invalid alert_level value', () => {
    expect(() => earthquakeCount.input.parse({ alert_level: 'blue' as never })).toThrow();
  });

  it('rejects min_felt below 1', () => {
    expect(() => earthquakeCount.input.parse({ min_felt: 0 })).toThrow();
  });

  it('applies default source=usgs', () => {
    expect(earthquakeCount.input.parse({}).source).toBe('usgs');
  });
});

describe('earthquakeCount — radius validation edge cases', () => {
  it('throws invalid_radius with only latitude', async () => {
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ latitude: 35.0 });
    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius with lat+lon but no radius_km', async () => {
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ latitude: 35.0, longitude: 139.0 });
    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });
});

describe('earthquakeCount — source_unavailable error contract', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
  });

  it('converts ServiceUnavailable McpError to typed contract error with data.reason', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockUsgsCount.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'USGS count endpoint is down', {}),
    );

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5.0 });
    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable' },
    });
  });

  it('re-throws non-ServiceUnavailable McpError unchanged', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockUsgsCount.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InternalError, 'Unexpected error', {}),
    );

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5.0 });
    await expect(earthquakeCount.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
    });
  });
});

describe('earthquakeCount — EMSC exceeds-limit logic', () => {
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockEmscCount = vi.fn();
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('exceeds_limit true when EMSC count is above 20000', async () => {
    // EMSC service returns exceedsLimit: true when count > 20000
    mockEmscCount.mockResolvedValue({ count: 21000, maxAllowed: null, exceedsLimit: true });

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc' });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.exceeds_limit).toBe(true);
    expect(result.max_allowed).toBeNull();
    expect(result.count).toBe(21000);
  });

  it('exceeds_limit false when EMSC count is at exactly 20000', async () => {
    mockEmscCount.mockResolvedValue({ count: 20000, maxAllowed: null, exceedsLimit: false });

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc' });
    const result = await earthquakeCount.handler(input, ctx);

    expect(result.exceeds_limit).toBe(false);
  });
});

describe('earthquakeCount — format', () => {
  it('formats zero count correctly', () => {
    const output = {
      count: 0,
      max_allowed: 20000,
      source: 'usgs' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCount.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0');
    expect(text).toContain('USGS');
    expect(text).toContain('No');
  });

  it('formats EMSC with exceeds_limit true', () => {
    const output = {
      count: 25000,
      max_allowed: null,
      source: 'emsc' as const,
      exceeds_limit: true,
    };
    const blocks = earthquakeCount.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('EMSC');
    expect(text).toContain('25000');
    expect(text).toContain('Yes');
  });

  it('format output is a single text block', () => {
    const output = {
      count: 10,
      max_allowed: 20000,
      source: 'usgs' as const,
      exceeds_limit: false,
    };
    const blocks = earthquakeCount.format!(output);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
  });
});

describe('earthquakeCount — security', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
  });

  it('propagates service error message without adding tool-layer secrets', async () => {
    mockUsgsCount.mockRejectedValue(new Error('Upstream timeout after 30000ms'));

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5.0 });
    const err = await Promise.resolve(earthquakeCount.handler(input, ctx)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('API_KEY');
    expect((err as Error).message).not.toContain('SECRET');
  });
});

describe('earthquakeCount — upstream rejection contracts (issue #27)', () => {
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

  /** Shaped like what `fetchWithTimeout` raises on a non-2xx: status-mapped code plus captured body. */
  const upstream = async (status: number, body: string | undefined, code?: number) => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    return new McpError(code ?? JsonRpcErrorCode.InvalidParams, `Fetch failed. Status: ${status}`, {
      status,
      statusText: 'Bad Request',
      ...(body !== undefined ? { body, responseBody: body } : {}),
      errorSource: 'FetchHttpError',
    });
  };

  const recovery = (reason: string) =>
    earthquakeCount.errors?.find((e) => e.reason === reason)?.recovery;

  it('folds an explained 4xx into upstream_rejected with the service reason', async () => {
    mockEmscCount.mockRejectedValue(
      await upstream(
        400,
        'Error 400: minmag > maxmag\n\nRequest:\nhttp://ws2/count?format=json\n\nService version: v 2.2\n',
      ),
    );

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc', min_magnitude: 5 });
    const err = (await Promise.resolve(earthquakeCount.handler(input, ctx)).catch((e) => e)) as {
      message: string;
      data: { reason?: string; recovery?: { hint?: string } };
    };

    expect(err.data.reason).toBe('upstream_rejected');
    expect(err.message).toContain('minmag > maxmag');
    expect(err.message).not.toContain('ws2');
    expect(err.data.recovery?.hint).toBe(recovery('upstream_rejected'));
  });

  it('reports a boilerplate-only 4xx under upstream_rejected_no_reason', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockEmscCount.mockRejectedValue(
      await upstream(
        400,
        'Error 400: Bad Request\n\nRequest:\nhttp://ws2/count?format=json\n\nService version: v 2.2\n',
      ),
    );

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc', min_magnitude: 5 });
    const err = (await Promise.resolve(earthquakeCount.handler(input, ctx)).catch((e) => e)) as {
      code: number;
      message: string;
      data: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
    };

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data.reason).toBe('upstream_rejected_no_reason');
    expect(err.data.recovery?.hint).toBe(recovery('upstream_rejected_no_reason'));
    expect(err.message).toBe('EMSC rejected the query (HTTP 400) — the service gave no reason.');
    expect(JSON.stringify(err.data)).not.toContain('ws2');
  });

  it('leaves a 404 alone — that is a misconfigured base URL, not a bad parameter', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const notFoundErr = await upstream(
      404,
      'Error 404: Not Found\n\nNo such resource here\n\nRequest:\n/count',
      JsonRpcErrorCode.NotFound,
    );
    mockUsgsCount.mockRejectedValue(notFoundErr);

    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ min_magnitude: 5 });
    const err = await Promise.resolve(earthquakeCount.handler(input, ctx)).catch((e: unknown) => e);

    expect(err).toBe(notFoundErr);
  });
});

describe('earthquakeCount — event_type filter (issue #24)', () => {
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsCount = vi
      .fn()
      .mockResolvedValue({ count: 127, maxAllowed: 20000, exceedsLimit: false });
    mockEmscCount = vi.fn().mockResolvedValue({ count: 40, maxAllowed: null, exceedsLimit: false });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  it('forwards event_type to the USGS service and echoes it', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ event_type: 'quarry blast' });
    const result = await earthquakeCount.handler(input, ctx);

    expect(mockUsgsCount.mock.calls[0]?.[0]).toMatchObject({ eventType: 'quarry blast' });
    expect(result.count).toBe(127);
    expect((getEnrichment(ctx).queryEcho as { event_type?: string } | undefined)?.event_type).toBe(
      'quarry blast',
    );
  });

  it('names event_type in ignoredFilters and keeps it out of the echo for EMSC', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const input = earthquakeCount.input.parse({ source: 'emsc', event_type: 'earthquake' });
    await earthquakeCount.handler(input, ctx);

    expect(getEnrichment(ctx).ignoredFilters).toEqual(['event_type']);
    expect(getEnrichment(ctx).queryEcho).not.toHaveProperty('event_type');
  });
});
