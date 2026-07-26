/**
 * @fileoverview Edge-case and security tests for the earthquake-get-event tool.
 * @module tests/tools/earthquake-get-event-edge-cases.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const reviewedEvent: EarthquakeEventOutput = {
  id: 'ci38457511',
  title: 'M 7.1 - 15 km ESE of Ridgecrest, CA',
  magnitude: 7.1,
  magnitude_type: 'mw',
  time: '2019-07-06T03:19:53.040Z',
  updated: '2019-07-08T18:00:00.000Z',
  place: '15 km ESE of Ridgecrest, CA',
  latitude: 35.7695,
  longitude: -117.5993,
  depth_km: 8,
  felt: 18000,
  cdi: 7.1,
  mmi: 8.3,
  alert: 'orange',
  tsunami: 0,
  significance: 1539,
  status: 'reviewed',
  event_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/ci38457511',
  detail_url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=ci38457511&format=geojson',
};

describe('earthquakeGetEvent — input schema', () => {
  it('requires event_id', () => {
    expect(() => earthquakeGetEvent.input.parse({})).toThrow();
  });

  it('accepts a typical USGS event ID string', () => {
    const input = earthquakeGetEvent.input.parse({ event_id: 'ci38457511' });
    expect(input.event_id).toBe('ci38457511');
  });

  it('accepts short event IDs', () => {
    const input = earthquakeGetEvent.input.parse({ event_id: 'ab12' });
    expect(input.event_id).toBe('ab12');
  });
});

describe('earthquakeGetEvent — not_found error handling', () => {
  let mockGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetEvent = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: mockGetEvent,
    } as unknown as usgsModule.UsgsService);
  });

  it('translates NotFound McpError to not_found contract failure', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetEvent.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'No earthquake event found for ID "zz99"', {
        eventId: 'zz99',
      }),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'zz99' });
    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('preserves non-NotFound McpErrors without wrapping in not_found', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const serviceUnavailableErr = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'USGS is down',
      {},
    );
    mockGetEvent.mockRejectedValue(serviceUnavailableErr);

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'ci38457511' });
    const err = await earthquakeGetEvent.handler(input, ctx).catch((e: unknown) => e);

    // Should re-throw the original McpError, not wrap it in not_found
    expect(err).toBe(serviceUnavailableErr);
  });
});

describe('earthquakeGetEvent — security', () => {
  let mockGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetEvent = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: mockGetEvent,
    } as unknown as usgsModule.UsgsService);
  });

  it('handles injection-like event_id in not_found message without executing code', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const injectionId = "'; DROP TABLE events; --";
    mockGetEvent.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, `No event for "${injectionId}"`, {}),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: injectionId });
    const err = await earthquakeGetEvent.handler(input, ctx).catch((e: unknown) => e);

    // The error message may contain the ID literally — that's correct behavior.
    // Critical: no exception escapes from the handler itself beyond the expected McpError.
    expect(err).toBeDefined();
    expect(typeof (err as { message?: string }).message).toBe('string');
  });

  it('formats event with HTML-like content in title without throwing', () => {
    const xssEvent: EarthquakeEventOutput = {
      ...reviewedEvent,
      title: '<img src=x onerror=alert(1)>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: adversarial test string — must stay literal
      place: '${__proto__.polluted}',
    };
    // format() must not throw and must not eval the injection
    const blocks = earthquakeGetEvent.format!({ event: xssEvent });
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('<img');
    expect(text).toContain('__proto__');
  });
});

describe('earthquakeGetEvent — format completeness', () => {
  it('includes event_url line in format output when present', () => {
    const blocks = earthquakeGetEvent.format!({ event: reviewedEvent });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('USGS page:');
    expect(text).toContain(reviewedEvent.event_url!);
  });

  it('includes detail_url line in format output when present', () => {
    const blocks = earthquakeGetEvent.format!({ event: reviewedEvent });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Detail URL:');
  });

  it('renders tsunami=1 with warning text', () => {
    const tsunamiEvent = { ...reviewedEvent, tsunami: 1 };
    const blocks = earthquakeGetEvent.format!({ event: tsunamiEvent });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Warning issued');
  });

  it('renders red alert level', () => {
    const redEvent = { ...reviewedEvent, alert: 'red' as const };
    const blocks = earthquakeGetEvent.format!({ event: redEvent });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('RED');
  });

  it('renders green alert level', () => {
    const greenEvent = { ...reviewedEvent, alert: 'green' as const };
    const blocks = earthquakeGetEvent.format!({ event: greenEvent });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('GREEN');
  });
});
