#!/usr/bin/env node
import { execGitSync } from "@red-cup-engineering/git-engine/git-process";
/**
 * repository-norms check [DIR] [--warn]      one checkout: its own name and its submodules (CI)
 * repository-norms estate --org ORG [...]    every non-archived repository name of the organizations (JSON lines)
 * repository-norms frontdoor [DIR] [--json] [--warn]    evidence-bound README entry-page observations
 * repository-norms layout [ROOT] [--rule RULE] [--warn]   every directory a layout rule relocates, under ROOT (JSON lines)
 * repository-norms relocate [ROOT] --rule RULE [--apply [--worktree]]  move one rule's directories onto their canonical paths (JSON lines)
 * repository-norms forbidden [ROOT] [--apply]               every file whose name is forbidden; --apply removes them (JSON lines)
 * repository-norms manifests [ROOT] [--apply]               every root manifest without Node.js source; --apply removes them (JSON lines)
 * repository-norms readmes [ROOT] [--apply]                 every README alone among directories; --apply removes them (JSON lines)
 * repository-norms remove-paths [ROOT] [--apply]            removes the paths listed on stdin as JSON lines {"path": …} relative to ROOT, from the worktree only (JSON lines)
 * repository-norms census [ROOT]                          directory names at the layout positions, and candidate rules (JSON lines)
 * repository-norms mounts [ROOT]                            every submodule mounted where a mount rule forbids it, or mounted twice (JSON lines)
 * repository-norms nesting [ROOT]                           every mounted section whose name does not specialise its parent's (JSON lines)
 * repository-norms subjects [ROOT]                          every file or directory named for a subject outside its owning section (JSON lines)
 * repository-norms check-all [ROOT] [--class CLASS]...      every rule class over the tree; exit 1 on any finding (JSON lines)
 * repository-norms check-staged [REPOSITORY] [--root ROOT] [--base REV] [--tree TREE]   what one commit would newly violate; exit 1 on any finding (JSON lines)
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { classifyName, loadNorms } from "../src/naming.mjs";
import { checkSubmodules } from "../src/submodules.mjs";
import { assessFrontdoor } from "../src/frontdoor.mjs";
import { censusLayout, relocate, reportLayout } from "../src/layout.mjs";
import { bareReadmes, forbiddenFiles, sourcelessManifests } from "../src/removals.mjs";
import { readFileSync } from "node:fs";
import { checkAll, checkMounts, checkNesting, checkStaged, checkSubjects, removePaths } from "../src/rules.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { org: { type: "string", multiple: true }, warn: { type: "boolean", default: false }, json: { type: "boolean", default: false }, rule: { type: "string" }, apply: { type: "boolean", default: false }, worktree: { type: "boolean", default: false }, root: { type: "string" }, base: { type: "string" }, tree: { type: "string" }, class: { type: "string", multiple: true } } });
const [command = "check", dir = "."] = positionals;
const norms = loadNorms();
const line = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
const git = (...a) => execGitSync(["-C", dir, ...a], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

if (command === "check") {
  const findings = [];
  const origin = (() => { try { return git("remote", "get-url", "origin").trim(); } catch { return ""; } })();
  const slug = process.env.GITHUB_REPOSITORY ?? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(origin)?.[1];
  if (slug) {
    const [owner, name] = slug.split("/");
    const named = classifyName(owner, name, norms);
    if (!named.ok) findings.push({ rule: "name", path: slug, detail: `${named.reason}: ${named.proposed}` });
  }
  const gitmodules = (() => { try { return git("show", "HEAD:.gitmodules"); } catch { return ""; } })();
  const gitlinks = git("ls-tree", "-r", "HEAD").split("\n").filter((l) => l.startsWith("160000 ")).map((l) => l.split("\t")[1]);
  findings.push(...checkSubmodules({ gitmodules, gitlinks, norms }));
  for (const f of findings) process.stdout.write(`${values.warn ? "warning" : "error"} ${f.rule}: ${f.path ?? ""} ${f.detail ?? ""}\n`);
  process.stdout.write(`${findings.length} finding(s) in ${slug ?? dir}\n`);
  if (findings.length && !values.warn) process.exitCode = 1;
} else if (command === "frontdoor") {
  const slug = process.env.GITHUB_REPOSITORY ?? (() => { try { return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(git("remote", "get-url", "origin").trim())?.[1]; } catch { return undefined; } })();
  const readme = (() => { try { return git("show", "HEAD:README.md"); } catch { return undefined; } })();
  const packageJson = (() => { try { return git("show", "HEAD:package.json"); } catch { return undefined; } })();
  const trackedPaths = git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
  const gitmodules = (() => { try { return git("show", "HEAD:.gitmodules"); } catch { return ""; } })();
  const gitlinks = git("ls-tree", "-r", "HEAD").split("\n").filter((l) => l.startsWith("160000 ")).map((l) => l.split("\t")[1]);
  const report = assessFrontdoor({ readme, packageJson, trackedPaths, gitmodules, gitlinks });
  const output = { repository: slug ?? dir, revision: git("rev-parse", "HEAD").trim(), ...report };
  if (values.json) process.stdout.write(`${JSON.stringify(output)}\n`);
  else {
    for (const f of report.findings) process.stdout.write(`${f.severity} ${f.rule} README.md:${f.line} ${f.detail}\n`);
    process.stdout.write(`${report.findings.length} frontdoor finding(s) for ${slug ?? dir}; review findings are advisory\n`);
  }
  if (!values.warn && report.findings.some((f) => f.severity === "error")) process.exitCode = 1;
} else if (command === "layout") {
  let count = 0;
  for (const row of reportLayout(dir, { rule: values.rule, norms })) { line(row); count += 1; }
  process.stderr.write(`${count} layout finding(s) under ${dir}\n`);
  if (count && !values.warn) process.exitCode = 1;
} else if (command === "relocate") {
  if (!values.rule) { process.stderr.write("relocate needs --rule RULE\n"); process.exit(2); }
  const counts = {};
  for (const row of relocate(dir, { rule: values.rule, apply: values.apply, worktree: values.worktree, norms })) {
    line(row);
    if (row.kind === "relocation") for (const [key, n] of [[row.outcome, 1], ["files moved", row.moved ?? 0], ["files dropped as identical", row.dropped ?? 0], ["files kept on collision", row.kept?.length ?? 0], ["files failed", row.failed?.length ?? 0]]) counts[key] = (counts[key] ?? 0) + n;
    else for (const key of ["rewritten", "remaining"]) counts[`references ${key}`] = (counts[`references ${key}`] ?? 0) + row[key].length;
  }
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  if (counts["files failed"]) process.exitCode = 1;
} else if (command === "forbidden" || command === "manifests" || command === "readmes") {
  const counts = {};
  for (const row of ({ forbidden: forbiddenFiles, manifests: sourcelessManifests, readmes: bareReadmes })[command](dir, { apply: values.apply, norms })) { line(row); counts[row.outcome] = (counts[row.outcome] ?? 0) + 1; }
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  if (counts.failed || (!values.warn && (counts.refused || (!values.apply && counts["would remove"])))) process.exitCode = 1;
} else if (command === "mounts" || command === "nesting" || command === "subjects" || command === "check-all" || command === "check-staged") {
  const counts = {};
  const rows = command === "mounts" ? checkMounts(dir, { norms }) : command === "nesting" ? checkNesting(dir, { norms }) : command === "subjects" ? checkSubjects(dir, { norms }) : command === "check-all" ? checkAll(dir, { only: values.class, norms }) : checkStaged(dir, { root: values.root, base: values.base, tree: values.tree, norms });
  for await (const row of rows) { line(row); const key = row.class ?? command; counts[key] = (counts[key] ?? 0) + 1; }
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  if (Object.keys(counts).length > 0 && !values.warn) process.exitCode = 1;
} else if (command === "remove-paths") {
  const counts = {};
  const entries = readFileSync(0, "utf8").split("\n").filter((text) => text.trim() !== "").map((text) => { try { return JSON.parse(text); } catch { return null; } });
  for await (const row of removePaths(dir, entries, { apply: values.apply })) { line(row); counts[row.outcome] = (counts[row.outcome] ?? 0) + 1; }
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  if (counts.failed || counts.refused) process.exitCode = 1;
} else if (command === "census") {
  for (const row of censusLayout(dir, { norms })) line(row);
} else if (command === "estate") {
  for (const org of values.org ?? []) {
    const rows = JSON.parse(execFileSync("gh", ["repo", "list", org, "--limit", "3000", "--json", "name,isArchived,visibility"], { encoding: "utf8", maxBuffer: 64 << 20 }));
    for (const r of rows) {
      if (r.isArchived) continue;
      const c = classifyName(org, r.name, norms);
      process.stdout.write(`${JSON.stringify({ slug: `${org}/${r.name}`, visibility: r.visibility, ...c })}\n`);
    }
  }
} else {
  process.stderr.write("usage: repository-norms check [DIR] [--warn] | frontdoor [DIR] [--json] [--warn] | layout [ROOT] [--rule RULE] [--warn] | relocate [ROOT] --rule RULE [--apply [--worktree]] | forbidden [ROOT] [--apply] | manifests [ROOT] [--apply] | readmes [ROOT] [--apply] | remove-paths [ROOT] [--apply] | census [ROOT] | mounts [ROOT] | nesting [ROOT] | subjects [ROOT] | check-all [ROOT] [--class CLASS]... | check-staged [REPOSITORY] [--root ROOT] [--base REV] [--tree TREE] | estate --org ORG [--org ORG]...\n");
  process.exitCode = 2;
}
