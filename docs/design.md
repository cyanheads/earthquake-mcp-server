# earthquake-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `earthquake_get_feed` | Fetch a USGS real-time pre-computed feed by magnitude tier and time window. Fast, cached, low-latency. | `magnitude_tier` (all/1.0/2.5/4.5/significant), `time_window` (hour/day/week/month) | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_search` | Query earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports. Supports both USGS and EMSC sources. | `start_time`, `end_time`, `min_magnitude`, `latitude`+`longitude`+`radius_km`, `source`, `limit`, `order_by` | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_get_event` | Fetch full detail for a specific earthquake by USGS event ID, including felt reports, ShakeMap intensity, PAGER alert, and product links. | `event_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `earthquake_count` | Count earthquakes matching filters without fetching full records. Useful for "how many M5+ earthquakes happened in Japan this year?" queries. | same filters as `earthquake_search` minus `limit`/`order_by` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `earthquake://feed/{magnitude_tier}/{time_window}` | Direct access to a USGS real-time feed as injectable context. | No — feeds are complete summaries |
| `earthquake://event/{event_id}` | Full event detail by ID as injectable context. | No |

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
- EMSC source: `https://www.seismicportal.eu/fdsnws/event/1/` (same FDSN spec, European-centric data)
- USGS feeds are the recommended path for current-state queries (better performance and availability). The FDSN query API supports up to 20,000 results per request.
- EMSC only supports `maxradius` in degrees, not `maxradiuskm`. Server converts km → degrees (1° ≈ 111.2 km) when routing to EMSC.
- USGS event IDs are network-specific strings (e.g. `hv74966427`, `us6000sznj`); `earthquake_get_event` is USGS-only since detail endpoints are USGS-hosted.
- USGS `time` and `updated` fields are epoch-millisecond integers in the raw API — the service layer must convert to ISO 8601 strings before returning to callers.
- EMSC counts (`/count`) return only `{"count": N}` — no `maxAllowed` field. The server derives `exceeds_limit` by comparing against the known 20,000 cap.
- Rate limits: generous on both services; no explicit published limits observed. Space requests reasonably.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `UsgsService` | USGS FDSN event API + real-time GeoJSON feeds | `earthquake_get_feed`, `earthquake_search` (USGS), `earthquake_get_event`, `earthquake_count` (USGS) |
| `EmscService` | EMSC FDSN event API | `earthquake_search` (EMSC), `earthquake_count` (EMSC) |

These services are thin clients — shared HTTP retry logic, base URL, response parsing, and coordinate conversion. No shared state beyond base URL and retry configuration.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `USGS_BASE_URL` | No | Override USGS API base URL. Defaults to `https://earthquake.usgs.gov`. Useful for testing or mirroring. |
| `EMSC_BASE_URL` | No | Override EMSC API base URL. Defaults to `https://www.seismicportal.eu`. |
| `DEFAULT_LIMIT` | No | Default result limit for `earthquake_search`. Defaults to `100`. Max `20000`. |
| `REQUEST_TIMEOUT_MS` | No | HTTP timeout in milliseconds. Defaults to `10000`. |

---

## Implementation Order

1. Config (`server-config.ts`) and shared HTTP utilities
2. `UsgsService` — feed fetcher + FDSN query client
3. `EmscService` — FDSN query client with degree-radius conversion
4. `earthquake_get_feed` tool (USGS feeds, no filters needed)
5. `earthquake_search` tool (FDSN query, both sources)
6. `earthquake_get_event` tool (USGS detail endpoint)
7. `earthquake_count` tool (USGS + EMSC count endpoints)
8. Resources (`earthquake://feed/...` and `earthquake://event/...`)

---

## Domain Mapping

Nouns and their operations across both data sources:

| Noun | USGS Operations | EMSC Operations |
|:-----|:----------------|:----------------|
| **Feed** (pre-computed) | list by tier+window (5 magnitude tiers × 4 windows = 20 feeds) | Not available |
| **Event** (seismic event) | query (FDSN), get by ID (detail endpoint), count | query (FDSN), count |

USGS event detail via `?eventid=` returns an extended GeoJSON Feature with a `products` object containing DYFI felt-report data, ShakeMap, losspager, moment-tensor, and focal-mechanism products. List queries return the compact Feature shape (no `products` block).

---

## Workflow Analysis

### `earthquake_get_feed`

Single upstream call to a pre-computed GeoJSON URL:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /earthquakes/feed/v1.0/summary/{mag}_{window}.geojson` | Retrieve complete feed |

Feed URLs are deterministic: `{mag}` ∈ {`all`, `1.0`, `2.5`, `4.5`, `significant`}, `{window}` ∈ {`hour`, `day`, `week`, `month`}. USGS recommends these for real-time display — they're served from CDN with better availability than the query API. Feed counts range from ~0 (significant_hour) to ~10,000+ (all_month) so the tool must communicate when large feeds are returned.

### `earthquake_search`

One upstream call (USGS or EMSC, per `source` param):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /fdsnws/event/1/query?format=geojson&{filters}` (USGS) or `?format=json&{filters}` (EMSC) | Filtered event query |

USGS uses `format=geojson`; EMSC uses `format=json` (`format=geojson` returns HTTP 400 on EMSC). Both USGS and EMSC support the same FDSN parameter set with one exception: USGS supports `maxradiuskm` directly; EMSC only accepts `maxradius` in degrees. Service layer handles format selection and conversion transparently. EMSC also lacks USGS-specific extensions (`alertlevel`, `sig`, `minfelt`, `reviewstatus`).

### `earthquake_get_event`

One upstream call to USGS only (EMSC has no per-ID detail endpoint):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /fdsnws/event/1/query?eventid={id}&format=geojson` | Full event detail with products |

The `eventid` query returns a single Feature with `products` populated. USGS recommends using the `detail` URL from feed responses when available — that URL is the same endpoint with the same eventid param.

### `earthquake_count`

Single call per source:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /fdsnws/event/1/count?format=geojson&{filters}` | Returns `{count, maxAllowed}` |

USGS count endpoint returns `{"count": N, "maxAllowed": 20000}`. When count > maxAllowed, the response also includes `"error": "..."` — the service layer should detect this and set `exceeds_limit: true`, not treat the `error` field as a failure. EMSC count endpoint is the same FDSN spec but returns only `{"count": N}` — no `maxAllowed` field. Use this when the human asks "how many" without needing individual events.

---

## Tool Detail

### `earthquake_get_feed`

**Purpose:** Retrieve a USGS real-time pre-computed feed. These feeds are the fastest path to current earthquake data — served from USGS CDN with guaranteed availability. Use for "what's happened recently" queries before reaching for the full query API.

**Input schema:**
```ts
{
  magnitude_tier: z.enum(['all', '1.0', '2.5', '4.5', 'significant'])
    .default('2.5')
    .describe('Minimum magnitude threshold. "all" includes microseisms (M<1). "significant" is a curated USGS selection based on magnitude, felt reports, and PAGER impact estimates — not purely magnitude-based.'),
  time_window: z.enum(['hour', 'day', 'week', 'month'])
    .default('day')
    .describe('Time window. "hour" typically returns 0–10 events; "month" can exceed 10,000 for "all" tier. Prefer "hour" or "day" for real-time checks.'),
}
```

**Output schema:**
```ts
{
  count: z.number().describe('Number of events in the feed.'),
  generated_at: z.string().describe('ISO 8601 UTC timestamp when this feed was generated by USGS.'),
  events: z.array(EarthquakeEventSchema).describe('Earthquake events, newest first.'),
  feed_url: z.string().describe('Source feed URL.'),
}
```

**Error contract:**
```ts
errors: [
  { reason: 'feed_unavailable', code: ServiceUnavailable,
    when: 'USGS feed endpoint returns non-2xx or times out',
    recovery: 'Try a smaller time_window or use earthquake_search as a fallback.' },
]
```

---

### `earthquake_search`

**Purpose:** Search earthquakes by time range, magnitude, depth, location radius, or impact level. Supports both USGS (global, richer metadata) and EMSC (European-Mediterranean focus, independent catalog). For location-based queries, provide `latitude`, `longitude`, and `radius_km` together.

**Input schema:**
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
  radius_km: z.number().min(0).max(20002).optional()
    .describe('Search radius in kilometers from the lat/lon point. 100 km covers a metro region; 500 km covers a large country. Converted to degrees for EMSC (1° ≈ 111.2 km).'),
  min_depth_km: z.number().optional()
    .describe('Minimum depth in kilometers. Shallow quakes (0–70 km) typically cause more surface damage than deep quakes (>300 km).'),
  max_depth_km: z.number().optional()
    .describe('Maximum depth in kilometers.'),
  alert_level: z.enum(['green', 'yellow', 'orange', 'red']).optional()
    .describe('Minimum PAGER alert level. PAGER estimates economic loss and casualties. "green" = minimal impact; "red" = extreme. Only available from USGS.'),
  min_felt: z.number().int().min(1).optional()
    .describe('Minimum number of DYFI (Did You Feel It?) reports. Use to find events with confirmed public impact. Only available from USGS.'),
  min_significance: z.number().int().optional()
    .describe('Minimum USGS significance score (0–2000+). Combines magnitude, felt reports, and PAGER estimates. Significant events typically score 600+. Only available from USGS.'),
  source: z.enum(['usgs', 'emsc']).default('usgs')
    .describe('Data source. "usgs" covers global events with PAGER, DYFI, and ShakeMap metadata. "emsc" covers the European-Mediterranean region with an independent catalog — useful for cross-verification or European-focused queries.'),
  limit: z.number().int().min(1).max(20000).default(100)
    .describe('Maximum events to return. Default 100. Large limits (>1000) may result in slow responses.'),
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

**Enrichment (success-path meta, reaches both `structuredContent` and `content[]`):** `totalCount` (full match total, fetched via a follow-up FDSN count sub-call when results are truncated at the limit), `countUnavailable` (that sub-call failed, so the total is unknown rather than never requested), `truncated`, `notice` (recovery guidance for empty or capped result sets), and `queryEcho` (effective upstream parameters including the server-resolved start_time default; USGS-only filters omitted for source=emsc).

**Error contract:**
```ts
errors: [
  { reason: 'query_too_broad', code: InvalidParams,
    when: 'Query would match more than 20,000 events — USGS returns HTTP 400 with plain-text body starting "Error 400: Bad Request\\n\\n{count} matching events exceeds search limit of 20000."',
    recovery: 'Narrow the time range, raise min_magnitude, or add a location radius filter. Use earthquake_count first to gauge result size.' },
  { reason: 'invalid_radius', code: InvalidParams,
    when: 'latitude or longitude provided without radius_km, or vice versa',
    recovery: 'Provide latitude, longitude, and radius_km together.' },
  { reason: 'source_unavailable', code: ServiceUnavailable,
    when: 'Selected source API returns non-2xx or times out',
    recovery: 'Try the other source (usgs or emsc) or retry after a short delay.' },
]
```

---

### `earthquake_get_event`

**Purpose:** Fetch complete detail for a specific earthquake by USGS event ID. Returns the full property set including felt reports count (DYFI), ShakeMap maximum intensity (MMI), PAGER alert level, tsunami flag, and magnitude type. Event IDs appear in feed and search results.

**Input schema:**
```ts
{
  event_id: z.string()
    .describe('USGS event ID (e.g. "hv74966427" or "us6000sznj"). Found in the "id" field of feed and search results.'),
}
```

**Output schema:**
```ts
{
  event: EarthquakeEventDetailSchema,  // full property set including product metadata
}
```

**Error contract:**
```ts
errors: [
  { reason: 'not_found', code: NotFound,
    when: 'No event matches the provided event_id',
    recovery: 'Verify the event ID from a feed or search result. IDs are network-specific strings like "us6000sznj" or "hv74966427".' },
]
```

---

### `earthquake_count`

**Purpose:** Count earthquakes matching filters without fetching full records. Use for statistical queries ("how many M5+ earthquakes in 2025?") or to gauge result size before calling `earthquake_search`.

**Input schema:** Same as `earthquake_search` minus `limit` and `order_by`.

**Output schema:**
```ts
{
  count: z.number().describe('Number of events matching the query.'),
  max_allowed: z.number().nullable().describe('Maximum events the API would return for a full fetch. 20000 for USGS. Null for EMSC — the EMSC count endpoint does not return this field.'),
  source: z.enum(['usgs', 'emsc']).describe('Data source used.'),
  exceeds_limit: z.boolean().describe('True when count exceeds 20000 — a full search would be truncated. For EMSC, evaluated against the known 20000 limit since max_allowed is not returned. Narrow filters to retrieve all matching events.'),
}
```

---

## Shared Schema: `EarthquakeEventSchema`

Fields returned by feeds and search results. These are normalized output fields — the service layer maps raw API field names to this schema. Raw API fields that differ: USGS uses `mag`→`magnitude`, `magType`→`magnitude_type`, `sig`→`significance`; USGS `time`/`updated` are epoch-millisecond integers and must be converted to ISO 8601; latitude/longitude are extracted from `geometry.coordinates[0,1]`; depth comes from `geometry.coordinates[2]` (positive km for USGS) or `properties.depth` (positive km for EMSC). EMSC uses `flynn_region`→`place`, `magtype`→`magnitude_type`, `unid`→`id`.

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
  tsunami: z.number().describe('1 if a tsunami warning was issued; 0 otherwise. USGS only; omitted or null for EMSC events.'),
  significance: z.number().nullable().describe('USGS significance score (0–2000+). Combines magnitude, felt reports, PAGER. Mapped from API field "sig". USGS only.'),
  status: z.enum(['automatic', 'reviewed', 'deleted']).describe('Review status. Automatic detections may be revised.'),
  event_url: z.string().optional().describe('USGS event page URL for full human-readable detail. Present for USGS events only.'),
  detail_url: z.string().optional().describe('URL to fetch the full GeoJSON detail record for this event. Present in USGS list responses; use with earthquake_get_event.'),
}
```

---

## Design Decisions

**Why two tools for feeds vs. search?**
USGS real-time feeds are pre-computed, CDN-served, and have better availability than the query API. The design exposes them as a distinct, lower-latency tool with no filter overhead. When an agent asks "any major earthquakes today?", `earthquake_get_feed` with `significant_day` is faster and more reliable than a `earthquake_search` with a 24h time window. The USGS docs explicitly recommend feeds for real-time display use cases.

**Why `earthquake_count` as a separate tool?**
The USGS count endpoint returns `{count, maxAllowed}` with no event data — it's a cheap probe. Agents asking statistical questions ("how many M4+ earthquakes in California last year?") shouldn't pay for 20,000-record responses. Count also surfaces the `exceeds_limit` condition cleanly, letting the agent decide whether to narrow before fetching.

**Why EMSC as an alternative source instead of a separate tool?**
EMSC uses the identical FDSN spec with nearly the same parameters. A `source` enum on `earthquake_search` is cleaner than a parallel `earthquake_search_emsc` tool. The main behavioral difference (degree-radius conversion) is handled in the service layer. EMSC's independent catalog is most useful for European events and for cross-verification — an agent can query both sources and compare.

**EMSC has no `maxradiuskm`.**
USGS supports `maxradiuskm`; EMSC only supports `maxradius` in degrees. The `radius_km` input is always specified in km (more intuitive), and the service layer converts: `degrees = km / 111.2`. This conversion is approximate (Earth isn't a perfect sphere) but well within the precision that matters for seismic queries.

**EMSC-only extensions not exposed.**
USGS-specific params (`alertlevel`, `minfelt`, `minsig`) are silently ignored when `source=emsc`. The tool description calls this out. These fields don't exist in the EMSC response shape either.

**Significance score vs. alert level vs. felt reports.**
These three metadata fields measure impact from different angles: significance is a USGS composite score, alert level is PAGER's economic/casualty estimate, felt reports count public responses. All three are exposed as optional search filters because they serve different query patterns. Journalists want alert level; researchers might filter on significance; local impact queries use felt reports.

**`earthquake_get_event` is USGS-only.**
EMSC has no per-event detail endpoint, and EMSC responses include no `detail` or `url` fields. The tool accepts only USGS event IDs (e.g. `us6000sznj`, `hv74966427`). EMSC events have their own `unid` format (e.g. `20260105_0000320`) that has no detail lookup path.

**Resources are supplementary.**
Feed and event resources are added for clients that support injectable context (e.g., Claude Desktop resource panel), but the tool surface is self-sufficient. A tool-only agent can do everything.

**No tsunami-detail tool.**
The `tsunami` flag in event data is a binary USGS indicator that a warning was issued. It links to the tsunami warning center externally. This server surfaces the flag; detailed tsunami product data (wave heights, travel times, warnings) is outside scope.

---

## Known Limitations

- **20,000-event cap.** USGS and EMSC both enforce a 20,000-event maximum per query. Broad historical queries (e.g., all M1+ earthquakes globally for a year, ~500K+ events) will be truncated. `earthquake_count` with `exceeds_limit` surfaces when this applies.
- **EMSC lacks USGS enrichment.** No PAGER alert, no DYFI felt reports, no ShakeMap MMI from EMSC queries. European data tends to have better coverage for small European events; USGS has better global coverage and richer metadata.
- **Automatic detections may be revised.** Events with `status: automatic` are preliminary — magnitude, location, and even existence may change. Reviewed events are more reliable.
- **Depth can be fixed artificially.** When depth is poorly constrained, USGS may report a fixed depth (typically 10 km or 33 km). These are conventional values, not measured.
- **EMSC coordinate conversion is approximate.** Degree-to-km conversion uses 1° = 111.2 km (mean Earth circumference). This is accurate to within ~0.5% globally.
- **Feed data is not real-time.** USGS feeds are typically updated every 1–5 minutes, not truly live. For the most current data on an active sequence, the query API (`earthquake_search` with a recent `start_time`) is more current than cached feeds.

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
- `eventid` query returns single Feature with `products` block (DYFI, ShakeMap, losspager, moment-tensor, focal-mechanism); returns HTTP 404 plain-text when event ID does not exist — parse `Error 404: Not Found` text
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
  - No `alertlevel`, `minfelt`, `minsig`, `reviewstatus` extensions
  - No `detail` per-event URL with products block
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
| 2026-05-23 | `earthquake_get_feed` as a distinct tool from `earthquake_search` | USGS explicitly recommends feeds for real-time display. Feeds are CDN-served, faster, and more available than the query API. Different enough in access pattern to warrant a separate tool rather than a `mode` parameter. |
| 2026-05-23 | `earthquake_count` as a separate tool | USGS count endpoint is cheap and returns `maxAllowed` — surfacing the truncation risk cleanly is only possible as a distinct call. Statistical queries shouldn't be forced through a full fetch. |
| 2026-05-23 | No EMSC-specific tool; `source` enum on `earthquake_search` instead | EMSC speaks the same FDSN spec. A parallel tool would duplicate the entire parameter set for one API difference (degree radius). The `source` enum is simpler and keeps the surface tight. |
| 2026-05-23 | `radius_km` input for both sources, converted to degrees for EMSC | "km" is universally more intuitive than degrees for location queries. The server absorbs the conversion complexity (1° ≈ 111.2 km). Agents shouldn't know or care about the EMSC coordinate system limitation. |
| 2026-05-23 | No resources for search results | Feeds and individual events have stable URIs; search results do not (they're parameterized queries). Resources cover addressable entities only. |
| 2026-05-23 | No prompts | Pure data-access server. No recurring multi-step interaction patterns that a prompt template would structure. |
| 2026-05-23 | `earthquake_get_event` USGS-only | EMSC has no per-event detail endpoint and EMSC responses include no `url` or `detail` fields. EMSC `unid` values (e.g. `20260105_0000320`) have no per-event lookup path. USGS event IDs are the only path to product-level detail. |
| 2026-05-23 | Expose `significance`, `cdi`, `mmi`, `felt` in event schema | These fields appear directly in USGS list responses (not just event detail). They're what distinguishes the USGS feed from a generic seismograph — the "did anyone feel this?" and "how bad could it get?" signals that serve journalists and public safety use cases. |
