/**
 * Repository naming norms. A section repository names its organization's domain (`x-engineering-services-section`,
 * `x-science-services-section`, `x-operations-services-section`; `public-x-services-section` and
 * `561-group-x-services-section` where that organization already uses the prefix form). Anything else is an
 * application, library or service under its plain name. Dated snapshots are archives, not renamed.
 */
import { readFileSync } from "node:fs";

export const loadNorms = () => JSON.parse(readFileSync(new URL("../norms.json", import.meta.url), "utf8"));

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
