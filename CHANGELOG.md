# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-06-04

Fix error classification: validationError for invalid feed params, typed source_unavailable/query_too_broad contracts in search and count tools

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.21 — per-request log context fix, fetchWithTimeout secret scrubbing, withRetry fail-fast; vitest ^4.1.8; release:github script; skill sync

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-05-30

enrichment adoption — earthquake_search and earthquake_get_feed surface result totals, truncation, and empty-result guidance via a typed enrichment block

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-05-28

mcp-ts-core ^0.9.9 → ^0.9.13: HTTP 413 body cap, session-init gate, quieter client-error logs, landing auth gate; invalid_radius reclassified to ValidationError

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-05-24

Code simplification, mcp-ts-core ^0.9.7 → ^0.9.9, error code correction for query_too_broad

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-24

Fix null depth_km crash on historical events; correct description claiming products metadata

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Add hosted server endpoint metadata (remotes block, public URL)

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Metadata alignment: scripts, fields, Dockerfile label, .gitignore/.dockerignore; remove tsx devDependency

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23

Sync tagline across all description surfaces; add publish-mcp script

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-24

Fix earthquake_get_event and event resource not_found path; sync metadata to gold standard

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Field-test fixes: earthquake_get_event always-not-found, feed description M prefix on string tiers, search truncation signal

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-23

First functional release — 4 tools and 2 resources for real-time and historical global earthquake data via USGS and EMSC

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-23

Initial release — USGS and EMSC earthquake data via 4 tools and 2 resources
