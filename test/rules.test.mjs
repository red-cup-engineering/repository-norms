import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { commitAndPushRepositories } from "@red-cup-engineering/git-engine/commit-and-push-repositories";
import { loadNorms } from "../src/naming.mjs";
import { checkAll, checkForbidden, checkMounts, checkNesting, checkStaged, checkSubjects, globToRegExp, removePaths, repositoryOfUrl } from "../src/rules.mjs";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" });
const scratch = new URL("../data/state/temporary-state/", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" }).trim();
const write = (directory, files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), text); } };
const collect = async (rows) => { const all = []; for await (const row of rows) all.push(row); return all; };

/** Bare origins for a parent and the submodule it mounts at `services/child`, cloned recursively at `parent`, each holding the files given. */
function forest(t, { parent = {}, child = {} } = {}) {
  mkdirSync(scratch, { recursive: true });
  const base = mkdtempSync(join(scratch, "rules-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const seed = (name, files, children) => {
    git(base, "init", "-q", "--bare", "-b", "main", `${name}.git`);
    const work = join(base, `${name}-seed`);
    git(base, "init", "-q", "-b", "main", work);
    write(work, { file: `${name}\n`, ...files });
    git(work, "add", "--all");
    for (const [path, origin] of children) git(work, "submodule", "add", "-q", join(base, `${origin}.git`), path);
    git(work, "commit", "-qm", name);
    git(work, "push", "-q", join(base, `${name}.git`), "main");
  };
  seed("child", child, []);
  seed("other", {}, []);
  seed("parent", parent, [["services/child", "child"]]);
  git(base, "clone", "-q", "--recurse-submodules", join(base, "parent.git"), "parent");
  const root = join(base, "parent");
  git(join(root, "services/child"), "checkout", "-q", "main");
  return { base, root, child: join(root, "services/child"), origin: (name) => join(base, `${name}.git`) };
}

const OWNER = "services/child/content/characters/ada-vane";
const NORMS = {
  ...loadNorms(),
  mounts: {
    onePerRepository: { rule: "one-mount-per-repository", except: [] },
    rules: [
      { rule: "child-in-services", name: "child", allowed: ["services/child"] },
      { rule: "no-other", repository: "*/other", allowed: [] },
      { rule: "one-kept", name: "kept-*-section", except: ["kept-good-section"], allowed: [] },
    ],
  },
  subjects: { skip: [".git", "node_modules"], rules: [{ subject: "ada-vane", owner: OWNER }] },
};

test("the placement rules are data: mounts, one mount per repository, nesting, subject owners and forbidden path globs with a mode", () => {
  const norms = loadNorms();
  assert.deepEqual(norms.mounts.rules.map((row) => [row.repository ?? row.name, row.allowed, row.except]), [
    ["561-group/bare-cedar-fog.colonies.union.561.group", ["sites/bare-cedar-fog.colonies.union.561.group"], undefined],
    ["561-group/cold-red-gate", [], undefined],
    ["561-group/cold-red-gate.colonies.union.561.group", [], undefined],
    ["*relationality-repo*", [], undefined],
    ["relationality-*-services-section", [], ["relationality-science-services-section"]],
  ]);
  assert.deepEqual(norms.mounts.onePerRepository, { rule: "one-mount-per-repository", sameName: true, except: [] });
  assert.deepEqual([norms.nesting.words, norms.nesting.engineCodes], [true, ["SS003", "SS004", "SS005"]]);
  assert.deepEqual(norms.subjects.rules.map((row) => [row.subject, row.owner.split("/").pop()]), [["cassia-lorne", "cassia-lorne-services-section"], ["codi-obrien", "codi-obrien"], ["sigmund-vexler", "sigmund-vexler-services-section"]]);
  const modes = Object.fromEntries(norms.layout.forbidden.paths.map((row) => [row.path, `${row.type} ${row.mode}`]));
  assert.deepEqual(modes, {
    NOTICE: "file remove", LICENSE: "file remove", "**/content/config/capability-providers.json": "file remove", "**/*.nq": "file remove",
    "repository-selected-main-reconciliation.ndjson": "file remove", "lib/agency/skills/*/scripts": "directory remove",
    "lib/agency": "directory refuse", triage: "directory refuse", _archive: "directory refuse", "lib/legacy/restored-from-main": "directory refuse", "content/documents": "directory refuse", "data/records/schema": "directory refuse",
  });
});

test("a path glob keeps * within one name, lets ** span names, and is read at any depth unless it starts with /", () => {
  const any = (glob) => globToRegExp(glob, { anyDepth: true });
  assert.deepEqual(["triage", "lib/unit/triage", "triage-notes", "lib/triage/x"].map((path) => any("triage").test(path)), [true, true, false, false]);
  assert.deepEqual(["lib/agency/skills/a/scripts", "x/lib/agency/skills/a/scripts", "lib/agency/skills/a/b/scripts"].map((path) => any("lib/agency/skills/*/scripts").test(path)), [true, true, false]);
  assert.deepEqual(["a.nq", "data/deep/a.nq", "a.nqx"].map((path) => any("**/*.nq").test(path)), [true, true, false]);
  assert.deepEqual(["LICENSE", "lib/LICENSE"].map((path) => any("/LICENSE").test(path)), [true, false]);
  assert.deepEqual(["https://github.com/561-group/cold-red-gate.git", "git@github.com:561-group/cold-red-gate", "/tmp/x/child.git/"].map(repositoryOfUrl), ["561-group/cold-red-gate", "561-group/cold-red-gate", "x/child"]);
});

test("forbidden paths are found as files and directories at any depth; remove rows are removed, refuse rows and directories holding a repository never", (t) => {
  const { root, child } = forest(t, {
    parent: {
      "triage/a.md": "a\n", "lib/unit/_archive/b.md": "b\n", "lib/legacy/restored-from-main/c.md": "c\n", "content/documents/d.md": "d\n",
      "content/config/capability-providers.json": "{}\n", "lib/agency/skills/reading/scripts/run.sh": "x\n", "lib/agency/skills/reading/SKILL.md": "s\n",
      "data/records/graph.nq": "q\n", "node_modules/x/triage/dep.md": "dep\n", "triage.md": "a file\n",
    },
    child: { "data/records/schema/s.json": "{}\n", LICENSE: "l\n" },
  });
  mkdirSync(join(child, "lib/agency/skills/holding/scripts"), { recursive: true });
  git(join(child, "lib/agency/skills/holding/scripts"), "init", "-q", "-b", "main", "nested");
  const found = (apply) => [...checkForbidden(root, { apply })].map((row) => `${row.repository === child ? "child" : "parent"} ${row.file ?? `${row.directory}/`} ${row.outcome}`).sort();
  assert.deepEqual(found(false), [
    "child LICENSE would remove", "child data/records/schema/ refused", "child lib/agency/ refused", "child lib/agency/skills/holding/scripts/ would remove",
    "parent content/config/capability-providers.json would remove", "parent content/documents/ refused", "parent data/records/graph.nq would remove",
    "parent lib/agency/ refused", "parent lib/agency/skills/reading/scripts/ would remove", "parent lib/legacy/restored-from-main/ refused", "parent lib/unit/_archive/ refused", "parent triage/ refused",
  ]);
  assert.deepEqual(found(true), [
    "child LICENSE removed", "child data/records/schema/ refused", "child lib/agency/ refused", "child lib/agency/skills/holding/scripts/ failed",
    "parent content/config/capability-providers.json removed", "parent content/documents/ refused", "parent data/records/graph.nq removed",
    "parent lib/agency/ refused", "parent lib/agency/skills/reading/scripts/ removed", "parent lib/legacy/restored-from-main/ refused", "parent lib/unit/_archive/ refused", "parent triage/ refused",
  ]);
  assert.deepEqual(["triage/a.md", "lib/unit/_archive/b.md", "lib/legacy/restored-from-main/c.md", "content/documents/d.md", "lib/agency/skills/reading/SKILL.md", "node_modules/x/triage/dep.md", "triage.md"].map((path) => existsSync(join(root, path))), Array(7).fill(true));
  assert.ok(existsSync(join(child, "lib/agency/skills/holding/scripts/nested/.git")) && !existsSync(join(root, "lib/agency/skills/reading/scripts")));
});

test("a mount is checked against the rules by its remote and its name, and a repository mounted twice is reported with every path", (t) => {
  const { root, origin } = forest(t);
  assert.deepEqual([...checkMounts(root, { norms: NORMS })], []);
  git(root, "submodule", "add", "-q", origin("child"), "lib/child");
  git(root, "submodule", "add", "-q", origin("other"), "services/other");
  const rows = [...checkMounts(root, { norms: NORMS })];
  assert.deepEqual(rows.map((row) => [row.kind, row.rule, row.mounted ?? row.mounts]), [
    ["mount", "child-in-services", "lib/child"],
    ["mount", "no-other", "services/other"],
    ["duplicate-mount", "one-mount-per-repository", ["lib/child", "services/child"]],
  ]);
  assert.deepEqual([rows[2].by, rows[2].urls], ["url", [origin("child")]]);
  const twice = (one) => [...checkMounts(root, { norms: { ...NORMS, mounts: { rules: [], onePerRepository: { rule: "one", ...one } } }, mounts: [["a/board", "https://github.com/x/board.git"], ["b/board", "https://github.com/y/board"], ["a/.github", "https://github.com/x/.github"], ["b/.github", "https://github.com/x/.github"]].map(([mounted, url]) => ({ mounted, url })) })].map((row) => [row.by, row.mounts]);
  assert.deepEqual([twice({}), twice({ sameName: true }), twice({ sameName: true, except: ["board"] })], [[], [["name", ["a/board", "b/board"]]], []], "the same name in two organizations is one repository only with sameName; a meta repository may stand in several places");
  const named = (mounted, url) => [...checkMounts(root, { norms: NORMS, mounts: [{ repository: root, path: mounted, mounted, url }] })].map((row) => row.rule);
  assert.deepEqual([named("services/kept-bad-section", "https://github.com/x/kept-bad-section"), named("services/kept-good-section", "https://github.com/x/kept-good-section.git"), named("services/renamed", "https://github.com/x/kept-bad-section")], [["one-kept"], [], ["one-kept"]]);
});

test("nesting is the law's derive-section-path placement, called once: a section its name places elsewhere, or seats more specifically than its name says, is reported with the derived path", async () => {
  const norms = { ...loadNorms(), nesting: { rule: "name-specialises-parent", words: true, engineCodes: ["SS003", "SS004", "SS005"], except: ["storage-engineering-services-section"], candidates: 3 } };
  const root = "services/engineering-services-section", computer = `${root}/services/computer-engineering-services-section`, data = `${computer}/services/computer-data-engineering-services-section`;
  const sections = [root, computer, data, `${data}/services/computer-indigenous-data-engineering-services-section`, `${data}/services/computer-mystery-engineering-services-section`, `${computer}/services/storage-engineering-services-section`, `${root}/services/computer-data-engineering-services-section`]
    .map((path) => ({ path, name: path.split("/").pop() }));
  const rows = await collect(checkNesting("/nowhere", { norms, sections }));
  assert.deepEqual(rows.map((row) => [row.name, row.parent.split("/").pop(), row.reasons.map((reason) => reason.split(" ")[0]), row.candidates.map((path) => path.split("/").pop())]), [
    ["computer-data-engineering-services-section", "engineering-services-section", ["SS003"], ["computer-data-engineering-services-section"]],
    ["computer-mystery-engineering-services-section", "computer-data-engineering-services-section", ["SS005"], ["computer-mystery-data-engineering-services-section"]],
  ]);
  assert.equal(rows[0].candidates[0], data);
  // A name that does not carry its parent's words but is placed where the law derives it is not a finding of this package's own.
  assert.deepEqual(await collect(checkNesting("/nowhere", { norms, sections: sections.slice(0, 5).filter((row) => !row.name.includes("mystery") && row.path !== sections[6].path) })), []);
});

test("a file or directory named for a subject outside its owning section is reported, a directory once; a missing owner is reported", async (t) => {
  const { root } = forest(t, {
    parent: { "content/characters/ada-vane/bio.md": "b\n", "content/characters/ada-vane/voice.md": "v\n", "lib/legacy/notes/Ada_Vane-notes.md": "n\n", "content/AdaVane.png": "p\n", "node_modules/x/ada-vane.md": "dep\n", "content/ada.md": "no\n" },
    child: { "content/characters/ada-vane/bio.md": "owned\n", "data/records/ada-vane.json": "{}\n" },
  });
  const rows = await collect(checkSubjects(root, { norms: NORMS }));
  assert.deepEqual(rows.map((row) => [row.found, row.type, row.files]), [
    ["content/AdaVane.png", "file", 1], ["content/characters/ada-vane", "directory", 2], ["lib/legacy/notes/Ada_Vane-notes.md", "file", 1], ["services/child/data/records/ada-vane.json", "file", 1],
  ]);
  const missing = await collect(checkSubjects(root, { norms: { ...NORMS, subjects: { rules: [{ subject: "nobody-here", owner: "services/absent" }] } } }));
  assert.deepEqual(missing, [{ kind: "subject-owner", subject: "nobody-here", owner: "services/absent", outcome: "owner missing" }]);
});

test("check-all gives every finding its class, and a class whose check cannot run is a finding", async (t) => {
  const { root, origin } = forest(t, { parent: { "triage/a.md": "a\n", "content/documents/d.md": "d\n", "notes/ada-vane.md": "n\n" } });
  git(root, "submodule", "add", "-q", origin("other"), "services/other");
  const count = (rows) => rows.reduce((counts, row) => ({ ...counts, [row.class]: (counts[row.class] ?? 0) + 1 }), {});
  assert.deepEqual(count(await collect(checkAll(root, { norms: NORMS, only: ["mounts", "subjects", "forbidden", "layout", "manifests", "readmes"] }))), { mounts: 1, subjects: 2, forbidden: 2, layout: 1 });
  const [row] = await collect(checkAll(root, { norms: NORMS, only: ["section-form"] }));
  assert.deepEqual([row.class, row.outcome], ["section-form", "check failed"]);
});

test("the staged check reads only what a commit adds or modifies: standing violations, deletions and moves away pass", (t) => {
  const { root, child } = forest(t, { child: { "content/documents/old.md": "old\n", "triage/old.md": "old\n" } });
  const staged = (directory, options = {}) => checkStaged(directory, { norms: NORMS, ...options }).map((row) => `${row.class} ${row.rule ?? row.subject} ${row.file ?? row.directory ?? row.found}`).sort();
  write(child, { "src/new.mjs": "x\n" });
  git(child, "add", "--all");
  assert.deepEqual(staged(child), [], "standing violations do not block an unrelated commit");
  write(child, { "content/documents/x.md": "x\n", "lib/unit/triage/y.md": "y\n", LICENSE: "l\n", "notes/Ada_Vane.md": "n\n", "content/characters/ada-vane/bio.md": "owned\n", "lib/legacy/content/documents/z.md": "z\n" });
  git(child, "add", "--all");
  assert.deepEqual(staged(child), [
    "forbidden no-content-documents content/documents", "forbidden no-content-documents lib/legacy/content/documents", "forbidden no-license LICENSE", "forbidden no-triage lib/unit/triage",
    "layout documents-under-content-text content/documents", "subjects ada-vane services/child/notes/Ada_Vane.md",
  ]);
  assert.deepEqual(staged(child, { root: child }).filter((row) => row.startsWith("subjects")), ["subjects ada-vane content/characters/ada-vane", "subjects ada-vane notes/Ada_Vane.md"], "owner paths are read from the superrepository root");
  git(child, "reset", "-q", "--hard");
  git(child, "rm", "-q", "triage/old.md");
  mkdirSync(join(child, "content/text/documents"), { recursive: true });
  git(child, "mv", "content/documents/old.md", "content/text/documents/old.md");
  assert.deepEqual(staged(child), []);
  const tree = git(child, "write-tree");
  assert.deepEqual(staged(child, { base: tree, tree: git(child, "rev-parse", "HEAD^{tree}") }), ["forbidden no-content-documents content/documents", "forbidden no-triage triage", "layout documents-under-content-text content/documents"], "between two trees: putting them back is refused");
  assert.equal(git(root, "status", "--porcelain", "--ignore-submodules=all"), "");
});

test("the staged check reads the mounts a commit adds: the mount rules, a second mount of one repository, and the placement its name derives; a moved pointer is not a mount", (t) => {
  const { root, child, origin } = forest(t);
  const norms = { ...NORMS, nesting: { rule: "name-specialises-parent", words: true } };
  const staged = (directory) => checkStaged(directory, { norms }).map((row) => `${row.class} ${row.rule} ${row.mounted ?? row.mounts ?? row.path}`).sort();
  write(child, { file: "moved\n" });
  git(child, "commit", "-qam", "moved");
  git(root, "add", "services/child");
  assert.deepEqual(staged(root), []);
  git(root, "submodule", "add", "-q", origin("other"), "services/other");
  git(root, "submodule", "add", "-q", origin("child"), "lib/child");
  assert.deepEqual(staged(root), ["duplicate-mounts one-mount-per-repository lib/child,services/child", "mounts child-in-services lib/child", "mounts no-other services/other"]);
  git(root, "commit", "-qm", "mounted");
  assert.deepEqual(staged(root), []);
  // Its name places it under services/engineering-services-section; standing at the top of services/, the law's derivation puts it elsewhere.
  git(root, "submodule", "add", "-q", join(dirname(origin("other")), "other.git"), "services/computer-engineering-services-section");
  assert.deepEqual(staged(root).filter((row) => row.startsWith("nesting")), ["nesting name-specialises-parent services/computer-engineering-services-section"]);
});

test("through git-engine's commit pass: a repository adding a violating path is refused, deleting it passes, and a parent adding a forbidden mount is refused", (t) => {
  const { root, child, origin } = forest(t);
  const pass = () => [...commitAndPushRepositories(root, { message: "Change", apply: true, norms: (request) => checkStaged(request.directory, { ...request, norms: NORMS }) })].map((row) => [row.outcome, (row.findings ?? []).map((finding) => `${finding.class} ${finding.rule}`).sort()]);
  write(child, { "content/documents/x.md": "x\n" });
  write(root, { file: "changed\n" });
  const before = git(origin("child"), "rev-parse", "main");
  assert.deepEqual(pass(), [["refused: norms", ["forbidden no-content-documents", "layout documents-under-content-text"]], ["committed and pushed", []]]);
  assert.deepEqual([git(origin("child"), "rev-parse", "main"), git(child, "rev-parse", "HEAD")], [before, before]);
  git(child, "add", "--all");
  git(child, "commit", "-qm", "by hand");
  assert.equal(pass()[0][0], "refused: norms", "a commit made by hand is refused at the push");
  rmSync(join(child, "content/documents"), { recursive: true });
  assert.deepEqual(pass(), [["committed and pushed", []], ["committed and pushed", []]]);
  assert.equal(git(origin("child"), "ls-tree", "-r", "--name-only", "main"), "file");
  git(root, "submodule", "add", "-q", origin("other"), "services/other");
  git(join(root, "services/other"), "checkout", "-q", "main");
  const rows = pass();
  assert.deepEqual(rows.at(-1), ["refused: norms", ["mounts no-other"]], JSON.stringify(rows));
  assert.equal(git(origin("parent"), "ls-tree", "main", "services/other"), "");
});

test("listed paths are removed from the worktree only with apply; a path outside the root, in a .git, a repository or a directory holding one is refused", async (t) => {
  const { root, child } = forest(t, { parent: { "data/old/a.md": "a\n", "data/old/deep/b.md": "b\n", "notes/c.md": "c\n", "lib/keep.md": "k\n" } });
  const paths = ["data/old", "notes/c.md", "absent/file", "../outside", ".git/config", "services/child", "services", "services/child/file", "", "data/../lib/keep.md"];
  const run = async (apply) => (await collect(removePaths(root, paths.map((path) => ({ path })), { apply }))).map((row) => `${row.path} ${row.outcome}${row.reason ? `: ${row.reason}` : ""}`);
  const refused = ["../outside refused: outside the root", ".git/config refused: inside a .git", "services/child refused: a mounted repository", "services refused: holds a repository"];
  assert.deepEqual(await run(false), ["data/old would remove", "notes/c.md would remove", "absent/file missing", ...refused, "services/child/file would remove", " refused: the root itself", "data/../lib/keep.md would remove"]);
  assert.ok(existsSync(join(root, "data/old/a.md")));
  assert.deepEqual(await run(true), ["data/old removed", "notes/c.md removed", "absent/file missing", ...refused, "services/child/file removed", " refused: the root itself", "data/../lib/keep.md removed"]);
  assert.deepEqual(["data/old", "notes/c.md", "lib/keep.md", "services/child/file", "services/child/.git", ".git"].map((path) => existsSync(join(root, path))), [false, false, false, false, true, true]);
  assert.deepEqual([git(root, "diff", "--cached", "--name-only"), git(child, "status", "--porcelain")], ["", "D file"], "nothing is staged");
  assert.deepEqual(await collect(removePaths(root, [{ nothing: 1 }])), [{ path: null, outcome: "refused", reason: "no path" }]);
});

test("this package holds no placement rule of its own: norms.json is naming settings, every rule is the section law's", async () => {
  const { readFileSync } = await import("node:fs");
  const own = JSON.parse(readFileSync(new URL("../norms.json", import.meta.url), "utf8"));
  for (const rule of ["layout", "mounts", "nesting", "subjects", "forbidden", "manifests", "bareReadmes", "relocations"]) assert.equal(own[rule], undefined, rule);
  const norms = loadNorms();
  for (const rule of ["layout", "mounts", "nesting", "subjects"]) assert.ok(norms[rule], rule);
  assert.ok(norms.mounts.rules.some((row) => row.rule === "no-cold-red-gate"));
});
