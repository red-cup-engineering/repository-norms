/**
 * Removal norms over a tree of checked-out repositories, each one data in `norms.json` `layout`:
 * - `forbidden`: path globs no repository holds, at any depth (the walk is in rules.mjs);
 * - `manifests`: a repository that offers no Node.js source holds no package manifest at its root;
 * - `bareReadmes`: a directory holding only directories and a README holds no README.
 * Each reports, and with `apply` removes from the worktree only: no git command runs, nothing is staged, and the only
 * file written is a manifest released from a dependency on a removed one.
 */
import { lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { layoutOf, walkDirectories } from "./layout.mjs";
import { loadNorms } from "./naming.mjs";
// rules.mjs imports this module for the manifest and README checks, so its namespace is read when called.
import * as rules from "./rules.mjs";

const stat = (path) => lstatSync(path, { throwIfNoEntry: false });
const remove = (path) => { try { unlinkSync(path); return null; } catch (error) { return String(error.message ?? error).split("\n")[0]; } };

/** Every forbidden file or directory under `root`: `checkForbidden` of rules.mjs, kept here under its first name. */
export function* forbiddenFiles(root, options = {}) {
  yield* rules.checkForbidden(root, options);
}

const leaves = (value) => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(leaves) : []);
const parse = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/** Whether `repository` holds a file with one of `extensions`, outside the `skip` paths and nested repositories. */
function hasSource(repository, extensions, skip) {
  const visit = (directory, path) => {
    let listed; try { listed = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of listed) {
      const below = path ? `${path}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) { if (extensions.includes(extname(entry.name))) return true; continue; }
      if (entry.name === ".git" || skip.some((tail) => below === tail || below.endsWith(`/${tail}`)) || stat(join(directory, entry.name, ".git"))) continue;
      if (visit(join(directory, entry.name), below)) return true;
    }
    return false;
  };
  return visit(repository, "");
}

/**
 * Every repository under `root` whose root manifest (`layout.manifests.file`) stands without Node.js source: no file
 * with a `sourceExtensions` extension outside `sourceSkip` and nested repositories, and no `entryFields` target that
 * exists. A package `keep` names is reported and kept, for the reason given there. With `apply` the manifest and the `beside` files next to it are removed, and each manifest under `root`
 * that names it in its `dependencyFields` (its `dependents`) loses that entry.
 */
export function* sourcelessManifests(root, { apply = false, norms = loadNorms() } = {}) {
  const { file = "package.json", sourceExtensions = [], sourceSkip = [], entryFields = [], dependencyFields = [], keep = {}, dependentSkip = [], beside = [] } = norms.layout?.manifests ?? {};
  const dependents = new Map(); // package name -> manifests that depend on it
  for (const { directory } of walkDirectories(root, { skip: dependentSkip })) {
    const manifest = stat(join(directory, file))?.isFile() ? parse(join(directory, file)) : null;
    for (const name of new Set(dependencyFields.flatMap((field) => Object.keys(manifest?.[field] ?? {})))) dependents.set(name, [...(dependents.get(name) ?? []), join(directory, file)]);
  }
  const found = [];
  for (const { repository, path } of walkDirectories(root, { skip: layoutOf(norms).skip })) {
    if (path !== "" || !stat(join(repository, file))?.isFile()) continue;
    const manifest = parse(join(repository, file));
    const row = { kind: "manifest", repository, name: manifest?.name ?? null };
    if (!manifest) { yield { ...row, outcome: "kept", reason: "the manifest does not parse" }; continue; }
    const offers = entryFields.flatMap((field) => leaves(manifest[field])).some((target) => (target.includes("*") ? stat(join(repository, target.split("*")[0])) : stat(join(repository, target))?.isFile()));
    if (offers || hasSource(repository, sourceExtensions, sourceSkip)) continue;
    if (manifest.name in keep) { yield { ...row, outcome: "kept", reason: keep[manifest.name] }; continue; }
    found.push({ ...row, path: join(repository, file), dependents: (dependents.get(manifest.name) ?? []).filter((other) => other !== join(repository, file)) });
  }
  const going = new Set(found.map((row) => row.path));
  const release = (dependent, name) => {
    try {
      const text = readFileSync(dependent, "utf8");
      const manifest = JSON.parse(text);
      for (const field of dependencyFields) {
        if (manifest[field] && name in manifest[field]) delete manifest[field][name];
        if (manifest[field] && typeof manifest[field] === "object" && Object.keys(manifest[field]).length === 0) delete manifest[field];
      }
      writeFileSync(dependent, `${JSON.stringify(manifest, null, /^([ \t]+)"/mu.exec(text)?.[1] ?? 2)}${text.endsWith("\n") ? "\n" : ""}`);
      return null;
    } catch (error) { return String(error.message ?? error).split("\n")[0]; }
  };
  for (const { path, dependents: named, ...row } of found) {
    // A dependent that is itself removed needs no release.
    const released = named.filter((other) => !going.has(other));
    const others = beside.filter((name) => stat(join(row.repository, name))?.isFile());
    const errors = apply ? [...released.map((other) => release(other, row.name)), ...[file, ...others].map((name) => remove(join(row.repository, name)))].filter(Boolean) : [];
    yield { ...row, outcome: !apply ? "would remove" : errors.length ? "failed" : "removed", beside: others, ...(released.length ? { dependents: released } : {}), ...(errors.length ? { errors } : {}) };
  }
}

/**
 * Every directory under `root`, outside the `layout.bareReadmes.skip` paths, whose only file is `layout.bareReadmes.file`
 * beside at least one directory. Names matching `hidden` are not counted either way.
 */
export function* bareReadmes(root, { apply = false, norms = loadNorms() } = {}) {
  const { file = "README.md", hidden = "^\\.", skip = [] } = norms.layout?.bareReadmes ?? {};
  const unseen = new RegExp(hidden, "u");
  for (const { repository, path, directory } of walkDirectories(root, { skip })) {
    let listed; try { listed = readdirSync(directory, { withFileTypes: true }).filter((entry) => !unseen.test(entry.name)); } catch { continue; }
    const files = listed.filter((entry) => !entry.isDirectory());
    if (files.length !== 1 || files[0].name !== file || listed.length < 2) continue;
    const error = apply ? remove(join(directory, file)) : null;
    yield { kind: "bare-readme", repository, file: path ? `${path}/${file}` : file, outcome: !apply ? "would remove" : error ? "failed" : "removed", ...(error ? { error } : {}) };
  }
}
