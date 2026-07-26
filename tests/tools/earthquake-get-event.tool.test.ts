/**
 * @fileoverview Tests for the earthquake-get-event tool.
 * @module tests/tools/earthquake-get-event.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';

const sampleEvent: EarthquakeEventOutput = {
  id: 'us6000sznj',
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

const sparseEvent: EarthquakeEventOutput = {
  id: 'nc12345678',
  title: 'M 1.5 - Unknown location',
  magnitude: 1.5,
  magnitude_type: 'ml',
  time: '2026-05-01T00:00:00.000Z',
  updated: '2026-05-01T00:01:00.000Z',
  place: 'Unknown location',
  latitude: 37.5,
  longitude: -122.0,
  depth_km: 5,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'automatic',
  // event_url and detail_url intentionally omitted (sparse upstream)
};

describe('earthquakeGetEvent', () => {
  let mockGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetEvent = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: mockGetEvent,
    } as unknown as usgsModule.UsgsService);
  });

  it('returns full event detail for valid ID', async () => {
    mockGetEvent.mockResolvedValue(sampleEvent);

    const ctx = createMockContext();
    const input = earthquakeGetEvent.input.parse({ event_id: 'ci38457511' });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(result.event.id).toBe('us6000sznj');
    expect(result.event.magnitude).toBe(7.1);
    expect(result.event.felt).toBe(18000);
    expect(result.event.alert).toBe('orange');
    expect(result.event.event_url).toContain('usgs.gov');
    expect(mockGetEvent).toHaveBeenCalledWith('ci38457511', ctx);
  });

  it('throws not_found for unknown event ID', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetEvent.mockRejectedValue(
      new McpError(-32001, 'No earthquake event found for ID "bad-id"', { eventId: 'bad-id' }),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'bad-id' });

    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toThrow();
  });

  it('puts the contract recovery hint on the not_found error (issue #15)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetEvent.mockRejectedValue(
      new McpError(-32001, 'No earthquake event found for ID "bad-id"', { eventId: 'bad-id' }),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'not-a-real-event-id-2026' });
    const err = (await earthquakeGetEvent.handler(input, ctx).catch((e) => e)) as InstanceType<
      typeof McpError
    >;

    // structuredContent surface: data.recovery.hint, resolved from the contract.
    // The handler factory mirrors this same hint into content[] as a "Recovery:" line.
    const contractHint = earthquakeGetEvent.errors?.find((e) => e.reason === 'not_found')?.recovery;
    expect(contractHint).toBeDefined();
    expect((err.data as { reason?: string }).reason).toBe('not_found');
    expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(contractHint);
    expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toContain('us6000sznj');
    expect(err.message).toContain('not-a-real-event-id-2026');
  });

  it('handles sparse event (null optional fields) without crashing', async () => {
    mockGetEvent.mockResolvedValue(sparseEvent);

    const ctx = createMockContext();
    const input = earthquakeGetEvent.input.parse({ event_id: 'nc12345678' });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(result.event.id).toBe('nc12345678');
    expect(result.event.felt).toBeNull();
    expect(result.event.alert).toBeNull();
    expect(result.event.event_url).toBeUndefined();
    expect(result.event.detail_url).toBeUndefined();
  });

  it('propagates service errors', async () => {
    mockGetEvent.mockRejectedValue(new Error('Network timeout'));

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'us6000sznj' });

    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toThrow('Network timeout');
  });

  it('formats event with all data fields', () => {
    const output = { event: sampleEvent };
    const blocks = earthquakeGetEvent.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('us6000sznj');
    expect(text).toContain('7.1');
    expect(text).toContain('Ridgecrest');
    expect(text).toContain('ORANGE');
    expect(text).toContain('18000');
  });

  it('formats sparse event without fabricating missing fields', () => {
    const output = { event: sparseEvent };
    const blocks = earthquakeGetEvent.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('nc12345678');
    // null alert renders as "Not computed"
    expect(text).toContain('Not computed');
    // no USGS page line for sparse event
    expect(text).not.toContain('USGS page:');
  });
});
