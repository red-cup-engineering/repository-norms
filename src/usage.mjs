/** The commands of `repository-norms`, each with its arguments and whether it changes the tree (and with which flag). */
export const COMMANDS = [
  { usage: "check [DIR] [--warn]", does: "one checkout: its own name and its submodules (CI)" },
  { usage: "estate --org ORG [--org ORG]...", does: "every non-archived repository name of the organizations" },
  { usage: "frontdoor [DIR] [--json] [--warn]", does: "evidence-bound README entry-page observations" },
  { usage: "layout [ROOT] [--rule RULE] [--warn]", does: "every directory a layout rule relocates" },
  { usage: "relocate [ROOT] --rule RULE [--apply [--worktree]]", does: "moves one rule's directories onto their canonical paths and rewrites the references to them", changes: "--apply (--worktree: no git command writes)" },
  { usage: "forbidden [ROOT] [--apply]", does: "every file whose name is forbidden", changes: "--apply removes them" },
  { usage: "manifests [ROOT] [--apply]", does: "every root manifest without Node.js source", changes: "--apply removes them" },
  { usage: "readmes [ROOT] [--apply]", does: "every README alone among directories", changes: "--apply removes them" },
  { usage: "remove-paths [ROOT] [--apply]", does: 'the paths listed on stdin as JSON lines {"path": ...}, relative to ROOT', changes: "--apply removes them from the worktree" },
  { usage: "census [ROOT]", does: "directory names at the layout positions, and candidate rules" },
  { usage: "mounts [ROOT]", does: "every submodule mounted where a mount rule forbids it, or mounted twice" },
  { usage: "nesting [ROOT]", does: "every section the law's placement derivation puts elsewhere than where it stands" },
  { usage: "subjects [ROOT]", does: "every file or directory named for a subject outside its owning section" },
  { usage: "check-all [ROOT] [--class CLASS]... [--warn]", does: "every rule class over the tree; exit 1 on any finding" },
  { usage: "check-staged [REPOSITORY] [--root ROOT] [--base REV] [--tree TREE]", does: "what one commit would newly violate; exit 1 on any finding" },
];

export function usageText() {
  const width = Math.max(...COMMANDS.map(({ usage }) => usage.length));
  const lines = COMMANDS.map(({ usage, does, changes }) => `  ${usage.padEnd(width)}  ${does}${changes ? `  [CHANGES THE TREE: ${changes}]` : ""}`);
  return [
    "usage: repository-norms COMMAND [ARGUMENTS]", "", ...lines, "",
    "Every command reads only, and prints JSON lines, unless it is marked CHANGES THE TREE: those change nothing without --apply.",
    "ROOT and DIR default to the current directory. --warn reports findings without a failing exit status. --help prints this.", "",
  ].join("\n");
}
