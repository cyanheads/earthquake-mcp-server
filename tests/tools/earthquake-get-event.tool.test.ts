/**
 * @fileoverview Tests for the earthquake-get-event tool.
 * @module tests/tools/earthquake-get-event.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeGetEvent } from '@/mcp-server/tools/definitions/earthquake-get-event.tool.js';
import type { EarthquakeDetailOutput, EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import { projectPagerEstimates } from '@/services/usgs/pager-estimates.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';
import { fixture } from '../helpers/usgs-fetch-stub.js';

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
    expect(mockGetEvent).toHaveBeenCalledWith('ci38457511', ctx, []);
  });

  it('threads include through to the service', async () => {
    mockGetEvent.mockResolvedValue({ event: sampleEvent });

    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({
      event_id: 'ci38457511',
      include: ['arrivals', 'origins'],
    });
    await earthquakeGetEvent.handler(input, ctx);

    expect(mockGetEvent).toHaveBeenCalledWith('ci38457511', ctx, ['arrivals', 'origins']);
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

  it('labels ShakeMap ground motion in the units USGS publishes (issue #30)', () => {
    const blocks = earthquakeGetEvent.format!({ event: sampleEvent, detail: sampleDetail });
    const text = (blocks[0] as { text: string }).text;
    // ShakeMap info.json declares PGA in "g" and PGV in "cms" — 1.2 is 1.2 g.
    expect(text).toContain('Max PGA: 1.2 g');
    expect(text).toContain('Max PGV: 90.5 cm/s');
    expect(text).not.toContain('%g');
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
    // Missing projected data does not establish whether USGS produced a product.
    expect(text.split('\n')).toContain(
      '_No projected analysis fields are available for this event; this does not imply zero impact._',
    );
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

describe('earthquakeGetEvent — routes by ID shape (issue #53)', () => {
  const emscEvent: EarthquakeEventOutput = {
    ...sparseEvent,
    id: '20190706_0000043',
    tsunami: null,
    status: null,
    source_catalog: 'EMSC-RTS',
    auth: 'EMSC',
  };
  let usgsGetEvent: ReturnType<typeof vi.fn>;
  let emscGetEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    usgsGetEvent = vi.fn().mockResolvedValue({ event: sampleEvent });
    emscGetEvent = vi.fn().mockResolvedValue({ event: emscEvent });
    vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      getEvent: usgsGetEvent,
    } as unknown as usgsModule.UsgsService);
    vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      getEvent: emscGetEvent,
    } as unknown as emscModule.EmscService);
  });

  it('sends an EMSC unid to EMSC only and reports requested groups as not_published', async () => {
    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({
      event_id: '20190706_0000043',
      include: ['pager', 'arrivals', 'origins', 'arrivals'],
    });
    const result = await earthquakeGetEvent.handler(input, ctx);

    expect(emscGetEvent).toHaveBeenCalledWith('20190706_0000043', ctx);
    expect(usgsGetEvent).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      event: emscEvent,
      unavailable_includes: [
        { group: 'origins', reason: 'not_published' },
        { group: 'arrivals', reason: 'not_published' },
        { group: 'pager', reason: 'not_published' },
      ],
    });
  });

  it('returns the bare EMSC event when no group was requested', async () => {
    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: '20190706_0000043' });
    expect(await earthquakeGetEvent.handler(input, ctx)).toStrictEqual({ event: emscEvent });
  });

  it('sends any other ID to USGS only', async () => {
    const ctx = createMockContext({ errors: earthquakeGetEvent.errors });
    const input = earthquakeGetEvent.input.parse({ event_id: '20190706_000043' });
    await earthquakeGetEvent.handler(input, ctx);
    expect(usgsGetEvent).toHaveBeenCalledWith('20190706_000043', ctx, []);
    expect(emscGetEvent).not.toHaveBeenCalled();
  });

  it('names the source a 501 came from and sends the caller to the other catalog', async () => {
    const notImplemented = () =>
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Not implemented', { retryable: false });
    emscGetEvent.mockRejectedValue(notImplemented());
    usgsGetEvent.mockRejectedValue(notImplemented());
    const hint = async (event_id: string) => {
      const err = (await Promise.resolve(
        earthquakeGetEvent.handler(
          earthquakeGetEvent.input.parse({ event_id }),
          createMockContext({ errors: earthquakeGetEvent.errors }),
        ),
      ).catch((e: unknown) => e)) as McpError;
      return (err.data as { recovery?: { hint?: string } }).recovery?.hint;
    };
    const emscHint = await hint('20190706_0000043');
    expect(emscHint).toMatch(/^Do not retry this EMSC lookup/);
    // The refusing catalog is never the suggested fallback.
    expect(emscHint).not.toContain('source=emsc');
    expect(emscHint).toContain('source=usgs');
    const usgsHint = await hint('us6000sznj');
    expect(usgsHint).toMatch(/^Do not retry this USGS lookup/);
    expect(usgsHint).toContain('source=emsc');
  });
});

describe('earthquakeGetEvent — include rendering', () => {
  const text = (output: Parameters<NonNullable<typeof earthquakeGetEvent.format>>[0]) =>
    (earthquakeGetEvent.format!(output)[0] as { text: string }).text;

  it('renders depth_type in the origin-quality line only when published', () => {
    const withType = text({
      event: sampleEvent,
      detail: { origin: { depth_error_km: 1.8, depth_type: 'operator assigned' } },
    });
    expect(withType).toContain(
      'Depth error: 1.8 km | Depth type: operator assigned | Review status',
    );
    const without = text({ event: sampleEvent, detail: { origin: { depth_error_km: 1.8 } } });
    expect(without).not.toContain('Depth type');
  });

  it('renders every origin, magnitude, arrival, forecast bin, and unavailable group', () => {
    const output = text({
      event: sampleEvent,
      origins: [
        {
          source: 'ci',
          event_id: 'ci38457511',
          is_preferred: true,
          time: '2019-07-06T03:19:53.040Z',
          latitude: 35.7695,
          longitude: -117.5993333,
          depth_km: 8,
          depth_type: 'operator assigned',
          standard_error_s: 0.22,
        },
        { source: 'pt', event_id: 'pt19187000', is_preferred: false, depth_km: 100 },
      ],
      magnitudes: [
        { type: 'Mww', value: 7.5, station_count: 82, agency: 'us', is_preferred: true },
        { type: 'mw', value: 7.1, is_preferred: false },
      ],
      arrivals: [
        {
          network: 'IM',
          station: 'MJAR',
          location: 'F0',
          channel: 'HHZ',
          phase: 'Pn',
          distance_deg: 1.3667,
        },
        { network: 'AK', station: 'BRSE', phase: 'P|S', time_residual_s: -0.5 },
      ],
      aftershock_forecast: {
        advisory_window: '1 Week',
        created: '2026-10-28T12:51:11.470Z',
        expires: '2027-10-28T13:00:00.000Z',
        windows: [
          {
            label: '1 Week',
            start: '2026-10-28T13:00:00.000Z',
            end: '2026-11-04T13:00:00.000Z',
            above_mainshock: { magnitude: 4.01, probability: 0.01958 },
            bins: [
              {
                magnitude: 3,
                probability: 0.0794,
                count_median: 0,
                count_p95_min: 0,
                count_p95_max: 1,
              },
              { magnitude: 5, probability: 0.002061 },
            ],
          },
        ],
      },
      unavailable_includes: [{ group: 'aftershock_forecast', reason: 'fetch_failed' }],
    });
    const lines = output.split('\n');

    expect(lines).toContain(
      '- **ci38457511** (source ci, preferred): Time: 2019-07-06T03:19:53.040Z | Location: 35.7695°, -117.5993333° | Depth: 8 km | Depth type: operator assigned | Standard error: 0.22 s',
    );
    expect(lines).toContain('- **pt19187000** (source pt): Depth: 100 km');
    expect(lines).toContain('- **Mww 7.5** (preferred): Stations: 82 | Agency: us');
    expect(lines).toContain('- **mw 7.1**');
    expect(lines).toContain('| IM | MJAR | F0 | HHZ | Pn |  |  | 1.3667 |  |  |');
    // A pipe inside a value is escaped so it cannot open a new cell.
    expect(lines).toContain('| AK | BRSE |  |  | P\\|S |  | -0.5 |  |  |  |');
    expect(lines).toContain(
      'Advisory window: 1 Week | Created: 2026-10-28T12:51:11.470Z | Expires: 2027-10-28T13:00:00.000Z',
    );
    expect(lines).toContain(
      '**1 Week** (2026-10-28T13:00:00.000Z → 2026-11-04T13:00:00.000Z) | Above mainshock (≥ M4.01): probability 0.01958',
    );
    expect(lines).toContain('| 3 | 0.0794 | 0 | 0 | 1 |');
    expect(lines).toContain('| 5 | 0.002061 |  |  |  |');
    expect(lines).toContain(
      '- aftershock_forecast: fetch_failed — the product exists but could not be fetched or parsed',
    );
    expect(output).toContain('### Origins (2)');
    expect(output).toContain('### Arrivals (2, preferred origin, nearest first)');
  });

  it('says so when a returned group is empty', () => {
    const output = text({ event: sampleEvent, magnitudes: [], arrivals: [] });
    expect(output).toContain('### Magnitudes (0)\n_The phase-data document lists no magnitudes._');
    expect(output).toContain('_The preferred origin lists no arrivals._');
    expect(output).not.toContain('| Network |');
  });

  it('adds nothing for groups that were not requested', () => {
    const output = text({ event: sampleEvent, detail: sampleDetail });
    expect(output).not.toMatch(/### (Origins|Magnitudes|Arrivals|Aftershock|PAGER|Unavailable)/);
  });

  const u18kPager = () =>
    projectPagerEstimates({
      alerts: fixture('us6000u18k.pager.alerts.json'),
      exposures: fixture('us6000u18k.pager.exposures.json'),
      comments: fixture('us6000u18k.pager.comments.json'),
    });

  it('renders both alerts, every PAGER bracket, the total row, and every country row', () => {
    const lines = text({ event: sampleEvent, pager: u18kPager() }).split('\n');
    const at = lines.indexOf('### PAGER loss estimates');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      'Fatality alert: yellow | Economic alert: orange',
      '- Orange alert for economic losses. Significant damage is likely and the disaster is potentially widespread. Estimated economic losses are 0-2% GDP of Panama. Past events with this alert level have required a regional or national level response.',
      '- Yellow alert for shaking-related fatalities. Some casualties are possible.',
    ]);
    expect(lines).toContain(
      '**Fatalities (deaths)**, each bracket from Min (inclusive) to Max (exclusive)',
    );
    expect(lines).toContain(
      '**Economic losses (millions of USD)**, each bracket from Min (inclusive) to Max (exclusive)',
    );
    const bracketRows = lines.filter((line) => /^\| \d+ \| \d+ \| \w+ \| [\d.e-]+ \|$/.test(line));
    expect(bracketRows).toHaveLength(14);
    expect(bracketRows.slice(0, 2)).toEqual([
      '| 0 | 1 | green | 0.11227771547768949 |',
      '| 1 | 10 | yellow | 0.33828893378760094 |',
    ]);
    expect(lines).toContain('| 100000 | 10000000 | red | 0.000011332245432704724 |');
    expect(lines).toContain('| 100 | 1000 | orange | 0.35322181682545284 |');
    expect(lines).toContain(
      '| Country | MMI 1 | MMI 2 | MMI 3 | MMI 4 | MMI 5 | MMI 6 | MMI 7 | MMI 8 | MMI 9 | MMI 10 |',
    );
    expect(lines).toContain(
      '| Total | 0 | 0 | 3221021 | 1877984 | 2595241 | 555396 | 140964 | 11406 | 0 | 0 |',
    );
    expect(lines.filter((line) => /^\| (CO|CR|NI|PA) \|/.test(line))).toEqual([
      '| CO | 0 | 0 | 3084 | 1125 | 0 | 0 | 0 | 0 | 0 | 0 |',
      '| CR | 0 | 0 | 3180784 | 488153 | 59824 | 0 | 0 | 0 | 0 | 0 |',
      '| NI | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |',
      '| PA | 0 | 0 | 37153 | 1388706 | 2535417 | 555396 | 140964 | 11406 | 0 | 0 |',
    ]);
    expect(lines).not.toContain('_PAGER lists no country rows._');
  });

  it('renders sparse PAGER fields without inventing them', () => {
    const pager = u18kPager();
    const { level: _level, ...fatality } = pager.fatality;
    const output = text({
      event: sampleEvent,
      pager: {
        fatality,
        economic: { ...pager.economic, bins: [{ min: 0, max: 1, probability: 0.5 }] },
        exposure: { mmi: [5, 6], population: [10, 2], countries: [] },
      },
    });
    expect(output).toContain('Fatality alert: not published | Economic alert: orange\n\n');
    expect(output).toContain('| 0 | 1 |  | 0.5 |');
    expect(output).toContain('| Country | MMI 5 | MMI 6 |\n|---|---|---|\n| Total | 10 | 2 |');
    expect(output).toContain('_PAGER lists no country rows._');
    expect(output).not.toContain('United Kingdom');
  });

  it('says what PAGER country code UK means, and escapes a pipe in a code', () => {
    const output = text({
      event: sampleEvent,
      pager: {
        ...u18kPager(),
        exposure: {
          mmi: [7],
          population: [5],
          countries: [
            { country_code: 'UK', population: [3] },
            { country_code: 'M|X', population: [2] },
          ],
        },
      },
    });
    expect(output).toContain('| UK | 3 |');
    expect(output).toContain('| M\\|X | 2 |');
    expect(output).toContain('_"UK" marks areas assigned to no country, not the United Kingdom._');
  });

  it('explains not_published as a missing product or missing files', () => {
    const output = text({
      event: sampleEvent,
      unavailable_includes: [{ group: 'pager', reason: 'not_published' }],
    });
    expect(output.split('\n')).toContain(
      '- pager: not_published — no product for this group is published for this event, or its product lacks the files this group reads',
    );
  });
});

describe('earthquakeGetEvent — PAGER rendering cost (timing)', () => {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const shapes: [string, (size: number) => string][] = [
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size / 4)}\ny`],
    ['breaks throughout', (size) => '  \r\n'.repeat(size / 4)],
    ['escapable cell characters', (size) => '|\\'.repeat(size / 2)],
    // escapeMarkdownInline is quadratic on an interior whitespace run (cyanheads/mcp-ts-core#809).
    ['one whitespace run inside a value', (size) => `a${' '.repeat(size)}b`],
  ];

  /** Upstream text in every string the PAGER path parses or renders, and padding on a bound. */
  const files = (filler: string) => {
    const alerts = JSON.parse(fixture('us6000u18k.pager.alerts.json'));
    alerts.fatality.level = filler;
    alerts.fatality.bins[0].color = filler;
    alerts.fatality.bins[0].min = `${filler.replace(/\S/g, ' ')}0`;
    const exposures = JSON.parse(fixture('us6000u18k.pager.exposures.json'));
    exposures.population_exposure.country_exposures[0].country_code = filler;
    return {
      alerts: JSON.stringify(alerts),
      exposures: JSON.stringify(exposures),
      comments: JSON.stringify({ impact1: filler, impact2: filler }),
    };
  };

  /**
   * Thread CPU time, in µs per call, of parse + render over one input: the least of
   * several measurements, each over a batch of calls so small inputs measure above
   * the clock's resolution.
   */
  const cpuMicros = (input: ReturnType<typeof files>, batch: number) => {
    let least = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const before = process.threadCpuUsage();
      for (let call = 0; call < batch; call++) {
        earthquakeGetEvent.format!({ event: sampleEvent, pager: projectPagerEstimates(input) });
      }
      const spent = process.threadCpuUsage(before);
      least = Math.min(least, (spent.user + spent.system) / batch);
    }
    return least;
  };

  it.each(shapes)('stays linear on %s', (_label, make) => {
    const times: number[] = [];
    for (const size of sizes) {
      const input = files(make(size));
      times.push(cpuMicros(input, Math.max(1, 80_000 / size)));
      // An absolute bound at each size before growing the input further.
      expect(times.at(-1)).toBeLessThan(2_000_000);
    }
    const ratio = (times.at(-1) ?? 0) / Math.max(times[0] ?? 1, 1);
    expect(ratio).toBeLessThan(256);
  });
});
