# Releasing

`jev-code` is published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a
GitHub Release is **published** for a tag `vX.Y.Z`. Publishing uses npm trusted publishing (OIDC) with
provenance. There is no npm token anywhere in this repository or its secrets, and none should be added.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `npm run check` on Node 22.18.0, 22 and 24
for every pull request and push to `main`, plus the same package-contents check the release uses.

## One-time setup

### 1. npm trusted publisher

Requires owner access to `jev-code` on npmjs.com with account 2FA enabled. On
<https://www.npmjs.com/package/jev-code/access>, under **Trusted Publisher**, choose **GitHub Actions** and
enter exactly:

| Field                 | Value          |
| --------------------- | -------------- |
| Organization or user  | `devagrawal09` |
| Repository            | `jev-code`     |
| Workflow filename     | `release.yml`  |
| Environment name      | `npm`          |

Values are case-sensitive. The workflow filename is the file name only, not `.github/workflows/release.yml`.
The environment must match `environment: npm` on the `publish` job.

Equivalent CLI (npm >= 11.10.0, run by a package owner):

```sh
npm trust github jev-code --repository devagrawal09/jev-code --file release.yml --environment npm --allow-publish
npm trust list jev-code
```

npm allows one trusted publisher per package. To change it, `npm trust revoke jev-code --id <id>` first.

After the first successful trusted publish, harden the package under **Settings → Publishing access** by
selecting **Require two-factor authentication and disallow tokens**, and revoke any npm automation or
publish tokens that were used for `0.0.1`. Trusted publishing does not use tokens, so it keeps working.

### 2. GitHub environment `npm`

GitHub creates the `npm` environment automatically on first use, but configure it up front at
<https://github.com/devagrawal09/jev-code/settings/environments>:

- **Deployment branches and tags:** "Selected branches and tags", add a **tag** rule `v*`.
- **Required reviewers (optional):** add yourself to require a manual approval before the publish job receives
  its OIDC token.
- Add **no** environment secrets.

Nothing else is needed: no repository secrets, no `NPM_TOKEN`, no `NODE_AUTH_TOKEN`.

## Cutting a release

1. **Bump the version in a pull request** and merge it once CI is green:

   ```sh
   npm version 0.1.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```

2. **Rehearse locally** from the merged `main` (optional, nothing is published):

   ```sh
   npm ci
   npm run check
   npm run check:package             # manifest + tarball allowlist
   node scripts/release.ts registry  # version is not on npm and is newer than latest
   ```

3. **Tag the merged commit and publish the GitHub Release.** The tag must be exactly `v` + the
   `package.json` version, on a commit reachable from `main`:

   ```sh
   git fetch origin
   git tag -a v0.1.0 origin/main -m "v0.1.0"
   git push origin v0.1.0
   gh release create v0.1.0 --verify-tag --title v0.1.0 --generate-notes
   ```

   Or use the GitHub UI and pick the existing tag. Do not mark it as a pre-release. Saving a draft does
   nothing; the workflow starts when the release is published.

4. **Watch the Release workflow.** If the `npm` environment has required reviewers, approve the `publish`
   job. When it finishes, `https://www.npmjs.com/package/jev-code/v/0.1.0` shows the version with a
   provenance badge linking back to the workflow run.

## What the workflow checks

Job `verify` (`contents: read` only, no OIDC token) stops the release before anything is published if any
check fails:

1. The tag is exactly `v` + a stable `X.Y.Z` version and equals `v` + `package.json` `version`.
2. `package.json` `name` is exactly `jev-code`, and `repository.url` is `https://github.com/devagrawal09/jev-code`
   (npm rejects provenance when this does not match).
3. The checkout is the tag commit (`HEAD` = tag commit = `GITHUB_SHA`, ref `refs/tags/<tag>`), the working tree
   is clean, and the tag commit is reachable from `origin/main`.
4. The GitHub Release is not marked as a pre-release.
5. npm is >= 11.5.1 (required for trusted publishing) and points at `https://registry.npmjs.org/`.
6. The version is not already on npm and is greater than the current `latest`.
7. `npm ci` and `npm run check` pass (lint, typecheck, tests, build, offline smoke).
8. The tree is still clean after the build.
9. `npm pack` contains only `package.json`, `README.md`, `LICENSE` and, for every `src/**/*.ts`, the matching
   `dist/**/*.js` and `dist/**/*.d.ts`. Nothing is missing, and `dist/cli.js` is executable with a node shebang.

The verified tarball and its SHA-256 are passed to job `publish` (`contents: read`, `id-token: write`,
environment `npm`). That job does not install dependencies or run package scripts. It re-checks the tag,
checkout, npm CLI and registry state, confirms the downloaded tarball's SHA-256 and contents, then runs:

```sh
npm publish <verified tarball> --provenance --access public --ignore-scripts
```

All check logic is in [`scripts/release-checks.ts`](../scripts/release-checks.ts) (unit-tested in
`test/release.test.ts`), with I/O in [`scripts/release.ts`](../scripts/release.ts).

Runs are grouped per tag with `cancel-in-progress: false`, so two runs for the same release queue rather
than race or cancel each other. The later run then fails the "not already on npm" check.

## When something fails

Every check runs before `npm publish`, and `npm publish` is the last step. A failed run has published
nothing unless the log shows `npm publish` succeeded.

| Failure                                                                    | Published? | Fix                                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag format, tag/version mismatch, package name or repository              | No         | Delete the GitHub Release and tag, then tag the right commit/version.                                                                                |
| Tag not on `main`, or release marked pre-release                           | No         | Delete the release (and the tag if it is wrong), then recreate. Editing a release does not re-trigger the workflow.                                  |
| Version already on npm, or not newer than `latest`                         | No         | Bump the version in a PR and release the new tag. npm versions can never be reused.                                                                  |
| `npm run check`, dirty tree or package contents                            | No         | Fix on `main`. The version never reached npm, so you may delete the release and tag and re-tag the fixed commit, or bump the version.                |
| Environment approval rejected                                              | No         | Re-run the workflow run when ready.                                                                                                                   |
| `npm publish` E404/E403 (trusted publisher mismatch) or OIDC error         | No         | Fix the npm trusted publisher fields above, then **Re-run failed jobs**. The verified tarball artifact is kept for 30 days.                           |
| `npm publish` E422 provenance/repository mismatch                          | No         | `package.json` `repository` is wrong. Fix it in a PR and release a new version.                                                                       |
| Run fails or times out after `npm publish` reported success                | Yes        | Do not re-tag. Re-running is safe: it stops at "version is not on npm". Confirm with `npm view jev-code@X.Y.Z`.                                      |

Re-runs use the workflow file and code from the tagged commit. A fix to `release.yml` or `scripts/` only takes
effect for a new tag. Never move or reuse a tag whose version is already on npm. Deleting a GitHub Release
does not unpublish anything from npm.
