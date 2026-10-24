/**
 * Read-only, source-bound assessment of a GitHub repository's first page.
 * No score or claimed semantic understanding: objective broken links are errors;
 * possible stale prose and unanswered visitor questions are review prompts.
 * `trackedPaths` must be HEAD's tracked paths, including submodule gitlinks.
 */
import { posix } from 'node:path';

const link = /!?\[[^\]\n]*\]\((<?[^)\s>]+>?)(?:\s+"[^"]*")?\)/gu;
// Capture backtick references without conflating code examples or normal prose.

function target(href) {
  const raw = href.replace(/^<|>$/gu, '').split(/[?#]/u, 1)[0];
  if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return { invalid: 'invalid URL encoding' }; }
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : decoded);
  if (path === '..' || path.startsWith('../')) return { invalid: 'target escapes repository root' };
  return { path: path.replace(/^\.\//u, '').replace(/\/$/u, '') };
}

export function assessFrontdoor({ readme, trackedPaths = undefined } = {}) {
  const findings = [], observed = { openingLine: null, headings: [], checkedRelativeLinks: 0, checkedCodePaths: 0 };
  const seen = new Set();
  const finding = (severity, rule, line, detail) => {
    const key = `${rule}\u0000${line}\u0000${detail}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ severity, rule, line, detail }); }
  };
  if (typeof readme !== 'string' || !readme.trim()) {
    finding('error', 'readme-missing', 1, 'No readable README.md at HEAD');
    return { kind: 'repository-frontdoor-observation.v1', observed, findings };
  }
  const lines = readme.replace(/\r\n/gu, '\n').split('\n');
  let fenced = false, fenceMark = '', inComment = false;
  const body = [];
  const paths = trackedPaths == null ? null : new Set();
  for (const raw of trackedPaths ?? []) {
    const path = raw.replace(/\/$/u, '');
    paths.add(path);
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) paths.add(path.slice(0, at));
  }
  const exists = (path) => path === '.' || paths.has(path);
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i], lineTrimmed = raw.trim();
    const fence = /^(`{3,}|~{3,})/u.exec(lineTrimmed);
    if (fence) {
      if (!fenced) { fenced = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) fenced = false;
      continue;
    }
    if (fenced) continue;
    if (lineTrimmed.includes('<!--')) inComment = true;
    if (inComment) {
      if (lineTrimmed.includes('-->')) inComment = false;
      continue;
    }
    if (/^\[!\[/u.test(lineTrimmed)) continue;
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/u.exec(lineTrimmed);
    if (heading) observed.headings.push({ line: lineNumber, title: heading[1] });
    if (!observed.openingLine && lineTrimmed && !/^(?:#|\[!|>|\||[-*]\s|\d+\.|\[)/u.test(lineTrimmed)) {
      observed.openingLine = lineNumber;
    }
    body.push(raw);
    if (paths) {
      for (const match of raw.matchAll(link)) {
        const t = target(match[1]);
        if (!t) continue;
        observed.checkedRelativeLinks++;
        if (t.invalid) finding('error', 'invalid-relative-link', lineNumber, `${match[1]}: ${t.invalid}`);
        else if (!exists(t.path)) finding('error', 'missing-relative-link', lineNumber, `${match[1]} has no tracked target at HEAD`);
      }
      // Backtick paths are often *claims* rather than hyperlinks, so these
      // produce review prompts, not automated conformance failures.
      const re = /`((?:\.\/)?(?:apps|bin|content|data|docs|lib|schemas|scripts|services|src|test|types)\/[A-Za-z0-9_.\/-]+\/?)`/gu;
      for (const match of raw.matchAll(re)) {
        const t = target(match[1]);
        if (!t?.path) continue;
        observed.checkedCodePaths++;
        if (!exists(t.path)) finding('review', 'unresolved-inline-path', lineNumber, `${match[1]} is not present at HEAD; determine whether historical, planned or stale`);
      }
    }
  }
  const headings = observed.headings.map((h) => h.title.toLowerCase());
  const text = body.join('\n');
  const beforeFirstSection = text.split(/^##\s/um)[0].replace(/^# .+$/um, '').trim();
  if (!observed.openingLine || !/[A-Za-z]{4}/u.test(beforeFirstSection)) finding('review', 'purpose-needs-review', 1, 'Check that an unfamiliar visitor learns what this repository actually provides before its first section');
  if (!headings.some((h) => /use|start|install|try|entry|example|interface|navigation|where to|how to|read this|contents|structure/iu.test(h)))
    finding('review', 'entry-route-needs-review', 1, 'Explain where a visitor can begin: runnable export, example, or explicit index of composed sources');
  if (!headings.some((h) => /status|readiness|maturity|implemented|what exists|current|limitation/iu.test(h)))
    finding('review', 'status-needs-review', 1, 'Distinguish implemented and independently verified work from plans, proposals or unverified features');
  if (!headings.some((h) => /scope|boundar|relation|responsibilit|does not|not here|architecture|fits|specialization/iu.test(h)) && !/\b(?:does not|is not|rather than|not a)\b/iu.test(text))
    finding('review', 'boundary-needs-review', 1, 'Explain what this repository owns and what adjacent components own instead');
  return { kind: 'repository-frontdoor-observation.v1', observed, findings };
}
