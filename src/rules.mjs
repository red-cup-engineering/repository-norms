import { createGit } from "@red-cup-engineering/git-engine/git-process";
import { readGitmodules } from "@red-cup-engineering/git-engine/gitmodules";
/**
 * Placement norms over a tree of checked-out repositories, each rule one row of `norms.json`:
 * - `mounts.rules`: where a repository, named by its remote URL or its name, may be mounted;
 * - `mounts.onePerRepository`: one repository is mounted at one path;
 * - `nesting`: a section's name specialises its parent section's name;
 * - `subjects.rules`: the one section that owns a named subject; a file or directory named for it elsewhere is misfiled;
 * - `layout.forbidden.paths`: path globs no repository holds, each removable (`remove`) or only reported (`refuse`).
 * `checkAll` runs these with the layout, manifest, README and section-form norms over a whole tree. `checkStaged`
 * reads only what one commit in one repository would add or modify, so what already stands does not block an
 * unrelated commit. Nothing here writes a file: rows are returned to the caller.
 *
 * What other packages already do is called, not written again: `.gitmodules` is read by git-engine; the tree is walked
 * by the filepath section (`walkEntries` in layout.mjs); paths named for a subject are found by the filepath section's
 * `listFilepathsMatchingString`; placement derived from a section's name is the services-section engine's forest lint,
 * and the section form is its `listSectionFormViolations`. Those three are loaded when a whole-tree check asks.
 */
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { layoutOf, reportLayout, walkEntries } from "./layout.mjs";
import { loadNorms } from "./naming.mjs";
import { bareReadmes, sourcelessManifests } from "./removals.mjs";

const GITLINK = "160000";
const under = (path, directory) => path === directory || path.startsWith(`${directory}/`);
const endsWithPath = (path, tail) => path === tail || path.endsWith(`/${tail}`);
const isRepository = (directory) => existsSync(join(directory, ".git"));
const firstLine = (error) => String(error.message ?? error).split("\n")[0];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A path glob as a regular expression over a `/`-separated path: `*` and `?` stay within one name, `**` spans names.
 * With `anyDepth` the glob is read at any depth unless it starts with `/`.
 */
export function globToRegExp(glob, { anyDepth = false, flags = "u" } = {}) {
  const rooted = glob.startsWith("/");
  const names = (rooted ? glob.slice(1) : glob).split("/");
  const source = names.map((name, at) => {
    const last = at === names.length - 1;
    if (name === "**") return last ? ".*" : "(?:[^/]+/)*";
    return `${name.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}${last ? "" : "/"}`;
  }).join("");
  return new RegExp(`^${anyDepth && !rooted ? "(?:.*/)?" : ""}${source}$`, flags);
}

/** `owner/name` of a remote URL: its last two path names, without `.git`. */
export const repositoryOfUrl = (url) => String(url ?? "").replace(/\/+$/u, "").replace(/\.git$/u, "").split(/[/:]/u).filter(Boolean).slice(-2).join("/");

const forbiddenOf = (norms) => {
  const { paths = [], skip = [] } = norms.layout?.forbidden ?? {};
  return { skip, rows: paths.map((row) => ({ ...row, type: row.type ?? "file", mode: row.mode ?? "refuse", matches: globToRegExp(row.path, { anyDepth: true }) })) };
};
const subjectsOf = (norms) => {
  const { rules = [], skip = [] } = norms.subjects ?? {};
  // One name holds the subject as the filepath section's search reads it: any case, with `-`, `_` or nothing between.
  const named = (subject) => { const held = new RegExp([...subject.toLowerCase().replace(/[-_]/gu, "")].map(escapeRegExp).join("[-_]?"), "iu"); return (name) => held.test(name); };
  return { skip, rows: rules.map((row) => ({ ...row, owner: row.owner.replace(/\/+$/u, ""), named: named(row.subject) })) };
};
const mountsOf = (norms) => (norms.mounts?.rules ?? []).map((row) => ({ ...row, allowed: row.allowed ?? [], except: row.except ?? [], matches: globToRegExp(row.repository ?? row.name, { flags: "iu" }) }));

/** The mount rules `{ mounted, url }` breaks: `mounted` is the path below the superrepository root. */
function mountFindings(rules, { mounted, url }) {
  const repository = repositoryOfUrl(url);
  const names = [...new Set([repository.split("/").pop(), mounted.split("/").pop()])];
  return rules.filter((row) => {
    const named = row.repository !== undefined ? row.matches.test(repository) : names.some((name) => row.matches.test(name) && !row.except.includes(name));
    return named && !row.allowed.includes(mounted);
  }).map((row) => ({ kind: "mount", rule: row.rule, mounted, url, allowed: row.allowed }));
}

/** Every declaration in every `.gitmodules` under `root`, followed through the submodules that are checked out. */
export function* readMounts(root, { git = createGit() } = {}) {
  function* visit(directory, below) {
    for (const entry of readGitmodules(directory, { git })) {
      for (const path of [entry.path].flat()) {
        const mounted = below ? `${below}/${path}` : path;
        for (const url of [entry.url].flat()) yield { repository: directory, path, mounted, url };
        if (isRepository(join(directory, path))) yield* visit(join(directory, path), mounted);
      }
    }
  }
  yield* visit(resolve(root), "");
}

/**
 * What makes two mounts one repository under `mounts.onePerRepository`: its owner/name, or with `sameName` its name
 * alone, whichever organization holds it. Null for a repository the rule leaves alone (`except`, and the `meta` names).
 */
function mountKey(url, norms) {
  const one = norms.mounts?.onePerRepository ?? {};
  const repository = repositoryOfUrl(url).toLowerCase(), name = repository.split("/").pop();
  if ([...(one.except ?? []), ...(norms.meta ?? [])].some((except) => [repository, name].includes(except.toLowerCase()))) return null;
  return one.sameName ? name : repository;
}

const organizationsOf = (norms) => Object.entries(norms.organizations ?? {}).map(([organization, { domain, style }]) => ({ organization, domain, style }));
/** A section-like name read against the organizations: `{ organization, words }`, the words without the organization's own. */
function readName(name, norms) {
  const stem = name.endsWith(norms.sectionSuffix) ? name.slice(0, -norms.sectionSuffix.length) : name;
  const organizations = organizationsOf(norms);
  const prefixed = organizations.filter(({ style, domain }) => style === "prefix" && (stem === domain || stem.startsWith(`${domain}-`))).sort((a, b) => b.domain.length - a.domain.length)[0];
  if (prefixed) return { ...prefixed, section: stem !== name, words: stem.slice(prefixed.domain.length + 1).split("-").filter(Boolean), subject: stem.slice(prefixed.domain.length + 1).split("-").filter(Boolean) };
  const words = stem.split("-").filter(Boolean);
  const suffixed = organizations.find(({ style, domain }) => style === "suffix" && words.at(-1) === domain);
  return { ...(suffixed ?? {}), section: stem !== name, words, subject: suffixed ? words.slice(0, -1) : words };
}
/** The name `subject` words take in an organization: `public-x-services-section`, `x-engineering-services-section`. */
const nameIn = ({ domain, style }, subject, norms) => `${[...(style === "prefix" ? [domain] : []), ...subject, ...(style === "suffix" ? [domain] : [])].join("-")}${norms.sectionSuffix}`;

/** The parent section of a mount at `<parent>/services/<name>`, or null when it is not mounted in a section's `services/`. */
function nestedUnder(mounted, norms) {
  const at = /^(?:(.*)\/)?services\/([^/]+)\/services\/([^/]+)$/u.exec(mounted);
  if (!at || !at[2].endsWith(norms.sectionSuffix)) return null;
  return { parent: `${at[1] ? `${at[1]}/` : ""}services/${at[2]}`, parentName: at[2], name: at[3] };
}
/** The parent's words the name of a section mounted at `mounted` lacks: empty when it specialises its parent, or is no section. */
function missingParentWords(mounted, norms) {
  const { words = false, except = [] } = norms.nesting ?? {};
  const nested = nestedUnder(mounted, norms);
  if (!words || !nested || except.includes(nested.name)) return [];
  const child = readName(nested.name, norms);
  // A plain application, library or service keeps its name; a name that carries the section suffix or an organization's prefix is a section's.
  if (!child.section && child.style !== "prefix") return [];
  return readName(nested.parentName, norms).words.filter((word) => !child.words.includes(word));
}

/**
 * Every mount under `root` that a `mounts.rules` row forbids where it stands (`kind` "mount"), and every repository
 * mounted at more than one path (`kind` "duplicate-mount", with all its `mounts` and `urls`; `by` says whether the
 * paths share a URL or only a repository name in two organizations).
 */
export function* checkMounts(root, { norms = loadNorms(), git = createGit(), mounts = [...readMounts(root, { git })] } = {}) {
  const rules = mountsOf(norms);
  for (const { repository, path, mounted, url } of mounts) for (const finding of mountFindings(rules, { mounted, url })) yield { ...finding, repository, path };
  const one = norms.mounts?.onePerRepository;
  if (!one) return;
  const standing = new Map();
  for (const { mounted, url } of mounts) {
    const key = mountKey(url, norms);
    if (key === null) continue;
    if (!standing.has(key)) standing.set(key, { urls: new Set(), mounts: new Set() });
    standing.get(key).urls.add(url);
    standing.get(key).mounts.add(mounted);
  }
  for (const { urls, mounts: paths } of standing.values()) {
    if (paths.size > 1) yield { kind: "duplicate-mount", rule: one.rule, by: urls.size > 1 ? "name" : "url", urls: [...urls].sort(), mounts: [...paths].sort() };
  }
}

/**
 * Every mounted section whose name does not specialise its parent's: by `nesting.words`, and by the services-section
 * engine's forest lint for the `nesting.engineCodes` diagnostics. One row per section, with its `parent`, the `reasons`,
 * and the `candidates`: the path or name the engine derives, else the paths the other organizations' trees give the
 * same subject words. The forest lint reads committed trees with `cache: null`, so it writes nothing.
 */
export async function* checkNesting(root, { norms = loadNorms(), git = createGit(), mounts = [...readMounts(root, { git })] } = {}) {
  const { engineCodes = [], except = [], candidates: most = 3 } = norms.nesting ?? {};
  if (!norms.nesting) return;
  const found = new Map();
  const at = (path) => found.get(path) ?? found.set(path, { kind: "nesting", rule: norms.nesting.rule, path, name: path.split("/").pop(), parent: path.replace(/\/services\/[^/]+$/u, ""), reasons: [], candidates: [] }).get(path);
  for (const { mounted } of mounts) {
    const missing = missingParentWords(mounted, norms);
    if (missing.length > 0) at(mounted).reasons.push(`its name lacks its parent's words: ${missing.join(", ")}`);
  }
  let sections = [...new Set(mounts.map(({ mounted }) => mounted))].filter((path) => path.endsWith(norms.sectionSuffix)).map((path) => ({ path, name: path.split("/").pop() }));
  if (engineCodes.length > 0) {
    const { readSectionForest, lintSectionForest, RULES } = await import("@red-cup-engineering/service-section-engineering-services-section/lint-services-section-forest");
    const nodes = await readSectionForest(resolve(root), { cache: null });
    sections = nodes.filter((node) => node.name.endsWith(norms.sectionSuffix)).map(({ path, name }) => ({ path, name }));
    for (const { path, code, message, rename } of lintSectionForest(nodes).diagnostics) {
      if (!engineCodes.includes(code) || except.includes(path.split("/").pop())) continue;
      const row = at(path);
      row.reasons.push(`${code} ${message}`);
      if (code === "SS003" && message.startsWith(`${RULES.SS003}: `)) row.candidates.push(message.slice(RULES.SS003.length + 2));
      if (rename) row.candidates.push(`${row.parent}/services/${rename}`);
    }
  }
  // How the other organizations nest the same subject words: their closest section's chain, renamed into this one's.
  const read = sections.map((section) => ({ ...section, ...readName(section.name, norms), chain: section.path.split("/services/").slice(1) })).filter((section) => section.organization && section.subject.length > 0);
  const rootOf = (path) => path.split("/").slice(0, 2).join("/");
  for (const row of found.values()) {
    row.candidates = [...new Set(row.candidates)];
    if (row.candidates.length > 0) continue;
    const child = readName(row.name, norms);
    const home = child.organization ? child : readName(rootOf(row.path).split("/").pop(), norms);
    if (!home.organization || child.subject.length === 0) continue;
    const scored = read.filter((section) => section.organization !== home.organization)
      .map((section) => ({ section, score: section.subject.filter((word) => child.subject.includes(word)).length }))
      .filter(({ score }) => score >= Math.min(2, child.subject.length));
    const best = Math.max(0, ...scored.map(({ score }) => score));
    const closest = scored.filter(({ score }) => score === best).sort((a, b) => a.section.subject.length - b.section.subject.length || (a.section.path < b.section.path ? -1 : 1));
    for (const { section } of closest) {
      const chain = section.chain.map((name) => readName(name, norms).subject).filter((subject) => subject.length > 0).map((subject) => nameIn(home, subject, norms));
      const candidate = [rootOf(row.path), ...chain].join("/services/");
      if (!row.candidates.includes(candidate)) row.candidates.push(candidate);
      if (row.candidates.length >= most) break;
    }
  }
  yield* [...found.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const holdsRepository = (directory) => { try { return readdirSync(directory, { withFileTypes: true }).some((entry) => entry.name === ".git" || (entry.isDirectory() && holdsRepository(join(directory, entry.name)))); } catch { return false; } };

/**
 * Every file or directory under `root` that a `layout.forbidden.paths` row names, outside the `layout.forbidden.skip`
 * paths. A row is "would remove", "removed" or "failed" when its mode is `remove`, and "refused" when it is `refuse`:
 * that one is never removed. Neither is a directory that holds a repository.
 */
export function* checkForbidden(root, { apply = false, norms = loadNorms() } = {}) {
  const { skip, rows } = forbiddenOf(norms);
  const found = [];
  walkEntries(root, { skip, visit: ({ repository, path, kind, absolute }) => {
    const isDirectory = kind === "directory";
    let gone = false;
    for (const row of rows) {
      if ((row.type === "directory") !== isDirectory || !row.matches.test(path)) continue;
      const finding = { kind: "forbidden", rule: row.rule, repository, [isDirectory ? "directory" : "file"]: path, mode: row.mode };
      if (row.mode !== "remove") { found.push({ ...finding, outcome: "refused", ...(row.reason ? { reason: row.reason } : {}) }); continue; }
      if (!apply) { found.push({ ...finding, outcome: "would remove" }); continue; }
      let error = null;
      try {
        if (isDirectory && holdsRepository(absolute)) error = "holds a repository";
        else if (isDirectory) rmSync(absolute, { recursive: true });
        else unlinkSync(absolute);
      } catch (thrown) { error = firstLine(thrown); }
      gone ||= error === null;
      found.push({ ...finding, outcome: error ? "failed" : "removed", ...(error ? { error } : {}) });
    }
    return !gone;
  } });
  yield* found;
}

/**
 * Every file or directory under `root` named for a subject outside the section that owns it, and each owner that is
 * missing. The paths are the filepath section's `listFilepathsMatchingString`; a directory named for the subject is one
 * row with the count of `files` under it. There is no fix: the rows are the work list.
 */
export async function* checkSubjects(root, { norms = loadNorms() } = {}) {
  const top = resolve(root);
  const { skip, rows } = subjectsOf(norms);
  if (rows.length === 0) return;
  const { listFilepathsMatchingString } = await import("@red-cup-engineering/computer-filepath-engineering-services-section/search-filepath");
  for (const row of rows) {
    if (!existsSync(join(top, row.owner))) yield { kind: "subject-owner", subject: row.subject, owner: row.owner, outcome: "owner missing" };
    const found = new Map();
    for (const { path } of await listFilepathsMatchingString({ root: top, string: row.subject, excludes: skip })) {
      const names = path.split("/");
      const depth = names.findIndex((name) => row.named(name)) + 1 || names.length;
      const at = names.slice(0, depth).join("/");
      if (under(at, row.owner)) continue;
      const seen = found.get(at) ?? found.set(at, { kind: "subject", subject: row.subject, owner: row.owner, found: at, type: depth < names.length ? "directory" : "file", files: 0 }).get(at);
      seen.files += 1;
    }
    yield* [...found.values()].sort((a, b) => (a.found < b.found ? -1 : 1));
  }
}

/** Every section under `root` whose directory breaks the section form, as the services-section engine reads it. */
export async function* checkSectionForm(root) {
  const { listSectionFormViolations } = await import("@red-cup-engineering/service-section-engineering-services-section/section-form-violations");
  for (const { path, violations } of (await listSectionFormViolations({ root: resolve(root) })).violating) yield { kind: "section-form", path, violations };
}

/**
 * Every finding of every rule class under `root`, each row with its `class`: mounts, duplicate-mounts, nesting,
 * subjects, forbidden, layout, manifests, readmes and section-form. A class whose check cannot run is one row with
 * `outcome` "check failed", so a broken check is never read as a clean tree. `only` names the classes to run (the
 * duplicate mounts are read with `mounts`).
 */
export async function* checkAll(root, { only, norms = loadNorms(), git = createGit() } = {}) {
  const mounts = [...readMounts(root, { git })];
  const classes = {
    mounts: () => checkMounts(root, { norms, git, mounts }),
    nesting: () => checkNesting(root, { norms, git, mounts }),
    subjects: () => checkSubjects(root, { norms }),
    forbidden: () => checkForbidden(root, { norms }),
    layout: () => reportLayout(root, { norms }),
    manifests: () => sourcelessManifests(root, { norms }),
    readmes: () => bareReadmes(root, { norms }),
    "section-form": () => checkSectionForm(root),
  };
  for (const [name, rows] of Object.entries(classes)) {
    if (only?.length && !only.includes(name)) continue;
    try {
      for await (const row of rows()) {
        if (name === "manifests" && row.outcome === "kept") continue;
        yield { class: row.kind === "duplicate-mount" ? "duplicate-mounts" : name, ...row };
      }
    } catch (error) {
      yield { class: name, outcome: "check failed", error: firstLine(error) };
    }
  }
}

/**
 * Removes the listed paths (`{ path }`, relative to `root`) from the worktree: no git command runs and nothing is
 * staged. Without `apply` nothing changes. One row per path: "removed" (or "would remove"), "missing", or "refused"
 * with the reason: outside the root (lexically, or through a symbolic link, by the filepath section's
 * `confineExistingPath`), the root itself, inside a `.git`, a mounted repository, or a directory holding one.
 */
export async function* removePaths(root, entries, { apply = false } = {}) {
  const top = resolve(root);
  const { confineExistingPath } = await import("@red-cup-engineering/computer-filepath-engineering-services-section/filepath");
  for (const entry of entries) {
    const path = typeof entry?.path === "string" ? entry.path : null;
    const refuse = (reason) => ({ path, outcome: "refused", reason });
    if (path === null) { yield refuse("no path"); continue; }
    const absolute = resolve(top, path);
    const below = relative(top, absolute).split(sep);
    if (absolute === top) { yield refuse("the root itself"); continue; }
    if (below[0] === ".." || !absolute.startsWith(`${top}${sep}`)) { yield refuse("outside the root"); continue; }
    if (below.includes(".git")) { yield refuse("inside a .git"); continue; }
    const found = lstatSync(absolute, { throwIfNoEntry: false });
    if (!found) { yield { path, outcome: "missing" }; continue; }
    if (!found.isSymbolicLink()) {
      try { await confineExistingPath({ root: top, path: absolute, allowRoot: false }); } catch { yield refuse("outside the root"); continue; }
    }
    if (found.isDirectory() && isRepository(absolute)) { yield refuse("a mounted repository"); continue; }
    if (found.isDirectory() && holdsRepository(absolute)) { yield refuse("holds a repository"); continue; }
    if (!apply) { yield { path, outcome: "would remove" }; continue; }
    try {
      if (found.isDirectory()) rmSync(absolute, { recursive: true }); else unlinkSync(absolute);
      yield { path, outcome: "removed" };
    } catch (error) { yield { path, outcome: "failed", error: firstLine(error) }; }
  }
}

/** The topmost repository that composes `repository` through submodules: `repository` itself when nothing does. */
export function superrepositoryOf(repository, { git = createGit() } = {}) {
  let top = resolve(repository);
  for (;;) {
    const above = git(top, ["rev-parse", "--show-superproject-working-tree"], { ok: [0, 128] }).trim();
    if (above === "") return top;
    top = above;
  }
}

/**
 * The findings a commit in `repository` would newly make: only paths the commit adds or modifies are read, so a commit
 * that deletes or moves a violating path away has none, and neither does one beside violations that already stand.
 * The commit is `tree` when given, else the index; it is compared with `base` (HEAD, or nothing when HEAD is unborn).
 * A submodule whose recorded commit alone changes is not a modified path. Checked: forbidden paths, layout variants
 * that are not on hold, subjects outside their owner, and for each submodule the commit adds or re-declares its mount
 * rules, whether its repository is already mounted elsewhere under `root`, and whether its name carries its parent's
 * words. `root` is the superrepository that owner and mount paths are relative to (default: the topmost one composing it).
 */
export function checkStaged(repository, { root, base, tree, norms = loadNorms(), git = createGit() } = {}) {
  const directory = resolve(repository);
  const top = resolve(root ?? superrepositoryOf(directory, { git }));
  const below = relative(top, directory).split(sep).join("/");
  if (below.startsWith("..")) throw new Error(`${directory} is not under ${top}`);
  const from = base ?? (git(directory, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { ok: [0, 1, 128] }).trim() || git(directory, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).trim());
  const raw = tree === undefined
    ? git(directory, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--ignore-submodules=none", from])
    : git(directory, ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, tree]);
  const fields = raw.split("\0");
  const changes = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [oldMode, mode, , , status] = fields[at].slice(1).split(" ");
    const gitlink = mode === GITLINK;
    if (!"AMT".includes(status[0]) || (gitlink && oldMode === GITLINK)) continue;
    changes.push({ path: fields[at + 1], gitlink });
  }
  const rooted = (path) => (below ? `${below}/${path}` : path);
  const banned = forbiddenOf(norms), owned = subjectsOf(norms), layout = layoutOf(norms);
  const variants = layout.relocations.filter((row) => !row.hold);
  const found = new Map();
  const find = (key, row) => { const seen = found.get(key); if (seen) seen.paths += 1; else found.set(key, { ...row, repository: directory, paths: 1 }); };
  for (const change of changes) {
    const names = change.path.split("/");
    const live = { forbidden: true, layout: true, subjects: true };
    const quiet = new Set();
    for (let depth = 1; depth <= names.length; depth += 1) {
      const prefix = names.slice(0, depth).join("/");
      const isDirectory = depth < names.length || change.gitlink;
      const skipped = (skip) => skip.some((tail) => endsWithPath(rooted(prefix), tail));
      live.forbidden &&= !skipped(banned.skip);
      live.layout &&= !skipped(layout.skip);
      live.subjects &&= !skipped(owned.skip);
      if (live.forbidden) for (const row of banned.rows) {
        if ((row.type === "directory") === isDirectory && row.matches.test(prefix)) find(`forbidden\0${row.rule}\0${prefix}`, { class: "forbidden", kind: "forbidden", rule: row.rule, [isDirectory ? "directory" : "file"]: prefix, mode: row.mode, outcome: "refused", ...(row.reason ? { reason: row.reason } : {}) });
      }
      if (live.layout && isDirectory) for (const row of variants) {
        if (endsWithPath(prefix, row.from)) find(`layout\0${row.rule}\0${prefix}`, { class: "layout", rule: row.rule, found: prefix, canonical: `${prefix.slice(0, prefix.length - row.from.length)}${row.to}` });
      }
      if (live.subjects) for (const row of owned.rows) {
        if (quiet.has(row.subject) || !row.named(names[depth - 1]) || under(rooted(prefix), row.owner)) continue;
        quiet.add(row.subject);
        find(`subjects\0${row.subject}\0${prefix}`, { class: "subjects", kind: "subject", subject: row.subject, owner: row.owner, found: rooted(prefix), type: isDirectory ? "directory" : "file" });
      }
    }
  }
  const findings = [...found.values()];
  const added = new Set(changes.filter((change) => change.gitlink).map((change) => change.path));
  if (added.size > 0 || changes.some((change) => change.path === ".gitmodules")) {
    const declared = (revision) => readGitmodules(directory, { commit: revision, git }).flatMap((entry) => [entry.path].flat().flatMap((path) => [entry.url].flat().map((url) => ({ path, url }))));
    const before = new Set(declared(from).map(({ path, url }) => `${path}\0${url}`));
    const mounting = declared(tree ?? "").filter(({ path, url }) => !before.has(`${path}\0${url}`) || added.has(path));
    const rules = mountsOf(norms), one = norms.mounts?.onePerRepository;
    // Read once, and only when the commit mounts something: every other mount under the superrepository.
    const elsewhere = one && mounting.length > 0 ? [...readMounts(top, { git })] : [];
    for (const { path, url } of mounting) {
      const mounted = rooted(path);
      for (const finding of mountFindings(rules, { mounted, url })) findings.push({ class: "mounts", ...finding, repository: directory, path });
      const key = one ? mountKey(url, norms) : null;
      const others = key === null ? [] : elsewhere.filter((other) => other.mounted !== mounted && mountKey(other.url, norms) === key);
      if (others.length > 0) findings.push({ class: "duplicate-mounts", kind: "duplicate-mount", rule: one.rule, repository: directory, path, urls: [...new Set([url, ...others.map((other) => other.url)])].sort(), mounts: [...new Set([mounted, ...others.map((other) => other.mounted)])].sort() });
      const missing = missingParentWords(mounted, norms);
      if (missing.length > 0) findings.push({ class: "nesting", kind: "nesting", rule: norms.nesting.rule, repository: directory, path: mounted, name: path.split("/").pop(), parent: mounted.replace(/\/services\/[^/]+$/u, ""), reasons: [`its name lacks its parent's words: ${missing.join(", ")}`] });
    }
  }
  return findings;
}
