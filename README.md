<div align="center">
  <h1>@cyanheads/earthquake-mcp-server</h1>
  <p><b>Search USGS and EMSC seismic data — real-time feeds, event queries, and earthquake counts via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/earthquake-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/earthquake-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/earthquake-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/earthquake-mcp-server/releases/latest/download/earthquake-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=earthquake-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZWFydGhxdWFrZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22earthquake-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fearthquake-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://earthquake.caseyjhand.com/mcp](https://earthquake.caseyjhand.com/mcp)

</div>

---

## Overview

Seismic data from USGS ComCat and the EMSC SeismicPortal. Fetch real-time earthquake feeds, search and count seismic events by time, magnitude, depth, and location, and pull full analysis detail for a single event.

### Tools

| Tool | Description |
|:---|:---|
| `earthquake_get_feed` | Fetch a USGS pre-computed real-time earthquake feed by magnitude tier and time window |
| `earthquake_search_events` | Search earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports |
| `earthquake_count_events` | Count earthquakes matching filters without fetching full records |
| `earthquake_get_event` | Fetch complete detail for a specific earthquake by USGS event ID |

### Resources

| Resource | Description |
|:---|:---|
| `earthquake://feed/{magnitude_tier}/{time_window}` | First bounded page of a USGS real-time feed, with an exact continuation URI |
| `earthquake://feed/{magnitude_tier}/{time_window}/page/{cursor}` | Continue the retained feed generation using the returned `next_uri` |
| `earthquake://event/{event_id}` | Full USGS earthquake event detail by ID as injectable context, including the same `detail` product projection as `earthquake_get_event` |

## Capability reference

### `earthquake_get_feed` <sub>tool</sub>

- Choose a magnitude tier (`all`, `1.0`, `2.5`, `4.5`, `significant`) and a window (`hour`, `day`, `week`, `month`). USGS caches these feeds; use `earthquake_search_events` for historical or filtered queries.
- Returns events, page count, generation time, and source feed URL. `all` includes microseisms; `significant` is USGS-curated using magnitude, felt reports, and PAGER impact.
- `limit` defaults to 100 and accepts up to 1000. Pages fit a 24,000-byte serialized result, so they can contain fewer events. `totalCount` reports the whole feed; pass `nextCursor` back unchanged with the same tier and window.
- Continuations read the first-read generation, unaffected by upstream edits. Retention lasts up to 15 minutes, subject to capacity eviction and restart. `cursor_expired` means restart without a cursor; legacy cursors must also be restarted.

---

### `earthquake_search_events` <sub>tool</sub>

- Search `usgs` or `emsc` by time, magnitude, depth, radius, or bounding box. A radius requires `latitude`, `longitude`, and `radius_km` together; box edges are independently optional, support antimeridian bounds up to ±360°, and intersect a supplied circle.
- Returns normalized events with `event_type` and EMSC's `event_certainty`. `ignoredFilters` names unsupported filters; `queryEcho` reports the effective query.
- Both search and count accept open `magnitude_type` values on either source. `product_type` (required product, e.g. `moment-tensor`) and `review_status` (`automatic` or `reviewed`) apply only to USGS; EMSC names them in `ignoredFilters`. Blank values mean omitted.
- Date-only bounds (including expanded year/year-month forms) mean midnight at the start of the named day on both sources: `2026-10-10` becomes `2026-10-10T00:00:00`. Explicit time and timezone suffixes are preserved; unpadded date components are padded. Offsetless times use UTC for the 30-day default. `queryEcho` shows the exact effective bounds.
- Sort by time or magnitude in either direction. `limit` defaults to 100 and accepts up to 20,000; each call fetches at most 100 candidates and returns a 24,000-byte serialized page. Paging uses the exact returned `nextOffset`, counting from 1, with the same filters and order. `queryEcho.limit` reports the effective upstream candidate limit. Search pages read the current catalog, so upstream edits can affect later pages.
- Strictly inverted magnitude, depth, or explicit time bounds fail locally as `invalid_range`, naming both values and recovery. Equal and single bounds remain valid; time comparisons use UTC instants, including explicit offsets. Calendar-invalid values remain for upstream rejection.
- A nonempty short upstream page establishes `totalCount` before byte shaping; an empty first page establishes zero, while an empty later page leaves the total unknown. Full upstream pages use a count lookup, with `countUnavailable` on failure. Feed and search requests share a 50-second deadline across retries; search includes its optional count lookup. Cancellation remains cancellation.

---

### `earthquake_count_events` <sub>tool</sub>

- Count matches using the same filters as `earthquake_search_events`, without fetching events. Omit `start_time` for the last 30 days; `queryEcho` reports the resolved window and applied filters.
- `exceeds_limit` flags the 20,000-event single-request threshold, not a retrieval ceiling: search offset paging can retrieve larger match sets. `max_allowed` is 20,000 for USGS and null for EMSC; `ignoredFilters` names filters the source cannot apply.

---

### `earthquake_get_event` <sub>tool</sub>

- Pass a USGS `event_id` from the `id` field of a feed or USGS search result (e.g. `us6000sznj`). This tool currently accepts USGS IDs only.
- Returns the normalized event plus optional `detail`: PAGER, ShakeMap, DYFI, moment tensor, ground-failure alerts, origin quality, and finite-fault dimensions. Groups are omitted when none of their projected fields is available; absence does not imply zero impact.
- Blank IDs fail locally; canonical IDs and aliases match case-insensitively. ShakeMap includes the producer's `code_version` when published.

---

### `earthquake://feed/{magnitude_tier}/{time_window}` <sub>resource</sub>

- Choose the same magnitude tiers and time windows as `earthquake_get_feed`; all 20 combinations are listed as browsable resources.
- Returns a bounded `application/json` page using the existing compact event projection, plus `totalCount`, `truncated`, `nextCursor`, and `next_uri`. Read `next_uri` verbatim until it is absent. The continuation URI is `earthquake://feed/{magnitude_tier}/{time_window}/page/{cursor}`.
- Feed resources share retained generations with `earthquake_get_feed`. Cache hints are private with zero lifetime because continuation tokens belong to the requesting tenant. Upstream failures classified as `ServiceUnavailable` expose `feed_unavailable`; those classified as `Timeout` expose `feed_timeout`, each with recovery guidance and no captured upstream body. Availability failures preserve numeric HTTP status; HTTP 501 remains non-retryable and points to EMSC search. Other error classes propagate unchanged.

---

### `earthquake://event/{event_id}` <sub>resource</sub>

- Pass a USGS `event_id` from a feed or search result. Returns the same event and optional `detail` products as `earthquake_get_event`.
- Uses that tool's `event_deleted`, `not_found`, `source_unavailable`, and `source_timeout` error contract.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USGS/EMSC-specific:

- Type-safe clients for the USGS FDSN/GeoJSON API and the EMSC FDSN-WS API, normalizing both into one shared earthquake domain schema
- Automatic retry with backoff and per-request timeouts on every upstream call; detects USGS's rate-limited/CDN failure mode (HTML served instead of GeoJSON) and maps it to a typed service-unavailable error instead of parsing it as data
- EMSC's two-character `evtype` code is decoded against the published event-type/certainty nomenclature into the same vocabulary USGS publishes, so `event_type` carries one meaning across both sources
- USGS-only filters (`alert_level`, `min_felt`, `min_significance`, `event_type`, `product_type`, `review_status`) are named in `ignoredFilters` when `source=emsc`. On USGS, `event_type="earthquake"` excludes quarry blasts and other non-tectonic records.
- No API key or rate-limit tier required — both USGS and EMSC are fully public, keyless APIs

Agent-friendly output:

- Provenance — `source: "usgs" | "emsc"` on every response, plus `source_catalog`/`auth` fields naming the catalog and authoritative agency, so agents can weigh two independent solutions against each other
- Discriminated output contracts — `event_type` and EMSC's `event_certainty` preserve published classifications, with absent fields remaining unknown; `exceeds_limit`, `countUnavailable`, and `truncated` flags let callers branch on data instead of parsing prose
- Response shaping — fields a source does not publish come back `null`, never a fabricated zero (`tsunami`, `status`, and `mmi` are always null on EMSC events); USGS-only filters dropped for an EMSC query are named in `ignoredFilters` rather than silently ignored
- Graceful degradation — an upstream rejection surfaces the service's own explanation (offending parameter, accepted format) in the error message instead of a bare status code, and a failed follow-up count degrades to `countUnavailable` rather than failing the whole search

## Getting started

### Public Hosted Instance

A public instance is available at `https://earthquake.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "earthquake-mcp-server": {
      "type": "streamable-http",
      "url": "https://earthquake.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "earthquake-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/earthquake-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "earthquake-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/earthquake-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "earthquake-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/earthquake-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher.
- No API keys required — USGS and EMSC data is fully public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/earthquake-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd earthquake-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_SESSION_MODE` | HTTP sessions: `stateful`, `stateless`, or `auto` (resolves to stateful). Overrides the `createApp()` declaration; Docker and `.env.example` also pin stateless. | `stateless` (declared in `src/index.ts`) |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files on Node.js and Bun | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results, redacted by key name. Secrets inside free-form values remain. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | UTF-8 byte cap per logged failure payload | `16384` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `USGS_BASE_URL` | USGS API base URL. Override for testing or mirroring. | `https://earthquake.usgs.gov` |
| `EMSC_BASE_URL` | EMSC API base URL. Override for testing or mirroring. | `https://www.seismicportal.eu` |
| `DEFAULT_LIMIT` | Default result limit for `earthquake_search_events` | `100` |
| `REQUEST_TIMEOUT_MS` | Per-attempt HTTP timeout in milliseconds; feed/search also share a 50-second total cap. Standalone event/count calls use this per-attempt value. | `10000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL for traces (`/v1/traces`) and metrics (`/v1/metrics`); signal-specific endpoint variables override it | none |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint, used as-is; the base URL never enables logs | none |

Empty values and unsubstituted whole-value `${…}` placeholders use the defaults. See [`.env.example`](./.env.example) for optional overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t earthquake-mcp-server .
docker run --rm -p 3010:3010 earthquake-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/earthquake-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Four tools across USGS and EMSC. |
| `src/mcp-server/resources` | Feed, feed continuation, and event resources. |
| `src/services/feed-snapshots.ts` | Tenant-scoped serialized feed retention with bounded payload and metadata accounting. |
| `src/services/usgs` | USGS ComCat service — GeoJSON feed fetcher and FDSN query API client. |
| `src/services/emsc` | EMSC SeismicPortal service — FDSN event search and count endpoints. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Validate upstream data, normalize to domain types, and preserve missing values rather than inventing facts

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
