import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { censusLayout, relocate, reportLayout } from "../src/layout.mjs";
import { loadNorms } from "../src/naming.mjs";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" });
const scratch = new URL("../data/state/temporary-state/", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();
const RULE = "documents-under-content-text";

/** A parent repository with the submodule `services/child`, each holding the files given as { path: text }. */
function forest(t, { parent = {}, child = {} } = {}) {
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, "layout-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const seed = (name, files, children) => {
    const work = join(base, `${name}-seed`);
    git(base, "init", "-q", "-b", "main", work);
    for (const [path, text] of Object.entries({ file: `${name}\n`, ...files })) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    git(work, "add", "--all");
    for (const [path, origin] of children) git(work, "submodule", "add", "-q", origin, path);
    git(work, "commit", "-qm", name);
    return work;
  };
  const childSeed = seed("child", child, []);
  const parentSeed = seed("parent", parent, [["services/child", childSeed]]);
  git(base, "clone", "-q", "--recurse-submodules", parentSeed, "parent");
  const root = join(base, "parent");
  git(join(root, "services/child"), "checkout", "-q", "main");
  return { root, child: join(root, "services/child") };
}

const rows = (root, options = {}) => [...relocate(root, { rule: RULE, ...options })];
const read = (directory, path) => readFileSync(join(directory, path), "utf8");
const status = (directory) => git(directory, "status", "--porcelain", "--ignore-submodules=all").split("\n").filter(Boolean).map((line) => line.replace(/\s+/gu, " ").trim()).sort();

test("the rules are data: norms.json maps each path variant to its canonical path", () => {
  const { relocations, skip, positions } = loadNorms().layout;
  assert.deepEqual(relocations.find((entry) => entry.rule === RULE), { ...relocations.find((entry) => entry.rule === RULE), from: "content/documents", to: "content/text/documents" });
  const held = relocations.find((entry) => entry.from === "data/records/schema");
  assert.equal(held.to, "data/records/schemas");
  assert.ok(held.hold);
  assert.deepEqual(skip, [".git", "node_modules", "data/state", "lib/legacy"]);
  assert.ok(positions.includes("") && positions.includes("content/text/documents"));
});

test("the check finds each variant directory in the repository that owns it, at any depth, and skips legacy, state and node_modules", (t) => {
  const { root, child } = forest(t, {
    parent: {
      "content/documents/a.md": "a\n",
      "lib/unit/content/documents/deep.md": "deep\n",
      "lib/legacy/content/documents/old.md": "old\n",
      "data/state/content/documents/scratch.md": "scratch\n",
      "node_modules/x/content/documents/dep.md": "dep\n",
      "data/records/schema/s.json": "{}\n",
    },
    child: {
      "content/documents/same.md": "same\n",
      "content/documents/differs.md": "variant\n",
      "content/documents/only.md": "only\n",
      "content/text/documents/same.md": "same\n",
      "content/text/documents/differs.md": "canonical\n",
    },
  });
  const found = [...reportLayout(root)];
  assert.deepEqual(found, [
    { rule: RULE, repository: root, found: "content/documents", canonical: "content/text/documents", files: 1, canonicalExists: false, collisions: 0 },
    { rule: "schemas-under-data-records", repository: root, found: "data/records/schema", canonical: "data/records/schemas", files: 1, canonicalExists: false, collisions: 0, hold: "ruled but not yet ordered applied" },
    { rule: RULE, repository: root, found: "lib/unit/content/documents", canonical: "lib/unit/content/text/documents", files: 1, canonicalExists: false, collisions: 0 },
    { rule: RULE, repository: child, found: "content/documents", canonical: "content/text/documents", files: 3, canonicalExists: true, collisions: 1 },
  ]);
  assert.equal([...reportLayout(root, { rule: RULE })].length, 3);
  assert.deepEqual(status(root), []);
});

test("the fix is a dry run until --apply, then moves with git mv, merges, drops identical copies and keeps differing ones", (t) => {
  const { root, child } = forest(t, {
    parent: { "content/documents/a.md": "a\n", "content/documents/articles/b.md": "b\n" },
    child: {
      "content/documents/same.md": "same\n",
      "content/documents/differs.md": "variant\n",
      "content/documents/sub/only.md": "only\n",
      "content/text/documents/same.md": "same\n",
      "content/text/documents/differs.md": "canonical\n",
    },
  });
  writeFileSync(join(child, "content/documents/untracked.md"), "untracked\n");
  const dry = rows(root).filter((row) => row.kind === "relocation");
  assert.deepEqual(dry.map((row) => [row.outcome, row.moved, row.dropped, row.kept.map((kept) => kept.file)]), [["would move", 2, 0, []], ["would move", 2, 1, ["content/documents/differs.md"]]]);
  assert.deepEqual(status(root), []);
  assert.deepEqual(status(child), ["?? content/documents/untracked.md"]);

  const applied = rows(root, { apply: true }).filter((row) => row.kind === "relocation");
  assert.deepEqual(applied.map((row) => [row.outcome, row.moved, row.dropped, row.untracked ?? 0]), [["moved", 2, 0, 0], ["moved", 2, 1, 1]]);
  assert.deepEqual(applied[1].kept, [{ file: "content/documents/differs.md", canonical: "content/text/documents/differs.md" }]);
  assert.equal(existsSync(join(root, "content/documents")), false);
  assert.deepEqual(status(root), ["R content/documents/a.md -> content/text/documents/a.md", "R content/documents/articles/b.md -> content/text/documents/articles/b.md"]);
  // The differing file stays and keeps its content on both sides; the identical copy and the emptied directory are gone.
  assert.deepEqual(readdirSync(join(child, "content/documents")), ["differs.md"]);
  assert.equal(read(child, "content/documents/differs.md"), "variant\n");
  assert.equal(read(child, "content/text/documents/differs.md"), "canonical\n");
  assert.equal(read(child, "content/text/documents/untracked.md"), "untracked\n");
  assert.deepEqual(status(child), ["?? content/text/documents/untracked.md", "D content/documents/same.md", "R content/documents/sub/only.md -> content/text/documents/sub/only.md"]);
  // A second pass has only the collision left, and moves nothing.
  assert.deepEqual([...reportLayout(root, { rule: RULE })].map((row) => [row.found, row.files, row.collisions]), [["content/documents", 1, 1]]);
  assert.deepEqual(rows(root, { apply: true }).map((row) => [row.kind, row.moved, row.kept.length]), [["relocation", 0, 1]]);
});

test("references that provably name a moved path are rewritten; the rest are listed", (t) => {
  const { root } = forest(t, {
    parent: {
      "content/documents/a.md": "[sibling](b.md) [up](../../README.md) [glossary](../text/glossary/term.md) [web](https://example.invalid/content/documents/a.md)\n",
      "content/documents/b.md": "b\n",
      "content/text/glossary/term.md": "[a](../../documents/a.md)\n",
      "lib/unit/content/documents/kept.md": "variant\n",
      "lib/unit/content/text/documents/kept.md": "canonical\n",
      "lib/unit/README.md": "[kept](content/documents/kept.md) in [dir](content/documents/)\n",
      "README.md": "[a](content/documents/a.md), [dir](./content/documents/), `content/documents/b.md`, never bare content/documents, see content/documents/missing.md and /srv/content/documents/a.md\n",
      "package.json": `${JSON.stringify({ files: ["content/documents"], scripts: { read: "cat content/documents/b.md" } }, null, 2)}\n`,
      "scripts/read.mjs": "const a = '../content/documents/a.md'; const d = join(root, \"content\", \"documents\");\n",
      "lib/legacy/old.md": "[a](../../content/documents/a.md)\n",
    },
  });
  const dry = rows(root).find((row) => row.kind === "references");
  assert.equal(dry.outcome, "would rewrite");
  assert.equal(read(root, "README.md").includes("content/text/documents"), false);
  const { rewritten, remaining } = rows(root, { apply: true }).find((row) => row.kind === "references");
  assert.deepEqual(dry.rewritten, rewritten);
  assert.deepEqual(dry.remaining, remaining);
  assert.equal(read(root, "content/text/documents/a.md"), "[sibling](b.md) [up](../../../README.md) [glossary](../glossary/term.md) [web](https://example.invalid/content/documents/a.md)\n");
  assert.equal(read(root, "content/text/glossary/term.md"), "[a](../documents/a.md)\n");
  assert.equal(read(root, "README.md"), "[a](content/text/documents/a.md), [dir](./content/text/documents/), `content/text/documents/b.md`, never bare content/documents, see content/documents/missing.md and /srv/content/documents/a.md\n");
  assert.deepEqual(JSON.parse(read(root, "package.json")), { files: ["content/text/documents"], scripts: { read: "cat content/text/documents/b.md" } });
  assert.equal(read(root, "scripts/read.mjs"), "const a = '../content/text/documents/a.md'; const d = join(root, \"content\", \"documents\");\n");
  assert.equal(read(root, "lib/unit/README.md"), "[kept](content/documents/kept.md) in [dir](content/documents/)\n");
  assert.equal(read(root, "lib/legacy/old.md"), "[a](../../content/documents/a.md)\n");
  assert.deepEqual(remaining.map((row) => [row.file, row.text, row.reason]), [
    ["README.md", "content/documents", "names the variant directory itself; a reader decides"],
    ["README.md", "content/documents/missing.md", "names no path this relocation moved"],
    ["README.md", "srv/content/documents/a.md", "absolute path or URL"],
    ["content/text/documents/a.md", "example.invalid/content/documents/a.md", "absolute path or URL"],
    ["lib/unit/README.md", "content/documents/kept.md", "names a path a collision left in place"],
    ["lib/unit/README.md", "content/documents/", "names a path a collision left in place"],
    ["scripts/read.mjs", "content\", \"documents", "path assembled from segments"],
  ]);
  assert.deepEqual(rewritten.map((row) => `${row.file}: ${row.from} -> ${row.to}`), [
    "README.md: content/documents/a.md -> content/text/documents/a.md",
    "README.md: ./content/documents/ -> ./content/text/documents/",
    "README.md: content/documents/b.md -> content/text/documents/b.md",
    "content/text/documents/a.md: ../../README.md -> ../../../README.md",
    "content/text/documents/a.md: ../text/glossary/term.md -> ../glossary/term.md",
    "content/text/glossary/term.md: ../../documents/a.md -> ../documents/a.md",
    "package.json: content/documents -> content/text/documents",
    "package.json: content/documents/b.md -> content/text/documents/b.md",
    "scripts/read.mjs: ../content/documents/a.md -> ../content/text/documents/a.md",
  ]);
});

test("the fix refuses a held rule, an unknown rule, and a variant directory that holds a repository", (t) => {
  const { root } = forest(t, { parent: { "data/records/schema/s.json": "{}\n" }, child: {} });
  assert.throws(() => rows(root, { rule: "schemas-under-data-records", apply: true }), /is held/u);
  assert.throws(() => rows(root, { rule: "no-such-rule" }), /no layout rule named/u);
  assert.equal(existsSync(join(root, "data/records/schema/s.json")), true);
  mkdirSync(join(root, "content/documents/nested"), { recursive: true });
  git(join(root, "content/documents/nested"), "init", "-q", "-b", "main");
  assert.deepEqual(rows(root, { apply: true }).map((row) => [row.outcome, row.reason]), [["refused", "the variant directory holds a nested repository"]]);
});

test("the census counts directory names at each layout position and proposes a canonical for each variant", (t) => {
  const { root } = forest(t, {
    parent: {
      "content/glossary/term.md": "t\n",
      "content/text/glossary/a.md": "a\n",
      "content/text/glossary/b.md": "b\n",
      "schemas/s.json": "{}\n",
      "data/records/schema/s.json": "{}\n",
      "data/records/requirement-records/r.json": "{}\n",
      "data/records/service_records/r.json": "{}\n",
      "content/world/w.json": "{}\n",
      "lib/legacy/content/x.md": "x\n",
    },
    child: {
      "content/text/glossary/c.md": "c\n",
      "data/records/requirements-records/r1.json": "{}\n",
      "data/records/requirements-records/r2.json": "{}\n",
      "data/records/service-records/a/r.json": "{}\n",
      "world/w.json": "{}\n",
      "world/x.json": "{}\n",
    },
  });
  const census = [...censusLayout(root)];
  const names = census.filter((row) => row.kind === "name");
  assert.deepEqual(names.find((row) => row.position === "content/text" && row.name === "glossary"), { kind: "name", position: "content/text", name: "glossary", repositories: 2, files: 3, standard: true });
  assert.deepEqual(names.find((row) => row.name === "world" && row.position === ""), { kind: "name", position: "", name: "world", repositories: 1, files: 2 });
  assert.equal(names.some((row) => row.name === "legacy" || row.name === "child"), false);
  const candidates = Object.fromEntries(census.filter((row) => row.kind === "candidate").map((row) => [row.variant, row]));
  assert.deepEqual(Object.keys(candidates).sort(), ["content/glossary", "content/world", "data/records/requirement-records", "data/records/schema", "data/records/service_records", "schemas"]);
  // The seat the services section form states wins, whatever the counts.
  assert.deepEqual(candidates["content/glossary"], { kind: "candidate", variant: "content/glossary", canonical: "content/text/glossary", reasons: ["same name at two depths"], repositories: 1, files: 1, canonicalRepositories: 2, canonicalFiles: 3, basis: "the services section form seats it there" });
  assert.deepEqual([candidates.schemas.canonical, candidates.schemas.reasons, candidates.schemas.canonicalRepositories], ["data/records/schemas", ["same name at two depths"], 0]);
  assert.deepEqual([candidates["data/records/service_records"].canonical, candidates["data/records/service_records"].reasons], ["data/records/service-records", ["hyphen, underscore or case"]]);
  // A ruling in norms.json wins over everything, and says when it is held.
  assert.deepEqual([candidates["data/records/schema"].canonical, candidates["data/records/schema"].reasons, candidates["data/records/schema"].basis], ["data/records/schemas", ["singular and plural"], "ruled: schemas-under-data-records (held)"]);
  // Where nothing is stated, the form more repositories (then more files) use is proposed.
  assert.deepEqual([candidates["data/records/requirement-records"].canonical, candidates["data/records/requirement-records"].reasons, candidates["data/records/requirement-records"].basis], ["data/records/requirements-records", ["singular and plural"], "more repositories use it"]);
  assert.deepEqual([candidates["content/world"].canonical, candidates["content/world"].basis], ["world", "more repositories use it"]);
  assert.deepEqual(census.at(-1), { kind: "summary", repositories: 2, positions: loadNorms().layout.positions, candidates: 6 });
  assert.deepEqual(status(root), []);
});
