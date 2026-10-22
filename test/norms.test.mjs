import test from "node:test";
import assert from "node:assert/strict";
import { classifyName } from "../src/naming.mjs";
import { checkSubmodules, parseGitmodules } from "../src/submodules.mjs";

test("a section names its organization's domain, as suffix or the organization's established prefix", () => {
  assert.deepEqual(classifyName("red-cup-engineering", "polymarket-services-section"),
    { kind: "section", ok: false, proposed: "polymarket-engineering-services-section", reason: "a engineering section names its domain" });
  assert.equal(classifyName("red-cup-engineering", "computer-engineering-services-section").ok, true);
  assert.equal(classifyName("lenticule-science", "math-services-section").proposed, "math-science-services-section");
  assert.equal(classifyName("lenticule-science", "information-science-services-section").ok, true);
  assert.equal(classifyName("coesite-operations", "agent-services-section").proposed, "agent-operations-services-section");
  assert.equal(classifyName("causeway-services", "health-education-curriculum-services-section").proposed, "public-health-education-curriculum-services-section");
  assert.equal(classifyName("causeway-services", "public-computer-services-section").ok, true);
  assert.equal(classifyName("561-group", "561-group-computer-services-section").ok, true);
  assert.equal(classifyName("561-group", "bare-cedar-fog-services-section").proposed, "561-group-bare-cedar-fog-services-section");
});

test("the domain roots, applications, libraries, services and the .github repository keep their names", () => {
  for (const [o, n] of [["red-cup-engineering", "engineering-services-section"], ["causeway-services", "public-services-section"],
    ["red-cup-engineering", "signcraft"], ["red-cup-engineering", "trading-belief-service"], ["lenticule-science", ".github"]])
    assert.equal(classifyName(o, n).ok, true, `${o}/${n}`);
});

test("section suffix typos are corrected, and dated snapshots are archives", () => {
  assert.equal(classifyName("lenticule-science", "smart-materials-service-section").proposed, "smart-materials-science-services-section");
  assert.equal(classifyName("561-group", "bare-cedar-fog-colony-administrative-services-sector").proposed, "561-group-bare-cedar-fog-colony-administrative-services-section");
  assert.equal(classifyName("red-cup-engineering", "2026-08-04-fizzos-corpus").kind, "archive");
});

const modules = `[submodule "a"]
\tpath = services/a-engineering-services-section
\turl = https://github.com/red-cup-engineering/a-engineering-services-section.git
[submodule "services/b"]
\tpath = services/b
\turl = https://github.com/red-cup-engineering/b-engineering-services-section.git
[submodule "dup"]
\tpath = services/a-engineering-services-section
\turl = https://github.com/red-cup-engineering/a-engineering-services-section.git
[submodule "c"]
\tpath = lib/c
\turl = git@github.com:someone/c.git
`;
test("submodules are declared once, only where a gitlink is, from house https URLs, in directories named for them", () => {
  assert.equal(parseGitmodules(modules).length, 4);
  const rules = checkSubmodules({ gitmodules: modules, gitlinks: ["services/a-engineering-services-section", "services/b", "services/orphan"] }).map((f) => `${f.rule} ${f.path}`).sort();
  assert.deepEqual(rules, [
    "declaration-has-gitlink lib/c",
    "declared-once services/a-engineering-services-section",
    "directory-names-repository services/b",
    "gitlink-declared services/orphan",
    "https-github-url lib/c",
  ]);
  assert.deepEqual(checkSubmodules({ gitmodules: modules.split("[submodule \"services/b\"]")[0], gitlinks: ["services/a-engineering-services-section"] }), []);
});
