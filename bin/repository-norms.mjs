#!/usr/bin/env node
import { execGitSync } from "@red-cup-engineering/git-engine/git-process";
// Commands and arguments: src/usage.mjs (`repository-norms --help`).
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { classifyName, loadNorms } from "../src/naming.mjs";
import { checkSubmodules } from "../src/submodules.mjs";
import { assessFrontdoor } from "../src/frontdoor.mjs";
import { REMAINING, censusLayout, relocate, reportLayout } from "../src/layout.mjs";
import { bareReadmes, forbiddenFiles, sourcelessManifests } from "../src/removals.mjs";
import { readFileSync } from "node:fs";
import { usageText } from "../src/usage.mjs";
import { checkAll, checkMounts, checkNesting, checkStaged, checkSubjects, removePaths } from "../src/rules.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { org: { type: "string", multiple: true }, warn: { type: "boolean", default: false }, json: { type: "boolean", default: false }, rule: { type: "string" }, apply: { type: "boolean", default: false }, worktree: { type: "boolean", default: false }, root: { type: "string" }, base: { type: "string" }, tree: { type: "string" }, class: { type: "string", multiple: true }, help: { type: "boolean", short: "h", default: false } } });
const [command, dir = "."] = positionals;
const norms = loadNorms();
const line = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
const git = (...a) => execGitSync(["-C", dir, ...a], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

if (values.help || command === undefined) {
  process.stdout.write(usageText());
  if (!values.help) process.exitCode = 2;
} else if (command === "check") {
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
    else {
      counts["references rewritten"] = (counts["references rewritten"] ?? 0) + row.rewritten.length;
      for (const [name, n] of Object.entries(row.remainingByClass)) if (n) counts[`references left, ${name}`] = (counts[`references left, ${name}`] ?? 0) + n;
    }
  }
  process.stderr.write(`${JSON.stringify(counts)}\n`);
  const left = counts[`references left, ${REMAINING.moved}`];
  if (Object.keys(counts).some((key) => key.startsWith("references left"))) process.stderr.write(`references left are mentions of the variant path the planner did not rewrite: "${REMAINING.moved}" is a defect (exit 1); "${REMAINING.absolute}" and "${REMAINING.none}" are not this repository's moved paths; "${REMAINING.ambiguous}" is a bare name the planner could not tell from a word\n`);
  if (counts["files failed"] || left) process.exitCode = 1;
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
  process.stderr.write(`unknown command ${command}\n${usageText()}`);
  process.exitCode = 2;
}
