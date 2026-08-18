/**
 * @fileoverview Tests for the filter surface earthquake_search and earthquake_count share —
 * the extracted validators (issue #32), FDSN timestamp validation and normalization (#29),
 * the alert-level minimum (#31), the bounding box (#37), and the invariant tying every
 * queryEcho entry to a parameter the adapter actually sent.
 * @module tests/tools/shared-filter-surface.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { earthquakeCount } from '@/mcp-server/tools/definitions/earthquake-count.tool.js';
import { earthquakeSearch } from '@/mcp-server/tools/definitions/earthquake-search.tool.js';
import { earthquakeFilterFields } from '@/mcp-server/tools/query-params.js';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import * as emscModule from '@/services/emsc/emsc-service.js';
import { EmscService } from '@/services/emsc/emsc-service.js';
import type { EarthquakeQueryParams } from '@/services/usgs/types.js';
import * as usgsModule from '@/services/usgs/usgs-service.js';
import { UsgsService } from '@/services/usgs/usgs-service.js';

const SHARED_FIELDS = Object.keys(earthquakeFilterFields);

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

/** Both tools, so every shared-surface assertion below runs against each of them. */
const tools = [
  { name: 'earthquakeSearch', tool: earthquakeSearch },
  { name: 'earthquakeCount', tool: earthquakeCount },
] as const;

// --- Schema-level: the shared validators reach both tools identically -------------------

describe('shared filter surface — bounds are identical across both tools (issue #32)', () => {
  it('emits byte-identical JSON Schema for every shared field, descriptions aside', () => {
    const shapeOf = (tool: typeof earthquakeSearch | typeof earthquakeCount) => {
      const emitted = z.toJSONSchema(tool.input, { io: 'input' }) as {
        properties: Record<string, Record<string, unknown>>;
      };
      return Object.fromEntries(
        SHARED_FIELDS.map((field) => {
          const { description: _description, ...constraints } = emitted.properties[field] ?? {};
          return [field, constraints];
        }),
      );
    };

    expect(shapeOf(earthquakeSearch)).toEqual(shapeOf(earthquakeCount));
    // Guard the guard: a typo in SHARED_FIELDS would make the comparison vacuous.
    expect(SHARED_FIELDS).toContain('radius_km');
    expect(Object.keys(shapeOf(earthquakeSearch))).toHaveLength(17);
  });

  it('publishes a readable pattern for the date fields so a caller can self-correct', () => {
    const emitted = z.toJSONSchema(earthquakeSearch.input, { io: 'input' }) as {
      properties: Record<string, { pattern?: string }>;
    };
    for (const field of ['start_time', 'end_time']) {
      expect(emitted.properties[field]?.pattern).toContain('\\d{4}');
    }
  });
});

describe.each(tools)('$name — start_time / end_time validation (issue #29)', ({ tool }) => {
  it.each(['2020-03-05', '2020-3-5', '2026-05-23T00:00:00', '2020-03-05T00:00:00.000Z', '2020'])(
    'accepts the recoverable form %s',
    (value) => {
      expect(tool.input.parse({ start_time: value }).start_time).toBe(value);
      expect(tool.input.parse({ end_time: value }).end_time).toBe(value);
    },
  );

  it('accepts a calendar-invalid but digit-shaped date, leaving it to the upstream', () => {
    expect(tool.input.parse({ start_time: '2026-13-45' }).start_time).toBe('2026-13-45');
  });

  it.each([
    '',
    '03/05/2020',
    'NaN-NaN-NaNT00:00:00.000Z',
    'last tuesday',
    '[object Object]T00:00:00',
  ])('rejects %s locally, naming the field and the accepted format', (value) => {
    for (const field of ['start_time', 'end_time'] as const) {
      const result = tool.input.safeParse({ [field]: value });
      expect(result.success).toBe(false);
      const issue = result.error?.issues[0];
      expect(issue?.path).toEqual([field]);
      expect(issue?.message).toContain('ISO 8601');
    }
  });

  it('rejects an empty start_time and end_time supplied together', () => {
    expect(tool.input.safeParse({ start_time: '', end_time: '' }).success).toBe(false);
  });
});

describe.each(tools)('$name — filter bounds (issue #32)', ({ tool }) => {
  it('rejects a blank or whitespace-only event_type but keeps a real one working', () => {
    expect(tool.input.safeParse({ event_type: '' }).success).toBe(false);
    expect(tool.input.safeParse({ event_type: '   ' }).success).toBe(false);
    expect(tool.input.parse({ event_type: 'quarry blast' }).event_type).toBe('quarry blast');
  });

  it('bounds depth to the documented -100..1000 km envelope', () => {
    expect(tool.input.parse({ min_depth_km: -100 }).min_depth_km).toBe(-100);
    expect(tool.input.parse({ max_depth_km: 1000 }).max_depth_km).toBe(1000);
    expect(() => tool.input.parse({ min_depth_km: -100.1 })).toThrow();
    expect(() => tool.input.parse({ max_depth_km: 1000.1 })).toThrow();
  });

  it('caps radius_km at the ceiling USGS actually enforces', () => {
    expect(tool.input.parse({ radius_km: 20001.6 }).radius_km).toBe(20001.6);
    expect(() => tool.input.parse({ radius_km: 20001.7 })).toThrow();
  });

  it('round-trips a literal zero on every filter that admits one', () => {
    const parsed = tool.input.parse({
      latitude: 0,
      longitude: 0,
      radius_km: 0,
      min_depth_km: 0,
      min_significance: 0,
      min_latitude: 0,
      min_longitude: 0,
      max_longitude: 0,
    });
    expect(parsed).toMatchObject({
      latitude: 0,
      longitude: 0,
      radius_km: 0,
      min_depth_km: 0,
      min_significance: 0,
      min_latitude: 0,
      min_longitude: 0,
      max_longitude: 0,
    });
  });
});

describe.each(tools)('$name — bounding-box bounds (issue #37)', ({ tool }) => {
  it.each(['min_latitude', 'max_latitude', 'min_longitude', 'max_longitude'] as const)(
    'accepts %s on its own — each edge is independently optional',
    (field) => {
      expect(tool.input.parse({ [field]: 12.5 })[field]).toBe(12.5);
    },
  );

  it('bounds latitude to ±90 and longitude to ±360', () => {
    expect(tool.input.parse({ min_latitude: -90, max_latitude: 90 })).toMatchObject({
      min_latitude: -90,
      max_latitude: 90,
    });
    expect(tool.input.parse({ min_longitude: -360, max_longitude: 360 })).toMatchObject({
      min_longitude: -360,
      max_longitude: 360,
    });
    expect(() => tool.input.parse({ min_latitude: -90.1 })).toThrow();
    expect(() => tool.input.parse({ max_latitude: 90.1 })).toThrow();
    expect(() => tool.input.parse({ min_longitude: -360.1 })).toThrow();
    expect(() => tool.input.parse({ max_longitude: 360.1 })).toThrow();
  });

  it('accepts an extended-range antimeridian box', () => {
    expect(tool.input.parse({ min_longitude: 170, max_longitude: 190 })).toMatchObject({
      min_longitude: 170,
      max_longitude: 190,
    });
  });
});

// --- Handler-level ---------------------------------------------------------------------

describe('shared filter surface — handler behavior', () => {
  let mockUsgsSearch: ReturnType<typeof vi.fn>;
  let mockUsgsCount: ReturnType<typeof vi.fn>;
  let mockEmscSearch: ReturnType<typeof vi.fn>;
  let mockEmscCount: ReturnType<typeof vi.fn>;
  let usgsAccessor: ReturnType<typeof vi.spyOn>;
  let emscAccessor: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fresh accessor spies each test: a leaked call count from a previous case would
    // make the "no service was resolved" assertions below report the wrong test's work.
    vi.restoreAllMocks();
    mockUsgsSearch = vi.fn().mockResolvedValue({ events: [minimalEvent], count: 1 });
    mockUsgsCount = vi
      .fn()
      .mockResolvedValue({ count: 12, maxAllowed: 20000, exceedsLimit: false });
    mockEmscSearch = vi.fn().mockResolvedValue({ events: [minimalEvent], count: 1 });
    mockEmscCount = vi.fn().mockResolvedValue({ count: 7, maxAllowed: null, exceedsLimit: false });
    usgsAccessor = vi.spyOn(usgsModule, 'getUsgsService').mockReturnValue({
      searchEvents: mockUsgsSearch,
      countEvents: mockUsgsCount,
    } as unknown as usgsModule.UsgsService);
    emscAccessor = vi.spyOn(emscModule, 'getEmscService').mockReturnValue({
      searchEvents: mockEmscSearch,
      countEvents: mockEmscCount,
    } as unknown as emscModule.EmscService);
  });

  const invoke = {
    earthquakeSearch: (input: unknown, ctx: Context) =>
      earthquakeSearch.handler(earthquakeSearch.input.parse(input), ctx as never),
    earthquakeCount: (input: unknown, ctx: Context) =>
      earthquakeCount.handler(earthquakeCount.input.parse(input), ctx as never),
  };
  const spyFor = {
    earthquakeSearch: { usgs: () => mockUsgsSearch, emsc: () => mockEmscSearch },
    earthquakeCount: { usgs: () => mockUsgsCount, emsc: () => mockEmscCount },
  };

  describe.each(tools)(
    '$name — empty dates never reach a service (issue #29)',
    ({ name, tool }) => {
      it.each(['start_time', 'end_time'])(
        'fails validation on an empty %s before any service is resolved',
        (field) => {
          expect(() => tool.input.parse({ [field]: '' })).toThrow();
          expect(usgsAccessor).not.toHaveBeenCalled();
          expect(emscAccessor).not.toHaveBeenCalled();
          expect(spyFor[name].usgs()).not.toHaveBeenCalled();
          expect(spyFor[name].emsc()).not.toHaveBeenCalled();
        },
      );

      it('never lets an empty date appear in queryEcho, because it never parses', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        await invoke[name]({ start_time: '2020-01-01' }, ctx as Context);
        const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
        expect(echo.start_time).toBe('2020-01-01');
        expect(Object.values(echo)).not.toContain('');
      });
    },
  );

  describe.each(tools)(
    '$name — normalized dates reach both sources (issue #29)',
    ({ name, tool }) => {
      it.each([
        ['2020-3-5', '2020-03-05'],
        ['2020', '2020-01-01'],
      ])('sends %s upstream as %s on source=usgs', async (supplied, normalized) => {
        const ctx = createMockContext({ errors: tool.errors });
        await invoke[name]({ start_time: supplied }, ctx as Context);

        expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({ startTime: normalized });
        expect(
          (getEnrichment(ctx).queryEcho as { start_time?: string } | undefined)?.start_time,
        ).toBe(normalized);
      });

      it('sends the same normalized window to EMSC, ending the source divergence', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        await invoke[name](
          { source: 'emsc', start_time: '2020', end_time: '2020-3-6' },
          ctx as Context,
        );

        expect(spyFor[name].emsc().mock.calls[0]?.[0]).toMatchObject({
          startTime: '2020-01-01',
          endTime: '2020-03-06',
        });
        expect(getEnrichment(ctx).queryEcho).toMatchObject({
          start_time: '2020-01-01',
          end_time: '2020-03-06',
        });
      });
    },
  );

  describe.each(tools)('$name — bounding box (issue #37)', ({ name, tool }) => {
    it('rejects a strictly inverted latitude pair with the declared reason', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await expect(
        invoke[name]({ min_latitude: 40, max_latitude: 30 }, ctx as Context),
      ).rejects.toMatchObject({ data: { reason: 'invalid_bounding_box' } });
      expect(spyFor[name].usgs()).not.toHaveBeenCalled();
    });

    it('rejects a strictly inverted longitude pair, including the antimeridian mistake', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await expect(
        invoke[name]({ min_longitude: 10, max_longitude: -10 }, ctx as Context),
      ).rejects.toMatchObject({ data: { reason: 'invalid_bounding_box' } });
    });

    it('carries an actionable recovery hint naming the extended-range escape', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      const err = (await Promise.resolve(
        invoke[name]({ min_latitude: 40, max_latitude: 30 }, ctx as Context),
      ).catch((e: unknown) => e)) as { data: { recovery?: { hint?: string } } };
      expect(err.data.recovery?.hint).toBe(
        tool.errors?.find((e) => e.reason === 'invalid_bounding_box')?.recovery,
      );
      expect(err.data.recovery?.hint).toContain('antimeridian');
    });

    it('accepts an equal-value pair — a degenerate box both providers answer', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ min_latitude: 35, max_latitude: 35 }, ctx as Context);
      expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({
        minLatitude: 35,
        maxLatitude: 35,
      });
      expect(getEnrichment(ctx).queryEcho).toMatchObject({
        min_latitude: 35,
        max_latitude: 35,
      });
    });

    it('accepts an equal-value longitude pair too', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ min_longitude: -120, max_longitude: -120 }, ctx as Context);
      expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({
        minLongitude: -120,
        maxLongitude: -120,
      });
    });

    it('forwards a 0 edge end to end — the equator survives the truthy trap', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ min_latitude: 0, min_longitude: 0, max_longitude: 0 }, ctx as Context);
      expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({
        minLatitude: 0,
        minLongitude: 0,
        maxLongitude: 0,
      });
      expect(getEnrichment(ctx).queryEcho).toMatchObject({
        min_latitude: 0,
        min_longitude: 0,
        max_longitude: 0,
      });
    });

    it('combines the box with the circle group instead of rejecting it', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name](
        {
          latitude: 35,
          longitude: -120,
          radius_km: 500,
          min_latitude: 30,
          max_latitude: 40,
        },
        ctx as Context,
      );
      expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({
        radiusKm: 500,
        minLatitude: 30,
        maxLatitude: 40,
      });
    });

    it('still enforces the circle triple all-or-nothing rule alongside a box', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await expect(
        invoke[name]({ latitude: 35, min_latitude: 30, max_latitude: 40 }, ctx as Context),
      ).rejects.toMatchObject({ data: { reason: 'invalid_radius' } });
    });

    it('forwards the box unchanged to EMSC — not a USGS-only filter', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ source: 'emsc', min_latitude: 35, max_latitude: 42 }, ctx as Context);
      expect(spyFor[name].emsc().mock.calls[0]?.[0]).toMatchObject({
        minLatitude: 35,
        maxLatitude: 42,
      });
      expect(getEnrichment(ctx).ignoredFilters).toBeUndefined();
      expect(getEnrichment(ctx).queryEcho).toMatchObject({ min_latitude: 35, max_latitude: 42 });
    });

    it('omits every box key from queryEcho when no edge was supplied', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ min_magnitude: 5 }, ctx as Context);
      const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
      for (const key of ['min_latitude', 'max_latitude', 'min_longitude', 'max_longitude']) {
        expect(echo).not.toHaveProperty(key);
      }
    });
  });

  describe.each(tools)('$name — alert_level stays a minimum end to end (#31)', ({ name, tool }) => {
    it('echoes the caller value unchanged while the adapter renames the parameter', async () => {
      const ctx = createMockContext({ errors: tool.errors });
      await invoke[name]({ alert_level: 'green' }, ctx as Context);
      expect(spyFor[name].usgs().mock.calls[0]?.[0]).toMatchObject({ alertLevel: 'green' });
      expect(getEnrichment(ctx).queryEcho).toMatchObject({ alert_level: 'green' });
    });
  });

  // --- queryEcho ⟺ upstream querystring ------------------------------------------------

  /** queryEcho key → the FDSN parameter each adapter builds from it. */
  const USGS_PARAM_OF: Record<string, string> = {
    start_time: 'starttime',
    end_time: 'endtime',
    min_magnitude: 'minmagnitude',
    max_magnitude: 'maxmagnitude',
    latitude: 'latitude',
    longitude: 'longitude',
    radius_km: 'maxradiuskm',
    min_latitude: 'minlatitude',
    max_latitude: 'maxlatitude',
    min_longitude: 'minlongitude',
    max_longitude: 'maxlongitude',
    min_depth_km: 'mindepth',
    max_depth_km: 'maxdepth',
    alert_level: 'minalertlevel',
    min_felt: 'minfelt',
    min_significance: 'minsig',
    event_type: 'eventtype',
    limit: 'limit',
    offset: 'offset',
    order_by: 'orderby',
  };
  const EMSC_PARAM_OF: Record<string, string> = { ...USGS_PARAM_OF, radius_km: 'maxradius' };

  /** Every filter this batch owns, supplied at once. */
  const fullFilterInput = {
    start_time: '2020-3-5',
    end_time: '2020-03-06',
    min_magnitude: 2.5,
    max_magnitude: 8,
    latitude: 35,
    longitude: -120,
    radius_km: 500,
    min_latitude: 0,
    max_latitude: 40,
    min_longitude: 0,
    max_longitude: 20,
    min_depth_km: 0,
    max_depth_km: 700,
    alert_level: 'green',
    min_felt: 10,
    min_significance: 600,
    event_type: 'earthquake',
  };

  /** Run the real adapter over the params the handler produced and return its querystring. */
  async function querystringFor(
    source: 'usgs' | 'emsc',
    params: EarthquakeQueryParams,
  ): Promise<URLSearchParams> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service =
      source === 'usgs'
        ? new UsgsService({} as AppConfig, {} as StorageService, 'https://usgs.test', 5000)
        : new EmscService({} as AppConfig, {} as StorageService, 'https://emsc.test', 5000);
    await service.searchEvents(params, createMockContext() as Context);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    vi.unstubAllGlobals();
    return url.searchParams;
  }

  describe.each(tools)(
    '$name — queryEcho reports only what was sent (#29, #32, #37)',
    ({ name, tool }) => {
      it.each(['usgs', 'emsc'] as const)(
        'every queryEcho entry maps to a %s parameter that is actually in the request',
        async (source) => {
          const ctx = createMockContext({ errors: tool.errors });
          await invoke[name]({ ...fullFilterInput, source }, ctx as Context);

          const params = spyFor[name][source]().mock.calls[0]?.[0] as EarthquakeQueryParams;
          const sent = await querystringFor(source, params);
          const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
          const paramOf = source === 'usgs' ? USGS_PARAM_OF : EMSC_PARAM_OF;

          // Forward direction: nothing is echoed that was not sent.
          for (const [key, value] of Object.entries(echo)) {
            if (key === 'source') continue;
            const param = paramOf[key];
            expect(param, `queryEcho.${key} has no known FDSN parameter`).toBeDefined();
            expect(sent.has(param as string), `${key} echoed but ${param} not sent`).toBe(true);
            if (key !== 'radius_km') expect(sent.get(param as string)).toBe(String(value));
          }

          // Reverse direction: nothing filter-shaped is sent that was not echoed.
          const echoedParams = new Set(
            Object.keys(echo)
              .filter((key) => key !== 'source')
              .map((key) => paramOf[key]),
          );
          for (const param of sent.keys()) {
            if (param === 'format') continue;
            expect(echoedParams.has(param), `${param} sent but not echoed`).toBe(true);
          }
        },
      );

      it('drops the USGS-only filters from both the echo and the EMSC request', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        await invoke[name]({ ...fullFilterInput, source: 'emsc' }, ctx as Context);

        const params = spyFor[name].emsc().mock.calls[0]?.[0] as EarthquakeQueryParams;
        const sent = await querystringFor('emsc', params);
        const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;

        for (const key of ['alert_level', 'min_felt', 'min_significance', 'event_type']) {
          expect(echo).not.toHaveProperty(key);
        }
        for (const param of ['minalertlevel', 'alertlevel', 'minfelt', 'minsig', 'eventtype']) {
          expect(sent.has(param)).toBe(false);
        }
        expect(getEnrichment(ctx).ignoredFilters).toEqual([
          'alert_level',
          'event_type',
          'min_felt',
          'min_significance',
        ]);
      });
    },
  );

  // --- content[] surface ----------------------------------------------------------------

  describe.each(tools)(
    '$name — the box reaches content[], not just structuredContent',
    ({ name, tool }) => {
      it('renders every box edge in the queryEcho trailer', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        await invoke[name](
          { min_latitude: 0, max_latitude: 40, min_longitude: 170, max_longitude: 190 },
          ctx as Context,
        );

        const echo = getEnrichment(ctx).queryEcho as Record<string, unknown>;
        const rendered = tool.enrichmentTrailer?.queryEcho?.render?.(echo as never);
        const text = typeof rendered === 'string' ? rendered : String(rendered);
        expect(text).toContain('min_latitude=0');
        expect(text).toContain('max_latitude=40');
        expect(text).toContain('min_longitude=170');
        expect(text).toContain('max_longitude=190');
      });
    },
  );

  it('search still renders its events for a box-only query, and says so when empty', async () => {
    const ctx = createMockContext({ errors: earthquakeSearch.errors });
    const result = await invoke.earthquakeSearch(
      { min_latitude: 30, max_latitude: 40 },
      ctx as Context,
    );
    expect((earthquakeSearch.format!(result)[0] as { text: string }).text).toContain('us1234567');

    mockUsgsSearch.mockResolvedValue({ events: [], count: 0 });
    const emptyCtx = createMockContext({ errors: earthquakeSearch.errors });
    const empty = await invoke.earthquakeSearch(
      { min_latitude: 30, max_latitude: 40 },
      emptyCtx as Context,
    );
    expect(empty.count).toBe(0);
    expect((earthquakeSearch.format!(empty)[0] as { text: string }).text).toContain(
      'No events matched the query.',
    );
    expect(getEnrichment(emptyCtx).notice).toContain('broadening');
  });

  it('count renders its box-scoped total on the content[] surface', async () => {
    const ctx = createMockContext({ errors: earthquakeCount.errors });
    const result = await invoke.earthquakeCount(
      { min_latitude: 30, max_latitude: 40 },
      ctx as Context,
    );
    const text = (earthquakeCount.format!(result)[0] as { text: string }).text;
    expect(text).toContain('12');
    expect(text).toContain('USGS');
  });
});
