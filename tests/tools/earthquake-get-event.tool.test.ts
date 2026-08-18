/**
 * @fileoverview Tests for the earthquake-get-event tool.
 * @module tests/tools/earthquake-get-event.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import type { EarthquakeDetailOutput, EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
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
  event_type: 'earthquake',
  event_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/ci38457511',
  detail_url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=ci38457511&format=geojson',
};

/** The projection a large reviewed event carries — every product group present. */
const sampleDetail: EarthquakeDetailOutput = {
  losspager: {
    alert_level: 'orange',
    report_url: 'https://earthquake.usgs.gov/product/losspager/us6000sznj/us/1/onepager.pdf',
  },
  shakemap: { max_mmi: 8.3, max_pga: 1.2, max_pgv: 90.5 },
  dyfi: { responses: 18000, max_cdi: 7.1 },
  moment_tensor: {
    scalar_moment_nm: 5.7e19,
    derived_depth_km: 8,
    nodal_plane_1: { strike: 227, dip: 84, rake: 178 },
  },
  ground_failure: { landslide_alert: 'yellow', liquefaction_alert: 'orange' },
  origin: {
    azimuthal_gap_deg: 25,
    num_stations_used: 120,
    horizontal_error_km: 1.2,
    depth_error_km: 0.9,
    review_status: 'reviewed',
  },
  finite_fault: { rupture_length_km: 60, rupture_width_km: 15 },
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

/** Recovery text the contract declares for a reason — the hint callers must receive. */
const contractRecovery = (reason: string) =>
  earthquakeGetEvent.errors?.find((e) => e.reason === reason)?.recovery;

describe('earthquakeGetEvent', () => {
  let mockGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetEvent = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: mockGetEvent,
    } as unknown as usgsModule.UsgsService);
  });

  it('returns full event detail for valid ID', async () => {
    mockGetEvent.mockResolvedValue({ event: sampleEvent, detail: sampleDetail });

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'ci38457511' });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(result.event.id).toBe('us6000sznj');
    expect(result.event.magnitude).toBe(7.1);
    expect(result.event.felt).toBe(18000);
    expect(result.event.alert).toBe('orange');
    expect(result.event.event_url).toContain('usgs.gov');
    expect(mockGetEvent).toHaveBeenCalledWith('ci38457511', ctx);
  });

  it('returns the product projection a search result cannot carry (issue #25)', async () => {
    mockGetEvent.mockResolvedValue({ event: sampleEvent, detail: sampleDetail });

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'us6000sznj' });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(result.detail).toEqual(sampleDetail);
    expect(result.detail?.losspager?.alert_level).toBe('orange');
    expect(result.detail?.moment_tensor?.nodal_plane_1).toEqual({
      strike: 227,
      dip: 84,
      rake: 178,
    });
  });

  it('omits detail for an event that carries no products', async () => {
    mockGetEvent.mockResolvedValue({ event: sparseEvent });

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'nc12345678' });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(result).not.toHaveProperty('detail');
  });

  it('throws not_found for unknown event ID', async () => {
    mockGetEvent.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'No earthquake event found for ID "bad-id"', {
        eventId: 'bad-id',
      }),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'bad-id' });

    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toThrow();
  });

  it('puts the contract recovery hint on the not_found error (issue #15)', async () => {
    mockGetEvent.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'No earthquake event found for ID "bad-id"', {
        eventId: 'bad-id',
      }),
    );

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'not-a-real-event-id-2026' });
    const err = (await Promise.resolve(earthquakeGetEvent.handler(input, ctx)).catch(
      (e) => e,
    )) as McpError;

    // structuredContent surface: data.recovery.hint, resolved from the contract.
    // The handler factory mirrors this same hint into content[] as a "Recovery:" line.
    const contractHint = contractRecovery('not_found');
    expect(contractHint).toBeDefined();
    expect((err.data as { reason?: string }).reason).toBe('not_found');
    expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(contractHint);
    expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toContain('us6000sznj');
    expect(err.message).toContain('not-a-real-event-id-2026');
  });

  it('handles sparse event (null optional fields) without crashing', async () => {
    mockGetEvent.mockResolvedValue({ event: sparseEvent });

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
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
    const output = { event: sampleEvent, detail: sampleDetail };
    const blocks = earthquakeGetEvent.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('us6000sznj');
    expect(text).toContain('7.1');
    expect(text).toContain('Ridgecrest');
    expect(text).toContain('ORANGE');
    expect(text).toContain('18000');
  });

  it('renders the product projection into content[] (issue #25)', () => {
    const blocks = earthquakeGetEvent.format!({ event: sampleEvent, detail: sampleDetail });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('### Analysis products');
    expect(text).toContain('**PAGER:** Alert level: orange');
    expect(text).toContain('**ShakeMap:** Max MMI: 8.3');
    expect(text).toContain('strike 227°, dip 84°, rake 178°');
    expect(text).toContain('**Ground failure:** Landslide alert: yellow');
    expect(text).toContain('**Origin quality:** Azimuthal gap: 25°');
    expect(text).toContain('**Finite fault:** Rupture length: 60 km');
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
    // absent products are stated, never rendered as zeros
    expect(text).toContain('No analysis products on this event');
  });
});

describe('earthquakeGetEvent — transport failure contracts (issue #28)', () => {
  let mockGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetEvent = vi.fn();
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: mockGetEvent,
    } as unknown as usgsModule.UsgsService);
  });

  it.each([
    ['source_unavailable', JsonRpcErrorCode.ServiceUnavailable, 'USGS is down'],
    ['source_timeout', JsonRpcErrorCode.Timeout, 'fetch GET earthquake.usgs.gov timed out.'],
  ] as const)(
    'maps an upstream failure onto the %s reason, reaching both surfaces',
    async (reason, code, message) => {
      mockGetEvent.mockRejectedValue(
        new McpError(code, message, { errorSource: 'FetchHttpError' }),
      );

      const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
      const input = earthquakeGetEvent.input.parse({ event_id: 'us6000sznj' });
      const err = (await Promise.resolve(earthquakeGetEvent.handler(input, ctx)).catch(
        (e) => e,
      )) as McpError;

      // structuredContent surface: code, data.reason, and data.recovery.hint.
      expect(err.code).toBe(code);
      expect((err.data as { reason?: string }).reason).toBe(reason);
      expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(
        contractRecovery(reason),
      );
      // content[] surface: the handler factory renders `Error: <message>` and mirrors
      // data.recovery.hint onto a `Recovery:` line, so both must carry real text.
      expect(err.message).toBe(message);
      expect(contractRecovery(reason)).toBeTruthy();
    },
  );

  it('gives recovery guidance a single-event lookup can act on', () => {
    // "Narrow the query" is meaningless here — there is one event and no filters.
    for (const reason of ['source_unavailable', 'source_timeout']) {
      const hint = contractRecovery(reason) ?? '';
      expect(hint).not.toMatch(/narrow|broaden|min_magnitude/i);
      expect(hint).toMatch(/retry/i);
    }
  });

  it('keeps not_found distinct from the transport reasons', async () => {
    mockGetEvent.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'No such event', {}));

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: 'zz99' });

    await expect(earthquakeGetEvent.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});
