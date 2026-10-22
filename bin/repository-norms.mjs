#!/usr/bin/env node
/**
 * repository-norms check [DIR] [--warn]      one checkout: its own name and its submodules (CI)
 * repository-norms estate --org ORG [...]    every non-archived repository name of the organizations (JSON lines)
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { classifyName, loadNorms } from "../src/naming.mjs";
import { checkSubmodules } from "../src/submodules.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { org: { type: "string", multiple: true }, warn: { type: "boolean", default: false } } });
const [command = "check", dir = "."] = positionals;
const norms = loadNorms();
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });

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
  process.stderr.write("usage: repository-norms check [DIR] [--warn] | estate --org ORG [--org ORG]...\n");
  process.exitCode = 2;
}
