# earthquake-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `earthquake_get_feed` | Fetch a USGS real-time pre-computed feed by magnitude tier and time window. Fast, cached, low-latency. | `magnitude_tier` (all/1.0/2.5/4.5/significant), `time_window` (hour/day/week/month) | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_search_events` | Query earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports. Supports both USGS and EMSC sources. | `start_time`, `end_time`, `min_magnitude`, `latitude`+`longitude`+`radius_km`, `source`, `limit`, `order_by` | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_get_event` | Fetch one earthquake by USGS or EMSC event ID. USGS events add felt reports, ShakeMap intensity, PAGER alert, and other product projections; `include` opts into alternative origins, magnitudes, phase arrivals, and the aftershock forecast. | `event_id`, `include` | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_count_events` | Count earthquakes matching filters without fetching full records. Useful for "how many M5+ earthquakes happened in Japan this year?" queries. | same filters as `earthquake_search_events` minus `limit`/`offset`/`order_by` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `earthquake://feed/{magnitude_tier}/{time_window}` | First page (100 events) of a USGS real-time feed. | `next_uri` |
| `earthquake://feed/{magnitude_tier}/{time_window}/page/{cursor}` | Continue a retained feed generation. | Read `next_uri` verbatim |
| `earthquake://event/{event_id}` | One event by USGS or EMSC ID as injectable context, with the USGS `detail` projection; no `include`. | No |

### Prompts

None — this is a data-access server; no recurring interaction templates warrant prompt definitions.

---

## Overview

Provides LLM-accessible global seismic data via the USGS Earthquake Hazards Program API and EMSC (European-Mediterranean Seismological Centre). Two complementary access paths: pre-computed real-time feeds (fast, USGS-cached) for "what's happening now" queries, and the FDSN Event query API for historical range searches, location-radius queries, and magnitude filtering. Both are read-only, no auth required.

Target users: journalists checking recent activity, researchers analyzing seismic patterns, disaster preparedness agents, and anyone asking "was there just an earthquake near X?"

---

## Requirements

- Read-only. No write operations.
- No API keys required. Both USGS and EMSC APIs are public and auth-free.
- USGS source: `https://earthquake.usgs.gov/fdsnws/event/1/` (FDSN query) and `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/` (pre-computed feeds)
- EMSC source: `https://www.seismicportal.eu/fdsnws/event/1/` (independent global FDSN catalog)
- USGS feeds are the recommended path for current-state queries (better performance and availability). The FDSN query API supports up to 20,000 results per request.
- EMSC only supports `maxradius` in degrees, not `maxradiuskm`. Server converts km → degrees (1° ≈ 111.2 km) when routing to EMSC.
- USGS event IDs are network-specific strings that begin with letters (e.g. `hv74966427`, `us6000sznj`); EMSC IDs (unids) are the origin date, an underscore, and a seven-digit sequence (`20190706_0000043`). `earthquake_get_event` routes on that shape. Analysis products and `include` groups are USGS-hosted, so EMSC events carry neither.
- USGS `time` and `updated` fields are epoch-millisecond integers in the raw API — the service layer must convert to ISO 8601 strings before returning to callers.
- EMSC counts (`/count`) return only `{"count": N}` — no `maxAllowed` field. The server derives `exceeds_limit` by comparing against the known 20,000 cap.
- Rate limits: generous on both services; no explicit published limits observed. Space requests reasonably.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `UsgsService` | USGS FDSN event API, real-time GeoJSON feeds, and event product files | `earthquake_get_feed`, `earthquake_search_events` (USGS), `earthquake_get_event` (USGS IDs), `earthquake_count_events` (USGS) |
| `EmscService` | EMSC FDSN event API | `earthquake_search_events` (EMSC), `earthquake_get_event` (EMSC unids), `earthquake_count_events` (EMSC) |

These services are thin clients — shared HTTP retry logic, base URL, response parsing, and coordinate conversion. No shared state beyond base URL and retry configuration.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `USGS_BASE_URL` | No | Override USGS API base URL. Defaults to `https://earthquake.usgs.gov`. Useful for testing or mirroring; a mirror must also serve product files on its own origin (content URLs rewritten), or the `magnitudes`, `arrivals`, and `aftershock_forecast` groups report `fetch_failed`. |
| `EMSC_BASE_URL` | No | Override EMSC API base URL. Defaults to `https://www.seismicportal.eu`. |
| `DEFAULT_LIMIT` | No | Events `earthquake_search_events` returns when a call omits `limit`. Defaults to `15`; accepts 1–1,000. |
| `EARTHQUAKE_CLAMP_LIMITS` | No | `true` (default) clamps a search or feed `limit` above 1,000 to 1,000 with a notice and advertises no schema maximum; `false` advertises and enforces `maximum: 1000`. Parsed with `z.stringbool()`. |
| `REQUEST_TIMEOUT_MS` | No | Per-attempt HTTP timeout in milliseconds. Defaults to `10000`. Feed, search, and event calls also share a 50-second total deadline across every request and retry; standalone count calls use this per-attempt value. |

---

## Implementation Order

1. Config (`server-config.ts`) and shared HTTP utilities
2. `UsgsService` — feed fetcher + FDSN query client
3. `EmscService` — FDSN query client with degree-radius conversion
4. `earthquake_get_feed` tool (USGS feeds, no filters needed)
5. `earthquake_search_events` tool (FDSN query, both sources)
6. `earthquake_get_event` tool (USGS detail endpoint and product files; EMSC `eventid` lookup)
7. `earthquake_count_events` tool (USGS + EMSC count endpoints)
8. Resources (`earthquake://feed/...` and `earthquake://event/...`)

---

## Domain Mapping

Nouns and their operations across both data sources:

| Noun | USGS Operations | EMSC Operations |
|:-----|:----------------|:----------------|
| **Feed** (pre-computed) | list by tier+window (5 magnitude tiers × 4 windows = 20 feeds) | Not available |
| **Event** (seismic event) | query (FDSN), get by ID (detail endpoint), count | query (FDSN), get by ID (`eventid`), count |

USGS event detail via `?eventid=` returns an extended GeoJSON Feature with a `products` object containing DYFI felt-report data, ShakeMap, losspager, moment-tensor, origin, phase-data, and, on some events, `oaf` aftershock-forecast products. List queries return the compact Feature shape (no `products` block). EMSC `?eventid=` returns the same bare Feature a search returns, with no products.

---

## Workflow Analysis

### `earthquake_get_feed`

Single upstream call to a pre-computed GeoJSON URL:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /earthquakes/feed/v1.0/summary/{mag}_{window}.geojson` | Retrieve complete feed |

Feed URLs are deterministic: `{mag}` ∈ {`all`, `1.0`, `2.5`, `4.5`, `significant`}, `{window}` ∈ {`hour`, `day`, `week`, `month`}. USGS recommends these for real-time display — they're served from CDN with better availability than the query API. Feed counts range from ~0 (significant_hour) to ~10,000+ (all_month) so the tool must communicate when large feeds are returned.

### `earthquake_search_events`

One query and, when the page fills `limit`, a count lookup on the selected source:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /fdsnws/event/1/query?format=geojson&{filters}&limit={limit}` (USGS) or `?format=json&…` (EMSC) | Filtered event query |
| 2 | `GET /fdsnws/event/1/count?{filters}` | Full match count when the page fills `limit` |

USGS uses `format=geojson`; EMSC uses `format=json` (`format=geojson` returns HTTP 400 on EMSC). Both accept the shared time, magnitude, depth, and area filters. USGS supports `maxradiuskm` directly; EMSC accepts `maxradius` in degrees. The service layer selects the format and converts the radius. USGS-only filters (`minalertlevel`, `minsig`, `minfelt`, `eventtype`, `producttype`, `reviewstatus`) are omitted for EMSC and disclosed in `ignoredFilters`.

### `earthquake_get_event`

An ID matching `^\d{8}_\d{7}$` is an EMSC unid and goes to SeismicPortal; every other ID goes to USGS.

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | USGS `GET /fdsnws/event/1/query?eventid={id}&format=geojson`, or EMSC `GET /fdsnws/event/1/query?eventid={unid}&format=json` | The event; on USGS, with `products` populated |
| 2 | The preferred `phase-data` product's `quakeml.xml` | `magnitudes` and `arrivals`, when requested and the product exists |
| 3 | The `oaf` product's `forecast.json` | `aftershock_forecast`, when requested and the product exists |

Calls 2 and 3 are USGS-only and run concurrently after call 1; `origins` reads call 1's `origin` products and costs nothing. One 50-second deadline covers all three, retries included. EMSC answers an unknown or malformed unid with HTTP 204 and an empty body, which maps to `not_found`.

### `earthquake_count_events`

Single call per source:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /fdsnws/event/1/count?format=geojson&{filters}` (USGS) or `?format=json&{filters}` (EMSC) | Returns `{count, maxAllowed}` (USGS) or `{count}` (EMSC) |

USGS count endpoint returns `{"count": N, "maxAllowed": 20000}`. When count > maxAllowed, the response also includes `"error": "..."` — the service layer should detect this and set `exceeds_limit: true`, not treat the `error` field as a failure. EMSC count endpoint is the same FDSN spec but returns only `{"count": N}` — no `maxAllowed` field. Use this when the human asks "how many" without needing individual events.

---

## Tool Detail

### `earthquake_get_feed`

**Purpose:** Retrieve a USGS real-time pre-computed feed. These feeds are served from USGS CDN for current activity queries; upstream failures carry recovery guidance.

**Input schema:**
```ts
{
  magnitude_tier: z.enum(['all', '1.0', '2.5', '4.5', 'significant'])
    .default('2.5')
    .describe('Minimum magnitude threshold. "all" includes microseisms (M<1). "significant" is a curated USGS selection based on magnitude, felt reports, and PAGER impact estimates — not purely magnitude-based.'),
  time_window: z.enum(['hour', 'day', 'week', 'month'])
    .default('day')
    .describe('Time window. "hour" typically returns 0–10 events; "month" can exceed 10,000 for "all" tier. Prefer "hour" or "day" for real-time checks.'),
  limit: limitSchema((capRule) => `Events to return per page. Default 15; ${capRule}. Applies to the first page; later pages carry the page size inside the cursor and ignore limit, so set it on the first call.`),
  cursor: z.string().optional()
    .describe("Opaque token for the next page, taken verbatim from a previous call's nextCursor. Omit for the first page."),
}
```

**Output schema:**
```ts
{
  count: z.number().describe('Number of events returned in this page, not the whole feed.'),
  generated_at: z.string().describe('ISO 8601 UTC timestamp when this feed was generated by USGS.'),
  events: z.array(EarthquakeEventSchema).describe('Earthquake events for this page, newest first.'),
  feed_url: z.string().describe('Source feed URL.'),
}
```

**Enrichment:** `totalCount` (events in the whole feed), `truncated` and `nextCursor` (more events remain), and `notice` (a clamped `limit`, an empty feed or cursor position, or the next page). Each first read retains a serialized generation; continuations slice that generation without fetching again. Each page returns `limit` events (default 15), fewer only on the last page, and `nextCursor` advances by that count.

**Limits:** search and feed `limit` share one cap, 1,000, in [`limit-clamp.ts`](../src/mcp-server/tools/limit-clamp.ts). Under the default `EARTHQUAKE_CLAMP_LIMITS=true` the schema advertises `minimum: 1` and no `maximum`; a larger value returns 1,000 events, `notice` names the requested and applied values (joined with any paging sentence), the server logs the clamp, and `earthquake.limit.clamps` counts it. `EARTHQUAKE_CLAMP_LIMITS=false` advertises and enforces `maximum: 1000`, so a larger value fails as `invalid_arguments`. The field's description names the active mode and, on search, the configured `DEFAULT_LIMIT`; both are read from config lazily, after `createApp()` loads `.env`.

**Retention:** a private process-local store owns serialized bytes, with tenant/feed-scoped SHA-256 deduplication and random handles. Both indexes and metadata are charged with a minimum per-record allowance under a 32-MiB retained budget. Expiry is fixed at creation, up to 15 minutes; reuse does not extend it. New reads prune expired records then evict oldest-created records to stay available. Eviction, restart, expiry, and cross-tenant/feed cursor reuse return `cursor_expired`; malformed or legacy cursors return `invalid_cursor`. Oversized snapshots fail before eviction. Cancellation is checked immediately before admission. Fresh parsed response objects prevent caller mutation from changing a retained generation. The bound covers retained payload and charged metadata, not total heap or concurrent fetch/parse/page allocations. A shared capacity budget allows one tenant's traffic to evict another tenant's old generations; anonymous requests share the default tenant.

**Resource paging:** the original URI remains the first page. The separate `/page/{cursor}` template preserves bare-URI dispatch. Each resource page returns 100 events in the compact eight-field projection, plus `totalCount`, `truncated`, `nextCursor`, and `next_uri`. Cache hints are private with zero lifetime. Upstream `ServiceUnavailable` failures map to fresh `feed_unavailable` data; `Timeout` failures map to `feed_timeout`, without captured upstream bodies. Availability failures preserve numeric HTTP status and explicit non-retryability; HTTP 501 points to EMSC search. Other error classes and cancellation propagate unchanged.

**Error contract:**
```ts
errors: [
  { reason: 'feed_unavailable', code: ServiceUnavailable,
    when: 'USGS feed endpoint returns a 5xx, serves HTML, or is unreachable',
    recovery: 'Try a smaller time_window, or use earthquake_search_events as a fallback.' },
  { reason: 'feed_timeout', code: Timeout,
    when: 'USGS feed endpoint did not answer before the request deadline',
    recovery: 'Retry the call, or request a smaller time_window — the "month" and "all" feeds are the largest documents and the slowest to transfer.' },
]
```

---

### `earthquake_search_events`

**Purpose:** Search earthquakes by time range, magnitude, depth, location radius, or impact level. Both USGS and EMSC are global catalogs; USGS provides additional impact products. For location-based queries, provide `latitude`, `longitude`, and `radius_km` together.

Search and count normalize date-only bounds to midnight at the start of the named day on both providers (`2026-10-10` → `2026-10-10T00:00:00`). Year/year-month expansion and date padding happen first. Explicit time and timezone suffixes remain unchanged. The 30-day default interprets offsetless FDSN times as UTC and honors explicit offsets; query echoes contain the exact forwarded bounds.

Both tools reject strictly inverted magnitude, depth, and explicit time pairs before fetching, with `invalid_range`, both values, and recovery on both client surfaces. Time ordering compares normalized UTC instants. Equal/single bounds and calendar-invalid upstream errors retain their existing behavior.

Both tools accept `magnitude_type` (open string, sent as `magnitudetype`) on either source. `product_type` (open string, `producttype`) and `review_status` (`automatic`/`reviewed`, `reviewstatus`) are USGS-only. Blank values mean omitted. EMSC queries/counts omit unsupported values, name them in `ignoredFilters`, and echo only applied filters.

**Selected input fields:** The complete shared filter schema is in [`query-params.ts`](../src/mcp-server/tools/query-params.ts).
```ts
{
  start_time: z.string().optional()
    .describe('Start of time range as ISO 8601 (e.g. "2026-01-01" or "2026-05-23T00:00:00"). Defaults to 30 days before end_time (or before the current time) if omitted — applied server-side so USGS and EMSC honor the same window.'),
  end_time: z.string().optional()
    .describe('End of time range as ISO 8601. Defaults to current time if omitted.'),
  min_magnitude: z.number().min(-1).max(10).optional()
    .describe('Minimum magnitude (Richter or equivalent). M2.5+ is felt by some people; M5+ can cause damage; M7+ is major.'),
  max_magnitude: z.number().min(-1).max(10).optional()
    .describe('Maximum magnitude.'),
  latitude: z.number().min(-90).max(90).optional()
    .describe('Latitude for radius search. Requires longitude and radius_km.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Longitude for radius search. Requires latitude and radius_km.'),
  radius_km: z.number().min(0).max(20001.6).optional()
    .describe('Search radius in kilometers from the lat/lon point. 100 km covers a metro region; 500 km covers a large country. Converted to degrees for EMSC (1° ≈ 111.2 km).'),
  min_depth_km: z.number().min(-100).max(1000).optional()
    .describe('Minimum depth in kilometers. Shallow quakes (0–70 km) typically cause more surface damage than deep quakes (>300 km).'),
  max_depth_km: z.number().min(-100).max(1000).optional()
    .describe('Maximum depth in kilometers.'),
  alert_level: z.enum(['green', 'yellow', 'orange', 'red']).optional()
    .describe('Minimum PAGER alert level. PAGER estimates economic loss and casualties. "green" = minimal impact; "red" = extreme. Only available from USGS.'),
  min_felt: z.number().int().min(1).optional()
    .describe('Minimum number of DYFI (Did You Feel It?) reports. Use to find events with confirmed public impact. Only available from USGS.'),
  min_significance: z.number().int().optional()
    .describe('Minimum USGS significance score (0–2000+). Combines magnitude, felt reports, and PAGER estimates. Significant events typically score 600+. Only available from USGS.'),
  source: z.enum(['usgs', 'emsc']).default('usgs')
    .describe('USGS includes PAGER, DYFI and ShakeMap; EMSC (European-Mediterranean Seismological Centre) is an independent global catalog, with densest station coverage around Europe/Mediterranean and no such impact products. earthquake_get_event accepts IDs from either source.'),
  limit: limitSchema((capRule) => `Events to return per call. Default ${getServerConfig().defaultLimit}; ${capRule}. Combine with offset to retrieve match sets larger than one call can return.`),
  order_by: z.enum(['time', 'time-asc', 'magnitude', 'magnitude-asc']).default('time')
    .describe('Sort order. "time" returns newest first; "magnitude" returns largest first.'),
}
```

**Output schema:**
```ts
{
  count: z.number().describe('Number of events returned.'),
  source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
  events: z.array(EarthquakeEventSchema).describe('Matching earthquake events.'),
}
```

**Enrichment (both client surfaces):** `totalCount` is inferred as `offset - 1 + returned events` for nonempty short pages; an empty first page establishes zero, while an empty later page establishes no total. Full pages keep the count sub-call and `countUnavailable` on failure. `truncated`, `nextOffset`, and `notice` guide continuation; `queryEcho` contains effective defaults and applied filters only.

Each call sends the applied `limit` upstream and returns every event the page holds: exactly `limit`, fewer only on the last page. `nextOffset` is the input offset (default 1) plus the events returned, and `truncated` reflects the count alone. `queryEcho.limit` is the applied limit, after any clamp (see **Limits** under `earthquake_get_feed`). Search does not freeze the upstream catalog. Feed fetching and each search's query/count chain share a 50-second deadline across attempts and backoff. An optional count timeout preserves the page with `countUnavailable`; caller cancellation propagates.

**Error contract:**
```ts
errors: [
  { reason: 'invalid_range', code: ValidationError,
    when: 'Minimum magnitude or depth exceeds its maximum, or start_time is after end_time',
    recovery: 'Swap or correct the named bounds; equal and single bounds are accepted.' },
  { reason: 'invalid_radius', code: ValidationError,
    when: 'latitude or longitude provided without radius_km, or vice versa',
    recovery: 'Provide latitude, longitude, and radius_km together for a location-based search.' },
  { reason: 'invalid_bounding_box', code: ValidationError,
    when: 'min_latitude exceeds max_latitude, or min_longitude exceeds max_longitude',
    recovery: 'Swap the inverted pair so the minimum is not above the maximum.' },
  { reason: 'source_unavailable', code: ServiceUnavailable,
    when: 'Selected source API returns a 5xx or is unreachable',
    recovery: 'Try the other source (usgs or emsc) or retry after a short delay.' },
  { reason: 'source_timeout', code: Timeout,
    when: 'Selected source API did not answer before the request deadline',
    recovery: 'Narrow the time range, raise min_magnitude, or lower limit so the upstream query returns faster, then retry. Use earthquake_count_events first to size the match set.' },
  { reason: 'upstream_rejected', code: InvalidParams,
    when: 'The source API rejected the query parameters and explained why in its response body',
    recovery: 'Read the upstream reason in the error message, correct that parameter, and call again.' },
  { reason: 'upstream_rejected_no_reason', code: InvalidParams,
    when: 'The source API rejected the query but its response body carried no usable explanation',
    recovery: 'Re-check the supplied parameters, or retry with the other source.' },
]
```

---

### `earthquake_get_event`

**Purpose:** Fetch one earthquake by USGS event ID or EMSC unid. Returns the normalized event a search result carries. A USGS event adds a projection of the analysis products only the single-event response holds: PAGER alert and report link, ShakeMap peak intensity and ground motion, DYFI totals, the moment-tensor focal mechanism, ground-failure alerts, origin quality (including `depth_type`), and finite-fault dimensions. `include` opts into groups that read more of the event's products. Event IDs appear in feed and search results.

**Input schema:**
```ts
{
  event_id: z.string().trim().min(1)
    .describe('USGS event ID, e.g. "hv74966427" or "us6000sznj", or EMSC event ID, e.g. "20190706_0000043". Found in the "id" field of earthquake_get_feed and earthquake_search_events results.'),
  include: z.array(z.enum(['origins', 'magnitudes', 'arrivals', 'aftershock_forecast'])).optional()
    .describe('Optional groups: origins (every contributed origin solution, no extra request), magnitudes and arrivals (one shared phase-data download; every arrival of the preferred origin, nearest first), aftershock_forecast (one extra request). Omit for the default response.'),
}
```

**Output schema:**
```ts
{
  event: EarthquakeEventSchema,        // the normalized event a search result carries
  detail: EarthquakeDetailSchema.optional(), // USGS analysis-product projection; absent when no projected field is available, and for EMSC
  origins: z.array(EventOriginSchema).optional(),       // one per `origin` product, preferred first
  magnitudes: z.array(EventMagnitudeSchema).optional(), // event-level magnitudes from the preferred phase-data QuakeML, document order
  arrivals: z.array(EventArrivalSchema).optional(),     // the QuakeML's preferred origin's arrivals joined to their picks, nearest first
  aftershock_forecast: AftershockForecastSchema.optional(), // every `oaf` forecast.json window and magnitude bin, upstream order
  unavailable_includes: z.array(UnavailableIncludeSchema).optional(), // requested groups not returned: not_published | fetch_failed
}
```

**Routing:** an `event_id` matching `^\d{8}_\d{7}$` is an EMSC unid. It is fetched from SeismicPortal, normalized by the same function EMSC search uses, and returned without `detail`; every requested `include` group is listed as `not_published` and no USGS request is made. Every other ID goes to USGS. Canonical IDs and aliases match case-insensitively; an alias returns the preferred event, whose `associated_ids` lists the alias. Event resource URI parameters decode once before validation, and the resource routes the same way but takes no `include`.

**Include groups (USGS):** `origins` projects every `origin` product's properties from the response already fetched, so it costs no request. `magnitudes` and `arrivals` share one download of the preferred `phase-data` product's `quakeml.xml`, parsed with `fast-xml-parser` (attributes kept, namespace prefixes removed, values left as strings, entities unexpanded). `magnitudes` lists the document's event-level magnitudes in document order, summarizing station magnitudes as `station_count`. `arrivals` returns every arrival of the document's `preferredOriginID` origin, joined to its pick and sorted by `distance_deg` ascending; a pick time published without a UTC offset is read as UTC and emitted with `Z`. `aftershock_forecast` downloads the `oaf` product's `forecast.json` and projects every window and bin in upstream order, with epoch-ms times as ISO 8601; it runs concurrently with the phase-data download. Sparse upstream fields stay absent, never defaulted. A group whose product the event lacks is `not_published` with no request. A download that fails, returns non-2xx (a redirect included; it is never followed) or HTML, does not parse, or has a content URL off the configured USGS origin lists its groups as `fetch_failed`; the event, `detail`, and the other groups still return, and cancellation propagates. One 50-second deadline covers the event request and every product request, retries included; a product request that cannot finish in the remainder degrades its groups to `fetch_failed`.

ShakeMap exposes optional `code_version`; PGV is converted from logarithmic values only for producer `4.0.2+335.gcbad862` and its `.dirty` variant, with unrepresentable converted values omitted.

**Error contract:**
```ts
errors: [
  { reason: 'event_deleted', code: NotFound, retryable: false,
    when: 'USGS reports that the requested event was deleted',
    recovery: 'Search earthquake_search_events around the same time and location for a possible replacement event.' },
  { reason: 'not_found', code: NotFound,
    when: 'No USGS or EMSC event matches the provided event_id',
    recovery: 'Verify the event ID from a feed or search result. USGS IDs are network-specific strings like "us6000sznj" or "hv74966427"; EMSC IDs are an origin date and seven-digit sequence like "20190706_0000043".' },
  { reason: 'source_unavailable', code: ServiceUnavailable,
    when: 'The USGS or EMSC event API returns a 5xx, serves HTML, or is unreachable',
    recovery: 'Retry after a short delay. The same event also appears in earthquake_search_events results (source=emsc for an EMSC ID), and a recent USGS event in earthquake_get_feed results, which carry the normalized record without the products.' },
  { reason: 'source_timeout', code: Timeout,
    when: 'The USGS or EMSC event API did not answer before the request deadline',
    recovery: 'Retry the same event ID — a single-event lookup carries no filters to reduce. If it keeps timing out, read the event from an earthquake_search_events result (source=emsc for an EMSC ID).' },
]
```

---

### `earthquake_count_events`

**Purpose:** Count earthquakes matching filters without fetching full records. Use for statistical queries ("how many M5+ earthquakes in 2025?") or to gauge result size before calling `earthquake_search_events`.

**Input schema:** Same filters as `earthquake_search_events`, without `limit`, `offset`, or `order_by`.

**Output schema:**
```ts
{
  count: z.number().describe('Number of events matching the query.'),
  max_allowed: z.number().nullable().describe('Single-request threshold: 20000 for USGS; null because EMSC count omits it. Offset paging can retrieve larger sets.'),
  source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
  exceeds_limit: z.boolean().describe('Count exceeds the single-request threshold (20000 for EMSC). Use search offset paging or narrower filters.'),
}
```

---

## Shared Schema: `EarthquakeEventSchema`

Selected fields returned by feeds and search results; the complete schema is in [`schemas.ts`](../src/mcp-server/tools/schemas.ts). The service layer normalizes USGS `mag`→`magnitude`, `magType`→`magnitude_type`, and `sig`→`significance`; USGS `time`/`updated` are epoch-millisecond integers converted to ISO 8601. Longitude and latitude come from `geometry.coordinates[0]` and `[1]`, respectively. Depth comes from `geometry.coordinates[2]` (USGS) or `properties.depth` (EMSC), in kilometers. EMSC maps `flynn_region`→`place`, `magtype`→`magnitude_type`, and `unid`→`id`.

```ts
{
  id: z.string().describe('USGS or EMSC event identifier.'),
  title: z.string().describe('Human-readable event summary, e.g. "M 6.0 - 13 km S of Honaunau-Napoopoo, Hawaii". Derived from properties.title (USGS) or constructed from magnitude and flynn_region (EMSC).'),
  magnitude: z.number().nullable().describe('Preferred magnitude value. Mapped from API field "mag". Null when no magnitude was computed for the event (the title renders it as "M ?").'),
  magnitude_type: z.string().describe('Magnitude type (ml, mww, mw, mb, etc.). Mapped from API field "magType" (USGS) or "magtype" (EMSC).'),
  time: z.string().describe('ISO 8601 UTC origin time. Converted from epoch-millisecond integer in USGS responses.'),
  updated: z.string().describe('ISO 8601 UTC time this record was last updated. Converted from epoch-millisecond integer in USGS responses; mapped from "lastupdate" in EMSC responses.'),
  place: z.string().describe('Nearest named location. Mapped from "place" (USGS) or "flynn_region" (EMSC).'),
  latitude: z.number().describe('Epicenter latitude in decimal degrees. Extracted from geometry.coordinates[1] (USGS) or properties.lat (EMSC).'),
  longitude: z.number().describe('Epicenter longitude in decimal degrees. Extracted from geometry.coordinates[0] (USGS) or properties.lon (EMSC).'),
  depth_km: z.number().nullable().describe('Hypocenter depth in kilometers. Extracted from geometry.coordinates[2] (USGS, positive = depth) or properties.depth (EMSC, positive km). Shallow (<70 km), intermediate (70–300 km), or deep (>300 km). Null for events where depth was not measured.'),
  felt: z.number().nullable().describe('Number of DYFI (Did You Feel It?) responses. Null if no reports. USGS only.'),
  cdi: z.number().nullable().describe('Maximum reported intensity (Community Decimal Intensity, 0–12 scale). USGS only.'),
  mmi: z.number().nullable().describe('Maximum ShakeMap instrumental intensity (Modified Mercalli, 0–12 scale). USGS only.'),
  alert: z.enum(['green', 'yellow', 'orange', 'red']).nullable().describe('PAGER estimated impact alert level. Null if not computed. USGS only.'),
  tsunami: z.number().nullable().describe('USGS tsunami flag; null for EMSC. Check tsunami.gov for warning status.'),
  significance: z.number().nullable().describe('USGS significance score (0–2000+). Combines magnitude, felt reports, PAGER. Mapped from API field "sig". USGS only.'),
  status: z.enum(['automatic', 'reviewed', 'deleted']).nullable().describe('Review status; null for EMSC. Automatic detections may be revised.'),
  event_url: z.string().optional().describe('USGS event page URL for full human-readable detail. Present for USGS events only.'),
  detail_url: z.string().optional().describe('URL to fetch the full GeoJSON detail record. Present in USGS list responses.'),
  associated_ids: z.array(z.string()).optional().describe('Other network IDs USGS lists for this event, in upstream order; earthquake_get_event accepts them. Absent when USGS lists none, and for EMSC events.'),
}
```

`associated_ids` comes from the comma-wrapped USGS `properties.ids` (`,ci38457511,us70004bn0,`), minus the event's own `id`, and appears on USGS events from feeds, searches, and lookups alike.

---

## Design Decisions

**Why two tools for feeds vs. search?**
USGS real-time feeds are pre-computed, CDN-served, and have better availability than the query API. The design exposes them as a distinct, lower-latency tool with no filter overhead. When an agent asks "any major earthquakes today?", `earthquake_get_feed` with `significant_day` is faster and more reliable than a `earthquake_search_events` with a 24h time window. The USGS docs explicitly recommend feeds for real-time display use cases.

**Why `earthquake_count_events` as a separate tool?**
The USGS count endpoint returns `{count, maxAllowed}` with no event data — it's a cheap probe. Agents asking statistical questions ("how many M4+ earthquakes in California last year?") shouldn't pay for 20,000-record responses. Count also surfaces the `exceeds_limit` condition cleanly, letting the agent decide whether to narrow before fetching.

**Why EMSC as an alternative source instead of a separate tool?**
Both catalogs use FDSN query parameters. A `source` enum lets callers switch catalogs through the same tool; each adapter handles provider differences, including degree-radius conversion and unsupported filters. EMSC provides an independent global solution for cross-verification.

**EMSC has no `maxradiuskm`.**
USGS supports `maxradiuskm`; EMSC only supports `maxradius` in degrees. The `radius_km` input is always specified in km (more intuitive), and the service layer converts: `degrees = km / 111.2`. This conversion is approximate (Earth isn't a perfect sphere) but well within the precision that matters for seismic queries.

**USGS-only filters omitted for EMSC.**
USGS-specific filters (`alert_level`, `event_type`, `min_felt`, `min_significance`, `product_type`, `review_status`) are not forwarded when `source=emsc`. `ignoredFilters` names each supplied filter that did not constrain the result, and `queryEcho` omits it. `magnitude_type` applies to both sources.

**Significance score vs. alert level vs. felt reports.**
These three metadata fields measure impact from different angles: significance is a USGS composite score, alert level is PAGER's economic/casualty estimate, felt reports count public responses. All three are exposed as optional search filters because they serve different query patterns. Journalists want alert level; researchers might filter on significance; local impact queries use felt reports.

**`earthquake_get_event` routes by ID shape.**
An `id` from an EMSC search must close the cross-checking loop `source=emsc` exists for, so the lookup accepts EMSC unids as well as USGS IDs. The two grammars are disjoint — USGS IDs begin with letters, and USGS answers an EMSC unid with 404 — so the ID's shape picks the catalog, with no `source` input. EMSC publishes no analysis products, so an EMSC event returns without `detail` or `include` groups. On USGS, `associated_ids` exposes the other network IDs merged into the event, so an alias that resolves to a different canonical `id` stays traceable.

**`include` groups are opt-in on the tool only.**
Phase arrivals, alternative origins, magnitude solutions, and the aftershock forecast belong to one event record, so they extend `earthquake_get_event` rather than adding tools. Three of the four groups cost a product download, and most events have no aftershock forecast, so nothing is fetched unless requested. The event resource takes no `include`: a URI addresses the event, and the extra requests stay where a caller asks for them.

**Resources are supplementary.**
Feed and event resources are added for clients that support injectable context (e.g., Claude Desktop resource panel), but the tool surface is self-sufficient. A tool-only agent can do everything.

**No tsunami-detail tool.**
The server returns the USGS `tsunami` flag, with null for EMSC. Warning status must be checked at [tsunami.gov](https://www.tsunami.gov/); wave heights, travel times, and warning products are outside this server's surface.

---

## Known Limitations

- **Single-request threshold.** USGS and EMSC limit each upstream page to 20,000 events. Search returns at most 1,000 events per call and continues with `nextOffset`, including beyond 20,000 matches. `exceeds_limit` describes the request threshold, not a retrieval ceiling.
- **EMSC lacks USGS enrichment.** No PAGER alert, DYFI felt reports, or ShakeMap MMI from EMSC queries, and no `detail` or `include` groups on an EMSC event lookup. EMSC arrivals and alternative solutions live behind separate SeismicPortal endpoints this server does not call. Both catalogs are global and can report different solutions for the same event.
- **Automatic detections may be revised.** Events with `status: automatic` are preliminary — magnitude, location, and even existence may change. Reviewed events are more reliable.
- **Depth can be fixed artificially.** When depth is poorly constrained, USGS may report a fixed depth (typically 10 km or 33 km). These are conventional values, not measured. `depth_type` on `detail.origin` and on each `origins` entry carries the published depth type (e.g. `operator assigned`), which separates an assigned depth from a located one.
- **Superseded solutions are not returned.** `origins` lists each origin product USGS currently holds, not earlier versions of one network's solution.
- **EMSC coordinate conversion is approximate.** Degree-to-km conversion uses 1° = 111.2 km (mean Earth circumference). This is accurate to within ~0.5% globally.
- **Feeds are snapshots.** [USGS updates its summary feeds every minute](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). Continuations retain the first-read generation; start a new feed request to read a newer generation.

---

## API Reference

### USGS FDSN Event API

- Base: `https://earthquake.usgs.gov/fdsnws/event/1/`
- Methods: `query`, `count`, `catalogs`, `contributors`, `version`
- Format: `geojson` (used throughout), also `csv`, `xml`, `text`
- Default time range: last 30 days if no `starttime`/`endtime` specified
- Limit: 1–20,000 events per query
- Default order: `time` (newest first)
- Circle search requires all three of `latitude`, `longitude`, `maxradiuskm` (or `maxradius` in degrees)
- `eventid` query returns a single Feature with a `products` block (DYFI, ShakeMap, losspager, moment-tensor, focal-mechanism, origin, phase-data, and `oaf` where published). Classify HTTP 404 as `not_found` and HTTP 409 as `event_deleted` from status, without parsing body text. An alias ID returns the canonical Feature; `properties.ids` lists every ID merged into it.
- Product content files are linked from `products.<type>[].contents.<file>.url`. The `include` groups read the preferred `phase-data` product's `quakeml.xml` (QuakeML: event magnitudes, origins, arrivals, picks) and the `oaf` product's `forecast.json`. Only URLs on the configured base URL's origin are requested.
- Empty results: returns GeoJSON FeatureCollection with `count: 0` and `features: []` at HTTP 200 (not 404) by default; pass `nodata=404` to get HTTP 404 on empty results instead — do NOT set this, let the service layer detect `features.length === 0`
- Error format: plain text `Error {code}: {reason}\n\n{detail}` for all client errors (4xx). Parse by HTTP status, not response body.

### USGS Real-time Feeds

- Base: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/`
- Pattern: `{magnitude_tier}_{time_window}.geojson`
- Magnitude tiers: `all`, `1.0`, `2.5`, `4.5`, `significant`
- Time windows: `hour`, `day`, `week`, `month`
- Representative counts (2026-05-23): significant_month≈8, 2.5_week≈331, all_day≈260, all_month≈10,000+
- Metadata includes `generated` (ms epoch), `count`, `api` version, and source `url`

### EMSC SeismicPortal FDSN API

- Base: `https://www.seismicportal.eu/fdsnws/event/1/`
- Format: `json` (not `geojson` — EMSC returns HTTP 400 "unknown format requested" for `format=geojson`)
- Supports same FDSN parameters as USGS with exceptions:
  - No `maxradiuskm` — use `maxradius` in degrees only
  - No `alertlevel`/`minalertlevel`, `minfelt`, `minsig`, `eventtype`, `producttype`, or `reviewstatus` parameters
  - No `detail` per-event URL with products block
- `eventid={unid}&format=json` returns a bare `Feature` (no collection wrapper) identical to the search result's. An unknown or malformed unid returns HTTP 204 with an empty body; `nodata=404` is never sent, because its 404 body echoes an internal host.
- Response shape differs from USGS: properties use `lat`/`lon`/`depth` (lat/lon also duplicated in `geometry.coordinates`), `flynn_region` instead of `place`, `magtype` (lowercase) instead of `magType`, `unid` as primary ID, no `url`/`detail`/`felt`/`cdi`/`mmi`/`alert`/`tsunami`/`sig` fields
- Count endpoint returns `{"count": N}` only — no `maxAllowed` field
- No default time window — omitting `starttime` queries the entire catalog (~27 years), unlike USGS's 30-day default. The server always sends an explicit `starttime` so both sources honor the documented 30-day window.
- Limit: 20,000 events per query (increased from 5,000 in 2023)

### Magnitude Types Reference

| Code | Scale | Notes |
|:-----|:------|:------|
| `ml` | Local magnitude | Short-period instruments; common for small regional events |
| `mw` / `mww` | Moment magnitude | Preferred for large events; physically meaningful |
| `mb` | Body-wave magnitude | Teleseismic P-waves; tends to saturate above M6 |
| `ms` | Surface-wave magnitude | Long-period surface waves; saturates above M8 |
| `mwr` | Regional moment magnitude | Waveform inversion, regional distances |

---

## Decisions Log

| Date | Decision | Rationale |
|:-----|:---------|:----------|
| 2026-05-23 | Two-service design (USGS + EMSC) vs. USGS-only | EMSC probed successfully — JSON format, same FDSN parameters (minus `maxradiuskm`), live events returned. Adds European coverage and independent verification. Cost: one degree-conversion, minor output normalization. Worth it. |
| 2026-05-23 | `earthquake_get_feed` as a distinct tool from `earthquake_search_events` | USGS explicitly recommends feeds for real-time display. Feeds are CDN-served, faster, and more available than the query API. Different enough in access pattern to warrant a separate tool rather than a `mode` parameter. |
| 2026-05-23 | `earthquake_count_events` as a separate tool | USGS count endpoint is cheap and returns `maxAllowed` — surfacing the truncation risk cleanly is only possible as a distinct call. Statistical queries shouldn't be forced through a full fetch. |
| 2026-05-23 | No EMSC-specific tool; `source` enum on `earthquake_search_events` instead | EMSC speaks the same FDSN spec. A parallel tool would duplicate the entire parameter set for one API difference (degree radius). The `source` enum is simpler and keeps the surface tight. |
| 2026-05-23 | `radius_km` input for both sources, converted to degrees for EMSC | "km" is universally more intuitive than degrees for location queries. The server absorbs the conversion complexity (1° ≈ 111.2 km). Agents shouldn't know or care about the EMSC coordinate system limitation. |
| 2026-05-23 | No resources for search results | Feeds and individual events have stable URIs; search results do not (they're parameterized queries). Resources cover addressable entities only. |
| 2026-05-23 | No prompts | Pure data-access server. No recurring multi-step interaction patterns that a prompt template would structure. |
| 2026-05-23 | `earthquake_get_event` USGS-only | The implemented lookup projects USGS analysis products. EMSC per-ID lookup is a separate capability not currently exposed by this tool. Superseded by the 2026-10-28 ID-routing decision. |
| 2026-05-23 | Expose `significance`, `cdi`, `mmi`, `felt` in event schema | These fields appear directly in USGS list responses (not just event detail). They're what distinguishes the USGS feed from a generic seismograph — the "did anyone feel this?" and "how bad could it get?" signals that serve journalists and public safety use cases. |
| 2026-10-28 | One clamped count cap (1,000) on search and feed `limit`, replacing the 24,000-byte page budget | Cutting each page to a byte budget returned fewer events than `limit`, so a caller stepping `offset` by `limit` skipped events, and search fetched at most 100 candidates whatever `limit` asked for. A count cap returns exactly `limit` events. A larger value clamps with a notice instead of failing, and the schema advertises no `maximum`, so it never names a ceiling the tool does not serve. `EARTHQUAKE_CLAMP_LIMITS=false` restores a strict `maximum: 1000`. The cap sits below USGS's 20,000 per request because 1,000 full events already serialize to about 1.2 MB. Feed resources keep a fixed 100-event page. |
| 2026-10-28 | `origins` from `origin` products, not from the phase-data QuakeML | Every contributed origin product's properties are already in the event response, so the group costs no request and lists one solution per origin product, preferred first. The QuakeML is downloaded only for `magnitudes` and `arrivals`. |
| 2026-10-28 | `arrivals`: the preferred origin's only, uncapped, nearest first | The phase-data document can carry several origins, each with its own arrival set; `preferredOriginID` names the one the catalog solution used. A cap without continuation would leave the rest unreachable, and the group is opt-in. Sorting by epicentral distance reads the nearest stations first. |
| 2026-10-28 | The event resource takes no `include` | A resource URI addresses an event, not a query. The groups that cost product downloads stay on the tool, where a caller opts in per call. |
| 2026-10-28 | One 50-second deadline per event call | MCP SDK clients time out after 60 seconds by default. Per-attempt timeouts multiplied by retries, or a fresh deadline per chained request, can run past that, so one deadline covers the event request, every product request, and every retry. A product request that cannot finish in what remains degrades its groups to `fetch_failed`. |
| 2026-10-28 | Product content URLs requested only on the configured USGS origin, redirects not followed | Content URLs come from the upstream response. A link naming any origin other than `USGS_BASE_URL`'s is not requested, and its groups degrade to `fetch_failed`. A same-origin URL could still redirect elsewhere, so product requests use `redirect: 'manual'` and any 3xx fails the download the same way; USGS serves `quakeml.xml` and `forecast.json` with a direct 200, so no real product needs a hop. |
| 2026-10-28 | `earthquake_get_event` routes EMSC unids by ID shape | `^\d{8}_\d{7}$` IDs go to SeismicPortal's `eventid` query; everything else goes to USGS. The grammars are disjoint (USGS IDs begin with letters, and USGS answers an EMSC unid with 404), so no `source` input is needed, and an `id` from a `source=emsc` search can be looked up. A separate match tool was rejected: by-ID lookup belongs on this tool. |
| 2026-10-28 | SeismicPortal EventID cross-catalog matching left out | Its matches are heuristic (a misfit tuned for M4.5+), each call queries up to five FDSN services live, and most matches name catalogs (INGV, GFZ, ISC) no tool here can fetch. `associated_ids` covers the USGS side: the network IDs USGS already merged into one event. |
