import { createGit } from "@red-cup-engineering/git-engine/git-process";
/**
 * Directory layout norms over a tree of checked-out repositories. Every rule is a row of `norms.json` `layout.relocations`
 * (`from` is a path variant, `to` the canonical path, both relative to the same directory at any depth of a repository):
 * - `checkLayout` reports each variant directory found;
 * - `relocate` moves one rule's variants onto their canonical paths with `git mv` inside the owning repository and
 *   rewrites the references that provably named a moved path;
 * - `censusLayout` counts directory names at the standard layout positions and proposes further rules.
 * Nothing here writes a file of its own: rows are returned to the caller.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { loadNorms } from "./naming.mjs";

const under = (path, directory) => directory === "" || path === directory || path.startsWith(`${directory}/`);
const endsWithPath = (path, tail) => path === tail || path.endsWith(`/${tail}`);
const entries = (directory) => readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
const isRepository = (directory) => existsSync(join(directory, ".git"));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The layout norms with their defaults filled in. */
export function layoutOf(norms = loadNorms()) {
  const { skip = [], positions = [], standard = {}, relocations = [] } = norms.layout ?? {};
  return { skip, positions, standard, relocations };
}

/**
 * Every directory under `root` that no `skip` path names, parents before children, as `{ repository, path, directory }`:
 * `repository` is the nearest enclosing directory holding `.git` (or `root`), `path` the directory relative to it.
 * `skip` paths are matched against the path below `root`, so a root inside a skipped directory is still walked.
 */
export function* walkDirectories(root, { skip = [] } = {}) {
  function* visit(directory, below, repository, path) {
    yield { repository, path, directory };
    for (const entry of entries(directory)) {
      if (!entry.isDirectory()) continue;
      const childBelow = below ? `${below}/${entry.name}` : entry.name;
      if (skip.some((tail) => endsWithPath(childBelow, tail))) continue;
      const child = join(directory, entry.name);
      if (isRepository(child)) yield* visit(child, childBelow, child, "");
      else yield* visit(child, childBelow, repository, path ? `${path}/${entry.name}` : entry.name);
    }
  }
  yield* visit(resolve(root), "", resolve(root), "");
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

const MARKDOWN_LINK = /(\]\(\s*<?)([^)\s>#?]+)([^)]*\))/gu;
const plainRelative = (target) => !/^(?:[a-z][a-z0-9+.-]*:|\/|#|~)/iu.test(target);

/**
 * Rewrites the references `repository` holds to paths a relocation moved, and lists those it left.
 * - A markdown link is resolved from the file that holds it (from where that file stood before the move), and rewritten
 *   when it lands on a moved path, or when the holding file itself moved and the link climbs out of the moved directory.
 * - Any other mention of the variant path is rewritten when, read from one of the directories above the file, it names a
 *   file or subdirectory that moved. A mention of the variant directory itself is rewritten only in `package.json`:
 *   elsewhere it may be a statement about the variant (a rule, a scanner), which only a reader can tell.
 * `moved` maps old file path to new; `kept` are the files a collision left in place.
 */
function rewriteReferences(repository, entry, { moved, kept, apply, git, skip }) {
  const rewritten = [], remaining = [];
  const oldOf = new Map([...moved].map(([from, to]) => [to, from]));
  const movedDirectory = (path) => !kept.some((file) => under(file, path)) && [...moved.keys()].some((file) => under(file, path) && file !== path);
  const relocated = (path) => {
    if (moved.has(path)) return moved.get(path);
    if (!movedDirectory(path)) return null;
    const sample = [...moved.keys()].find((file) => under(file, path));
    return `${moved.get(sample).slice(0, moved.get(sample).length - (sample.length - path.length))}`;
  };
  const standing = (path) => (apply ? existsSync(join(repository, path)) : existsSync(join(repository, path)) && !moved.has(path));
  const token = new RegExp(`(?<![A-Za-z0-9_-])((?:[A-Za-z0-9_.@-]+/)*)${escapeRegExp(entry.from)}(?![A-Za-z0-9_-])((?:/[A-Za-z0-9_.@%-]+)*)(/?)`, "gu");
  const segments = entry.from.split("/").map(escapeRegExp);
  const assembled = new RegExp(segments.join(`["'\`]\\s*,\\s*["'\`]`), "u");
  const patterns = [escapeRegExp(entry.from), segments.join(`["'\`][[:space:]]*,[[:space:]]*["'\`]`), "\\]\\("];
  for (const file of textFiles(repository, git, skip, patterns)) {
    const before = apply ? (oldOf.get(file) ?? file) : file;
    const now = apply ? file : (moved.get(file) ?? file);
    const here = posix.dirname(before) === "." ? "" : posix.dirname(before);
    const from = (base, path) => { const joined = posix.normalize(posix.join(base, path)); return joined.startsWith("..") ? null : joined.replace(/\/$/u, ""); };
    const absolute = join(repository, file);
    if (lstatSync(absolute).isSymbolicLink()) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    let changed = false;
    lines.forEach((line, index) => {
      const note = (list, row) => list.push({ file: now, line: index + 1, ...row });
      let next = line;
      if (/\.(?:md|markdown|mdx)$/iu.test(file)) {
        next = next.replace(MARKDOWN_LINK, (whole, open, target, close) => {
          if (!plainRelative(target)) return whole;
          let decoded; try { decoded = decodeURI(target); } catch { return whole; }
          const aimed = from(here, decoded);
          if (aimed === null || aimed === "") return whole;
          const landed = relocated(aimed) ?? aimed;
          if (landed === aimed && now === before) return whole;
          if (landed === aimed && !standing(aimed)) return whole;
          const link = posix.relative(posix.dirname(now) === "." ? "" : posix.dirname(now), landed) || ".";
          const written = encodeURI(`${target.startsWith("./") && !link.startsWith(".") ? "./" : ""}${link}${target.endsWith("/") ? "/" : ""}`);
          if (written === target) return whole;
          note(rewritten, { from: target, to: written });
          return `${open}${written}${close}`;
        });
      }
      const edits = [];
      for (const match of next.matchAll(token)) {
        const [whole, prefix, suffix, slash] = match;
        if (/[:/~]$/u.test(next.slice(0, match.index))) { note(remaining, { text: whole, reason: "absolute path or URL" }); continue; }
        const path = `${prefix}${entry.from}${suffix}`;
        const bases = here.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")).concat(here === "" ? [] : [""]);
        // Read from each directory above the file; the mention is rewritten only when exactly one reading names a relocated path.
        const readings = [...new Set(bases.map((base) => from(base, path)).filter((aimed) => aimed !== null && aimed !== ""))];
        const left = readings.filter((aimed) => kept.some((file_) => under(file_, aimed)));
        const hits = readings.filter((aimed) => relocated(aimed));
        if (hits.length !== 1 || left.length) {
          note(remaining, { text: whole, reason: left.length ? "names a path a collision left in place" : hits.length > 1 ? "names more than one moved path" : "names no path this relocation moved" });
          continue;
        }
        if (suffix === "" && posix.basename(file) !== "package.json") { note(remaining, { text: whole, reason: "names the variant directory itself; a reader decides" }); continue; }
        if (now !== before && prefix.startsWith("..")) { note(remaining, { text: whole, reason: "relative path in a file that moved" }); continue; }
        const written = `${prefix}${entry.to}${suffix}${slash}`;
        edits.push({ index: match.index, length: whole.length, written });
        note(rewritten, { from: whole, to: written });
      }
      for (const edit of edits.reverse()) next = `${next.slice(0, edit.index)}${edit.written}${next.slice(edit.index + edit.length)}`;
      if (assembled.test(next)) note(remaining, { text: assembled.exec(next)[0], reason: "path assembled from segments" });
      if (next !== line) { lines[index] = next; changed = true; }
    });
    if (changed && apply) writeFileSync(absolute, lines.join("\n"));
  }
  return { rewritten, remaining };
}

/**
 * Moves every variant directory of one rule under `root` onto its canonical path, in the repository that owns it.
 * A file the canonical directory lacks is moved (`git mv` when tracked); a file it already holds with the same content
 * is dropped from the variant; a file it holds with other content stays where it is and is listed in `kept`.
 * Without `apply` nothing changes. Yields one `relocation` row per variant directory, then one `references` row per
 * repository changed. A rule that `norms.json` holds, and a variant directory holding a nested repository, are refused.
 */
export function* relocate(root, { rule, apply = false, norms = loadNorms(), git = createGit() } = {}) {
  const { skip, relocations } = layoutOf(norms);
  const entry = relocations.find((candidate) => candidate.rule === rule);
  if (!entry) throw new Error(`no layout rule named ${rule}; norms.json has ${relocations.map((candidate) => candidate.rule).join(", ")}`);
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
      const tracked = new Set(git(repository, ["ls-files", "-z", "--", found]).split("\0").filter(Boolean));
      const attempt = (file, act) => { try { act(); return true; } catch (error) { failed.push({ file, error: String(error.message ?? error).split("\n")[0] }); return false; } };
      for (const { from, to } of plan.move) {
        if (!tracked.has(from)) untracked += 1;
        const done = attempt(from, () => {
          mkdirSync(dirname(join(repository, to)), { recursive: true });
          if (tracked.has(from)) git(repository, ["mv", "--", from, to]);
          else renameSync(join(repository, from), join(repository, to));
        });
        if (done) state.moved.set(from, to); else state.kept.push(from);
      }
      for (const { from, to } of plan.drop) {
        if (!tracked.has(from)) untracked += 1;
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
    yield { kind: "references", rule, repository, outcome: apply ? "rewritten" : "would rewrite", ...rewriteReferences(repository, entry, { moved, kept, apply, git, skip }) };
  }
}

const singular = (word) => (word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("sses") ? word.slice(0, -2) : word.length > 2 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
const spelled = (name) => name.toLowerCase().replace(/[_.\s]+/gu, "-");
const numbered = (name) => spelled(name).split("-").map(singular).join("-");

/**
 * Counts the directory names found at each standard layout position (`norms.json` `layout.positions`, relative to each
 * repository's root) across the repositories under `root`, then proposes rules. Yields `name` rows
 * (`position`, `name`, `repositories`, `files`) and `candidate` rows (`variant` path, proposed `canonical` path, the
 * `reason` they look like one name, `repositories` and `files` under the variant, and the `basis` of the proposal:
 * a ruling in `norms.json`, else the seat `layout.standard` states for the name, else the form more repositories use).
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
