# earthquake-mcp-server - Directory Structure

Generated on: 2026-10-28 14:31:08

```text
earthquake-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   └── earthquake-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── earthquake-event.resource.ts
│   │   │       └── earthquake-feed.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── earthquake-count-events.tool.ts
│   │       │   ├── earthquake-get-event.tool.ts
│   │       │   ├── earthquake-get-feed.tool.ts
│   │       │   └── earthquake-search-events.tool.ts
│   │       ├── fdsn-error.ts
│   │       ├── limit-clamp.ts
│   │       ├── query-params.ts
│   │       └── schemas.ts
│   ├── services/
│   │   ├── emsc/
│   │   │   └── emsc-service.ts
│   │   ├── usgs/
│   │   │   ├── aftershock-forecast.ts
│   │   │   ├── event-includes.ts
│   │   │   ├── product-fields.ts
│   │   │   ├── quakeml.ts
│   │   │   ├── types.ts
│   │   │   └── usgs-service.ts
│   │   ├── feed-snapshots.ts
│   │   └── upstream-call.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── emsc/
│   │   │   ├── 19980101_0000021.json
│   │   │   ├── 20190706_0000043.json
│   │   │   └── 20190706_0000043.search.json
│   │   └── usgs/
│   │       ├── ak20419010.phase-data.xml
│   │       ├── aka2026viylbm.phase-data.xml
│   │       ├── ci38457511.detail.json
│   │       ├── ci38457511.phase-data.xml
│   │       ├── ci41567984.detail.json
│   │       ├── ci41567984.phase-data.xml
│   │       ├── nc75458907.detail.json
│   │       ├── nc75458907.forecast.json
│   │       ├── us6000m0xl.phase-data.xml
│   │       ├── us6000m0yg.detail.json
│   │       ├── us6000m0yg.phase-data.xml
│   │       ├── us6000qw60.detail.json
│   │       ├── us6000qw60.forecast.json
│   │       ├── us6000u18k.detail.json
│   │       └── us6000u18k.forecast.json
│   ├── helpers/
│   │   └── usgs-fetch-stub.ts
│   ├── prompts/
│   ├── resources/
│   │   ├── earthquake-event-edge-cases.resource.test.ts
│   │   ├── earthquake-event.resource.test.ts
│   │   ├── earthquake-feed-edge-cases.resource.test.ts
│   │   └── earthquake-feed.resource.test.ts
│   ├── scripts/
│   │   └── bundle-agent-docs.test.ts
│   ├── services/
│   │   ├── cancellation.test.ts
│   │   ├── emsc-service.test.ts
│   │   ├── event-includes.test.ts
│   │   ├── feed-snapshots.test.ts
│   │   └── usgs-service.test.ts
│   └── tools/
│       ├── advertised-wire-contract.test.ts
│       ├── date-midnight-contract.test.ts
│       ├── earthquake-count-events-edge-cases.test.ts
│       ├── earthquake-count-events.tool.test.ts
│       ├── earthquake-get-event-edge-cases.test.ts
│       ├── earthquake-get-event-wire.test.ts
│       ├── earthquake-get-event.tool.test.ts
│       ├── earthquake-get-feed-edge-cases.test.ts
│       ├── earthquake-get-feed.tool.test.ts
│       ├── earthquake-search-events-edge-cases.test.ts
│       ├── earthquake-search-events.tool.test.ts
│       ├── fdsn-error.test.ts
│       ├── feed-retention.test.ts
│       ├── limit-clamp.test.ts
│       ├── paging-wire.test.ts
│       ├── query-params.test.ts
│       ├── schemas.test.ts
│       ├── shared-filter-surface.test.ts
│       ├── timeout-contract.test.ts
│       └── upstream-retry-contract.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
