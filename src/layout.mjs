import { walkPosixPathsSync } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { DATA_CUSTODY_KINDS } from "@red-cup-engineering/data-custody-directory-service";
import { admitDispositions, applyRelocation, planRelocation as planResourceRelocation, proposeRelocation, verifyRelocation } from "@red-cup-engineering/computer-file-engine/relocation";
/**
 * Directory layout norms over a tree of checked-out repositories. Every rule is a row of the section law's relocations
 * (`from` is a path variant, `to` the canonical path, both relative to the same directory at any depth of a repository):
 * - `checkLayout` reports each variant directory found;
 * - `relocate` moves one rule's variants onto their canonical paths inside the owning repository and rewrites the
 *   references to them;
 * - `censusLayout` counts directory names at the standard layout positions and proposes further rules.
 * Nothing here writes a file of its own: rows are returned to the caller.
 * The tree walk is the filepath section's `walkPosixPathsSync`, the moving and the reference rewriting are the file
 * engine's one relocation, and the names `data/` may hold are the data-custody-directory service's.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { loadNorms } from "./naming.mjs";

const under = (path, directory) => directory === "" || path === directory || path.startsWith(`${directory}/`);
const endsWithPath = (path, tail) => path === tail || path.endsWith(`/${tail}`);
/**
 * The canonical path of `path` under a relocation row, or null when the row does not relocate it. A row relocates only
 * its variant: a path already at the canonical path (it ends with `to`) is never a variant, and a row whose `from` is
 * its `to` moves nothing. So the canonical path is never itself found, and applying a row twice is a no-op.
 */
export function canonicalOf(path, { from, to }) {
  if (from === to || !endsWithPath(path, from) || endsWithPath(path, to)) return null;
  return `${path.slice(0, path.length - from.length)}${to}`;
}
// A directory another process removed during the walk reads as empty.
const entries = (directory) => { try { return readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const isRepository = (directory) => existsSync(join(directory, ".git"));

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

/** The workspace root and repository name the file engine names a repository by: the repository's parent and its own directory name. */
const repositoryAt = (repository) => ({ workspaceRoot: dirname(repository), name: basename(repository) });

/** The file engine's request to move the variant directory `found` onto `canonical` inside `repository`. */
function requestFor(repository, found, canonical, rest = {}) {
  const { workspaceRoot, name } = repositoryAt(repository);
  return { workspaceRoot, source: { repository: name }, destination: { repository: name, moves: [{ from: found, to: canonical }] }, proposedBy: "repository-norms", ...rest };
}

/** What moving the variant directory `found` onto `canonical` would do to each file: move it, drop it (same content there), or keep it. */
function planRelocation(repository, found, canonical) {
  const plan = { files: 0, canonicalExists: existsSync(join(repository, canonical)), move: [], drop: [], keep: [], nestedRepository: false };
  let proposal;
  try { proposal = proposeRelocation(requestFor(repository, found, canonical)); } catch { return plan; }
  const inside = (path) => path.slice(path.indexOf("/") + 1);
  plan.nestedRepository = proposal.refusals.some((item) => item.reason === "nested repository");
  plan.refusals = proposal.refusals;
  const { admitted } = admitDispositions(proposal);
  const within = (location) => location.slice(repositoryAt(repository).name.length + 1);
  for (const item of admitted.moves) (item.disposition === "move" ? plan.move : plan.drop).push({ from: within(item.from), to: within(item.to) });
  for (const item of admitted.collisions) plan.keep.push(within(item.from));
  plan.files = plan.move.length + plan.drop.length + plan.keep.length;
  void inside;
  return plan;
}

/** Every variant directory under `root`, one row each. `rule` narrows the check to one rule. */
export function* checkLayout(root, { rule, norms = loadNorms() } = {}) {
  const { skip, relocations } = layoutOf(norms);
  const rules = relocations.filter((entry) => !rule || entry.rule === rule);
  for (const { repository, path } of walkDirectories(root, { skip })) {
    for (const entry of rules) {
      const canonical = canonicalOf(path, entry);
      if (canonical === null) continue;
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

/**
 * Moves every variant directory of one rule under `root` onto its canonical path, in the repository that owns it: the
 * file engine's one relocation, each variant directory one move whose support is the section law's rule.
 * A file the canonical directory lacks is moved (and staged as `git mv` would, when tracked); a file it already holds with
 * the same content is dropped from the variant; a file it holds with other content stays where it is and is listed in
 * `kept`. With `worktree` no git command writes, so the index is untouched. Without `apply` nothing changes.
 * Yields one `relocation` row per variant directory, then one `references` row per repository changed: the references
 * rewritten, the mentions of a moved path the move left naming it (`remaining`) and the bare names held as ambiguous.
 * A rule the section law holds, and a variant directory holding a nested repository, are refused.
 */
export async function* relocate(root, { rule, apply = false, worktree = false, norms = loadNorms() } = {}) {
  const { skip, relocations } = layoutOf(norms);
  const entry = relocations.find((candidate) => candidate.rule === rule);
  if (!entry) throw new Error(`no layout rule named ${rule}; the section law has ${relocations.map((candidate) => candidate.rule).join(", ")}`);
  if (entry.hold) throw new Error(`layout rule ${rule} is held: ${entry.hold}`);
  const changed = new Map();
  for (const { plan, ...row } of [...checkLayout(root, { rule, norms })]) {
    const { repository, found } = row;
    if (plan.nestedRepository) { yield { kind: "relocation", ...row, outcome: "refused", reason: "the variant directory holds a nested repository" }; continue; }
    const state = changed.get(repository) ?? { rewritten: [], remaining: [], ambiguous: [] };
    changed.set(repository, state);
    const kept = plan.keep.map((file) => ({ file, canonical: `${row.canonical}${file.slice(found.length)}` }));
    const request = requestFor(repository, found, row.canonical, { references: "mentions", keepStatements: true, supportedBy: `the section law's layout rule ${rule}`, excludeCarriers: norms.lawSources ?? [], stage: apply && !worktree });
    if (plan.files === 0 || plan.move.length + plan.drop.length === 0) {
      yield { kind: "relocation", ...row, outcome: apply ? "moved" : "would move", moved: 0, dropped: 0, kept };
      continue;
    }
    let planned, verified;
    try {
      planned = await planResourceRelocation(request);
      if (planned.refusals.length) throw new Error(planned.refusals.map((item) => `${item.path}: ${item.reason}`).join("; "));
      if (apply) { applyRelocation(planned, { stage: request.stage }); verified = await verifyRelocation(planned); }
    } catch (error) { yield { kind: "relocation", ...row, outcome: "refused", reason: String(error.message ?? error).split("\n")[0] }; continue; }
    for (const edit of planned.rewrites) {
      const counts = new Map();
      for (const reference of edit.references) counts.set(`${reference.before}\u0000${reference.after}`, (counts.get(`${reference.before}\u0000${reference.after}`) ?? 0) + 1);
      for (const [key, count] of counts) { const [before, after] = key.split("\u0000"); state.rewritten.push({ file: edit.path.slice(basename(repository).length + 1), from: before, to: after, count }); }
    }
    state.remaining.push(...(verified?.dangling ?? []).map((item) => ({ file: item.path.slice(basename(repository).length + 1), text: item.reference })));
    state.ambiguous.push(...planned.ambiguous.map((item) => ({ file: item.path.slice(basename(repository).length + 1), text: item.reference })));
    yield { kind: "relocation", ...row, outcome: apply ? "moved" : "would move", moved: plan.move.length, dropped: plan.drop.length, kept };
  }
  for (const [repository, { rewritten, remaining, ambiguous }] of changed) {
    if (rewritten.length === 0 && ambiguous.length === 0) continue;
    yield { kind: "references", rule, repository, outcome: apply ? "rewritten" : "would rewrite", rewritten, remaining, ambiguous, remainingByClass: { "resolves to a moved path": remaining.length, "ambiguous: held, a bare name may not be a path": ambiguous.length } };
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
