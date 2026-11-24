/**
 * Repository naming norms. A section repository names its organization's domain (`x-engineering-services-section`,
 * `x-science-services-section`, `x-operations-services-section`; `public-x-services-section` and
 * `561-group-x-services-section` where that organization already uses the prefix form). Anything else is an
 * application, library or service under its plain name. Dated snapshots are archives, not renamed.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findForestRoot, readSectionLaw } from "@red-cup-engineering/service-section-engineering-services-section/section-law";

/**
 * The files `readSectionLaw` loads, as absolute real paths: the Group section's schemas it reads (the form schema and
 * the content taxonomy) and the section package's own `section-mounting.json` and `agency-layout.json`. The loader keeps
 * no list of its own, so this one names the same files; a file that does not exist is left out. `relocate` never
 * rewrites these.
 */
export function lawSourceFiles({ forestRoot } = {}) {
  const loader = dirname(fileURLToPath(import.meta.resolve("@red-cup-engineering/service-section-engineering-services-section/section-law")));
  const own = join(loader, "../data/records/schemas");
  const root = forestRoot ?? findForestRoot(loader);
  const group = root ? join(resolve(root), "services/561-group-services-section/data/records/schemas") : null;
  return [
    ...(group ? ["services-section-form.schema.json", "services-section-form-content-taxonomy.json"].map((file) => join(group, file)) : []),
    ...["section-mounting.json", "agency-layout.json"].map((file) => join(own, file)),
  ].filter((file) => existsSync(file)).map((file) => realpathSync(file));
}

/** The norms: this package's naming settings (`norms.json`) and every placement rule, read from the section law
 * (`readSectionLaw`: layout, mounts, nesting, subjects). This package holds no placement rule of its own. */
export const loadNorms = ({ forestRoot } = {}) => ({
  ...JSON.parse(readFileSync(new URL("../norms.json", import.meta.url), "utf8")),
  ...readSectionLaw(forestRoot === undefined ? {} : { forestRoot }),
  lawSources: lawSourceFiles(forestRoot === undefined ? {} : { forestRoot }),
});

const segments = (name) => name.split("-");
const hasDomain = (base, domain) => {
  const parts = segments(base), want = segments(domain);
  for (let i = 0; i + want.length <= parts.length; i += 1) if (want.every((w, j) => parts[i + j] === w)) return true;
  return false;
};

/** { kind: "meta" | "archive" | "section" | "package", ok, proposed?, reason } for one repository name. */
export function classifyName(owner, name, norms = loadNorms()) {
  if (norms.meta.includes(name)) return { kind: "meta", ok: true };
  if (new RegExp(norms.archive, "u").test(name)) return { kind: "archive", ok: true, reason: "dated snapshot: archive it rather than rename it" };
  const org = norms.organizations[owner];
  let fixed = name, typo = false;
  for (const [pattern, replacement] of norms.sectionTypos) {
    const re = new RegExp(pattern, "u");
    if (re.test(fixed)) { fixed = fixed.replace(re, replacement); typo = true; }
  }
  if (!fixed.endsWith(norms.sectionSuffix)) return { kind: "package", ok: true };
  if (!org) return { kind: "section", ok: !typo, ...(typo ? { proposed: fixed, reason: "section suffix" } : {}) };
  const base = fixed.slice(0, -norms.sectionSuffix.length);
  if (base === org.domain || hasDomain(base, org.domain)) {
    return typo ? { kind: "section", ok: false, proposed: fixed, reason: "section suffix" } : { kind: "section", ok: true };
  }
  const proposed = org.style === "prefix" ? `${org.domain}-${base}${norms.sectionSuffix}` : `${base}-${org.domain}${norms.sectionSuffix}`;
  return { kind: "section", ok: false, proposed, reason: `a ${org.domain} section names its domain` };
}
