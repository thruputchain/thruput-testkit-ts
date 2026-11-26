# npm releases

The manual **Release package** workflow runs on `main` and defaults to
`dry_run: true`. It repeats all CI checks, including the live-node integration
suite, then packs testkit and previews publication. A dry run does not publish
or tag.

## Releasing a version

1. Make sure the `@thruputchain/client` peer range in `package.json` names a
   published client release, and that `devDependencies` uses that release.
2. Qualify testkit against the CLI and devnode pins in
   `scripts/integration-versions.json`. Update the pins and `LOCAL_RUNTIME`
   first when the release targets a new runtime.
3. Bump `version` in `package.json` and `package-lock.json` in a pull request
   titled for the release. Merge it to `main`.
4. Run the workflow with `dry_run: true` and review the packed contents.
5. After explicit release approval, run it with `dry_run: false`.

Versions are immutable on npm. Never reuse a version number.

## Authentication

`publishConfig` selects the public npm registry. The workflow authenticates
with the Actions secret `NPM_TOKEN`: a granular npm write token for the
`@thruputchain` organization. Do not put tokens in files. Dry-run success does
not prove npm scope ownership or token permissions.

## Tags and retries

Publication creates `npm-v<version>` at the tested commit. A retry skips an
existing npm version only if its tarball integrity matches the local package
exactly. Different contents, or a tag at another commit, stop the release. Retry
from the same commit.
