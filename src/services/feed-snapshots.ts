/**
 * @fileoverview Bounded, tenant-owned serialized feed generations and replayable cursors.
 * @module services/feed-snapshots
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { UsgsService } from './usgs/usgs-service.js';

type Feed = Awaited<ReturnType<UsgsService['getFeed']>>;
type Selection = {
  magnitude_tier: string;
  time_window: string;
  cursor?: string | undefined;
  limit?: number | undefined;
};
type RecordEntry = {
  handle: string;
  bytes: Buffer;
  tenant: string | undefined;
  tier: string;
  window: string;
  key: string;
  expires: number;
  charge: number;
};
const TTL_MS = 15 * 60_000;
/** Process-wide retained payload and charged metadata bound; not a heap limit. */
export const SNAPSHOT_BUDGET = 32 * 1024 * 1024;

function failure(reason: string, message: string) {
  return new McpError(JsonRpcErrorCode.ValidationError, message, {
    reason,
    retryable: false,
    recovery: { hint: 'Restart the feed read without a cursor; use a smaller feed if necessary.' },
  });
}

/** Owns serialized bytes privately; callers receive only fresh parsed objects. */
export class FeedSnapshots {
  #records = new Map<string, RecordEntry>();
  #digests = new Map<string, RecordEntry>();
  #retained = 0;
  constructor(private readonly budget = SNAPSHOT_BUDGET) {}

  /** Measured payload plus encoded metadata and minimum per-record/index charge. */
  get retainedBytes() {
    return this.#retained;
  }

  #remove(handle: string, entry: RecordEntry) {
    this.#records.delete(handle);
    this.#digests.delete(entry.key);
    this.#retained -= entry.charge;
  }

  /** Capture one generation or resolve a cursor before doing any network I/O. */
  async read(selection: Selection, ctx: Context, fetch: () => Promise<Feed>) {
    let handle: string;
    let index = 0;
    let limit = selection.limit ?? 100;
    let record: RecordEntry | undefined;
    const now = Date.now();
    if (selection.cursor != null) {
      const token = selection.cursor;
      if (token.length > 512) throw failure('invalid_cursor', 'Malformed feed cursor.');
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      } catch {
        throw failure('invalid_cursor', 'Malformed feed cursor.');
      }
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        typeof value[0] !== 'string' ||
        !Number.isSafeInteger(value[1]) ||
        value[1] < 0 ||
        !Number.isInteger(value[2]) ||
        value[2] < 1 ||
        value[2] > 1000 ||
        Buffer.from(JSON.stringify(value)).toString('base64url') !== token
      ) {
        throw failure('invalid_cursor', 'Malformed feed cursor.');
      }
      [handle, index, limit] = value as [string, number, number];
      record = this.#records.get(handle);
      if (
        !record ||
        record.expires <= now ||
        record.tenant !== ctx.tenantId ||
        record.tier !== selection.magnitude_tier ||
        record.window !== selection.time_window
      ) {
        throw failure(
          'cursor_expired',
          'Feed cursor is unavailable for this tenant and feed, or has expired.',
        );
      }
      ctx.signal?.throwIfAborted();
    } else {
      const feed = await fetch();
      ctx.signal?.throwIfAborted();
      const bytes = Buffer.from(JSON.stringify(feed), 'utf8');
      const key = JSON.stringify([
        ctx.tenantId,
        selection.magnitude_tier,
        selection.time_window,
        createHash('sha256').update(bytes).digest('hex'),
      ]);
      handle = randomUUID();
      const metadata = {
        handle,
        tenant: ctx.tenantId,
        tier: selection.magnitude_tier,
        window: selection.time_window,
        key,
        expires: Date.now() + TTL_MS,
      };
      const charge = bytes.byteLength + Buffer.byteLength(JSON.stringify(metadata)) + 512;
      if (charge > this.budget)
        throw failure('snapshot_too_large', 'This feed cannot fit in retained storage.');
      ctx.signal?.throwIfAborted();
      for (const [id, entry] of this.#records)
        if (entry.expires <= Date.now()) this.#remove(id, entry);
      const existing = this.#digests.get(key);
      if (existing != null) {
        handle = existing.handle;
        record = existing;
      } else {
        for (const [id, entry] of this.#records) {
          if (this.#retained + charge <= this.budget) break;
          this.#remove(id, entry);
        }
        record = { ...metadata, bytes, charge };
        this.#records.set(handle, record);
        this.#digests.set(key, record);
        this.#retained += charge;
      }
    }
    const feed = JSON.parse(record.bytes.toString('utf8')) as Feed;
    return {
      feed,
      index,
      limit,
      cursor: (next: number) =>
        Buffer.from(JSON.stringify([handle, next, limit])).toString('base64url'),
    };
  }
}

/** Shared by feed tools and both resource dispatch paths. */
export const feedSnapshots = new FeedSnapshots();
