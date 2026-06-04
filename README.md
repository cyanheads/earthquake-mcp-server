<div align="center">
  <h1>@cyanheads/earthquake-mcp-server</h1>
  <p><b>Search USGS and EMSC seismic data — real-time feeds, event queries, and earthquake counts via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/earthquake-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/earthquake-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/earthquake-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/earthquake-mcp-server/releases/latest/download/earthquake-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=earthquake-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZWFydGhxdWFrZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22earthquake-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fearthquake-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://earthquake.caseyjhand.com/mcp](https://earthquake.caseyjhand.com/mcp)

</div>

---

## Tools

4 tools for querying global earthquake data from USGS and EMSC:

| Tool | Description |
|:---|:---|
| `earthquake_get_feed` | Fetch a USGS pre-computed real-time earthquake feed by magnitude tier and time window |
| `earthquake_search` | Search earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports |
| `earthquake_count` | Count earthquakes matching filters without fetching full records |
| `earthquake_get_event` | Fetch complete detail for a specific earthquake by USGS event ID |

### `earthquake_get_feed`

Fetch a USGS pre-computed real-time earthquake feed by magnitude tier and time window.

- CDN-cached by USGS — faster and more available than the FDSN query API
- Five magnitude tiers: `all` (microseisms), `1.0`, `2.5`, `4.5`, and `significant` (USGS-curated by magnitude, felt reports, and PAGER impact)
- Four time windows: `hour`, `day`, `week`, `month`
- Returns event list with counts and the source feed URL
- Best for real-time "what's happening now" queries; use `earthquake_search` for historical or filtered queries

---

### `earthquake_search`

Search earthquakes by time range, magnitude, depth, location radius, PAGER alert level, or felt reports.

- Dual-source: USGS (global, richer metadata) or EMSC (European-Mediterranean, independent catalog for cross-verification)
- Full FDSN ComCat query API parameters: time range, magnitude, depth, location radius
- USGS-specific filters: PAGER alert level (`green`/`yellow`/`orange`/`red`), DYFI felt reports count, significance score
- Location-based queries: provide `latitude`, `longitude`, and `radius_km` together
- Sort by time (newest first) or magnitude (largest first), ascending or descending
- Results capped at 20,000 events per query; use `earthquake_count` first to gauge result size
- USGS-specific filters are silently ignored when `source=emsc`

---

### `earthquake_count`

Count earthquakes matching filters without fetching full records.

- Lightweight alternative to `earthquake_search` for statistical queries ("how many M5+ events in 2025?")
- Same filter surface as `earthquake_search`: time, magnitude, depth, location radius, PAGER, DYFI, significance
- Returns `exceeds_limit` flag when count exceeds 20,000 — signals that a full search would be truncated
- USGS returns the `max_allowed` cap (20,000); EMSC count endpoint does not expose this field (`max_allowed` will be null)

---

### `earthquake_get_event`

Fetch complete detail for a specific earthquake by USGS event ID.

- Returns the full USGS property set: felt reports count (DYFI), ShakeMap maximum intensity (MMI), PAGER alert level, tsunami flag, and magnitude type
- Event IDs appear in the `id` field of `earthquake_get_feed` and `earthquake_search` results (e.g. `us6000sznj`, `hv74966427`)
- USGS-only — EMSC events have no per-event detail endpoint

## Resources

| Type | URI pattern | Description |
|:---|:---|:---|
| Resource | `earthquake://feed/{magnitude_tier}/{time_window}` | USGS real-time earthquake feed as injectable context |
| Resource | `earthquake://event/{event_id}` | Full USGS earthquake event detail by ID as injectable context |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

Earthquake-specific:

- Two independent data sources: USGS ComCat (global, full metadata) and EMSC SeismicPortal (European-Mediterranean, independent catalog)
- USGS real-time GeoJSON feeds (CDN-cached, fast availability) plus FDSN event query API
- EMSC FDSN-WS event and count endpoints
- No API key required — both USGS and EMSC are fully public

Agent-friendly output:

- Source attribution on every response (`usgs` / `emsc`) so agents can reason about data provenance
- `exceeds_limit` flag on count responses surfaces truncation risk before a full search
- USGS-specific fields (`alert_level`, `felt`, `mmi`, `tsunami`) clearly labeled as USGS-only to prevent misattribution on EMSC results

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

- [Bun v1.3.0](https://bun.sh/) or higher.
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
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `USGS_BASE_URL` | USGS API base URL. Override for testing or mirroring. | `https://earthquake.usgs.gov` |
| `EMSC_BASE_URL` | EMSC API base URL. Override for testing or mirroring. | `https://www.seismicportal.eu` |
| `DEFAULT_LIMIT` | Default result limit for `earthquake_search` | `100` |
| `REQUEST_TIMEOUT_MS` | HTTP timeout in milliseconds for upstream API calls | `10000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

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

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Four tools across USGS and EMSC. |
| `src/mcp-server/resources` | Resource definitions. Feed and event resources. |
| `src/services/usgs` | USGS ComCat service — GeoJSON feed fetcher and FDSN query API client. |
| `src/services/emsc` | EMSC SeismicPortal service — FDSN event search and count endpoints. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
