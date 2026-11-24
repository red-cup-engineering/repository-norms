/**
 * Observe the source-addressable interfaces advertised by package.json.
 * Pure and read-only. Build products are review prompts; declared source
 * files and explicit test files absent at HEAD are objective contradictions.
 * The observations say nothing about successful imports, test outcomes,
 * published packages, or deployed services.
 */
import { posix } from "node:path";

const generatedPrefix = /^(?:dist|build|generated|coverage|out)\//u;
const localPath = (raw) => {
  if (typeof raw !== "string" || raw.includes("*")) return null;
  const value = raw.split(/[?#]/u, 1)[0].replace(/^\.\//u, "");
  if (!value || value.startsWith("/") || /^(?:[a-z][a-z\d+.-]*:|\.\.\/)/iu.test(value)) return null;
  const normalized = posix.normalize(value);
  return normalized === ".." || normalized.startsWith("../") ? null : normalized;
};
const regexEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function globMatcher(glob) {
  const path = glob.replace(/^\.\//u, "");
  const parts = path.split("*").map(regexEscape);
  return new RegExp("^" + parts.join("[^/]*") + "$", "u");
}

export function assessPackageSurface({ packageJson, trackedPaths } = {}) {
  const findings = [], entrypoints = [], scripts = [];
  const observed = { name: null, version: null, isPrivate: null, description: null };
  const paths = trackedPaths == null ? null : new Set(trackedPaths);
  if (packageJson == null) return { kind: "repository-package-surface.v1", observed, entrypoints, scripts, findings, present: false };
  let p;
  try { p = JSON.parse(packageJson); }
  catch (e) {
    findings.push({ severity: "error", rule: "package-json-invalid", line: null, detail: "package.json cannot be parsed as JSON" });
    return { kind: "repository-package-surface.v1", observed, entrypoints, scripts, findings, present: true };
  }
  observed.name = typeof p.name === "string" ? p.name : null;
  observed.version = typeof p.version === "string" ? p.version : null;
  observed.isPrivate = p.private === true;
  observed.description = typeof p.description === "string" ? p.description : null;
  const entry = (kind, name, raw) => {
    const path = localPath(raw);
    if (!path) {
      entrypoints.push({ kind, name, target: raw, status: "unresolved" });
      return;
    }
    const status = !paths ? "unchecked" : paths.has(path) ? "tracked" : generatedPrefix.test(path) ? "generated-or-absent" : "missing";
    entrypoints.push({ kind, name, target: path, status });
    if (status === "missing") findings.push({ severity: "error", rule: "missing-declared-entrypoint", line: null, detail: `${kind} ${name} declares ${path}, absent at HEAD` });
    else if (status === "generated-or-absent") findings.push({ severity: "review", rule: "unobserved-build-product", line: null, detail: `${kind} ${name} declares ${path}; verify the declared build generates this file before distribution` });
  };
  const walk = (at, kind, name) => {
    if (typeof at === "string") { entry(kind, name, at); return; }
    if (Array.isArray(at)) { at.forEach((v, i) => walk(v, kind, `${name}[${i}]`)); return; }
    if (at && typeof at === "object") {
      for (const [key, value] of Object.entries(at)) {
        walk(value, kind, key.startsWith(".") ? key : `${name}:${key}`);
      }
    }
  };
  if (p.exports !== undefined) walk(p.exports, "export", ".");
  if (typeof p.bin === "string") entry("bin", "default", p.bin);
  else if (p.bin && typeof p.bin === "object") {
    for (const [name, path] of Object.entries(p.bin)) entry("bin", name, path);
  }
  for (const name of ["main", "module", "types", "typings"]) if (p[name]) entry(name, name, p[name]);

  for (const [name, command] of Object.entries(p.scripts ?? {})) {
    if (typeof command !== "string") continue;
    const inspected = [];
    // Only explicit, repository-local source fixtures used by a Node test/check
    // command. Other shell constructs remain unassessed; no guessing.
    const re = /\bnode\s+(--test|--check)\s+((?:\.\/)?(?:test|tests|src|scripts|bin)\/[A-Za-z\d_.\/*?-]+)/gu;
    for (const match of command.matchAll(re)) {
      const argument = match[2].replace(/^\.\//u, "");
      const matched = paths && [...paths].filter(path => argument.includes("*") ? globMatcher(argument).test(path) : path === argument);
      const status = !paths ? "unchecked" : matched.length ? "tracked" : "missing";
      inspected.push({ command: match[1], argument, status, matches: matched?.length ?? null });
      if (status === "missing") findings.push({ severity: "error", rule: "missing-script-test-source", line: null, detail: `script ${name} calls node ${match[1]} ${argument}, with no matching tracked source at HEAD` });
    }
    scripts.push({ name, examined: inspected });
  }
  return { kind: "repository-package-surface.v1", observed, entrypoints, scripts, findings, present: true };
}
