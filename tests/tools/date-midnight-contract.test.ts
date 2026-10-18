/**
 * @fileoverview Date bounds through tool contracts, real adapters, and both client surfaces.
 * @module tests/tools/date-midnight-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { earthquakeCountEvents } from '@/mcp-server/tools/definitions/earthquake-count-events.tool.js';
import { earthquakeSearchEvents } from '@/mcp-server/tools/definitions/earthquake-search-events.tool.js';
import * as emsc from '@/services/emsc/emsc-service.js';
import * as usgs from '@/services/usgs/usgs-service.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['usgs', 'emsc'] as const)('%s date bounds on the wire', (source) => {
  it.each([earthquakeSearchEvents, earthquakeCountEvents])(
    '$name sends and echoes explicit midnight through the real adapter',
    async (tool) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(
          async (url: string) =>
            new Response(
              JSON.stringify(
                new URL(url).pathname.endsWith('/count')
                  ? { count: 0 }
                  : { type: 'FeatureCollection', features: [] },
              ),
              { headers: { 'Content-Type': 'application/json' } },
            ),
        );
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(usgs, 'getUsgsService').mockReturnValue(
        new usgs.UsgsService({} as AppConfig, {} as StorageService, 'https://usgs.test', 5000),
      );
      vi.spyOn(emsc, 'getEmscService').mockReturnValue(
        new emsc.EmscService({} as AppConfig, {} as StorageService, 'https://emsc.test', 5000),
      );

      const result = await runToolContract(tool, {
        source,
        start_time: '2026-10-9',
        end_time: '2026-10-10',
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        count: 0,
        queryEcho: {
          start_time: '2026-10-09T00:00:00',
          end_time: '2026-10-10T00:00:00',
        },
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain('start_time=2026-10-09T00:00:00');
      expect(text).toContain('end_time=2026-10-10T00:00:00');
      expect(fetchMock).toHaveBeenCalledOnce();
      const sent = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(sent.hostname).toBe(`${source}.test`);
      expect(sent.searchParams.get('starttime')).toBe('2026-10-09T00:00:00');
      expect(sent.searchParams.get('endtime')).toBe('2026-10-10T00:00:00');
    },
  );

  it.each([earthquakeSearchEvents, earthquakeCountEvents])(
    '$name rejects blank and ambiguous dates before network access on both surfaces',
    async (tool) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      for (const value of ['', '03/05/2020']) {
        const result = await runToolContract(tool, { source, end_time: value });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.structuredContent)).toContain('ISO 8601');
        expect(JSON.stringify(result.content)).toContain('ISO 8601');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
