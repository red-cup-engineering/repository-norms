import assert from 'node:assert/strict';
import test from 'node:test';
import { assessFrontdoor } from '../src/frontdoor.mjs';

const current = `# Multi-Agent Systems

<!-- 561-group-standards:badges:start -->
[![MIT](https://img.shields.io/badge/license-MIT)](LICENSE)
<!-- 561-group-standards:badges:end -->

A grouping of reusable systems composed across multiple agents.

## Apps

- \`apps/playing\`
- \`apps/computing\`

See [the contract](docs/contract.md) and [upstream](https://github.com/red-cup-engineering/agent-organization-engine).
`;

test('flags stale inline paths as review and broken relative links as errors', () => {
  const r = assessFrontdoor({ readme: current, trackedPaths: ['README.md','LICENSE','services/multi-agent-computer-platform-engineering-services-section'] });
  assert.deepEqual(r.findings.filter(x=>x.rule==='unresolved-inline-path').map(x=>x.detail.split(' ')[0]), ['apps/playing','apps/computing']);
  assert.deepEqual(r.findings.filter(x=>x.rule==='missing-relative-link').map(x=>x.detail.split(' ')[0]), ['docs/contract.md']);
  assert.equal(r.observed.checkedCodePaths, 2);
});

test('accepts tracked files and submodule directory paths, ignores URLs, fences, and anchors', () => {
  const readme = `# Engine

A source-bound explanation of what the engine does.

## Where to start

See [implementation](src/index.mjs#entry), the \`services/child/\` submodule, and [external](https://example.test/docs).

\`\`\`sh
\`apps/unbuilt\`
\`\`\`

## What exists today

The delivered export is tested; future deployment is not yet implemented.

## Boundaries

This is not a deployment service.
`;
  const r = assessFrontdoor({readme,trackedPaths:['README.md','src/index.mjs','services/child']});
  assert.deepEqual(r.findings, []);
  assert.equal(r.observed.checkedRelativeLinks, 1);
  assert.equal(r.observed.checkedCodePaths, 1);
});

test('missing README is an objective error while no observed tracked inventory does not invent broken links', () => {
  const missing=assessFrontdoor({readme:undefined,trackedPaths:[]});
  assert.equal(missing.findings[0].rule,'readme-missing');
  const noInventory=assessFrontdoor({readme:'## Links\n[foo](docs/foo.md)'});
  assert.equal(noInventory.findings.some(x=>x.rule==='missing-relative-link'),false);
});

test('rejects relative escapes while preserving explicit uncertainty for user-facing meaning', () => {
  const r=assessFrontdoor({readme:'# Agent\n\nExplains an Agent.\n\n[unsafe](../secret.md)\n',trackedPaths:['README.md']});
  assert.equal(r.findings.some(x=>x.rule==='invalid-relative-link'),true);
  assert.equal(r.findings.some(x=>x.rule==='status-needs-review'),true);
  assert.equal(r.findings.some(x=>x.rule==='entry-route-needs-review'),true);
});
