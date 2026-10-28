/**
 * @fileoverview The shared count-input cap: schema bounds and description per config mode,
 * the clamp value table, its notice, log line, and counter. Per-tool tests prove only the wiring.
 * @module tests/tools/limit-clamp.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ add: vi.fn() }));
const counterNames = vi.hoisted(() => [] as string[]);
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    counterNames.push(name);
    return counter;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EARTHQUAKE_CLAMP_LIMITS', undefined);
  counter.add.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const load = () => import('@/mcp-server/tools/limit-clamp.js');
const emit = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });
const describeAs = (capRule: string) => `Limit; ${capRule}.`;

describe('limit cap', () => {
  it('pins the cap at 1,000', async () => {
    const { MAX_LIMIT } = await import('@/config/server-config.js');
    expect(MAX_LIMIT).toBe(1000);
  });

  it.each([1, 15, 999, 1000])('passes %i through without a notice, log, or count', async (n) => {
    const { clampLimit } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const result = clampLimit(n, 'earthquake_search_events', ctx);
    expect(result).toEqual({ applied: n });
    expect(result).not.toHaveProperty('notice');
    expect(info).not.toHaveBeenCalled();
    expect(counter.add).not.toHaveBeenCalled();
  });

  it.each([
    [1001, 'earthquake_search_events'],
    [20001, 'earthquake_get_feed'],
  ] as const)('clamps %i to the cap, naming requested and applied values', async (n, tool) => {
    const { clampLimit } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    expect(clampLimit(n, tool, ctx)).toEqual({
      applied: 1000,
      notice: `Requested limit ${n}; applied limit 1000, the per-call cap.`,
    });
    expect(info).toHaveBeenCalledExactlyOnceWith('Clamped limit', {
      tool,
      requested: n,
      applied: 1000,
    });
    expect(counter.add).toHaveBeenCalledExactlyOnceWith(1, { [ATTR_MCP_TOOL_NAME]: tool });
    expect(counterNames).toContain('earthquake.limit.clamps');
  });

  describe('schema, clamping on (default)', () => {
    it.each(['', 'true'])(
      'accepts values above the cap with EARTHQUAKE_CLAMP_LIMITS=%j',
      async (v) => {
        vi.stubEnv('EARTHQUAKE_CLAMP_LIMITS', v);
        const { limitSchema } = await load();
        const schema = limitSchema(describeAs);
        expect(schema.parse(1001)).toBe(1001);
        expect(schema.parse(20001)).toBe(20001);
        // `.int()` would advertise the safe-integer ceiling as a maximum.
        expect(emit(schema)).toMatchObject({ type: 'number', minimum: 1, multipleOf: 1 });
        expect(emit(schema)).not.toHaveProperty('maximum');
      },
    );

    it.each([0, -1, 1.5])('still rejects %d', async (n) => {
      const { limitSchema } = await load();
      expect(limitSchema(describeAs).safeParse(n).success).toBe(false);
    });

    it('describes an over-cap value as clamped and disclosed', async () => {
      const { limitSchema } = await load();
      const schema = limitSchema(describeAs);
      expect(schema.description).toBe('Limit; a larger value returns at most 1,000 and says so.');
      expect(emit(schema).description).toBe(schema.description);
    });
  });

  describe('schema, EARTHQUAKE_CLAMP_LIMITS=false', () => {
    it('advertises and enforces a maximum at the cap', async () => {
      vi.stubEnv('EARTHQUAKE_CLAMP_LIMITS', 'false');
      const { limitSchema } = await load();
      const schema = limitSchema(describeAs);
      expect(schema.parse(1000)).toBe(1000);
      expect(schema.safeParse(1001).success).toBe(false);
      expect(emit(schema)).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 });
    });

    it('describes the cap without promising a clamp', async () => {
      vi.stubEnv('EARTHQUAKE_CLAMP_LIMITS', 'false');
      const { limitSchema } = await load();
      const schema = limitSchema(describeAs);
      expect(schema.description).toBe('Limit; at most 1,000.');
      expect(emit(schema).description).toBe('Limit; at most 1,000.');
    });
  });

  it('reads the mode when the description is read, not when the field is built', async () => {
    const { limitSchema } = await load();
    const schema = limitSchema(describeAs);
    // Building the field must not parse the config: `createApp()` loads `.env` after
    // the definition modules are imported, and the parsed config is cached.
    vi.stubEnv('EARTHQUAKE_CLAMP_LIMITS', 'false');
    expect(schema.description).toBe('Limit; at most 1,000.');
  });
});
