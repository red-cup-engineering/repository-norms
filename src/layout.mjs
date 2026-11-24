import { createGit } from "@red-cup-engineering/git-engine/git-process";
import { walkPosixPathsSync } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { DATA_CUSTODY_KINDS } from "@red-cup-engineering/data-custody-directory-service";
import { planMovedPathReferenceUpdates } from "@red-cup-engineering/service-section-engineering-services-section/plan-moved-path-reference-updates";
/**
 * Directory layout norms over a tree of checked-out repositories. Every rule is a row of the section law's relocations
 * (`from` is a path variant, `to` the canonical path, both relative to the same directory at any depth of a repository):
 * - `checkLayout` reports each variant directory found;
 * - `relocate` moves one rule's variants onto their canonical paths with `git mv` inside the owning repository and
 *   rewrites the references that provably named a moved path;
 * - `censusLayout` counts directory names at the standard layout positions and proposes further rules.
 * Nothing here writes a file of its own: rows are returned to the caller.
 * The tree walk is the filepath section's `walkPosixPathsSync`, the reference edits are the services-section engine's
 * `planMovedPathReferenceUpdates`, a whole-directory move in the worktree is the relocating-directory service's, and
 * the names `data/` may hold are the data-custody-directory service's.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNorms } from "./naming.mjs";

const under = (path, directory) => directory === "" || path === directory || path.startsWith(`${directory}/`);
const endsWithPath = (path, tail) => path === tail || path.endsWith(`/${tail}`);
// A directory another process removed during the walk reads as empty.
const entries = (directory) => { try { return readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const isRepository = (directory) => existsSync(join(directory, ".git"));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The layout norms with their defaults filled in. */
export function layoutOf(norms = loadNorms()) {
  const { skip = [], positions = [], standard = {}, relocations = [] } = norms.layout ?? {};
  // What `data/` may hold is the data-custody-directory service's to say, not a second list here.
  return { skip, positions, standard: { ...standard, data: standard.data ?? [...DATA_CUSTODY_KINDS] }, relocations };
}

/**
 * Walks `root` with the filepath section's `walkPosixPathsSync`, parents before children, calling `visit` with each
 * entry outside the `skip` paths: `{ repository, path, below, name, kind, absolute, mounted }`. `repository` is the
 * nearest enclosing directory holding `.git` (or `root`) and `path` the entry's path in it; `below` is its path below
 * `root`; `mounted` says the entry is itself a repository. `skip` paths are matched against `below`, so a root inside a
 * skipped directory is still walked. A directory is not entered when `visit` returns false. A path another process
 * removes during the walk is passed over.
 */
export function walkEntries(root, { skip = [], visit }) {
  const top = resolve(root);
  const owners = new Map([[top, { repository: top, path: "" }]]);
  const entered = new Set();
  walkPosixPathsSync({
    root: top, excludes: skip.filter((tail) => !tail.includes("/")), result: "paths", missing: "skip", unreadable: "skip", symlinks: "skip",
    includeFile: () => false,
    includeDirectory: ({ absolutePath }) => entered.has(absolutePath),
    inspectEntry: ({ path: below, absolutePath: absolute, name, kind }) => {
      if (skip.some((tail) => endsWithPath(below, tail))) return;
      const owner = owners.get(dirname(absolute));
      const path = owner.path ? `${owner.path}/${name}` : name;
      const mounted = kind === "directory" && isRepository(absolute);
      if (visit({ repository: owner.repository, path, below, name, kind, absolute, mounted }) === false || kind !== "directory") return;
      owners.set(absolute, mounted ? { repository: absolute, path: "" } : { repository: owner.repository, path });
      entered.add(absolute);
    },
  });
}

/**
 * Every directory under `root` that no `skip` path names, parents before children, as `{ repository, path, directory }`:
 * `repository` is the nearest enclosing directory holding `.git` (or `root`), `path` the directory relative to it.
 */
export function* walkDirectories(root, { skip = [] } = {}) {
  const top = resolve(root);
  const found = [{ repository: top, path: "", directory: top }];
  walkEntries(top, { skip, visit: ({ repository, path, kind, absolute, mounted }) => { if (kind === "directory") found.push(mounted ? { repository: absolute, path: "", directory: absolute } : { repository, path, directory: absolute }); } });
  yield* found;
}

/** The files under `directory`, as paths relative to it, and whether a nested repository sits among them. */
function filesUnder(directory) {
  const files = [];
  let nestedRepository = false;
  const visit = (current, prefix) => {
    for (const entry of entries(current)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === ".git") nestedRepository = true;
      else if (entry.isDirectory()) visit(join(current, entry.name), path);
      else files.push(path);
    }
  };
  visit(directory, "");
  return { files, nestedRepository };
}

function sameContent(a, b) {
  const [x, y] = [lstatSync(a), lstatSync(b)];
  if (x.isSymbolicLink() || y.isSymbolicLink()) return x.isSymbolicLink() && y.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  return x.isFile() && y.isFile() && x.size === y.size && readFileSync(a).equals(readFileSync(b));
}

/** What moving the variant directory `found` onto `canonical` would do to each file: move it, drop it, or keep it. */
function planRelocation(repository, found, canonical) {
  const { files, nestedRepository } = filesUnder(join(repository, found));
  const plan = { files: files.length, canonicalExists: existsSync(join(repository, canonical)), move: [], drop: [], keep: [], nestedRepository };
  for (const file of files) {
    const [from, to] = [`${found}/${file}`, `${canonical}/${file}`];
    const target = lstatSync(join(repository, to), { throwIfNoEntry: false });
    // A file where a directory of the path is needed leaves nothing to move onto.
    const blocked = !target && to.split("/").some((_, i, parts) => i > 0 && lstatSync(join(repository, parts.slice(0, i).join("/")), { throwIfNoEntry: false })?.isDirectory() === false);
    if (!target && !blocked) plan.move.push({ from, to });
    else if (target && sameContent(join(repository, from), join(repository, to))) plan.drop.push({ from, to });
    else plan.keep.push(from);
  }
  return plan;
}

/** Every variant directory under `root`, one row each. `rule` narrows the check to one rule. */
export function* checkLayout(root, { rule, norms = loadNorms() } = {}) {
  const { skip, relocations } = layoutOf(norms);
  const rules = relocations.filter((entry) => !rule || entry.rule === rule);
  for (const { repository, path } of walkDirectories(root, { skip })) {
    for (const entry of rules) {
      if (!endsWithPath(path, entry.from)) continue;
      const canonical = `${path.slice(0, path.length - entry.from.length)}${entry.to}`;
      const plan = planRelocation(repository, path, canonical);
      yield {
        rule: entry.rule, repository, found: path, canonical, files: plan.files, canonicalExists: plan.canonicalExists,
        collisions: plan.keep.length, ...(plan.nestedRepository ? { nestedRepository: true } : {}), ...(entry.hold ? { hold: entry.hold } : {}), plan,
      };
    }
  }
}

const withoutPlan = ({ plan, ...row }) => row;
/** `checkLayout` rows as they are printed. */
export function* reportLayout(root, options) {
  for (const row of checkLayout(root, options)) yield withoutPlan(row);
}

function removeEmptyDirectories(directory) {
  for (const entry of entries(directory)) if (entry.isDirectory()) removeEmptyDirectories(join(directory, entry.name));
  if (readdirSync(directory).length === 0) rmdirSync(directory);
}

/** Text files of `repository` (tracked, or untracked and not ignored) outside the `skip` paths, as relative paths. */
function textFiles(repository, git, skip, patterns) {
  const output = git(repository, ["grep", "-l", "-z", "-I", "--untracked", "-E", ...patterns.flatMap((p) => ["-e", p])], { ok: [0, 1] });
  return output.split("\0").filter(Boolean).filter((file) => !file.split("/").some((_, i, parts) => skip.some((tail) => endsWithPath(parts.slice(0, i + 1).join("/"), tail))));
}

/**
 * Rewrites the references `repository` holds to paths a relocation moved, and lists the mentions of the variant path
 * that are left. The edits are the services-section engine's `planMovedPathReferenceUpdates`: repository-relative and
 * file-relative paths to a moved file or a wholly moved directory, and in a moved file its relative paths to files that
 * stayed. When the planner holds its plan (a bare directory name it cannot tell from a word) nothing is rewritten.
 * `moved` maps old file path to new; a directory a collision left a file in did not wholly move, so it is not rewritten.
 */
function rewriteReferences(repository, entry, { moved, apply, git, skip }) {
  const oldOf = new Map([...moved].map(([from, to]) => [to, from]));
  const text = (file) => {
    const found = lstatSync(join(repository, file), { throwIfNoEntry: false });
    if (!found?.isFile()) return null;
    const bytes = readFileSync(join(repository, file));
    return bytes.includes(0) ? null : bytes.toString("utf8");
  };
  // The files as they stand now; before `apply` a moved file is read where it still is and planned where it will be.
  const standing = git(repository, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter((file) => file && lstatSync(join(repository, file), { throwIfNoEntry: false }));
  const tracked = [...new Set(standing.map((file) => (apply ? oldOf.get(file) ?? file : file)))];
  // Any text file may hold a path relative to itself, so each one outside the skipped paths is handed to the planner.
  const candidates = new Set(textFiles(repository, git, skip, ["^"]));
  const files = [...candidates].sort().flatMap((file) => { const read = text(file); return read === null ? [] : [{ at: file, path: apply ? file : moved.get(file) ?? file, text: read }]; });
  const rewritten = [], remaining = [];
  let planned = [];
  try {
    planned = planMovedPathReferenceUpdates({ tracked, moves: [...moved].map(([from, to]) => ({ from, to })), files: files.map(({ path, text: read }) => ({ path, text: read })) });
  } catch (error) {
    if (error.code !== "ERR_AMBIGUOUS_DIRECTORY_REFERENCE") throw error;
    remaining.push({ file: error.path, text: error.reference, reason: "the reference planner held its plan: a bare directory name may not be a path" });
  }
  const after = new Map(planned.map((plan) => [plan.path, plan]));
  const mention = new RegExp(`(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_.@-]+/)*${escapeRegExp(entry.from)}(?![A-Za-z0-9_-])(?:/[A-Za-z0-9_.@%-]+)*/?`, "gu");
  for (const file of files) {
    const plan = after.get(file.path);
    for (const update of plan?.updates ?? []) rewritten.push({ file: file.path, from: update.from, to: update.to, count: update.count });
    if (plan && apply) writeFileSync(join(repository, file.at), plan.text);
    (plan?.text ?? file.text).split("\n").forEach((line, index) => { for (const [found] of line.matchAll(mention)) remaining.push({ file: file.path, line: index + 1, text: found, reason: "left by the reference planner" }); });
  }
  return { rewritten, remaining };
}

/** Moves a whole directory with the relocating-directory service: one rename, never a merge or an overwrite. */
function relocateWholeDirectory(source, destination) {
  const service = fileURLToPath(import.meta.resolve("@red-cup-engineering/relocating-directory-service"));
  const run = spawnSync(process.execPath, [service, "--source", source, "--destination", destination, "--apply"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error((run.stderr || run.error?.message || `relocate-directory exited ${run.status}`).trim());
}

/**
 * Moves every variant directory of one rule under `root` onto its canonical path, in the repository that owns it.
 * A file the canonical directory lacks is moved (`git mv` when tracked); a file it already holds with the same content
 * is dropped from the variant; a file it holds with other content stays where it is and is listed in `kept`.
 * With `worktree` every move and drop is a plain rename or unlink: no git command writes, so the index is untouched.
 * Without `apply` nothing changes. Yields one `relocation` row per variant directory, then one `references` row per
 * repository changed. A rule the section law holds, and a variant directory holding a nested repository, are refused.
 */
export function* relocate(root, { rule, apply = false, worktree = false, norms = loadNorms(), git = createGit() } = {}) {
  const { skip, relocations } = layoutOf(norms);
  const entry = relocations.find((candidate) => candidate.rule === rule);
  if (!entry) throw new Error(`no layout rule named ${rule}; the section law has ${relocations.map((candidate) => candidate.rule).join(", ")}`);
  if (entry.hold) throw new Error(`layout rule ${rule} is held: ${entry.hold}`);
  const changed = new Map();
  for (const { plan, ...row } of [...checkLayout(root, { rule, norms })]) {
    const { repository, found } = row;
    if (plan.nestedRepository) { yield { kind: "relocation", ...row, outcome: "refused", reason: "the variant directory holds a nested repository" }; continue; }
    const state = changed.get(repository) ?? { moved: new Map(), kept: [] };
    changed.set(repository, state);
    const failed = [];
    let untracked = 0;
    if (apply) {
      const tracked = new Set(worktree ? [] : git(repository, ["ls-files", "-z", "--", found]).split("\0").filter(Boolean));
      const attempt = (file, act) => { try { act(); return true; } catch (error) { failed.push({ file, error: String(error.message ?? error).split("\n")[0] }); return false; } };
      // Nothing stands at the canonical path: with `worktree` the directory moves whole, by the relocating-directory service.
      const whole = worktree && !plan.canonicalExists && plan.move.length > 0 && attempt(found, () => relocateWholeDirectory(join(repository, found), join(repository, row.canonical)));
      if (whole) for (const { from, to } of plan.move) state.moved.set(from, to);
      for (const { from, to } of whole ? [] : plan.move) {
        if (!worktree && !tracked.has(from)) untracked += 1;
        const done = attempt(from, () => {
          mkdirSync(dirname(join(repository, to)), { recursive: true });
          if (tracked.has(from)) git(repository, ["mv", "--", from, to]);
          else renameSync(join(repository, from), join(repository, to));
        });
        if (done) state.moved.set(from, to); else state.kept.push(from);
      }
      for (const { from, to } of plan.drop) {
        if (!worktree && !tracked.has(from)) untracked += 1;
        const done = attempt(from, () => {
          if (!tracked.has(from)) return unlinkSync(join(repository, from));
          // The canonical copy takes the dropped copy's place in the index when it was not tracked itself.
          if (git(repository, ["ls-files", "--", to]) === "") git(repository, ["add", "--", to], { ok: [0, 1] });
          git(repository, ["rm", "-q", "-f", "--", from]);
        });
        if (done) state.moved.set(from, to); else state.kept.push(from);
      }
      if (existsSync(join(repository, found))) removeEmptyDirectories(join(repository, found));
    } else {
      for (const { from, to } of [...plan.move, ...plan.drop]) state.moved.set(from, to);
    }
    state.kept.push(...plan.keep);
    yield {
      kind: "relocation", ...row, outcome: apply ? (failed.length ? "moved in part" : "moved") : "would move",
      moved: plan.move.length - failed.filter(({ file }) => plan.move.some(({ from }) => from === file)).length,
      dropped: plan.drop.length - failed.filter(({ file }) => plan.drop.some(({ from }) => from === file)).length,
      kept: plan.keep.map((file) => ({ file, canonical: `${row.canonical}${file.slice(found.length)}` })),
      ...(untracked ? { untracked } : {}), ...(failed.length ? { failed } : {}),
    };
  }
  for (const [repository, { moved, kept }] of changed) {
    if (moved.size === 0) continue;
    yield { kind: "references", rule, repository, outcome: apply ? "rewritten" : "would rewrite", ...rewriteReferences(repository, entry, { moved, apply, git, skip }) };
  }
}

const singular = (word) => (word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("sses") ? word.slice(0, -2) : word.length > 2 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
const spelled = (name) => name.toLowerCase().replace(/[_.\s]+/gu, "-");
const numbered = (name) => spelled(name).split("-").map(singular).join("-");

/**
 * Counts the directory names found at each standard layout position (the section law's `layout.positions`, relative to each
 * repository's root) across the repositories under `root`, then proposes rules. Yields `name` rows
 * (`position`, `name`, `repositories`, `files`) and `candidate` rows (`variant` path, proposed `canonical` path, the
 * `reason` they look like one name, `repositories` and `files` under the variant, and the `basis` of the proposal:
 * a ruling in the section law, else the seat `layout.standard` states for the name, else the form more repositories use).
 * Reads only.
 */
export function* censusLayout(root, { norms = loadNorms() } = {}) {
  const { skip, positions, standard, relocations } = layoutOf(norms);
  const counts = new Map(); // position -> name -> { repositories, files }
  const filesIn = new Map();
  const repositories = new Set();
  const directories = [...walkDirectories(root, { skip })];
  for (const { repository, directory } of directories) {
    repositories.add(repository);
    const own = entries(directory).filter((entry) => !entry.isDirectory() && entry.name !== ".git").length;
    for (let current = directory; ; current = dirname(current)) {
      filesIn.set(current, (filesIn.get(current) ?? 0) + own);
      if (current === repository) break;
    }
  }
  for (const { path, directory } of directories) {
    if (path === "" || !positions.includes(posix.dirname(path) === "." ? "" : posix.dirname(path))) continue;
    const position = posix.dirname(path) === "." ? "" : posix.dirname(path);
    const names = counts.get(position) ?? counts.set(position, new Map()).get(position);
    const count = names.get(posix.basename(path)) ?? names.set(posix.basename(path), { repositories: 0, files: 0 }).get(posix.basename(path));
    count.repositories += 1;
    count.files += filesIn.get(directory) ?? 0;
  }
  const at = (position, name) => (position ? `${position}/${name}` : name);
  const stated = new Set(Object.entries(standard).flatMap(([position, names]) => names.map((name) => at(position, name))));
  for (const position of positions) {
    for (const [name, count] of [...(counts.get(position) ?? [])].sort((a, b) => b[1].repositories - a[1].repositories || (a[0] < b[0] ? -1 : 1))) {
      yield { kind: "name", position, name, ...count, ...(stated.has(at(position, name)) ? { standard: true } : {}) };
    }
  }

  // Paths whose last names differ only in number, hyphen, underscore or case are one name; so is one name at two depths.
  const groups = new Map();
  const join_ = (key, member) => groups.set(key, [...(groups.get(key) ?? []), member]);
  for (const position of positions) for (const [name, count] of counts.get(position) ?? []) join_(numbered(name), { path: at(position, name), position, name, ...count });
  const none = { repositories: 0, files: 0 };
  for (const path of stated) {
    const key = numbered(posix.basename(path));
    if (!groups.get(key)?.some((member) => member.path === path)) join_(key, { path, position: posix.dirname(path) === "." ? "" : posix.dirname(path), name: posix.basename(path), ...none });
  }
  const more = (a, b) => b.repositories - a.repositories || b.files - a.files;
  const candidates = [];
  for (const group of groups.values()) {
    const targets = new Set(relocations.map((entry) => entry.to));
    const seats = group.filter((member) => stated.has(member.path)).sort(more);
    const most = [...group].sort(more)[0];
    for (const member of group) {
      const ruled = relocations.find((entry) => entry.from === member.path);
      if (member.repositories === 0 || (!ruled && (stated.has(member.path) || targets.has(member.path)))) continue;
      if (!ruled && seats.length === 0 && (group.length < 2 || member === most)) continue;
      const kept = ruled ? (group.find((other) => other.path === ruled.to) ?? { path: ruled.to, name: posix.basename(ruled.to), position: posix.dirname(ruled.to), ...none }) : (seats[0] ?? most);
      const reasons = [
        ...(spelled(member.name) !== spelled(kept.name) ? ["singular and plural"] : []),
        ...(member.name !== kept.name && spelled(member.name) === spelled(kept.name) ? ["hyphen, underscore or case"] : []),
        ...(member.position !== kept.position ? ["same name at two depths"] : []),
      ];
      candidates.push({
        kind: "candidate", variant: member.path, canonical: kept.path, reasons, repositories: member.repositories, files: member.files,
        canonicalRepositories: kept.repositories, canonicalFiles: kept.files,
        basis: ruled ? `ruled: ${ruled.rule}${ruled.hold ? " (held)" : ""}` : seats.length ? `the services section form seats it there${seats.length > 1 ? ` (also at ${seats.slice(1).map((seat) => seat.path).join(", ")})` : ""}` : "more repositories use it",
      });
    }
  }
  for (const row of candidates.sort((a, b) => b.repositories - a.repositories || b.files - a.files || (a.variant < b.variant ? -1 : 1))) yield row;
  yield { kind: "summary", repositories: repositories.size, positions, candidates: candidates.length };
}
