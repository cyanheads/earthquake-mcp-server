/**
 * @fileoverview Fixture readers and a fetch stub for the USGS single-event path: serves the event's detail
 * capture and, per product type, a content-file capture or a custom responder. Every
 * requested URL is recorded so tests can assert the exact upstream traffic.
 * @module tests/helpers/usgs-fetch-stub
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

/** Read a capture trimmed from a live USGS response. */
export const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/usgs/${name}`, import.meta.url), 'utf8');

/** A SeismicPortal capture — `<unid>.json` is the by-unid response, `.search.json` a query page. */
export const emscFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/emsc/${name}`, import.meta.url), 'utf8');

/** A fixture file name served as a 200, or a function answering the request. */
export type Responder = string | ((url: URL, init?: RequestInit) => Response | Promise<Response>);

/**
 * Stub `fetch` for one event. `products` maps a product type (`phase-data`, `oaf`) to
 * the responder for its content files. Any other URL rejects and is still recorded.
 */
export function stubUsgsEvent(
  eventId: string,
  products: Partial<Record<'phase-data' | 'oaf', Responder>> = {},
  detail: Responder = `${eventId}.detail.json`,
) {
  const urls: string[] = [];
  const answer = (responder: Responder, url: URL, init?: RequestInit) =>
    typeof responder === 'string'
      ? new Response(fixture(responder), { status: 200 })
      : responder(url, init);
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url.href);
    if (url.pathname === '/fdsnws/event/1/query' && url.searchParams.get('eventid') === eventId) {
      return answer(detail, url, init);
    }
    const productType = url.pathname.split('/')[2];
    const responder =
      url.pathname.startsWith('/product/') &&
      (productType === 'phase-data' || productType === 'oaf')
        ? products[productType]
        : undefined;
    if (responder !== undefined) return answer(responder, url, init);
    throw new Error(`unexpected fetch ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls };
}

/** A fetch that never settles until its signal aborts, as a hung upstream behaves. */
export function hang(_url: URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener('abort', fail, { once: true });
  });
}
