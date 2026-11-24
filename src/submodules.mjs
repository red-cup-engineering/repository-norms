import { parseGitmodules } from "@red-cup-engineering/git-engine/gitmodules";
/**
 * Submodule integrity of one checkout: every gitlink is declared exactly once, every declaration names a gitlink,
 * every URL is an https GitHub repository of a house organization, and the composing directory is named for the
 * repository it composes. Pure over the inputs: callers pass the `.gitmodules` text and the gitlink paths.
 */
import { loadNorms } from "./naming.mjs";

/** Findings for one checkout: [{ rule, path?, detail }]. Empty when it conforms. */
export function checkSubmodules({ gitmodules, gitlinks, norms = loadNorms() }) {
  const decls = parseGitmodules(gitmodules), findings = [];
  const byPath = new Map();
  for (const d of decls) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
  const links = new Set(gitlinks);
  for (const [path, list] of byPath) {
    if (list.length > 1) findings.push({ rule: "declared-once", path, detail: `${list.length} declarations` });
    if (!links.has(path)) findings.push({ rule: "declaration-has-gitlink", path, detail: "declared but tracked as files or absent" });
  }
  for (const path of links) if (!byPath.has(path)) findings.push({ rule: "gitlink-declared", path, detail: "gitlink with no declaration" });
  for (const d of decls) {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(d.url ?? "");
    if (!m) { findings.push({ rule: "https-github-url", path: d.path, detail: d.url ?? "no url" }); continue; }
    const [, owner, repo] = m;
    if (!norms.organizations[owner]) findings.push({ rule: "house-organization", path: d.path, detail: `${owner}/${repo}` });
    const dir = String(d.path ?? "").split("/").pop();
    if (dir !== repo) findings.push({ rule: "directory-names-repository", path: d.path, detail: `directory ${dir}, repository ${repo}` });
  }
  return findings;
}
