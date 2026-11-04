---
name: earthquake-guide
description: Gates and workflows for the earthquake_* tools (USGS ComCat and EMSC). Use to judge how bad a quake was, read USGS aftershock odds, check whether a depth or location holds up, match one event across USGS and EMSC, or count and list events over years or in a region — before concluding from a missing product, a default time window, or magnitudes of different types.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

Catalog records of past seismic events from two independent global catalogs, plus the analysis products USGS attaches to its events. Keyless.

- **Not a forecast service.** The only forward-looking numbers are the USGS aftershock forecasts attached to some events. **Not a tsunami warning service:** the `tsunami` field flags a large oceanic event; tsunami.gov has warning status.
- **No geocoding, no place filter.** The tools take coordinates. `place` ("12 km NE of …") is display text that no input matches against. Resolve "near X" to latitude/longitude with a geocoding tool first, then search or count within a radius.
- **The feed can't be scoped by area.** `earthquake_get_feed` returns one global USGS tier for a rolling window ("Past Week" means the 7 days before generation, not the calendar week). For a place-scoped question, use `earthquake_search_events` with a radius and an explicit start.
- **Which catalog holds small events depends on the region.** M2.5+ in 2025 (`start_time` 2025-01-01, `end_time` 2026-01-01): a box over Italy (latitude 36 to 47, longitude 6 to 19) returned 41 USGS events and 633 EMSC; one over Japan (latitude 30 to 46, longitude 128 to 146) 806 and 1,120; one over California (latitude 32 to 42, longitude −125 to −114) 1,224 and 1,221. At M4+ the Italy box converged (25 vs 30). For small events outside the US, query EMSC, and always say which catalog a count came from.

## Identifiers

| ID | Looks like | Comes from |
|:--|:--|:--|
| USGS event ID | network prefix + code: `ci38457511`, `us6000u18k` | `id` in feed and USGS search results; the segment after `/eventpage/` in a USGS event page URL |
| EMSC event ID (unid) | `YYYYMMDD_NNNNNNN`: `20190706_0000043` | `id` in search results with source `emsc` |

- **One USGS event, many IDs.** Every contributing network files its own ID. `earthquake_get_event` accepts any of them, case-insensitively, and returns the preferred one: `us70004bn0` comes back as `ci38457511`. The others are listed in `associated_ids`. Use the returned `id` from then on, and treat any ID in `associated_ids` as the same event when deduplicating. An ID from a news link, an earlier read, or another network can be one of these aliases.
- **No ID links the two catalogs.** `associated_ids` never holds an EMSC unid. To get from a USGS event to its EMSC record, or back, match by time and place (Workflows).

## Gates

- **Set both time bounds for any period other than the last 30 days.** Search and count fall back to the 30 days before `end_time` (or now) when `start_time` is omitted, so "how many since 2015" asked without a start gets a 30-day answer. A date-only `end_time` means midnight at the start of that day: to include all of 2024, end at `2025-01-01`. Read `queryEcho` before reporting a count. Times in and out are UTC, so convert the user's local times both ways.
- **Pin the window before paging.** With both bounds omitted, the default start is recomputed from the current time on every call, and with the default newest-first order an open `end_time` lets new events push every later offset back by one. Either way pages skip or repeat events. Set both bounds on the first page, repeat every input unchanged, and dedupe by `id`.
- **"M5+" is not one scale.** `magnitude` is each catalog's preferred value, and its type varies by event: in 2025 (`start_time` 2025-01-01, `end_time` 2026-01-01), mb was the preferred type for about half of M5+ events in both catalogs. The same threshold gives different counts in the two catalogs. mb saturates near M6: the 2024 Noto M7.5 `us6000m0xl` has mb 6.9, Ms_20 7.2, and Mww 7.5 (preferred). To compare magnitudes across catalogs, networks, or years, filter or compare within one `magnitude_type`. Report the type with every magnitude.
- **Missing means not assessed, not zero.** A null `felt`, `alert`, or `mmi`, or an absent `detail` group, means USGS published nothing for that event (for `mmi`, also a ShakeMap that computed no maximum intensity, common offshore). A `not_published` entry in `unavailable_includes` means USGS published no product for that group, or, for `pager`, a PAGER product older than the files the group reads; its alert still shows in `detail.losspager`. None of these means the event was unfelt, caused no damage, or carries no aftershock risk. `fetch_failed` means the product exists but couldn't be read; retry before reporting it missing. An `automatic` USGS solution can still move or be deleted, and EMSC's real-time `EMSC-RTS` solutions carry no status and get revised, so report the status and catalog with the numbers.
- **A depth with an error bar can still be fixed.** Analysts assign a depth when the data can't constrain one. Ridgecrest's `us` origin (the `us70004bn0` entry in `origins` for `ci38457511`) sits at exactly 8 km with `depth_type` "operator assigned" and a `depth_error_km` of 1.8. Its preferred `ci` origin is also an operator-assigned 8 km, with a 31.61 km error. Before calling a depth measured, read `depth_type` on `detail.origin` or on each entry of `origins`.

## Workflows

**How bad was it.** Find the event (search within a radius and an explicit window, or take it from the feed), then call `earthquake_get_event`.
- **PAGER alert:** an *estimate* from modeled shaking and exposed population. The color is whichever is higher of the fatality alert and the economic-loss alert: green 0 deaths / under $1M, yellow 1–99 / $1M–$100M, orange 100–999 / $100M–$1B, red 1,000+ / $1B+. Add `include: ['pager']` to see which one drove it: both alert levels, the probability of each fatality and loss bracket (economic bounds in millions of USD), and the people exposed at each shaking intensity, per country (`UK` marks areas assigned to no country). Report a bracket with its probability, never as a single figure; PAGER revises them as data arrive.
- **ShakeMap intensity:** modeled. **DYFI:** public reports.
- **Tsunami:** a `tsunami` of 1 sends the reader to tsunami.gov; it is not a warning in itself.

**Aftershock odds.** Call `earthquake_get_event` with the `aftershock_forecast` group. USGS publishes these for few events: fewer than 1 in 20 M5+ events carried one in the year to October 2026, and most of those were in the US and its Pacific territories.
- **No forecast:** `not_published` means USGS issued none. Say so; don't present a rule of thumb as the USGS figure.
- **Timing:** each window runs from its own `start` to `end`, fixed when USGS issued the forecast, not from your call, and each re-issue moves every window. Compare `end` to the current time before calling a window "the next day" or "the next week". `next_update` says when USGS plans a fresh forecast.
- **Reporting:** give each probability with its window label and bin magnitude. `above_mainshock` is the chance of an event at least as large as the mainshock.

**Does the solution hold up.** On `earthquake_get_event`:
- **Preferred origin:** `detail.origin` carries azimuthal gap, station count, errors, and depth type for it.
- **`origins`:** returns every origin product filed for the event, preferred first. `ci38457511` has five: `ci` (preferred), `us`, a second `us` row carrying the ISC-GEM solution, and solutions from the tsunami warning centers `pt` and `at`, both at 100 km with no depth type. Weigh the network solutions; a tsunami-center quick solution is not a disagreement about depth.
- **`magnitudes`:** compares scales type by type.
- **`arrivals`:** request only when the phase picks themselves are the question. A large event returns hundreds of rows: `nc72282711` returns 681, a response of about 200 KB.

**Match one event across USGS and EMSC.**
1. Take the origin time, latitude, and longitude from one catalog.
2. Search the other catalog over a few minutes either side, within about 100 km.
3. Pick the row whose origin time is seconds away and whose magnitude is similar. Never take the first row: aftershocks share the window. For Ridgecrest, USGS `ci38457511` is 03:19:53.0Z M7.1 mw and EMSC `20190706_0000043` is 03:19:57.8Z M7.1 mw, about 3 km apart. The same ±3-minute, 100 km EMSC search lists an M5.0 ml aftershock from about three minutes later first.
4. To reread an EMSC match, pass its unid to `earthquake_get_event`.

**Counts over years, or long lists.** Pass explicit bounds and the area to `earthquake_count_events`.
- **For a trend:** make one count per year (or month) with explicit bounds each, rather than paging events. Hold one `magnitude_type` if the series must be comparable.
- **To list the events:** read the count, then page `earthquake_search_events` under the paging gate.
- **Non-tectonic events:** `event_type` filters them out only on USGS. On EMSC, read each event's `event_type`.
