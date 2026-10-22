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

## Use

```sh
node bin/repository-norms.mjs check .            # this checkout: its own name and its submodules; exit 1 on findings
node bin/repository-norms.mjs check . --warn     # report without failing
node bin/repository-norms.mjs estate --org red-cup-engineering --org lenticule-science   # every name, as JSON lines
```

In GitHub Actions, call the reusable workflow
`red-cup-engineering/continuous-delivery-services-section/.github/workflows/repository-norms.yml`.
