# repository-norms

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![ci](https://github.com/red-cup-engineering/repository-norms/actions/workflows/ci.yml/badge.svg)](https://github.com/red-cup-engineering/repository-norms/actions/workflows/ci.yml)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The 561 Group's repository norms, as checks that run in CI and across the estate.

## Norms

- **Names.** A section repository names its organization's domain:
  `x-science-services-section` (Lenticule Science), `x-engineering-services-section` (Red Cup Engineering),
  `x-operations-services-section` (Coesite Operations), and the prefix forms those organizations already use,
  `public-x-services-section` (Causeway Services) and `561-group-x-services-section` (561 Group).
  An application, library or service keeps its plain name. A dated snapshot (`2026-08-04-…`) is an archive:
  archive it on GitHub rather than renaming it.
- **Submodules.** A section, its package and its repository are one unit, composed into its parent as a submodule.
  Every gitlink is declared exactly once in `.gitmodules`, every declaration names a gitlink, every URL is an
  `https://github.com/` repository of a house organization, and the composing directory is named for the
  repository it composes.

The norms are data in [`norms.json`](norms.json).

## First-visit clarity checks

A person arriving at a GitHub repository should be able to tell **what is here
now**, **where to begin**, and **what belongs elsewhere**. Repository introductions
must be checked against tracked sources, not improved by inventing capabilities
or copying the same boilerplate into every repository.

The optional, read-only `frontdoor` assessment examines the README at `HEAD`
against the tracked tree (including submodule gitlinks). It reports:

- **Errors:** missing README, broken relative Markdown links, and paths escaping
  the repository. These can fail CI.
- **Review prompts:** missing visitor routes/status/boundary explanations and
  inline code-path mentions absent from the tracked tree. These are **not**
  automatic semantic judgments: historical and planned paths may be legitimate.

Review the package's actual exports, root directories, current Issues, PRs,
development branches, owner boundaries, and tests before rewriting prose.
Explain section/catalog repositories as such; never advertise a root app or
CLI that does not exist. Link the real component owners. Distinguish source
code, independently verified behavior, and deployment.

```sh
node bin/repository-norms.mjs frontdoor . --json  # machine-readable observations
node bin/repository-norms.mjs frontdoor .          # compact human findings
node bin/repository-norms.mjs frontdoor . --warn   # no failing exit; advisory survey
```

The report includes the source commit, line numbers, and observed paths.
This supplements, rather than replaces, the existing name/submodule `check`
and the estate-level public repository branding policy owned by
`github-engineering-services-section`.

### Continuous use in another repository

The [reusable GitHub Actions workflow](.github/workflows/frontdoor.yml)
checks a **caller's** checked-out HEAD. A repository can opt in with the
following small `.github/workflows/frontdoor.yml` (pin the referenced
workflow by an explicitly reviewed commit SHA, not an unspecified branch):

```yaml
name: Repository first-visit audit
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  frontdoor:
    uses: red-cup-engineering/repository-norms/.github/workflows/frontdoor.yml@97767b274202af7ff0f95172d1234721da64354f
```

That reusable workflow checks out both the caller and an immutable,
version-pinned observer, with no write or credential persistence. It emits
source-revision-bound findings. This deliberately does not edit repositories
or auto-approve architectural assertions. When upgrading the observer,
review and move the pinned implementation and caller refs together.


## Use

```sh
node bin/repository-norms.mjs check .            # this checkout: its own name and its submodules; exit 1 on findings
node bin/repository-norms.mjs check . --warn     # report without failing
node bin/repository-norms.mjs estate --org red-cup-engineering --org lenticule-science   # every name, as JSON lines
```

In GitHub Actions, call the reusable workflow
`red-cup-engineering/continuous-delivery-engineering-services-section/.github/workflows/repository-norms.yml`.
