import assert from "node:assert/strict";
import test from "node:test";
import { assessPackageSurface } from "../src/package-surface.mjs";

const observe = (manifest, trackedPaths) => assessPackageSurface({packageJson: JSON.stringify(manifest), trackedPaths});
test("observes source-addressable export, bin and types without assuming runtime success", () => {
  const r = observe({
    name: "@sample/agent", version: "0.2.1", description: "Test description", private: false,
    exports: { ".": { import: "./src/agent.mjs", types: "./types/agent.d.mts" }, "./carriers": "./src/carriers.mjs" },
    bin: { "sample-agent": "./bin/sample-agent.mjs" },
    scripts: { test: "node --test test/*.test.mjs" },
  }, ["package.json","src/agent.mjs","src/carriers.mjs","types/agent.d.mts","bin/sample-agent.mjs","test/agent.test.mjs"]);
  assert.equal(r.observed.name, "@sample/agent");
  assert.equal(r.entrypoints.length, 4);
  assert.deepEqual(r.findings, []);
  assert.equal(r.scripts[0].examined[0].matches, 1);
});
test("exposes an orphaned explicit test glob as a real failure", () => {
  const r=observe({
    name:"@red-cup-engineering/agent-section-descent-assay-service",
    exports:{".":"./src/assay.mjs"},
    scripts:{test:"node --test test/*.test.mjs"}
  },["README.md","package.json","src/assay.mjs"]);
  assert.deepEqual(r.findings.map(x=>x.rule),["missing-script-test-source"]);
});
test("distinguishes generated targets from missing source targets", () => {
  const r=observe({exports:{".":"./dist/index.js","./other":"./src/missing.mjs"}},["package.json","src/index.ts"]);
  assert.deepEqual(r.entrypoints.map(x=>x.status),["generated-or-absent","missing"]);
  assert.deepEqual(r.findings.map(x=>x.severity),["review","error"]);
});
test("a section manifest without exports is not miscast as a standalone executable", () => {
  const r=observe({name:"@sample/section",description:"A composition",scripts:{}},["package.json","README.md"]);
  assert.deepEqual(r.entrypoints,[]);
  assert.deepEqual(r.findings,[]);
});
test("invalid manifests cannot silently supply invented interface evidence", () => {
  const r=assessPackageSurface({packageJson:"{oops",trackedPaths:[]});
  assert.equal(r.findings[0].rule,"package-json-invalid");
  assert.equal(r.observed.name,null);
});
test("absence of a package manifest is not failure for a pure knowledge repository", () => {
  const r=assessPackageSurface({trackedPaths:["README.md"]});
  assert.equal(r.present,false);
  assert.deepEqual(r.findings,[]);
});
