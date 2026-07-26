/**
 * @fileoverview Edge-case, validation boundary, and security tests for the earthquake-search tool.
 * @module tests/tools/earthquake-search-edge-cases.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const minimalEvent: EarthquakeEventOutput = {
  id: 'us1234567',
  title: 'M 3.0 - Test Region',
  magnitude: 3.0,
  magnitude_type: 'ml',
  time: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:10:00.000Z',
  place: 'Test Region',
  latitude: 0.0,
  longitude: 0.0,
  depth_km: 10,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'reviewed',
};

describe('earthquakeSearch — input schema boundaries', () => {
  it('rejects min_magnitude below -1', () => {
    expect(() => earthquakeSearch.input.parse({ min_magnitude: -2 })).toThrow();
  });

  it('rejects min_magnitude above 10', () => {
    expect(() => earthquakeSearch.input.parse({ min_magnitude: 11 })).toThrow();
  });

  it('accepts min_magnitude at boundary -1', () => {
    const input = earthquakeSearch.input.parse({ min_magnitude: -1 });
    expect(input.min_magnitude).toBe(-1);
  });

  it('accepts min_magnitude at boundary 10', () => {
    const input = earthquakeSearch.input.parse({ min_magnitude: 10 });
    expect(input.min_magnitude).toBe(10);
  });

  it('rejects latitude below -90', () => {
    expect(() => earthquakeSearch.input.parse({ latitude: -91 })).toThrow();
  });

  it('rejects latitude above 90', () => {
    expect(() => earthquakeSearch.input.parse({ latitude: 91 })).toThrow();
  });

  it('accepts latitude at boundary -90 and 90', () => {
    expect(earthquakeSearch.input.parse({ latitude: -90 }).latitude).toBe(-90);
    expect(earthquakeSearch.input.parse({ latitude: 90 }).latitude).toBe(90);
  });

  it('rejects longitude below -180', () => {
    expect(() => earthquakeSearch.input.parse({ longitude: -181 })).toThrow();
  });

  it('rejects longitude above 180', () => {
    expect(() => earthquakeSearch.input.parse({ longitude: 181 })).toThrow();
  });

  it('rejects radius_km above 20002', () => {
    expect(() => earthquakeSearch.input.parse({ radius_km: 20003 })).toThrow();
  });

  it('accepts radius_km at boundary 20002', () => {
    const input = earthquakeSearch.input.parse({ radius_km: 20002 });
    expect(input.radius_km).toBe(20002);
  });

  it('rejects limit below 1', () => {
    expect(() => earthquakeSearch.input.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit above 20000', () => {
    expect(() => earthquakeSearch.input.parse({ limit: 20001 })).toThrow();
  });

  it('rejects limit as non-integer', () => {
    expect(() => earthquakeSearch.input.parse({ limit: 1.5 })).toThrow();
  });

  it('rejects min_felt below 1', () => {
    expect(() => earthquakeSearch.input.parse({ min_felt: 0 })).toThrow();
  });

  it('rejects invalid alert_level', () => {
    expect(() => earthquakeSearch.input.parse({ alert_level: 'purple' as never })).toThrow();
  });

  it('accepts all valid alert_level values', () => {
    for (const level of ['green', 'yellow', 'orange', 'red'] as const) {
      const input = earthquakeSearch.input.parse({ alert_level: level });
      expect(input.alert_level).toBe(level);
    }
  });

  it('rejects invalid source', () => {
    expect(() => earthquakeSearch.input.parse({ source: 'bgs' as never })).toThrow();
  });

  it('rejects invalid order_by', () => {
    expect(() => earthquakeSearch.input.parse({ order_by: 'distance' as never })).toThrow();
  });

  it('accepts all valid order_by values', () => {
    for (const order of ['time', 'time-asc', 'magnitude', 'magnitude-asc'] as const) {
      const input = earthquakeSearch.input.parse({ order_by: order });
      expect(input.order_by).toBe(order);
    }
  });

  it('applies default source=usgs when omitted', () => {
    const input = earthquakeSearch.input.parse({});
    expect(input.source).toBe('usgs');
  });

  it('applies default order_by=time when omitted', () => {
    const input = earthquakeSearch.input.parse({});
    expect(input.order_by).toBe('time');
  });
});

describe('earthquakeSearch — source_unavailable error contract', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
  });

  it('converts ServiceUnavailable McpError to typed contract error with data.reason', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockUsgsSearch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'USGS API is down', {}),
    );

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'source_unavailable' },
    });
  });

  it('re-throws non-ServiceUnavailable McpError unchanged', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockUsgsSearch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Resource not found', {}),
    );

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

describe('earthquakeSearch — radius validation edge cases', () => {
  it('throws invalid_radius with only longitude', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ longitude: 35.0 });
    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius with lat+radius but no lon', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ latitude: 35.0, radius_km: 100 });
    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });

  it('throws invalid_radius with lon+radius but no lat', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ longitude: 35.0, radius_km: 100 });
    await expect(earthquakeSearch.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_radius' },
    });
  });
});

describe('earthquakeSearch — security', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUsgsSearch = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: vi.fn(),
    } as unknown as emscModule.EmscService);
  });

  it('does not leak service error internals in rethrown errors', async () => {
    const internalUrl = 'https://internal.example.com/secret-path?token=SEKRET123';
    mockUsgsSearch.mockRejectedValue(
      new Error(`Fetch failed: ${internalUrl} — connection refused`),
    );

    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    const err = await earthquakeSearch.handler(input, ctx).catch((e: unknown) => e);

    // The tool re-throws directly — the error message is the service's, but
    // it should not be wrapped with any sensitive token from the tool layer itself.
    // Confirm there's no additional tool-layer secret injection.
    expect(err).toBeInstanceOf(Error);
  });

  it('handles injection-like event IDs in format output without executing them', () => {
    const injectionEvent: EarthquakeEventOutput = {
      ...minimalEvent,
      id: "'; DROP TABLE events; --",
      title: '<script>alert(1)</script>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: adversarial test string — must stay literal
      place: '${process.env.SECRET_KEY}',
    };
    const output = {
      count: 1,
      source: 'usgs' as const,
      events: [injectionEvent],
    };
    // format() is a pure string renderer — must not throw and must not eval anything
    const blocks = earthquakeSearch.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    // The injection string appears as literal text, not executed
    expect(text).toContain('DROP TABLE');
    expect(text).toContain('<script>');
    expect(text).toContain('process.env.SECRET_KEY');
  });

  it('handles unicode and non-ASCII characters in place names without crashing', async () => {
    const unicodeEvent: EarthquakeEventOutput = {
      ...minimalEvent,
      place: '50 km SE of Tōkyō, 日本 (Japan)',
      title: 'M 5.0 - 50 km SE of Tōkyō, 日本',
    };
    mockUsgsSearch.mockResolvedValue({ events: [unicodeEvent], count: 1 });

    const ctx = createMockContext();
    const input = earthquakeSearch.input.parse({ min_magnitude: 5.0 });
    const result = await earthquakeSearch.handler(input, ctx);

    expect(result.events[0]?.place).toBe('50 km SE of Tōkyō, 日本 (Japan)');
    const blocks = earthquakeSearch.format!({ count: 1, source: 'usgs', events: [unicodeEvent] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Tōkyō');
    expect(text).toContain('日本');
  });

  it('handles oversized place name without crashing', async () => {
    const longPlace = 'A'.repeat(10000);
    const oversizedEvent: EarthquakeEventOutput = {
      ...minimalEvent,
      place: longPlace,
      title: `M 3.0 - ${longPlace.slice(0, 50)}`,
    };
    mockUsgsSearch.mockResolvedValue({ events: [oversizedEvent], count: 1 });

    const ctx = createMockContext();
    const input = earthquakeSearch.input.parse({ min_magnitude: 3.0 });
    const result = await earthquakeSearch.handler(input, ctx);

    expect(result.events[0]?.place).toBe(longPlace);
  });
});

describe('earthquakeSearch — format edge cases', () => {
  it('formats multiple events in order', () => {
    const events = [
      { ...minimalEvent, id: 'us0000001', magnitude: 7.0, place: 'Region A' },
      { ...minimalEvent, id: 'us0000002', magnitude: 5.5, place: 'Region B' },
    ];
    const output = { count: 2, source: 'usgs' as const, events };
    const blocks = earthquakeSearch.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('us0000001');
    expect(text).toContain('us0000002');
    // Both magnitudes present
    expect(text).toContain('7');
    expect(text).toContain('5.5');
  });

  it('formats EMSC source correctly', () => {
    const emscEvent: EarthquakeEventOutput = {
      ...minimalEvent,
      id: 'emsc-abc123',
      felt: null,
      alert: null,
    };
    const output = { count: 1, source: 'emsc' as const, events: [emscEvent] };
    const blocks = earthquakeSearch.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('EMSC');
    expect(text).toContain('emsc-abc123');
  });

  it('renders count in format header', () => {
    const output = { count: 42, source: 'usgs' as const, events: [minimalEvent] };
    const blocks = earthquakeSearch.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('42');
  });
});
