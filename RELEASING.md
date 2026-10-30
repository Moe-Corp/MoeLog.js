# Releasing

Versions and the changelog are managed by [release-please](https://github.com/googleapis/release-please).
Nobody bumps a version by hand.

## Versioning policy

| Version | Meaning | npm dist-tag |
|---|---|---|
| `X.0.0` | Major. Breaks compatibility; each major is an LTS line on a `release/X.x` branch that only takes fixes | `latest` |
| `0.X.0` | One roadmap milestone. Stable only when every issue in the milestone is closed and its exit criterion holds | `latest` |
| `0.X.Y` | Bug fixes only | `latest` |
| `0.X.Y-alpha.N` | Experimental: what `main` ships while a milestone is open | `alpha` |

The four packages (`core`, `sidecar`, `node`, `bun`) always share one version.

## How a release happens

1. Pull requests are merged into `main` with [Conventional Commits](https://www.conventionalcommits.org)
   messages.
2. On every push to `main`, release-please opens or updates a pull request titled
   `chore: release <version>`. It bumps the version everywhere and writes `CHANGELOG.md`.
3. Merging that pull request tags `v<version>` and creates the GitHub release.

The release pull request can stay open for as long as you like; it keeps updating itself.
Merge it when you want to ship what it contains.

### What each commit type does

| Type | Changelog | Version bump while a milestone is open |
|---|---|---|
| `feat:` | Features | next minor alpha (`0.1.0-alpha.1` → `0.1.0-alpha.2`, `0.1.0` → `0.2.0-alpha.0`) |
| `fix:` | Bug Fixes | next alpha (`0.1.0` → `0.1.1-alpha.0`) |
| `perf:`, `revert:`, `deps:` | their own section | next alpha |
| `chore:` | Miscellaneous | next alpha |
| `feat!:` / `BREAKING CHANGE:` | Features, flagged | before 1.0, the next minor; after, the next major |
| `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `style:` | hidden | none on their own |

A release pull request only appears when at least one commit lands in a visible section.

## Closing a milestone

A milestone ships as a stable minor (`0.X.0`) once its last issue is closed and its exit criterion
holds.

1. Open a pull request that adds `"release-as": "0.X.0"` to the `"."` package in
   `release-please-config.json`, and merge it.
2. The release pull request turns into `chore: release 0.X.0`. Review it and merge it.
3. Open a pull request that removes `release-as` and merge it. **Do not skip this step:** while
   `release-as` is set, every release pull request uses that exact version.
4. Close the milestone on GitHub.

## Where the version lives

release-please updates all of these in the release pull request:

- `package.json` at the root and in each of the four packages
- the `VERSION` constant in `packages/sidecar/src/version.ts`, `packages/node/src/index.ts` and
  `packages/bun/src/index.ts`, which every envelope carries
- the status line at the top of `README.md`

If you add a file that carries the version, put `x-release-please-version` on the same line and add
the file to `extra-files` in `release-please-config.json`.

## Things to know

- **The release pull request does not run CI.** Pull requests opened with the workflow's own token
  do not trigger other workflows. It only touches versions and the changelog.
- **release-please marks every 0.x release as a pre-release on GitHub.** The release workflow
  removes that flag from stable versions and marks them as latest.
- **Publishing to npm is not automated yet** (#4). Until it is, publish a release by hand with
  `bun run publicar` after the release pull request is merged.
