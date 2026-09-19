# Releasing

Publishing a GitHub Release for tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which publishes `stanley-code` to npm with **trusted publishing (OIDC) and provenance**. There is no npm token in
this repository or its secrets, and none should ever be added.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs `npm run check` on Node 22.18.0, 22 and 24
for every pull request and push to `main`, plus `npm run check:package`, the same package check the release uses.

## One-time setup: npm trusted publisher

You need owner access to `stanley-code` on npmjs.com, with 2FA on your account. At
<https://www.npmjs.com/package/stanley-code/access>, under **Trusted Publisher**, choose **GitHub Actions** and enter
exactly (case-sensitive):

| Field                | Value          |
| -------------------- | -------------- |
| Organization or user | `devagrawal09` |
| Repository           | `stanley-code` |
| Workflow filename    | `release.yml`  |
| Environment name     | `npm`          |

The workflow filename is the file name only, not the full path. The environment must match `environment: npm`
on the `publish` job. Equivalent CLI (npm >= 11.10.0, run by a package owner):

```sh
npm trust github stanley-code --repository devagrawal09/stanley-code --file release.yml --environment npm --allow-publish
npm trust list stanley-code
```

npm allows one trusted publisher per package; run `npm trust revoke stanley-code --id <id>` before changing it.

**After the first successful trusted publish:** under **Settings → Publishing access**, select **Require
two-factor authentication and disallow tokens**, and revoke any npm automation or publish tokens used for
`0.0.1`. Trusted publishing uses no tokens, so it keeps working.

## One-time setup: GitHub environment `npm`

Configure it at <https://github.com/devagrawal09/stanley-code/settings/environments> before the first release:

- **Deployment branches and tags:** "Selected branches and tags", with a **tag** rule `v*`.
- **Required reviewers (optional):** add yourself to approve each publish before the job gets its OIDC token.
- **No** environment secrets. Also no repository secrets, `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

## Cutting a release

1. **Bump the version in a pull request** and merge it once CI is green:

   ```sh
   npm version 0.1.0 --no-git-tag-version   # updates package.json and package-lock.json
   ```

2. **Rehearse locally** from the merged `main` (optional; publishes nothing):

   ```sh
   npm ci && npm run check
   npm run check:package             # manifest + tarball file list
   node scripts/release.ts registry  # version is not on npm and is newer than latest
   ```

3. **Tag the merged commit and publish the release.** The tag must be exactly `v` + the `package.json` version,
   on a commit reachable from `main`. Do not mark it as a pre-release. A saved draft does nothing; only
   publishing starts the workflow.

   ```sh
   git fetch origin
   git tag -a v0.1.0 origin/main -m "v0.1.0"
   git push origin v0.1.0
   gh release create v0.1.0 --verify-tag --title v0.1.0 --generate-notes
   ```

4. **Watch the Release workflow.** Approve the `publish` job if reviewers are required. When it finishes,
   <https://www.npmjs.com/package/stanley-code/v/0.1.0> shows the version with a provenance badge.

## What the workflow checks

Job `verify` (`contents: read`, no OIDC token) stops the release before anything is published unless:

1. The tag is `v` + a stable `X.Y.Z` that equals `v` + `package.json` `version`.
2. `package.json` `name` is `stanley-code` and `repository.url` is `https://github.com/devagrawal09/stanley-code`
   (npm rejects provenance otherwise).
3. `HEAD` is the tag commit (`GITHUB_SHA`, ref `refs/tags/<tag>`), the tree is clean, and the commit is reachable
   from `origin/main`.
4. The GitHub Release is not a pre-release.
5. npm is >= 11.5.1 and points at `https://registry.npmjs.org/`.
6. The version is not on npm yet and is greater than the current `latest`.
7. `npm ci` and `npm run check` pass, and the tree is still clean afterwards.
8. `npm pack` contains only `package.json`, `README.md`, `LICENSE`, and a `dist/**/*.js` and `dist/**/*.d.ts` for
   every `src/**/*.ts`; `dist/cli.js` is executable with a node shebang.

Job `publish` (`contents: read`, `id-token: write`, environment `npm`) installs no dependencies and runs no
package scripts. It re-checks the tag, checkout, npm CLI and registry, confirms the verified tarball's SHA-256
and contents, then runs:

```sh
npm publish <verified tarball> --provenance --access public --ignore-scripts
```

Check logic lives in [`scripts/release-checks.ts`](../scripts/release-checks.ts) (tested in
`test/release.test.ts`); I/O is in [`scripts/release.ts`](../scripts/release.ts). Runs for the same tag queue
(`cancel-in-progress: false`) instead of racing; a second run fails the "not on npm" check.

## When something fails

`npm publish` is the last step: a failed run published nothing unless its log shows `npm publish` succeeded.

| Failure                                                         | Published? | Fix                                                                                                      |
| --------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| Tag format, tag/version mismatch, package name or repository    | No         | Delete the GitHub Release and tag, then tag the right commit/version.                                    |
| Tag not on `main`, or release marked pre-release                | No         | Delete the release (and the tag if wrong) and recreate. Editing a release does not re-trigger the run.   |
| Version already on npm, or not newer than `latest`              | No         | Bump the version in a PR and release a new tag. npm versions can never be reused.                        |
| `npm run check`, dirty tree or package contents                 | No         | Fix on `main`, then delete the release and tag and re-tag the fixed commit, or bump the version.         |
| Environment approval rejected                                   | No         | Re-run the workflow when ready.                                                                          |
| `npm publish` E404/E403 (trusted publisher mismatch) or OIDC    | No         | Fix the trusted publisher fields above, then **Re-run failed jobs**. The tarball artifact is kept 30 days. |
| `npm publish` E422 provenance/repository mismatch               | No         | Fix `package.json` `repository` in a PR and release a new version.                                       |
| Run fails or times out after `npm publish` reported success     | Yes        | Do not re-tag. Re-running is safe (it stops at "not on npm"). Confirm with `npm view stanley-code@X.Y.Z`.    |

Re-runs use the workflow and scripts from the tagged commit, so fixes to `release.yml` or `scripts/` apply only
to a new tag. Never move or reuse a tag whose version is on npm. Deleting a GitHub Release does not unpublish
anything from npm.
