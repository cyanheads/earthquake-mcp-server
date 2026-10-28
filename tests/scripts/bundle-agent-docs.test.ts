/**
 * @fileoverview Bundle agent-doc selector shared by `scripts/clean-mcpb.ts` (the strip)
 * and `scripts/lint-packaging.ts` (check 8). A nested `skills/` directory is an agent-doc
 * tree only at an installed package's root: the MCP SDK's `dist/ext/skills/` is runtime
 * code the server imports, and stripping it kills the bundle at boot with
 * `ERR_MODULE_NOT_FOUND` while the packaging lint still passes.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';

/**
 * The linter's exports, typed structurally. It is loaded by URL at run time: its
 * framework-repository fallback imports `../src/mcp-server/skills.js`, which this server
 * does not have, so a static import would pull a missing module into `tsc`.
 */
interface PackagingLint {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const lint = (await import(/* @vite-ignore */ lintPackagingUrl)) as PackagingLint;

/** SDK runtime modules under a nested `skills/` directory — the skills extension. */
const SDK_RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.cjs',
];

/** Other runtime entries that sit near agent-doc names and must survive. */
const OTHER_RUNTIME = [
  'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
  'node_modules/some-pkg/lib/skills.js',
  'node_modules/@scope/pkg/dist/skills/index.js',
  'node_modules/a/node_modules/b/dist/skills/index.js',
];

/** Package-root agent skill trees, scoped and unscoped, top-level and nested. */
const PACKAGE_ROOT_SKILLS = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenv/reference.md',
  'node_modules/@scope/pkg/skills/guide/examples.md',
  'node_modules/a/node_modules/b/skills/guide/reference.md',
  'node_modules/a/node_modules/@scope/b/skills/guide/reference.md',
  'node_modules/@outer/a/node_modules/@scope/b/skills/guide/reference.md',
];

/** The other agent-doc classes, stripped at any depth as before. */
const OTHER_AGENT_DOCS = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/example.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/x/notes.md',
  'node_modules/some-pkg/docs/deep/SKILL.md',
];

describe.each([
  ['clean-mcpb', () => CLEAN_AGENT_DOC_ENTRY],
  ['lint-packaging', () => lint.AGENT_DOC_ENTRY],
])('AGENT_DOC_ENTRY (%s)', (_name, entry) => {
  it.each([...SDK_RUNTIME, ...OTHER_RUNTIME])('keeps runtime entry %s', (path) => {
    expect(entry().test(path)).toBe(false);
  });

  it.each([...PACKAGE_ROOT_SKILLS, ...OTHER_AGENT_DOCS])('strips agent-doc entry %s', (path) => {
    expect(entry().test(path)).toBe(true);
  });
});

describe('bundle agent-doc selection', () => {
  const listing = [...SDK_RUNTIME, ...OTHER_RUNTIME, ...PACKAGE_ROOT_SKILLS, ...OTHER_AGENT_DOCS];

  it('selects exactly the agent-doc entries for the strip', () => {
    expect(filterAgentDocEntries(listing)).toEqual([...PACKAGE_ROOT_SKILLS, ...OTHER_AGENT_DOCS]);
  });

  it('passes check 8 on a cleaned listing that still holds the SDK skills runtime', () => {
    expect(lint.checkBundleEntries([...SDK_RUNTIME, ...OTHER_RUNTIME], 'bundle.mcpb')).toEqual([]);
  });

  it('flags package-root skill trees left in a bundle', () => {
    const errors = lint.checkBundleEntries([...SDK_RUNTIME, ...PACKAGE_ROOT_SKILLS], 'bundle.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${PACKAGE_ROOT_SKILLS.length} node_modules agent-doc entries`);
  });

  it('uses one selector in the cleaner and the linter', () => {
    expect(CLEAN_AGENT_DOC_ENTRY.source).toBe(lint.AGENT_DOC_ENTRY.source);
  });
});
