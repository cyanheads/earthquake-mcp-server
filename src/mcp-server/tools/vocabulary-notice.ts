/**
 * @fileoverview Explains a zero USGS search or count caused by a type filter value USGS does
 * not list. `event_type`, `magnitude_type`, and `product_type` are open strings that USGS
 * matches case-insensitively against its published vocabulary, answering any other value with
 * zero events; the notice names each unlisted value and the listed values it most likely
 * meant. Shared by earthquake_search_events and earthquake_count_events so the sentences read
 * identically on both, with the renderer both tools' content[] trailers draw a notice with.
 * @module mcp-server/tools/vocabulary-notice
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { EarthquakeQueryParams, UsgsVocabulary } from '@/services/usgs/types.js';
import { getUsgsService } from '@/services/usgs/usgs-service.js';

/**
 * The checked values a query sends, in input order. USGS reads `eventtype` as a
 * comma-separated list whose members it does not trim (`buildQueryParams` trims them before
 * sending), and `magnitudetype` and `producttype` as one value each.
 */
function checkedValues(
  params: EarthquakeQueryParams,
): { field: string; kind: string; list: keyof UsgsVocabulary; values: string[] }[] {
  const one = (value: string | undefined) => (value != null ? [value] : []);
  return [
    {
      field: 'event_type',
      kind: 'event',
      list: 'eventtypes',
      values: params.eventType?.split(',') ?? [],
    },
    {
      field: 'magnitude_type',
      kind: 'magnitude',
      list: 'magnitudetypes',
      values: one(params.magnitudeType),
    },
    {
      field: 'product_type',
      kind: 'product',
      list: 'producttypes',
      values: one(params.productType),
    },
  ];
}

/** A value with case and the separators `-`, `_`, and space ignored. */
const fold = (value: string) => value.toLowerCase().replace(/[-_ ]/g, '');

/**
 * Sentences naming each checked value the vocabulary does not list, each with the listed
 * values it equals once case and separators are ignored; undefined when every value is
 * listed. Listed-ness ignores case alone, as USGS matching does: `quarry_blast` is listed
 * beside `quarry blast`, and `moment_tensor` is not. Values are quoted as JSON strings.
 */
export function unlistedValueSentences(
  params: EarthquakeQueryParams,
  vocabulary: UsgsVocabulary,
): string | undefined {
  const sentences: string[] = [];
  for (const { field, kind, list, values } of checkedValues(params)) {
    if (values.length === 0) continue;
    const listed = new Set(vocabulary[list].map((value) => value.toLowerCase()));
    const byFold = Map.groupBy(vocabulary[list], fold);
    for (const value of new Set(values)) {
      if (listed.has(value.toLowerCase())) continue;
      const likely = byFold.get(fold(value)) ?? [];
      const suggestion =
        likely.length > 0
          ? `; did you mean ${likely.map((match) => JSON.stringify(match)).join(' or ')}?`
          : '.';
      sentences.push(
        `${field} ${JSON.stringify(value)} is not a listed USGS ${kind} type${suggestion}`,
      );
    }
  }
  if (sentences.length === 0) return;
  return `${sentences.join(' ')} USGS matches an unlisted value against no events.`;
}

/**
 * The vocabulary sentences for a zero USGS result, or undefined: when the query sent none of
 * the checked filters (no lookup runs), when every value is listed, or when the vocabulary
 * could not be read before `deadline`, the epoch-ms end of the call's budget. Caller
 * cancellation propagates.
 */
export async function unlistedValueNotice(
  params: EarthquakeQueryParams,
  ctx: Context,
  deadline: number,
): Promise<string | undefined> {
  if (params.eventType == null && params.magnitudeType == null && params.productType == null) {
    return;
  }
  const vocabulary = await getUsgsService().getVocabulary(ctx, deadline);
  return vocabulary && unlistedValueSentences(params, vocabulary);
}

/**
 * A tool's one-line notice as the content[] blockquote, escaped because it can quote
 * caller-supplied values. Each whitespace-free run is escaped on its own, which keeps the
 * escape linear in the notice's length until cyanheads/mcp-ts-core#809 ships; collapse this
 * to one `escapeMarkdownInline(notice)` call then. No escape decision reaches past
 * whitespace, so the runs read back as the whole line would, at worst with a redundant
 * backslash before a run's leading block marker.
 */
export function renderNotice(notice: string): string {
  const runs = notice.split(/(\s+)/);
  return `> ${runs.map((run, index) => (index % 2 === 0 ? escapeMarkdownInline(run) : run)).join('')}`;
}
